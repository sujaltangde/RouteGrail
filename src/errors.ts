import type { AttemptRecord, Skipped } from "./types.js";

export type ErrorClass =
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "AUTH"
  | "REGION_BLOCKED"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "INVALID_REQUEST"
  | "MODEL_NOT_FOUND"
  | "SERVER"
  | "TIMEOUT"
  | "NETWORK"
  | "UNKNOWN";

export class RouteGrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteGrailError";
  }
}

export class ProviderError extends RouteGrailError {
  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly errorClass: ErrorClass,
    public readonly status: number | undefined,
    message: string,
    public readonly retryAfterMs?: number,
    public readonly body?: string,
  ) {
    super(`[${provider}/${model}] ${errorClass}: ${message}`);
    this.name = "ProviderError";
  }
}

export class AllProvidersFailedError extends RouteGrailError {
  constructor(
    public readonly trail: AttemptRecord[],
    public readonly skipped: Skipped[],
  ) {
    const attempted = trail.length
      ? trail.map((a) => `${a.provider}/${a.model} → ${a.errorClass ?? "?"}`).join("; ")
      : "no provider was eligible";
    super(
      `All providers failed. Attempted: ${attempted}. ` +
        `Skipped ${skipped.length} route(s). Inspect .trail and .skipped for detail.`,
    );
    this.name = "AllProvidersFailedError";
  }
}

export class NoRouteError extends RouteGrailError {
  constructor(public readonly skipped: Skipped[], detail: string) {
    super(`No eligible route: ${detail}`);
    this.name = "NoRouteError";
  }
}

export class ConfigError extends RouteGrailError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const CONTEXT_PATTERNS = [
  /context[_ -]?length/i,
  /maximum context/i,
  /too many tokens/i,
  /reduce the length/i,
  /input is too long/i,
  /prompt is too long/i,
  /exceeds? the (maximum|model)/i,
  /string too long/i,
  /max_tokens.*(greater|exceed)/i,
  /tokens?_limit_reached/i,
];

const REGION_PATTERNS = [
  /location is not supported/i,
  /user location/i,
  /not available in your (country|region)/i,
  /country[,_ ]?region[,_ ]?territory not supported/i,
  /FAILED_PRECONDITION/,
];

const QUOTA_PATTERNS = [
  /quota exceeded/i,
  /insufficient (credit|balance|quota)/i,
  /monthly limit/i,
  /out of credits/i,
  /trial key.*limit/i,
  /neurons/i,
];

/**
 * Classify an HTTP failure into a routing action.
 *
 * The important branch is CONTEXT_LENGTH_EXCEEDED. Providers return oversized
 * prompts as a 400, and a naive "400 means stop" rule would halt the loop when
 * the correct action is to try a provider with a larger cap.
 */
export function classifyHttp(status: number, body: string): ErrorClass {
  const matches = (pats: RegExp[]) => pats.some((p) => p.test(body));

  if (status === 429) {
    // A 429 that names a daily or monthly cap is exhaustion, not pacing.
    if (/per day|daily|RPD|per month|monthly/i.test(body)) return "QUOTA_EXHAUSTED";
    return "RATE_LIMITED";
  }
  if (status === 402) return "QUOTA_EXHAUSTED";

  if (status === 401) return "AUTH";
  if (status === 403) {
    if (matches(REGION_PATTERNS)) return "REGION_BLOCKED";
    if (matches(QUOTA_PATTERNS)) return "QUOTA_EXHAUSTED";
    return "AUTH";
  }

  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 413) return "CONTEXT_LENGTH_EXCEEDED";

  if (status === 400 || status === 422) {
    if (matches(CONTEXT_PATTERNS)) return "CONTEXT_LENGTH_EXCEEDED";
    if (matches(REGION_PATTERNS)) return "REGION_BLOCKED";
    if (matches(QUOTA_PATTERNS)) return "QUOTA_EXHAUSTED";
    // Model IDs rotate; a stale ID often comes back as 400, not 404.
    if (/model.*(not found|does not exist|invalid|unknown)/i.test(body)) return "MODEL_NOT_FOUND";
    return "INVALID_REQUEST";
  }

  if (status >= 500) return "SERVER";
  return "UNKNOWN";
}

export function classifyThrown(err: unknown): ErrorClass {
  const e = err as { name?: string; message?: string; code?: string };
  const name = e?.name ?? "";
  const msg = e?.message ?? "";
  const code = e?.code ?? "";
  if (name === "AbortError" || /abort/i.test(msg)) return "TIMEOUT";
  if (/timeout|ETIMEDOUT/i.test(msg) || code === "ETIMEDOUT") return "TIMEOUT";
  if (/ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|network/i.test(msg + code)) {
    return "NETWORK";
  }
  return "UNKNOWN";
}

/** Should the executor try the next route, or stop the whole loop? */
export function shouldCascade(cls: ErrorClass): boolean {
  // INVALID_REQUEST means the caller's request is malformed. Cascading it
  // through a dozen providers burns a dozen quotas to produce the same error.
  return cls !== "INVALID_REQUEST";
}

/** Should the request be re-counted against the provider's quota despite failing? */
export function consumesQuota(cls: ErrorClass): boolean {
  // Rate-limited and quota errors mean the provider *did* count the attempt.
  // Network and timeout failures never reached the provider's meter.
  switch (cls) {
    case "NETWORK":
    case "TIMEOUT":
      return false;
    default:
      return true;
  }
}

/** How long to cool a provider down after this error class. */
export function cooldownMs(cls: ErrorClass, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 24 * 60 * 60 * 1000);
  switch (cls) {
    case "RATE_LIMITED":
      return 60_000;
    case "QUOTA_EXHAUSTED":
      return 60 * 60 * 1000;
    case "SERVER":
      return 30_000;
    case "TIMEOUT":
    case "NETWORK":
      return 15_000;
    case "MODEL_NOT_FOUND":
      return 0;
    default:
      return 0;
  }
}
