import type { ProviderConfig, WindowKind } from "../types/index.js";

/** Format a Date as YYYY-MM-DD in an arbitrary IANA timezone. */
export function dateInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // en-CA yields YYYY-MM-DD
}

export function monthInTz(d: Date, tz: string): string {
  return dateInTz(d, tz).slice(0, 7); // YYYY-MM
}

/**
 * Window portion of a ledger key. Four kinds because the providers demand it —
 * Mistral meters per second and per month, and daily windows roll over in the
 * provider's own timezone (Gemini is midnight Pacific).
 */
export function windowKey(kind: WindowKind, provider: ProviderConfig, now = new Date()): string {
  switch (kind) {
    case "sec":
      return `s${Math.floor(now.getTime() / 1000)}`;
    case "min": {
      const iso = now.toISOString(); // 2026-08-19T12:34:56.789Z
      return `m${iso.slice(0, 16).replace(/[-:T]/g, "")}`;
    }
    case "day":
      return `d${dateInTz(now, provider.resetTz)}`;
    case "month":
      return `M${monthInTz(now, provider.resetTz)}`;
  }
}

/** How long a counter for this window needs to survive. */
export function windowTtlMs(kind: WindowKind): number {
  switch (kind) {
    case "sec":
      return 2_000;
    case "min":
      return 120_000;
    case "day":
      return 26 * 60 * 60 * 1000;
    case "month":
      return 32 * 24 * 60 * 60 * 1000;
  }
}

/** Milliseconds remaining in the current window. */
export function msUntilWindowEnd(
  kind: WindowKind,
  provider: ProviderConfig,
  now = new Date(),
): number {
  const t = now.getTime();
  switch (kind) {
    case "sec":
      return 1000 - (t % 1000);
    case "min":
      return 60_000 - (t % 60_000);
    case "day": {
      const today = dateInTz(now, provider.resetTz);
      // Walk forward in hours until the local date flips.
      for (let h = 1; h <= 48; h++) {
        const probe = new Date(t + h * 3_600_000);
        if (dateInTz(probe, provider.resetTz) !== today) {
          // Narrow to the minute.
          for (let m = 1; m <= 60; m++) {
            const fine = new Date(t + (h - 1) * 3_600_000 + m * 60_000);
            if (dateInTz(fine, provider.resetTz) !== today) {
              return (h - 1) * 3_600_000 + m * 60_000;
            }
          }
          return h * 3_600_000;
        }
      }
      return 24 * 3_600_000;
    }
    case "month": {
      const cur = monthInTz(now, provider.resetTz);
      for (let d = 1; d <= 32; d++) {
        const probe = new Date(t + d * 86_400_000);
        if (monthInTz(probe, provider.resetTz) !== cur) return d * 86_400_000;
      }
      return 30 * 86_400_000;
    }
  }
}

/**
 * Parse Groq-style duration strings: "2m59.56s", "7.66s", "1h2m3s".
 * Returns milliseconds.
 */
export function parseDuration(s: string): number | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  // Plain seconds count (Retry-After: 30)
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(parseFloat(trimmed) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    matched = true;
    const n = parseFloat(m[1]!);
    switch (m[2]) {
      case "ms":
        total += n;
        break;
      case "h":
        total += n * 3_600_000;
        break;
      case "m":
        total += n * 60_000;
        break;
      case "s":
        total += n * 1000;
        break;
    }
  }
  return matched ? Math.round(total) : undefined;
}

export function nowIso(): string {
  return new Date().toISOString();
}
