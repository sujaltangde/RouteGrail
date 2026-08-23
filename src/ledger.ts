import type {
  Headroom,
  LedgerSource,
  Limits,
  Metric,
  ProviderConfig,
  ReportedQuota,
  Reservation,
  StateStore,
  WindowKind,
} from "./types.js";
import { msUntilWindowEnd, windowKey, windowTtlMs } from "./util.js";

/** How long a reported/mined anchor is trusted before falling back to estimates. */
const ANCHOR_TTL_MS: Record<"reported" | "mined", number> = {
  reported: 120_000,
  mined: 300_000,
};

interface Anchor {
  /** Remaining budget the provider disclosed. */
  remaining: number;
  /** Local counter value at the moment of disclosure. */
  atCount: number;
  ts: number;
  source: "reported" | "mined";
}

const WINDOWS: WindowKind[] = ["sec", "min", "day", "month"];

/**
 * The quota ledger.
 *
 * Provider abstraction is commodity. Knowing how much free capacity remains
 * across providers you personally own — before spending a request to find out —
 * is the product. This class is that.
 *
 * Three sources, ranked:
 *   reported  ← response headers, or a quota endpoint   (trust: high)
 *   mined     ← parsed out of a 429 body                (trust: high)
 *   estimated ← local counter vs seed limits            (trust: low, always available)
 *
 * The sources COMPOSE rather than replace each other. A reported value is an
 * anchor: `remaining` at a known local count. Live headroom is then
 * `anchor.remaining - (currentLocalCount - anchor.atCount)`. When the anchor
 * ages out, the ledger falls back to pure local counting against seed limits.
 * This is why local counting is the floor and reported values are the upgrade,
 * never the reverse — the ledger must work with zero published data.
 */
export class Ledger {
  constructor(
    private readonly store: StateStore,
    private readonly scopeIds: Map<string, string>,
  ) {}

  private scopeId(provider: ProviderConfig): string {
    // Scope is NOT "API key". Groq bills per organization, Gemini per project,
    // Cloudflare per account, GitHub per user. Keying by key double-counts
    // headroom that does not exist.
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

  /**
   * Some limits are per-model, some are account-wide. Groq's RPD is per-model;
   * Cohere's monthly cap and Cloudflare's neuron pool are shared across all of
   * them. Getting this wrong either over- or under-counts by the model count.
   */
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
  ): Promise<Anchor | undefined> {
    const raw = await this.store.get(this.anchorKey(provider, modelId, kind, metric));
    if (!raw) return undefined;
    try {
      const a = JSON.parse(raw) as Anchor;
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
   * Current headroom across every window the provider meters.
   *
   * A window is only reported when a limit is known for it. An absent entry
   * means "unknown or unlimited", which the selector treats as passable — the
   * alternative would drop NVIDIA (no daily cap) entirely.
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
          // Anchor + delta: trust the provider's disclosed number, then subtract
          // everything counted locally since it was disclosed.
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

    // Cloudflare is neuron-denominated. Surface it on the request axis so the
    // selector can gate on it without pretending neurons are requests.
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
   * Reserve capacity BEFORE sending.
   *
   * Without a pre-send reservation, N parallel calls all read the same headroom
   * and blow through the limit together. The reservation is committed with the
   * real token count on success, or rolled back if the request never reached
   * the provider's meter.
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
      const { estimateNeurons } = await import("./tokens.js");
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
   * Undo a reservation for a request that never reached the provider's meter.
   *
   * Only network and timeout failures qualify. A 429 or a 400 DID consume the
   * provider's counter, and rolling those back would strand quota by making the
   * ledger believe capacity exists that the provider has already spent.
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

  /**
   * Record a provider's own disclosure as a new anchor.
   *
   * Called on every response, success AND failure — the headers are equally
   * truthful either way, and harvesting them costs nothing.
   */
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
      const anchor: Anchor = { remaining, atCount, ts: Date.now(), source: q.source };
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
    const anchor: Anchor = {
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
