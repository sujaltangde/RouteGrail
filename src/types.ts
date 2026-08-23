/**
 * RouteGrail — core type definitions.
 */

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export type Tier = "fast" | "balanced" | "strong";

export type QuotaSource = "headers" | "endpoint" | "opaque";

/** Header parsing dialects. Each provider spells rate-limit headers differently. */
export type HeaderDialect = "groq" | "sambanova" | "mistral" | "standard" | "none";

/**
 * Whose budget the quota belongs to. Keying the ledger by API key
 * double-counts headroom that does not exist (two Groq keys share one org budget).
 */
export type Scope = "key" | "organization" | "project" | "account" | "user";

export type RateUnit = "rpm" | "rps";

/**
 * How to reduce a provider's catalog to only the models that cost nothing.
 * Without this the router will happily spend real credits on OpenRouter.
 */
export type FreeFilter =
  | { kind: "all" } // whole account is free-tier gated
  | { kind: "suffix"; suffix: string } // e.g. ":free"
  | { kind: "zero-price" } // pricing.prompt === "0"
  | { kind: "allowlist"; ids: string[] }; // only these IDs are free

export interface Limits {
  rpm?: number;
  rps?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
  /** Requests per calendar month (Cohere). */
  rpMonth?: number;
  /** Tokens per calendar month (Mistral). */
  tpMonth?: number;
  /** Cloudflare neurons per day. */
  neuronsPerDay?: number;
}

export interface ProviderConfig {
  id: string;
  label: string;

  /**
   * Base URL. May contain `{accountId}` which is substituted from credentials
   * (Cloudflare embeds the account in the path).
   */
  baseUrl: string;

  /** Path appended to baseUrl for the model catalog. `null` = no catalog endpoint. */
  modelsPath: string | null;
  /** Absolute override when the catalog lives on a different host than inference. */
  modelsUrl?: string;

  auth:
    | { type: "bearer" }
    | { type: "header"; header: string }
    | { type: "none" };

  quota: {
    source: QuotaSource;
    dialect: HeaderDialect;
    /** Absolute URL polled for live quota (OpenRouter). */
    endpoint?: string;
  };

  scope: Scope;
  /** Timezone the daily window rolls over in. Gemini resets midnight Pacific. */
  resetTz: "UTC" | "America/Los_Angeles";
  rateUnit: RateUnit;

  /** Concurrency-gated providers need a semaphore, not a counter. Z.ai = 1. */
  maxConcurrent?: number;

  /** false = ToS forbids production use (NVIDIA dev/eval, Cohere non-commercial). */
  productionAllowed: boolean;
  /** Free tier unavailable in these regions. Gemini: EU/UK/CH. */
  regionBlocked?: string[];
  /** No API key required at all. */
  keyless?: boolean;
  /** Provider may train on prompts. */
  logsPrompts?: boolean;
  /** Hard per-request caps independent of the model's context window. */
  perRequestCaps?: { maxInput?: number; maxOutput?: number };

  freeFilter: FreeFilter;

  /** Environment variables read when no explicit key is supplied. */
  envKeys: string[];
  /** Extra credential env var (Cloudflare account ID). */
  envAccountId?: string;

  /** Seed limits, overwritten by live data. Key `"default"` applies to all models. */
  defaultLimits: Record<string, Limits>;

  /** Used when the provider has no catalog endpoint. */
  staticModels?: string[];

  /** Extra headers required by the provider (e.g. OpenRouter attribution). */
  extraHeaders?: Record<string, string>;

  notes?: string;
}

// ---------------------------------------------------------------------------
// Model families
// ---------------------------------------------------------------------------

export interface Family {
  id: string;
  tier: Tier;
  patterns: RegExp[];
}

export interface DiscoveredModel {
  /** Provider-native model ID, used verbatim on the wire. */
  id: string;
  provider: string;
  family: string;
  tier: Tier;
  contextWindow?: number;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type WindowKind = "sec" | "min" | "day" | "month";
export type Metric = "req" | "tok" | "neurons";

export type LedgerSource = "reported" | "mined" | "estimated";

export interface Headroom {
  source: LedgerSource;
  req: Partial<Record<WindowKind, number>>;
  tok: Partial<Record<WindowKind, number>>;
  /** Milliseconds until the binding window resets, when known. */
  resetInMs?: number;
}

/** A parsed quota disclosure from response headers or a 429 body. */
export interface ReportedQuota {
  source: "reported" | "mined";
  reqRemaining?: Partial<Record<WindowKind, number>>;
  tokRemaining?: Partial<Record<WindowKind, number>>;
  reqLimit?: Partial<Record<WindowKind, number>>;
  tokLimit?: Partial<Record<WindowKind, number>>;
  resetInMs?: number;
  retryAfterMs?: number;
}

/** Returned by `ledger.reserve()`; must be committed or rolled back. */
export interface Reservation {
  provider: string;
  modelId: string;
  scopeId: string;
  estTokens: number;
  keys: string[];
  released: boolean;
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Minimum acceptable family tier. Errors rather than silently downgrading. */
  tier?: Tier;
  requires?: { json?: boolean; minContext?: number };
  /** Provider IDs or `provider:model` strings to skip. */
  exclude?: string[];
  /**
   * Groups related calls so affinity keeps them on one model family.
   * Without it, affinity is global and defeats headroom spreading.
   */
  sessionId?: string;
  signal?: AbortSignal;
}

export type SkipReason =
  | "disabled"
  | "cooldown"
  | "no_headroom"
  | "concurrency_full"
  | "context_too_small"
  | "per_request_cap"
  | "capability_missing"
  | "production_disallowed"
  | "keyless_not_enabled"
  | "prompt_logging_disallowed"
  | "excluded"
  | "tier_too_low"
  | "no_models";

export interface Skipped {
  provider: string;
  model?: string;
  reason: SkipReason;
  detail?: string;
}

export interface AttemptRecord {
  provider: string;
  model: string;
  errorClass?: string;
  status?: number;
  message?: string;
  latencyMs: number;
}

export interface GenerateResponse {
  text: string;
  provider: string;
  model: string;
  family: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs: number;
  routing: {
    attempts: number;
    fallbackUsed: boolean;
    skipped: Skipped[];
    trail: AttemptRecord[];
  };
}

export interface StreamChunk {
  text: string;
  provider: string;
  model: string;
  family: string;
  done: boolean;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface ProviderStatus {
  state: "healthy" | "degraded" | "exhausted" | "cooldown" | "disabled";
  reason?: string;
  discovered?: number;
  quota?: {
    source: LedgerSource;
    remainingMinute?: number;
    remainingDay?: number;
    remainingMonth?: number;
    remainingTokensMinute?: number;
    resetInMs?: number;
  };
  latencyMsEwma?: number;
  successRate?: number;
}

export interface StatusReport {
  providers: Record<string, ProviderStatus>;
  families: Record<string, { routes: number; available: number; tier: Tier }>;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProviderCredentials {
  apiKey?: string;
  accountId?: string;
}

export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  incr(key: string, by: number, ttlMs: number): Promise<number>;
  del(key: string): Promise<void>;
  acquire(key: string, max: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface RouterConfig {
  providers?: Record<string, ProviderCredentials>;
  /** "production" filters out providers whose ToS forbids production use. */
  mode?: "development" | "production";
  /** Enable keyless providers (LLM7, OVHcloud, Pollinations). Opt-in. */
  keylessFallback?: boolean;
  /** false filters providers that may train on prompts. */
  allowPromptLogging?: boolean;
  /** Keep a session on one family for output consistency. */
  affinity?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  /** User region, used to skip region-blocked providers up front. */
  region?: string;
  store?: StateStore;
  /** Replace or extend the bundled registry. */
  registry?: ProviderConfig[];
  discoveryTtlMs?: number;
  logger?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}
