import type { Ledger } from "../quota/ledger.js";
import { estimateRequestTokens } from "../quota/tokens.js";
import { tierRank } from "../providers/families.js";
import type {
  DiscoveredModel,
  GenerateRequest,
  ProviderConfig,
  ProviderRuntime,
  Route,
  SelectionInput,
  SelectionResult,
  Skipped,
  StateStore,
  Tier,
} from "../types/index.js";
import { clamp } from "../utils/index.js";

const REGION_ALIASES: Record<string, string[]> = {
  EU: ["EU", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"],
  UK: ["UK", "GB"],
  CH: ["CH"],
};

function regionMatches(userRegion: string | undefined, blocked: string[]): boolean {
  if (!userRegion) return false;
  const u = userRegion.toUpperCase();
  return blocked.some((b) => (REGION_ALIASES[b] ?? [b]).includes(u));
}

export class Selector {
  constructor(
    private readonly ledger: Ledger,
    private readonly store: StateStore,
  ) {}

  private async affinityFamily(sessionId: string): Promise<string | null> {
    return this.store.get(`aff:${sessionId}`);
  }

  async setAffinity(sessionId: string, family: string): Promise<void> {
    await this.store.set(`aff:${sessionId}`, family, 30 * 60_000);
  }

  /**
   * Build the ranked candidate list. Filters are hard constraints; a dropped
   * route always carries a reason so the error trail can explain it.
   */
  async select(input: SelectionInput): Promise<SelectionResult> {
    const { request, providers, models, runtime, config, region } = input;
    const skipped: Skipped[] = [];
    const candidates: Route[] = [];
    const now = new Date();

    const estTokens = estimateRequestTokens(request.prompt, request.system);
    const minContext = Math.max(request.requires?.minContext ?? 0, estTokens + (request.maxTokens ?? 512));
    const excluded = new Set((request.exclude ?? []).map((s) => s.toLowerCase()));

    for (const provider of providers) {
      const rt = runtime.get(provider.id);

      if (rt?.disabled) {
        skipped.push({ provider: provider.id, reason: "disabled", detail: rt.disabled });
        continue;
      }
      if (rt?.cooldownUntil && rt.cooldownUntil > Date.now()) {
        skipped.push({
          provider: provider.id,
          reason: "cooldown",
          detail: `${Math.round((rt.cooldownUntil - Date.now()) / 1000)}s remaining`,
        });
        continue;
      }
      if (excluded.has(provider.id.toLowerCase())) {
        skipped.push({ provider: provider.id, reason: "excluded" });
        continue;
      }
      if (!provider.productionAllowed && config.mode === "production") {
        skipped.push({
          provider: provider.id,
          reason: "production_disallowed",
          detail: "ToS restricts this free tier to development/evaluation",
        });
        continue;
      }
      if (provider.keyless && !config.keylessFallback) {
        skipped.push({ provider: provider.id, reason: "keyless_not_enabled" });
        continue;
      }
      if (provider.logsPrompts && !config.allowPromptLogging) {
        skipped.push({
          provider: provider.id,
          reason: "prompt_logging_disallowed",
          detail: "provider may use prompts for training",
        });
        continue;
      }
      if (provider.regionBlocked && regionMatches(region, provider.regionBlocked)) {
        skipped.push({
          provider: provider.id,
          reason: "disabled",
          detail: `region_blocked: unavailable in ${provider.regionBlocked.join("/")}`,
        });
        continue;
      }

      // Held across the call at execution time, but a full semaphore is
      // visible here and worth skipping early.
      if (provider.maxConcurrent !== undefined) {
        const key = `sem:${provider.id}`;
        const acquired = await this.store.acquire(key, provider.maxConcurrent);
        if (!acquired) {
          skipped.push({ provider: provider.id, reason: "concurrency_full" });
          continue;
        }
        await this.store.release(key);
      }

      const provModels = models.get(provider.id) ?? [];
      if (provModels.length === 0) {
        skipped.push({ provider: provider.id, reason: "no_models" });
        continue;
      }

      for (const model of provModels) {
        const fq = `${provider.id}:${model.id}`.toLowerCase();
        if (excluded.has(fq) || excluded.has(model.id.toLowerCase())) {
          skipped.push({ provider: provider.id, model: model.id, reason: "excluded" });
          continue;
        }

        // minTier errors rather than silently downgrading.
        if (request.tier && tierRank(model.tier) < tierRank(request.tier)) {
          skipped.push({ provider: provider.id, model: model.id, reason: "tier_too_low" });
          continue;
        }

        // Context window from discovery.
        if (model.contextWindow !== undefined && model.contextWindow < minContext) {
          skipped.push({
            provider: provider.id,
            model: model.id,
            reason: "context_too_small",
            detail: `${model.contextWindow} < ${minContext}`,
          });
          continue;
        }

        // Separate from the context window: GitHub Models advertises huge
        // contexts but caps 8K in / 4K out.
        const capIn = provider.perRequestCaps?.maxInput;
        if (capIn !== undefined && estTokens > capIn) {
          skipped.push({
            provider: provider.id,
            model: model.id,
            reason: "per_request_cap",
            detail: `${estTokens} input tokens exceeds ${capIn}`,
          });
          continue;
        }

        const hr = await this.ledger.headroom(provider, model.id, now);
        const values = [
          ...Object.values(hr.req),
          ...Object.values(hr.tok).map((v) => (v > 0 ? 1 : 0)),
        ];
        if (values.some((v) => v <= 0)) {
          skipped.push({
            provider: provider.id,
            model: model.id,
            reason: "no_headroom",
            detail: `source=${hr.source}`,
          });
          continue;
        }

        const headroomRatio = this.headroomRatio(provider, model.id, hr.req);
        candidates.push({
          provider,
          model,
          headroomRatio,
          score: this.score(request, provider, model, rt, headroomRatio, hr.source),
        });
      }
    }

    // Affinity keeps follow-ups on one family so output stays consistent. It
    // is a HARD restriction, not a score nudge — a nudge still lets the
    // weighted pick jump families. Falls back to all routes only when the
    // pinned family has no capacity left anywhere.
    if (config.affinity && request.sessionId && candidates.length > 0) {
      const fam = await this.affinityFamily(request.sessionId);
      if (fam) {
        const sameFamily = candidates.filter((c) => c.model.family === fam);
        if (sameFamily.length > 0) {
          sameFamily.sort((a, b) => b.score - a.score);
          return { routes: sameFamily, skipped };
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return { routes: candidates, skipped };
  }

  private headroomRatio(
    provider: ProviderConfig,
    modelId: string,
    req: Partial<Record<string, number>>,
  ): number {
    const limits = { ...provider.defaultLimits.default, ...(provider.defaultLimits[modelId] ?? {}) };
    const pairs: Array<[number | undefined, number | undefined]> = [
      [req.min, limits.rpm],
      [req.day, limits.rpd],
      [req.month, limits.rpMonth],
      [req.sec, limits.rps],
    ];
    const ratios = pairs
      .filter(([rem, lim]) => rem !== undefined && lim !== undefined && lim > 0)
      .map(([rem, lim]) => clamp(rem! / lim!, 0, 1));
    // No known limit means unmetered from our side (NVIDIA has no daily cap).
    return ratios.length ? Math.min(...ratios) : 0.9;
  }

  private score(
    request: GenerateRequest,
    provider: ProviderConfig,
    model: DiscoveredModel,
    rt: ProviderRuntime | undefined,
    headroomRatio: number,
    source: string,
  ): number {
    const wanted: Tier = request.tier ?? "balanced";
    const distance = Math.abs(tierRank(model.tier) - tierRank(wanted));
    const tierFit = distance === 0 ? 1 : distance === 1 ? 0.65 : 0.35;

    const latency = rt?.latencyMs ?? 1500;
    const latencyFactor = clamp(2000 / (latency + 500), 0.3, 1.6);

    const total = (rt?.successes ?? 0) + (rt?.failures ?? 0);
    const reliability = total < 3 ? 0.85 : clamp((rt!.successes + 1) / (total + 2), 0.1, 1);

    // Discount guesses so reported headroom wins ties.
    const confidence = source === "reported" ? 1 : source === "mined" ? 0.95 : 0.85;

    const headroomFactor = 0.25 + 0.75 * headroomRatio;

    return tierFit * latencyFactor * reliability * confidence * headroomFactor;
  }

  /**
   * Weighted random pick among the top N. Load-bearing: deterministic top-1
   * drains providers one at a time and ends the day on the worst one, while
   * weighting by remaining capacity keeps every tier alive longer.
   */
  pick(routes: Route[], topN = 4): Route | undefined {
    if (routes.length === 0) return undefined;
    const pool = routes.slice(0, Math.min(topN, routes.length));
    const total = pool.reduce((s, r) => s + r.score, 0);
    if (total <= 0) return pool[0];
    let r = Math.random() * total;
    for (const route of pool) {
      r -= route.score;
      if (r <= 0) return route;
    }
    return pool[pool.length - 1];
  }

  /** Order routes for the executor: weighted first pick, then descending score. */
  order(routes: Route[], maxAttempts: number): Route[] {
    const out: Route[] = [];
    const remaining = [...routes];
    const first = this.pick(remaining);
    if (first) {
      out.push(first);
      remaining.splice(remaining.indexOf(first), 1);
    }
    // Prefer a different provider so one outage cannot eat every attempt.
    for (const r of remaining) {
      if (out.length >= maxAttempts) break;
      if (out.some((o) => o.provider.id === r.provider.id)) continue;
      out.push(r);
    }
    for (const r of remaining) {
      if (out.length >= maxAttempts) break;
      if (!out.includes(r)) out.push(r);
    }
    return out;
  }
}
