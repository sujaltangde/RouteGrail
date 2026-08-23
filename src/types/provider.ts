/** Provider registry shapes. */

export type Tier = "fast" | "balanced" | "strong";

export type QuotaSource = "headers" | "endpoint" | "opaque";

/** Header parsing dialects. Each provider spells rate-limit headers differently. */
export type HeaderDialect = "groq" | "sambanova" | "mistral" | "standard" | "none";

/** Whose budget the quota belongs to — two Groq keys share one org budget. */
export type Scope = "key" | "organization" | "project" | "account" | "user";

export type RateUnit = "rpm" | "rps";

/** How to reduce a catalog to models that cost nothing. */
export type FreeFilter =
  | { kind: "all" } // whole account is free-tier gated
  | { kind: "suffix"; suffix: string } // e.g. ":free"
  | { kind: "zero-price" } // pricing.prompt === "0"
  | { kind: "allowlist"; ids: string[] }; // only these IDs are free

export type Limits = {
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
};

export type ProviderAuth =
  | { type: "bearer" }
  | { type: "header"; header: string }
  | { type: "none" };

export type ProviderQuota = {
  source: QuotaSource;
  dialect: HeaderDialect;
  /** Absolute URL polled for live quota (OpenRouter). */
  endpoint?: string;
};

/** Hard per-request caps independent of the model's context window. */
export type PerRequestCaps = { maxInput?: number; maxOutput?: number };

export type ProviderConfig = {
  id: string;
  label: string;

  /** May contain `{accountId}`, substituted from credentials (Cloudflare). */
  baseUrl: string;

  /** Path appended to baseUrl for the model catalog. `null` = no catalog endpoint. */
  modelsPath: string | null;
  /** Absolute override when the catalog lives on a different host than inference. */
  modelsUrl?: string;

  auth: ProviderAuth;
  quota: ProviderQuota;

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
  perRequestCaps?: PerRequestCaps;

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
};

export type ProviderCredentials = {
  apiKey?: string;
  accountId?: string;
};
