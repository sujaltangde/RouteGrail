import type {
  Headroom,
  LedgerSource,
  Limits,
  Metric,
  ProviderConfig,
  QuotaAnchor,
  ReportedQuota,
  Reservation,
  StateStore,
  WindowKind,
} from "../types/index.js";
import { msUntilWindowEnd, windowKey, windowTtlMs } from "../utils/index.js";
import { estimateNeurons } from "./tokens.js";

/** How long a reported/mined anchor is trusted before falling back to estimates. */
const ANCHOR_TTL_MS: Record<"reported" | "mined", number> = {
  reported: 120_000,
  mined: 300_000,
};

const WINDOWS: WindowKind[] = ["sec", "min", "day", "month"];

/**
 * Quota ledger. Sources rank reported > mined > estimated and compose: a
 * reported value anchors `remaining` at a known local count, so live headroom
 * is `anchor.remaining - (localCount - anchor.atCount)`. Local counting is the
 * floor — the ledger must work with zero published data.
 */
export class Ledger {
  constructor(
    private readonly store: StateStore,
    private readonly scopeIds: Map<string, string>,
  ) {}

  private scopeId(provider: ProviderConfig): string {
    // Not "API key": Groq bills per org, Gemini per project. Keying by key
    // double-counts headroom that does not exist.
    return this.scopeIds.get(provider.id) ?? provider.id;
  }

  private counterKey(
    provider: ProviderConfig,
    modelId: string,
    kind: WindowKind,
    metric: Metric,
    now: Date,
  ): string {
    const model = this.modelScope(provider, kind, modelId);
    return `q:${this.scopeId(provider)}:${provider.id}:${model}:${windowKey(kind, provider, now)}:${metric}`;
  }

  private anchorKey(
    provider: ProviderConfig,
    modelId: string,
    kind: WindowKind,
    metric: Metric,
  ): string {
    const model = this.modelScope(provider, kind, modelId);
    return `a:${this.scopeId(provider)}:${provider.id}:${model}:${kind}:${metric}`;
  }

  /** Some limits are per-model (Groq RPD), some account-wide (Cohere, Cloudflare). */
  private modelScope(provider: ProviderConfig, kind: WindowKind, modelId: string): string {
    if (kind === "month") return "*";
    if (provider.id === "cloudflare") return "*";
    if (provider.id === "openrouter") return "*"; // key-wide daily cap
    if (provider.id === "ovhcloud") return modelId; // 2 RPM per IP PER MODEL
    return modelId;
  }

  private limitsFor(provider: ProviderConfig, modelId: string): Limits {
    return { ...provider.defaultLimits.default, ...(provider.defaultLimits[modelId] ?? {}) };
  }

  /** Static cap for a given window+metric, from seed limits. */
  private seedLimit(
    provider: ProviderConfig,
    modelId: string,
    kind: WindowKind,
    metric: Metric,
  ): number | undefined {
    const L = this.limitsFor(provider, modelId);
    if (metric === "req") {
      switch (kind) {
        case "sec":
          return L.rps;
        case "min":
          return L.rpm;
        case "day":
          return L.rpd;
        case "month":
          return L.rpMonth;
      }
    }
    if (metric === "tok") {
      switch (kind) {
        case "min":
          return L.tpm;
        case "day":
          return L.tpd;
        case "month":
          return L.tpMonth;
        default:
          return undefined;
      }
    }
    if (metric === "neurons" && kind === "day") return L.neuronsPerDay;
    return undefined;
  }

  private async readAnchor(
    provider: ProviderConfig,
    modelId: string,
    kind: WindowKind,
    metric: Metric,
  ): Promise<QuotaAnchor | undefined> {
    const raw = await this.store.get(this.anchorKey(provider, modelId, kind, metric));
    if (!raw) return undefined;
    try {
      const a = JSON.parse(raw) as QuotaAnchor;
      if (Date.now() - a.ts > ANCHOR_TTL_MS[a.source]) return undefined;
      return a;
    } catch {
      return undefined;
    }
  }

  private async count(
    provider: ProviderConfig,
    modelId: string,
    kind: WindowKind,
    metric: Metric,
    now: Date,
  ): Promise<number> {
    const v = await this.store.get(this.counterKey(provider, modelId, kind, metric, now));
    return v ? Number(v) : 0;
  }

  /**
   * Headroom per metered window. An absent entry means unknown/unlimited and
   * the selector treats it as passable (NVIDIA has no daily cap).
   */
  async headroom(
    provider: ProviderConfig,
    modelId: string,
    now = new Date(),
  ): Promise<Headroom> {
    const req: Partial<Record<WindowKind, number>> = {};
    const tok: Partial<Record<WindowKind, number>> = {};
    let bestSource: LedgerSource = "estimated";
    let resetInMs: number | undefined;

    const rank: Record<LedgerSource, number> = { estimated: 0, mined: 1, reported: 2 };

    for (const kind of WINDOWS) {
      for (const metric of ["req", "tok"] as const) {
        const anchor = await this.readAnchor(provider, modelId, kind, metric);
        const local = await this.count(provider, modelId, kind, metric, now);

        let remaining: number | undefined;

        if (anchor) {
          // Trust the disclosed number, minus everything counted since.
          const delta = Math.max(0, local - anchor.atCount);
          remaining = Math.max(0, anchor.remaining - delta);
          if (rank[anchor.source] > rank[bestSource]) bestSource = anchor.source;
        } else {
          const limit = this.seedLimit(provider, modelId, kind, metric);
          if (limit !== undefined) remaining = Math.max(0, limit - local);
        }

        if (remaining !== undefined) {
          if (metric === "req") req[kind] = remaining;
          else tok[kind] = remaining;

          if (remaining <= 0) {
            const ms = msUntilWindowEnd(kind, provider, now);
            resetInMs = resetInMs === undefined ? ms : Math.min(resetInMs, ms);
          }
        }
      }
    }

    // Cloudflare is neuron-denominated; gate on the request axis without
    // pretending neurons are requests.
    if (provider.defaultLimits.default?.neuronsPerDay !== undefined) {
      const anchor = await this.readAnchor(provider, modelId, "day", "neurons");
      const local = await this.count(provider, modelId, "day", "neurons", now);
      const limit = this.seedLimit(provider, modelId, "day", "neurons");
      const remaining = anchor
        ? Math.max(0, anchor.remaining - Math.max(0, local - anchor.atCount))
        : limit !== undefined
          ? Math.max(0, limit - local)
          : undefined;
      if (remaining !== undefined && remaining <= 0) {
        req.day = 0;
        resetInMs = Math.min(resetInMs ?? Infinity, msUntilWindowEnd("day", provider, now));
      }
    }

    return { source: bestSource, req, tok, resetInMs };
  }

  /** Remaining neurons, for status reporting. Always low confidence. */
  async neuronsRemaining(provider: ProviderConfig, now = new Date()): Promise<number | undefined> {
    const limit = provider.defaultLimits.default?.neuronsPerDay;
    if (limit === undefined) return undefined;
    const local = await this.count(provider, "*", "day", "neurons", now);
    return Math.max(0, limit - local);
  }

  /**
   * Reserve capacity BEFORE sending, else N parallel calls read the same
   * headroom and blow the limit together. Commit or roll back afterwards.
   */
  async reserve(
    provider: ProviderConfig,
    modelId: string,
    estTokens: number,
    now = new Date(),
  ): Promise<Reservation> {
    const keys: string[] = [];

    for (const kind of WINDOWS) {
      if (this.seedLimit(provider, modelId, kind, "req") !== undefined) {
        const k = this.counterKey(provider, modelId, kind, "req", now);
        await this.store.incr(k, 1, windowTtlMs(kind));
        keys.push(`req:${kind}:${k}`);
      }
      if (this.seedLimit(provider, modelId, kind, "tok") !== undefined) {
        const k = this.counterKey(provider, modelId, kind, "tok", now);
        await this.store.incr(k, estTokens, windowTtlMs(kind));
        keys.push(`tok:${kind}:${k}`);
      }
    }

    if (provider.defaultLimits.default?.neuronsPerDay !== undefined) {
      const k = this.counterKey(provider, modelId, "day", "neurons", now);
      await this.store.incr(k, estimateNeurons(modelId, estTokens), windowTtlMs("day"));
      keys.push(`neurons:day:${k}`);
    }

    return {
      provider: provider.id,
      modelId,
      scopeId: this.scopeId(provider),
      estTokens,
      keys,
      released: false,
    };
  }

  /** Reconcile the estimate against actual usage once the response is in. */
  async commit(res: Reservation, actualTokens?: number): Promise<void> {
    if (res.released) return;
    res.released = true;
    if (actualTokens === undefined || actualTokens === res.estTokens) return;

    const delta = actualTokens - res.estTokens;
    for (const entry of res.keys) {
      const [metric, kind, ...rest] = entry.split(":");
      const key = rest.join(":");
      if (metric === "tok") {
        await this.store.incr(key, delta, windowTtlMs(kind as WindowKind));
      }
    }
  }

  /**
   * Undo a reservation the provider never metered — network/timeout only.
   * A 429 or 400 DID consume their counter; rolling those back strands quota.
   */
  async rollback(res: Reservation): Promise<void> {
    if (res.released) return;
    res.released = true;
    for (const entry of res.keys) {
      const [metric, kind, ...rest] = entry.split(":");
      const key = rest.join(":");
      const by = metric === "req" ? -1 : metric === "tok" ? -res.estTokens : -1;
      await this.store.incr(key, by, windowTtlMs(kind as WindowKind));
    }
  }

  /** Record a disclosure as a new anchor. Called on success AND failure. */
  async ingest(
    provider: ProviderConfig,
    modelId: string,
    q: ReportedQuota,
    now = new Date(),
  ): Promise<void> {
    const write = async (
      kind: WindowKind,
      metric: Metric,
      remaining: number | undefined,
    ): Promise<void> => {
      if (remaining === undefined) return;
      const atCount = await this.count(provider, modelId, kind, metric, now);
      const anchor: QuotaAnchor = { remaining, atCount, ts: Date.now(), source: q.source };
      await this.store.set(
        this.anchorKey(provider, modelId, kind, metric),
        JSON.stringify(anchor),
        ANCHOR_TTL_MS[q.source],
      );
    };

    for (const kind of WINDOWS) {
      await write(kind, "req", q.reqRemaining?.[kind]);
      await write(kind, "tok", q.tokRemaining?.[kind]);
    }
  }

  /** Force a provider+model to zero for the rest of the given window. */
  async exhaust(
    provider: ProviderConfig,
    modelId: string,
    kind: WindowKind,
    now = new Date(),
  ): Promise<void> {
    const anchor: QuotaAnchor = {
      remaining: 0,
      atCount: await this.count(provider, modelId, kind, "req", now),
      ts: Date.now(),
      source: "mined",
    };
    await this.store.set(
      this.anchorKey(provider, modelId, kind, "req"),
      JSON.stringify(anchor),
      Math.min(msUntilWindowEnd(kind, provider, now), ANCHOR_TTL_MS.mined * 12),
    );
  }
}
