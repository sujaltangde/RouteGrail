import type { StateStore } from "../types.js";

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * Default single-process store.
 *
 * The StateStore seam exists so Lambda / Vercel / multi-container deploys can
 * swap in Redis. Without it, N instances each rediscover limits via 429s.
 * All methods are async from day one — retrofitting async selection after the
 * selector assumes sync reads is painful.
 */
export class MemoryStore implements StateStore {
  private data = new Map<string, Entry>();
  private semaphores = new Map<string, number>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(sweepIntervalMs = 60_000) {
    if (sweepIntervalMs > 0) {
      this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
      // Do not hold the event loop open in short-lived scripts.
      this.sweeper.unref?.();
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.data) {
      if (v.expiresAt <= now) this.data.delete(k);
    }
  }

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async incr(key: string, by: number, ttlMs: number): Promise<number> {
    const cur = this.live(key);
    const next = (cur ? Number(cur.value) : 0) + by;
    // Preserve the original expiry so a counter's window does not slide forward
    // every time it is touched.
    const expiresAt = cur ? cur.expiresAt : Date.now() + ttlMs;
    this.data.set(key, { value: String(next), expiresAt });
    return next;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async acquire(key: string, max: number): Promise<boolean> {
    const held = this.semaphores.get(key) ?? 0;
    if (held >= max) return false;
    this.semaphores.set(key, held + 1);
    return true;
  }

  async release(key: string): Promise<void> {
    const held = this.semaphores.get(key) ?? 0;
    this.semaphores.set(key, Math.max(0, held - 1));
  }

  /** Stop the background sweeper. Call when tearing down long-lived processes. */
  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.data.clear();
    this.semaphores.clear();
  }
}
