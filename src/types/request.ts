import type { Tier } from "./provider.js";

export type GenerateRequest = {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Minimum acceptable family tier. Errors rather than silently downgrading. */
  tier?: Tier;
  requires?: { json?: boolean; minContext?: number };
  /** Provider IDs or `provider:model` strings to skip. */
  exclude?: string[];
  /** Groups related calls so affinity keeps them on one model family. */
  sessionId?: string;
  signal?: AbortSignal;
};

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

export type Skipped = {
  provider: string;
  model?: string;
  reason: SkipReason;
  detail?: string;
};

export type AttemptRecord = {
  provider: string;
  model: string;
  errorClass?: string;
  status?: number;
  message?: string;
  latencyMs: number;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/** How the response was reached: what was tried, what was skipped. */
export type RoutingTrace = {
  attempts: number;
  fallbackUsed: boolean;
  skipped: Skipped[];
  trail: AttemptRecord[];
};

export type GenerateResponse = {
  text: string;
  provider: string;
  model: string;
  family: string;
  usage?: TokenUsage;
  latencyMs: number;
  routing: RoutingTrace;
};

export type StreamChunk = {
  text: string;
  provider: string;
  model: string;
  family: string;
  done: boolean;
};
