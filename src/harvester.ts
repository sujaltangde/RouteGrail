import type { ProviderConfig, ReportedQuota } from "./types.js";
import { parseDuration, toNum } from "./util.js";

type HeaderBag = Headers | Record<string, string>;

function h(bag: HeaderBag, name: string): string | undefined {
  if (typeof (bag as Headers).get === "function") {
    return (bag as Headers).get(name) ?? undefined;
  }
  const rec = bag as Record<string, string>;
  const lower = name.toLowerCase();
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lower) return rec[k];
  }
  return undefined;
}

/**
 * Parse rate-limit headers into a quota snapshot.
 *
 * Header harvesting is free and always fresh: it rides along on responses the
 * router was already making. No probe request is ever needed.
 */
export function harvestHeaders(
  provider: ProviderConfig,
  headers: HeaderBag,
): ReportedQuota | undefined {
  const retryAfterMs = parseDuration(h(headers, "retry-after") ?? "");

  switch (provider.quota.dialect) {
    // -----------------------------------------------------------------------
    case "groq": {
      // Documented and counter-intuitive:
      //   x-ratelimit-*-requests  ALWAYS means requests per DAY
      //   x-ratelimit-*-tokens    ALWAYS means tokens per MINUTE
      // RPM is not exposed at all and must be counted locally.
      const reqRemaining = toNum(h(headers, "x-ratelimit-remaining-requests"));
      const reqLimit = toNum(h(headers, "x-ratelimit-limit-requests"));
      const tokRemaining = toNum(h(headers, "x-ratelimit-remaining-tokens"));
      const tokLimit = toNum(h(headers, "x-ratelimit-limit-tokens"));
      const resetReq = parseDuration(h(headers, "x-ratelimit-reset-requests") ?? "");
      const resetTok = parseDuration(h(headers, "x-ratelimit-reset-tokens") ?? "");
      if (
        reqRemaining === undefined &&
        tokRemaining === undefined &&
        retryAfterMs === undefined
      ) {
        return undefined;
      }
      return {
        source: "reported",
        reqRemaining: reqRemaining !== undefined ? { day: reqRemaining } : {},
        reqLimit: reqLimit !== undefined ? { day: reqLimit } : {},
        tokRemaining: tokRemaining !== undefined ? { min: tokRemaining } : {},
        tokLimit: tokLimit !== undefined ? { min: tokLimit } : {},
        resetInMs: resetTok ?? resetReq,
        retryAfterMs,
      };
    }

    // -----------------------------------------------------------------------
    case "sambanova": {
      // The only provider that exposes BOTH minute and day windows, which makes
      // it the best fixture for testing the ledger's window handling.
      const minRemaining = toNum(h(headers, "x-ratelimit-remaining-requests"));
      const minLimit = toNum(h(headers, "x-ratelimit-limit-requests"));
      const dayRemaining = toNum(h(headers, "x-ratelimit-remaining-requests-day"));
      const dayLimit = toNum(h(headers, "x-ratelimit-limit-requests-day"));
      const tokDayRemaining = toNum(h(headers, "x-ratelimit-remaining-tokens-day"));
      const reset = parseDuration(h(headers, "x-ratelimit-reset-requests") ?? "");
      if (minRemaining === undefined && dayRemaining === undefined && retryAfterMs === undefined) {
        return undefined;
      }
      const reqRemaining: ReportedQuota["reqRemaining"] = {};
      if (minRemaining !== undefined) reqRemaining.min = minRemaining;
      if (dayRemaining !== undefined) reqRemaining.day = dayRemaining;
      const reqLimit: ReportedQuota["reqLimit"] = {};
      if (minLimit !== undefined) reqLimit.min = minLimit;
      if (dayLimit !== undefined) reqLimit.day = dayLimit;
      return {
        source: "reported",
        reqRemaining,
        reqLimit,
        tokRemaining: tokDayRemaining !== undefined ? { day: tokDayRemaining } : {},
        resetInMs: reset,
        retryAfterMs,
      };
    }

    // -----------------------------------------------------------------------
    case "mistral": {
      const remaining = toNum(h(headers, "x-ratelimit-remaining"));
      const limit = toNum(h(headers, "x-ratelimit-limit"));
      const reset = parseDuration(h(headers, "x-ratelimit-reset") ?? "");
      const tokRemaining = toNum(h(headers, "x-ratelimit-remaining-tokens"));
      if (remaining === undefined && tokRemaining === undefined && retryAfterMs === undefined) {
        return undefined;
      }
      return {
        source: "reported",
        // Mistral meters per second.
        reqRemaining: remaining !== undefined ? { sec: remaining } : {},
        reqLimit: limit !== undefined ? { sec: limit } : {},
        tokRemaining: tokRemaining !== undefined ? { min: tokRemaining } : {},
        resetInMs: reset,
        retryAfterMs,
      };
    }

    // -----------------------------------------------------------------------
    case "standard": {
      const remaining = toNum(h(headers, "x-ratelimit-remaining-requests"));
      const limit = toNum(h(headers, "x-ratelimit-limit-requests"));
      if (remaining === undefined && retryAfterMs === undefined) return undefined;
      return {
        source: "reported",
        reqRemaining: remaining !== undefined ? { min: remaining } : {},
        reqLimit: limit !== undefined ? { min: limit } : {},
        retryAfterMs,
      };
    }

    default:
      return retryAfterMs !== undefined ? { source: "reported", retryAfterMs } : undefined;
  }
}

/**
 * Mine a 429 response body for real numbers.
 *
 * Groq embeds the truth in prose:
 *   "Rate limit reached for model X ... Limit 200000, Used 199336,
 *    Requested 1524. Please try again in 6m11.52s"
 *
 * For providers with no usable headers this is the only honest disclosure of
 * daily consumption they ever make.
 */
export function mine429(body: string): ReportedQuota | undefined {
  if (!body) return undefined;

  const limit = /limit[:\s]+(\d+)/i.exec(body)?.[1];
  const used = /used[:\s]+(\d+)/i.exec(body)?.[1];
  const requested = /requested[:\s]+(\d+)/i.exec(body)?.[1];
  const retry =
    /try again in ([\dhms.]+)/i.exec(body)?.[1] ??
    /retry after ([\dhms.]+)/i.exec(body)?.[1] ??
    /in ([\d.]+m[\d.]+s)/i.exec(body)?.[1];

  const retryAfterMs = retry ? parseDuration(retry) : undefined;
  if (!limit && !used && retryAfterMs === undefined) return undefined;

  const out: ReportedQuota = { source: "mined", retryAfterMs, resetInMs: retryAfterMs };

  if (limit && used) {
    const remaining = Math.max(0, Number(limit) - Number(used));
    // Heuristic: six-figure limits are token budgets, small ones are requests.
    const isTokens = Number(limit) > 50_000 || /token/i.test(body);
    if (isTokens) {
      out.tokRemaining = { min: remaining };
      out.tokLimit = { min: Number(limit) };
    } else {
      const daily = /per day|daily|RPD/i.test(body);
      out.reqRemaining = daily ? { day: remaining } : { min: remaining };
      out.reqLimit = daily ? { day: Number(limit) } : { min: Number(limit) };
    }
  }
  if (requested) {
    // Retained for diagnostics; the selector does not use it directly.
  }
  return out;
}
