import { Discovery } from "./discovery.js";
import { AllProvidersFailedError, ConfigError, NoRouteError, classifyHttp, classifyThrown, cooldownMs, shouldCascade } from "./errors.js";
import { Executor } from "./executor.js";
import { FAMILIES } from "./families.js";
import { Ledger } from "./ledger.js";
import { REGISTRY } from "./registry/providers.js";
import { Selector, type ProviderRuntime, type Route } from "./selector.js";
import { MemoryStore } from "./store/memory.js";
import { estimateRequestTokens } from "./tokens.js";
import { OpenAITransport, type Credentials } from "./transport/openai.js";
import type {
  DiscoveredModel,
  GenerateRequest,
  GenerateResponse,
  ProviderConfig,
  ProviderStatus,
  RouterConfig,
  StateStore,
  StatusReport,
  StreamChunk,
  Tier,
} from "./types.js";
import { nowIso } from "./util.js";

const DEFAULTS = {
  mode: "development" as const,
  keylessFallback: false,
  allowPromptLogging: true,
  affinity: true,
  maxAttempts: 3,
  timeoutMs: 60_000,
  discoveryTtlMs: 24 * 60 * 60 * 1000,
};

/**
 * RouteGrail — a multi-provider router over permanently-free LLM tiers.
 *
 * Give it whatever API keys you have. It discovers which models each key can
 * actually reach, tracks how much free capacity remains across every provider,
 * and routes each request to a live one — falling back to the same model family
 * on a different provider rather than to a worse model.
 *
 * Positioning: free-tier quality with paid-tier-like uptime. Routing solves
 * availability, not capability.
 */
export class Router {
  private readonly registry: ProviderConfig[];
  private readonly store: StateStore;
  private readonly transport: OpenAITransport;
  private readonly ledger: Ledger;
  private readonly selector: Selector;
  private readonly discovery: Discovery;
  private readonly executor: Executor;

  private readonly credentials = new Map<string, Credentials>();
  private readonly runtime = new Map<string, ProviderRuntime>();
  private readonly models = new Map<string, DiscoveredModel[]>();
  private readonly scopeIds = new Map<string, string>();

  private readonly cfg: Required<
    Pick<
      RouterConfig,
      | "mode"
      | "keylessFallback"
      | "allowPromptLogging"
      | "affinity"
      | "maxAttempts"
      | "timeoutMs"
      | "discoveryTtlMs"
    >
  > & { region?: string };

  private readonly log: NonNullable<RouterConfig["logger"]>;
  private discoveryPromise?: Promise<void>;
  private activeProviders: ProviderConfig[] = [];

  constructor(config: RouterConfig = {}) {
    this.cfg = {
      mode: config.mode ?? DEFAULTS.mode,
      keylessFallback: config.keylessFallback ?? DEFAULTS.keylessFallback,
      allowPromptLogging: config.allowPromptLogging ?? DEFAULTS.allowPromptLogging,
      affinity: config.affinity ?? DEFAULTS.affinity,
      maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
      timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
      discoveryTtlMs: config.discoveryTtlMs ?? DEFAULTS.discoveryTtlMs,
      region: config.region,
    };

    this.log = config.logger ?? (() => {});
    this.registry = config.registry ?? REGISTRY;
    this.store = config.store ?? new MemoryStore();
    this.transport = new OpenAITransport(this.cfg.timeoutMs);
    this.ledger = new Ledger(this.store, this.scopeIds);
    this.selector = new Selector(this.ledger, this.store);
    this.discovery = new Discovery(this.transport, this.store, this.cfg.discoveryTtlMs);

    this.resolveCredentials(config.providers);

    this.executor = new Executor({
      transport: this.transport,
      ledger: this.ledger,
      store: this.store,
      credentials: this.credentials,
      runtime: this.runtime,
      onModelNotFound: async (id) => {
        await this.discovery.invalidate(id);
        this.models.delete(id);
      },
      onAffinity: (sessionId, family) => this.selector.setAffinity(sessionId, family),
      log: this.log,
    });

    if (this.activeProviders.length === 0) {
      throw new ConfigError(
        "No providers configured. Pass `providers: { groq: { apiKey } }`, set an env var " +
          "such as GROQ_API_KEY, or enable `keylessFallback: true` to run with no keys at all.",
      );
    }

    // Kick discovery off but never block the constructor on it.
    this.discoveryPromise = this.runDiscovery();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /**
   * Resolve credentials from explicit config, falling back to environment
   * variables. `new Router()` with zero config picks up whatever is present.
   */
  private resolveCredentials(explicit?: RouterConfig["providers"]): void {
    const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string>);

    for (const provider of this.registry) {
      const given = explicit?.[provider.id];
      let apiKey = given?.apiKey;
      let accountId = given?.accountId;

      if (!apiKey) {
        for (const name of provider.envKeys) {
          if (env[name]) {
            apiKey = env[name];
            break;
          }
        }
      }
      if (!accountId && provider.envAccountId) {
        accountId = env[provider.envAccountId];
      }

      const usable =
        provider.keyless || provider.auth.type === "none" ? true : Boolean(apiKey);

      // Cloudflare's base URL embeds the account ID; without it there is no
      // valid endpoint to call.
      if (provider.envAccountId && !accountId) {
        if (apiKey) {
          this.runtime.set(provider.id, {
            successes: 0,
            failures: 0,
            disabled: `missing account id (set ${provider.envAccountId})`,
          });
        }
        continue;
      }

      if (!usable) continue;
      if (provider.keyless && !this.cfg.keylessFallback && !apiKey) continue;

      this.credentials.set(provider.id, { apiKey, accountId });
      this.scopeIds.set(provider.id, this.deriveScopeId(provider, apiKey, accountId));
      this.activeProviders.push(provider);
    }
  }

  /**
   * Scope is not "API key".
   *
   * Groq bills per organization, Gemini per project, Cloudflare per account,
   * GitHub per user. Two keys on one Groq org share one budget, so the ledger
   * must key on the billing entity, not the credential. Without a way to see
   * the real org ID, a stable hash of the credential is the best available
   * proxy — it at least stops one key from being counted twice.
   */
  private deriveScopeId(
    provider: ProviderConfig,
    apiKey: string | undefined,
    accountId: string | undefined,
  ): string {
    if (accountId) return `${provider.scope}:${accountId}`;
    if (!apiKey) return `${provider.scope}:anon`;
    let hash = 0;
    for (let i = 0; i < apiKey.length; i++) {
      hash = (hash * 31 + apiKey.charCodeAt(i)) | 0;
    }
    return `${provider.scope}:${(hash >>> 0).toString(36)}`;
  }

  private async runDiscovery(): Promise<void> {
    await Promise.all(
      this.activeProviders.map(async (provider) => {
        const creds = this.credentials.get(provider.id) ?? {};
        try {
          const result = await this.discovery.discover(provider, creds);
          if (result.disabled) {
            this.runtime.set(provider.id, {
              successes: 0,
              failures: 0,
              disabled: result.disabled.reason,
            });
            this.log("warn", `provider disabled: ${provider.id}`, result.disabled);
            return;
          }
          this.models.set(provider.id, result.models);
          this.log("debug", `discovered ${result.models.length} models on ${provider.id}`);
        } catch (err) {
          this.log("warn", `discovery failed for ${provider.id}`, err);
          this.models.set(provider.id, []);
        }
      }),
    );
  }

  /** Await in-flight discovery. Safe to call repeatedly. */
  async ready(): Promise<void> {
    if (this.discoveryPromise) await this.discoveryPromise;
  }

  /** Force a fresh catalog fetch for every provider. */
  async refresh(): Promise<void> {
    await Promise.all(this.activeProviders.map((p) => this.discovery.invalidate(p.id)));
    this.models.clear();
    this.discoveryPromise = this.runDiscovery();
    await this.discoveryPromise;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Generate a completion, falling back across providers as needed. */
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (!request?.prompt) throw new ConfigError("`prompt` is required.");
    await this.ready();

    const { routes, skipped } = await this.selector.select({
      request,
      providers: this.activeProviders,
      models: this.models,
      runtime: this.runtime,
      config: {
        mode: this.cfg.mode,
        keylessFallback: this.cfg.keylessFallback,
        allowPromptLogging: this.cfg.allowPromptLogging,
        affinity: this.cfg.affinity,
      },
      region: this.cfg.region,
    });

    if (routes.length === 0) {
      throw new NoRouteError(
        skipped,
        this.explainNoRoute(skipped, request),
      );
    }

    const ordered = this.selector.order(routes, this.cfg.maxAttempts);
    return this.executor.run(request, ordered, skipped, this.cfg.maxAttempts);
  }

  /**
   * Stream a completion.
   *
   * Provider switching is only possible before the first chunk reaches the
   * caller, so the first chunk is buffered internally: a failure before any
   * output is emitted reroutes invisibly. Once output has started, errors
   * surface — splicing another model's continuation into a partial response
   * would produce text no single model ever wrote.
   */
  async *stream(request: GenerateRequest): AsyncGenerator<StreamChunk, void, void> {
    if (!request?.prompt) throw new ConfigError("`prompt` is required.");
    await this.ready();

    const { routes, skipped } = await this.selector.select({
      request,
      providers: this.activeProviders,
      models: this.models,
      runtime: this.runtime,
      config: {
        mode: this.cfg.mode,
        keylessFallback: this.cfg.keylessFallback,
        allowPromptLogging: this.cfg.allowPromptLogging,
        affinity: this.cfg.affinity,
      },
      region: this.cfg.region,
    });

    if (routes.length === 0) {
      throw new NoRouteError(skipped, this.explainNoRoute(skipped, request));
    }

    const ordered = this.selector.order(routes, this.cfg.maxAttempts);
    const trail: Array<{ provider: string; model: string; errorClass?: string; latencyMs: number }> = [];
    const estTokens = estimateRequestTokens(request.prompt, request.system);

    for (const route of ordered) {
      const { provider, model } = route;
      const creds = this.credentials.get(provider.id) ?? {};
      const started = Date.now();

      if (provider.maxConcurrent !== undefined) {
        const got = await this.store.acquire(`sem:${provider.id}`, provider.maxConcurrent);
        if (!got) {
          skipped.push({ provider: provider.id, model: model.id, reason: "concurrency_full" });
          continue;
        }
      }

      const reservation = await this.ledger.reserve(provider, model.id, estTokens);
      let emitted = false;

      try {
        const it = this.transport.stream(provider, creds, model.id, request);
        let buffered: string | undefined;

        while (true) {
          const next = await it.next();
          if (next.done) {
            const meta = next.value;
            if (buffered !== undefined && !emitted) {
              emitted = true;
              yield { text: buffered, provider: provider.id, model: model.id, family: model.family, done: false };
            }
            await this.ledger.commit(reservation, meta?.usage?.totalTokens);
            const rt = this.runtimeFor(provider.id);
            rt.successes += 1;
            rt.latencyMs = Date.now() - started;
            if (request.sessionId) await this.selector.setAffinity(request.sessionId, model.family);
            yield { text: "", provider: provider.id, model: model.id, family: model.family, done: true };
            return;
          }

          if (buffered === undefined) {
            // Hold the first chunk back so a failure that happens immediately
            // after it can still be rerouted without the caller seeing output.
            buffered = next.value;
            continue;
          }
          if (!emitted) {
            emitted = true;
            yield { text: buffered, provider: provider.id, model: model.id, family: model.family, done: false };
          }
          yield { text: next.value, provider: provider.id, model: model.id, family: model.family, done: false };
        }
      } catch (err) {
        const failure = (err as { failure?: { status: number; body: string; headers: Headers } }).failure;
        const cls = failure ? classifyHttp(failure.status, failure.body) : classifyThrown(err);

        if (failure) {
          await this.ledger.commit(reservation, undefined);
        } else {
          await this.ledger.rollback(reservation);
        }

        const rt = this.runtimeFor(provider.id);
        rt.failures += 1;
        if (cls === "AUTH") rt.disabled = "auth_failed";
        else {
          const ms = cooldownMs(cls);
          if (ms > 0) rt.cooldownUntil = Date.now() + ms;
        }

        trail.push({ provider: provider.id, model: model.id, errorClass: cls, latencyMs: Date.now() - started });

        // Output already reached the caller — do not splice in another model.
        if (emitted) throw err;
        if (!shouldCascade(cls)) throw err;
        continue;
      } finally {
        if (provider.maxConcurrent !== undefined) {
          await this.store.release(`sem:${provider.id}`);
        }
      }
    }

    throw new AllProvidersFailedError(trail as never, skipped);
  }

  /**
   * Snapshot of every provider's state and remaining capacity.
   *
   * Async because the state store may be Redis. Surfacing `source` and `reason`
   * is the point: it tells you which numbers are real measurements and which
   * are local estimates, and why anything is switched off.
   */
  async status(): Promise<StatusReport> {
    await this.ready();
    const providers: Record<string, ProviderStatus> = {};
    const now = new Date();

    for (const provider of this.activeProviders) {
      const rt = this.runtime.get(provider.id);
      const models = this.models.get(provider.id) ?? [];

      if (rt?.disabled) {
        providers[provider.id] = { state: "disabled", reason: rt.disabled, discovered: models.length };
        continue;
      }
      if (!provider.productionAllowed && this.cfg.mode === "production") {
        providers[provider.id] = {
          state: "disabled",
          reason: "productionAllowed=false, mode=production",
          discovered: models.length,
        };
        continue;
      }
      if (provider.keyless && !this.cfg.keylessFallback) {
        providers[provider.id] = {
          state: "disabled",
          reason: "keyless provider, keylessFallback=false",
          discovered: models.length,
        };
        continue;
      }

      const probe = models[0]?.id ?? "default";
      const hr = await this.ledger.headroom(provider, probe, now);
      const dry =
        Object.values(hr.req).some((v) => v <= 0) || Object.values(hr.tok).some((v) => v <= 0);

      const total = (rt?.successes ?? 0) + (rt?.failures ?? 0);
      providers[provider.id] = {
        state:
          rt?.cooldownUntil && rt.cooldownUntil > Date.now()
            ? "cooldown"
            : dry
              ? "exhausted"
              : models.length === 0
                ? "degraded"
                : "healthy",
        discovered: models.length,
        quota: {
          source: hr.source,
          remainingMinute: hr.req.min,
          remainingDay: hr.req.day,
          remainingMonth: hr.req.month,
          remainingTokensMinute: hr.tok.min,
          resetInMs: hr.resetInMs,
        },
        latencyMsEwma: rt?.latencyMs,
        successRate: total > 0 ? (rt!.successes / total) : undefined,
        reason:
          rt?.cooldownUntil && rt.cooldownUntil > Date.now()
            ? `cooldown ${Math.round((rt.cooldownUntil - Date.now()) / 1000)}s`
            : undefined,
      };
    }

    // Family view: how many providers can serve each family, and how many of
    // those are live right now. Six routes to one family is the redundancy
    // that makes the whole thing work.
    const families: StatusReport["families"] = {};
    for (const [providerId, models] of this.models) {
      const state = providers[providerId]?.state;
      for (const m of models) {
        const entry = (families[m.family] ??= { routes: 0, available: 0, tier: m.tier });
        entry.routes += 1;
        if (state === "healthy") entry.available += 1;
      }
    }

    return { providers, families, generatedAt: nowIso() };
  }

  /** Providers currently configured and eligible. */
  listProviders(): string[] {
    return this.activeProviders.map((p) => p.id);
  }

  /** Models discovered for a provider, or all of them. */
  listModels(providerId?: string): DiscoveredModel[] {
    if (providerId) return this.models.get(providerId) ?? [];
    return [...this.models.values()].flat();
  }

  /** Known families and their tiers. */
  listFamilies(): Array<{ id: string; tier: Tier }> {
    return FAMILIES.map((f) => ({ id: f.id, tier: f.tier }));
  }

  dispose(): void {
    if (this.store instanceof MemoryStore) this.store.dispose();
  }

  // -------------------------------------------------------------------------

  private runtimeFor(id: string): ProviderRuntime {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = { successes: 0, failures: 0 };
      this.runtime.set(id, rt);
    }
    return rt;
  }

  /** Turn a pile of skip reasons into one actionable sentence. */
  private explainNoRoute(
    skipped: Array<{ reason: string; provider: string; detail?: string }>,
    request: GenerateRequest,
  ): string {
    const counts = new Map<string, number>();
    for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);

    if (counts.get("no_headroom")) {
      return `every route is out of quota (${counts.get("no_headroom")} exhausted). ` +
        `Wait for the next window, add another provider key, or enable keylessFallback.`;
    }
    if (counts.get("tier_too_low") && request.tier) {
      return `no available model meets tier="${request.tier}". Lower the tier or add a provider that hosts stronger models.`;
    }
    if (counts.get("per_request_cap") || counts.get("context_too_small")) {
      return `the prompt is too large for every available route. Shorten it or add a provider with a bigger context window.`;
    }
    if (counts.get("prompt_logging_disallowed")) {
      return `all remaining providers may train on prompts and allowPromptLogging=false.`;
    }
    if (counts.get("production_disallowed")) {
      return `all remaining providers forbid production use and mode="production".`;
    }
    const reasons = [...counts.entries()].map(([r, n]) => `${r}×${n}`).join(", ");
    return `no provider was eligible (${reasons || "none configured"}).`;
  }
}
