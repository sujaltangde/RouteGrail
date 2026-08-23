import type { ProviderCredentials } from "./provider.js";
import type { TokenUsage } from "./request.js";

export type Credentials = ProviderCredentials;

export type ChatResult = {
  text: string;
  usage?: TokenUsage;
  headers: Headers;
  raw: unknown;
};

export type HttpFailure = {
  ok: false;
  status: number;
  body: string;
  headers: Headers;
};

/** Returned by the stream generator once the SSE feed closes. */
export type StreamMeta = {
  usage?: TokenUsage;
  headers: Headers;
};

export type CatalogEntry = {
  id: string;
  contextWindow?: number;
  /** Present on OpenRouter; used to prove a model costs nothing. */
  pricing?: { prompt?: string; completion?: string };
};
