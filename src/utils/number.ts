export function toNum(v: string | null | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Exponentially weighted moving average. */
export function ewma(prev: number | undefined, next: number, alpha = 0.3): number {
  return prev === undefined ? next : alpha * next + (1 - alpha) * prev;
}
