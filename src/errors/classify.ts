import type { ErrorClass } from "../types/index.js";

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
 * Classify an HTTP failure into a routing action. The load-bearing branch is
 * CONTEXT_LENGTH_EXCEEDED: providers return oversized prompts as a 400, so a
 * naive "400 means stop" rule halts a loop that should try a bigger provider.
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
  // A malformed request would fail identically everywhere; don't spend quota.
  return cls !== "INVALID_REQUEST";
}

/** Should the request be re-counted against the provider's quota despite failing? */
export function consumesQuota(cls: ErrorClass): boolean {
  // 429s were counted by the provider; network/timeout never reached it.
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
