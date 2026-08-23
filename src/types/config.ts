import type { ProviderConfig, ProviderCredentials } from "./provider.js";
import type { StateStore } from "./store.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (level: LogLevel, msg: string, meta?: unknown) => void;

export type RouterMode = "development" | "production";

export type RouterConfig = {
  providers?: Record<string, ProviderCredentials>;
  /** "production" filters out providers whose ToS forbids production use. */
  mode?: RouterMode;
  /** Enable keyless providers (LLM7, OVHcloud, Pollinations). Opt-in. */
  keylessFallback?: boolean;
  /** false filters providers that may train on prompts. */
  allowPromptLogging?: boolean;
  /** Keep a session on one family for output consistency. */
  affinity?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  /** User region, used to skip region-blocked providers up front. */
  region?: string;
  store?: StateStore;
  /** Replace or extend the bundled registry. */
  registry?: ProviderConfig[];
  discoveryTtlMs?: number;
  logger?: Logger;
};

/** RouterConfig after defaults have been applied. */
export type ResolvedRouterConfig = Required<
  Pick<
    RouterConfig,
    | "mode"
    | "keylessFallback"
    | "allowPromptLogging"
    | "affinity"
    | "maxAttempts"
    | "timeoutMs"
    | "discoveryTtlMs"
  >
> & { region?: string };

/** The subset of config the selector applies as hard filters. */
export type RoutingPolicy = Required<
  Pick<RouterConfig, "mode" | "keylessFallback" | "allowPromptLogging" | "affinity">
>;
