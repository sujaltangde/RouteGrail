import { isChatModel, resolveFamily } from "../providers/families.js";
import { isFailure, OpenAITransport } from "../transport/openai.js";
import type {
  CatalogEntry,
  Credentials,
  DiscoveredModel,
  DiscoveryResult,
  ProviderConfig,
  StateStore,
} from "../types/index.js";

/**
 * Reduce a catalog to models that genuinely cost nothing. The key safety
 * filter: ~20 of OpenRouter's ~370 models are free, and without this the
 * router quietly spends the user's credit balance.
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
   * Discover a provider's usable models. One catalog request validates the key,
   * returns live model IDs (lineups rotate; hardcoding produces 404s that look
   * like outages) and yields context windows.
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
    } catch {
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

    // Filtering down to nothing is not an error, just an empty provider.
    const final = models.length > 0 ? models : this.fromStatic(provider);
    await this.store.set(this.cacheKey(provider.id), JSON.stringify(final), this.ttlMs);
    return { models: final };
  }
}
