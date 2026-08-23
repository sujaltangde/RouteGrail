export type WindowKind = "sec" | "min" | "day" | "month";

export type Metric = "req" | "tok" | "neurons";

export type LedgerSource = "reported" | "mined" | "estimated";

export type Headroom = {
  source: LedgerSource;
  req: Partial<Record<WindowKind, number>>;
  tok: Partial<Record<WindowKind, number>>;
  /** Milliseconds until the binding window resets, when known. */
  resetInMs?: number;
};

/** A parsed quota disclosure from response headers or a 429 body. */
export type ReportedQuota = {
  source: "reported" | "mined";
  reqRemaining?: Partial<Record<WindowKind, number>>;
  tokRemaining?: Partial<Record<WindowKind, number>>;
  reqLimit?: Partial<Record<WindowKind, number>>;
  tokLimit?: Partial<Record<WindowKind, number>>;
  resetInMs?: number;
  retryAfterMs?: number;
};

/** A provider disclosure pinned to the local counter value at that moment. */
export type QuotaAnchor = {
  /** Remaining budget the provider disclosed. */
  remaining: number;
  /** Local counter value at the moment of disclosure. */
  atCount: number;
  ts: number;
  source: "reported" | "mined";
};

/** Returned by `ledger.reserve()`; must be committed or rolled back. */
export type Reservation = {
  provider: string;
  modelId: string;
  scopeId: string;
  estTokens: number;
  keys: string[];
  released: boolean;
};
