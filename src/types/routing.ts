import type { Ledger } from "../quota/ledger.js";
import type { OpenAITransport } from "../transport/openai.js";
import type { Logger, RoutingPolicy } from "./config.js";
import type { DiscoveredModel } from "./model.js";
import type { ProviderConfig } from "./provider.js";
import type { GenerateRequest, Skipped } from "./request.js";
import type { StateStore } from "./store.js";
import type { Credentials } from "./transport.js";

export type Route = {
  provider: ProviderConfig;
  model: DiscoveredModel;
  score: number;
  headroomRatio: number;
};

/** Per-provider health accumulated over the process lifetime. */
export type ProviderRuntime = {
  disabled?: string;
  cooldownUntil?: number;
  latencyMs?: number;
  successes: number;
  failures: number;
};

export type SelectionInput = {
  request: GenerateRequest;
  providers: ProviderConfig[];
  models: Map<string, DiscoveredModel[]>;
  runtime: Map<string, ProviderRuntime>;
  config: RoutingPolicy;
  region?: string;
};

export type SelectionResult = {
  routes: Route[];
  skipped: Skipped[];
};

export type ExecutorDeps = {
  transport: OpenAITransport;
  ledger: Ledger;
  store: StateStore;
  credentials: Map<string, Credentials>;
  runtime: Map<string, ProviderRuntime>;
  onModelNotFound: (providerId: string) => Promise<void>;
  onAffinity: (sessionId: string, family: string) => Promise<void>;
  log: Logger;
};
