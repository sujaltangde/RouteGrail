import { isChatModel, resolveFamily } from "./families.js";
import { isFailure, type CatalogEntry, type Credentials, OpenAITransport } from "./transport/openai.js";
import type { DiscoveredModel, ProviderConfig, StateStore } from "./types.js";

export interface DiscoveryResult {
  models: DiscoveredModel[];
  /** Set when the provider must be taken out of rotation for this session. */
  disabled?: { reason: string };
  degraded?: boolean;
}

/**
 * Reduce a provider's catalog to models that genuinely cost nothing.
 *
 * This is the single most important safety filter in the SDK. OpenRouter's
 * catalog is ~370 models of which roughly 20 are free; without this, a router
 * "for free tiers" will quietly spend the user's credit balance. SiliconFlow
 * and Z.ai have the same shape at smaller scale.
 */
export function filterFree(provider: ProviderConfig, entries: CatalogEntry[]): CatalogEntry[] {
  const f = provider.freeFilter;
  switch (f.kind) {
    case "all":
      return entries;
    case "suffix":
      return entries.filter((e) => e.id.endsWith(f.suffix));
    case "zero-price":
      return entries.filter((e) => {
        if (e.id.endsWith(":free")) return true;
        const p = e.pricing;
        if (!p) return false;
        const prompt = Number(p.prompt ?? "1");
        const completion = Number(p.completion ?? "1");
        return prompt === 0 && completion === 0;
      });
    case "allowlist": {
      const set = new Set(f.ids.map((s) => s.toLowerCase()));
      return entries.filter((e) => set.has(e.id.toLowerCase()));
    }
  }
}

/** Detect a region block from an error body so it is not misreported as auth. */
function looksRegionBlocked(body: string): boolean {
  return /location is not supported|user location|not available in your (country|region)|FAILED_PRECONDITION/i.test(
    body,
  );
}

export class Discovery {
  constructor(
    private readonly transport: OpenAITransport,
    private readonly store: StateStore,
    private readonly ttlMs: number,
  ) {}

  private cacheKey(providerId: string): string {
    return `disc:${providerId}`;
  }

  async invalidate(providerId: string): Promise<void> {
    await this.store.del(this.cacheKey(providerId));
  }

  private fromStatic(provider: ProviderConfig): DiscoveredModel[] {
    return (provider.staticModels ?? []).map((id) => {
      const { family, tier } = resolveFamily(id);
      return { id, provider: provider.id, family, tier };
    });
  }

  /**
   * Discover a provider's usable models.
   *
   * One catalog request does three jobs at once: it validates the key, returns
   * real model IDs (never hardcoded — free-tier lineups rotate constantly and a
   * stale models.ts produces 404s that look like outages), and yields context
   * windows for free.
   */
  async discover(provider: ProviderConfig, creds: Credentials): Promise<DiscoveryResult> {
    const cached = await this.store.get(this.cacheKey(provider.id));
    if (cached) {
      try {
        return { models: JSON.parse(cached) as DiscoveredModel[] };
      } catch {
        // fall through and re-discover
      }
    }

    // No catalog endpoint: fall back to the registry's static list.
    if (!provider.modelsPath && !provider.modelsUrl) {
      const models = this.fromStatic(provider);
      await this.store.set(this.cacheKey(provider.id), JSON.stringify(models), this.ttlMs);
      return { models };
    }

    let raw: CatalogEntry[];
    try {
      const res = await this.transport.catalog(provider, creds);
      if (isFailure(res)) {
        if (res.status === 401 || res.status === 403) {
          if (looksRegionBlocked(res.body)) {
            return {
              models: [],
              disabled: {
                reason: `region_blocked: free tier unavailable in ${(provider.regionBlocked ?? ["this region"]).join("/")}`,
              },
            };
          }
          return {
            models: [],
            disabled: { reason: `auth_failed: ${res.status} on model catalog` },
          };
        }
        // Transient: keep the provider, retry lazily on first use.
        const models = this.fromStatic(provider);
        return { models, degraded: true };
      }
      raw = res;
    } catch (err) {
      const models = this.fromStatic(provider);
      return { models, degraded: true };
    }

    const free = filterFree(provider, raw);
    const models: DiscoveredModel[] = free
      .filter((e) => isChatModel(e.id))
      .map((e) => {
        const { family, tier } = resolveFamily(e.id);
        return {
          id: e.id,
          provider: provider.id,
          family,
          tier,
          contextWindow: e.contextWindow,
        };
      });

    // A catalog that filters down to nothing is not an error, but the provider
    // has nothing to offer this session.
    const final = models.length > 0 ? models : this.fromStatic(provider);
    await this.store.set(this.cacheKey(provider.id), JSON.stringify(final), this.ttlMs);
    return { models: final };
  }
}
