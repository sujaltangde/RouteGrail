/** Pluggable state backend. Async from day one so Redis can drop in. */
export type StateStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  incr(key: string, by: number, ttlMs: number): Promise<number>;
  del(key: string): Promise<void>;
  acquire(key: string, max: number): Promise<boolean>;
  release(key: string): Promise<void>;
};
