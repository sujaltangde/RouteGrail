import type { GenerateRequest, ProviderConfig } from "../types.js";
import { joinUrl, renderBaseUrl } from "../util.js";

export interface Credentials {
  apiKey?: string;
  accountId?: string;
}

export interface ChatResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  headers: Headers;
  raw: unknown;
}

export interface HttpFailure {
  ok: false;
  status: number;
  body: string;
  headers: Headers;
}

export interface CatalogEntry {
  id: string;
  contextWindow?: number;
  /** Present on OpenRouter; used to prove a model costs nothing. */
  pricing?: { prompt?: string; completion?: string };
}

/**
 * Every provider in the registry speaks the OpenAI chat-completions shape —
 * including Cloudflare Workers AI (via /accounts/{id}/ai/v1) and Cohere
 * (via its Compatibility API). One transport covers all of them.
 */
export class OpenAITransport {
  constructor(private readonly timeoutMs: number) {}

  baseUrl(provider: ProviderConfig, creds: Credentials): string {
    return renderBaseUrl(provider.baseUrl, { accountId: creds.accountId });
  }

  headers(provider: ProviderConfig, creds: Credentials): Record<string, string> {
    const out: Record<string, string> = {
      "Content-Type": "application/json",
      ...(provider.extraHeaders ?? {}),
    };
    if (provider.auth.type === "bearer") {
      // Keyless providers that still want an Authorization header accept a
      // placeholder token (LLM7 documents the literal string "unused").
      const token = creds.apiKey ?? (provider.keyless ? "unused" : undefined);
      if (token) out.Authorization = `Bearer ${token}`;
    } else if (provider.auth.type === "header") {
      if (creds.apiKey) out[provider.auth.header] = creds.apiKey;
    }
    return out;
  }

  private buildBody(
    modelId: string,
    req: GenerateRequest,
    provider: ProviderConfig,
    stream: boolean,
  ): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

    // Respect hard per-request output caps (GitHub Models: 4K out) even when
    // the caller asked for more.
    let maxTokens = req.maxTokens;
    const cap = provider.perRequestCaps?.maxOutput;
    if (cap !== undefined) maxTokens = Math.min(maxTokens ?? cap, cap);

    const body: Record<string, unknown> = { model: modelId, messages };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (req.requires?.json) body.response_format = { type: "json_object" };
    if (stream) body.stream = true;
    return body;
  }

  private signal(external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const onAbort = () => ctrl.abort();
    external?.addEventListener("abort", onAbort, { once: true });
    return {
      signal: ctrl.signal,
      cancel: () => {
        clearTimeout(timer);
        external?.removeEventListener("abort", onAbort);
      },
    };
  }

  async chat(
    provider: ProviderConfig,
    creds: Credentials,
    modelId: string,
    req: GenerateRequest,
  ): Promise<ChatResult | HttpFailure> {
    const url = joinUrl(this.baseUrl(provider, creds), "/chat/completions");
    const { signal, cancel } = this.signal(req.signal);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.headers(provider, creds),
        body: JSON.stringify(this.buildBody(modelId, req, provider, false)),
        signal,
      });

      if (!res.ok) {
        return { ok: false, status: res.status, body: await res.text(), headers: res.headers };
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      return {
        text,
        usage: json.usage
          ? {
              inputTokens: json.usage.prompt_tokens,
              outputTokens: json.usage.completion_tokens,
              totalTokens: json.usage.total_tokens,
            }
          : undefined,
        headers: res.headers,
        raw: json,
      };
    } finally {
      cancel();
    }
  }

  /**
   * Stream chat completions as SSE.
   *
   * Yields text deltas. The caller is responsible for buffering the first chunk
   * so a pre-first-token failure can still be rerouted invisibly.
   */
  async *stream(
    provider: ProviderConfig,
    creds: Credentials,
    modelId: string,
    req: GenerateRequest,
  ): AsyncGenerator<string, { usage?: ChatResult["usage"]; headers: Headers }, void> {
    const url = joinUrl(this.baseUrl(provider, creds), "/chat/completions");
    const { signal, cancel } = this.signal(req.signal);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.headers(provider, creds),
        body: JSON.stringify(this.buildBody(modelId, req, provider, true)),
        signal,
      });

      if (!res.ok || !res.body) {
        const failure: HttpFailure = {
          ok: false,
          status: res.status,
          body: res.body ? await res.text() : "empty stream body",
          headers: res.headers,
        };
        throw Object.assign(new Error("stream_http_failure"), { failure });
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage: ChatResult["usage"];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            if (evt.usage) {
              usage = {
                inputTokens: evt.usage.prompt_tokens,
                outputTokens: evt.usage.completion_tokens,
                totalTokens: evt.usage.total_tokens,
              };
            }
            const delta = evt.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Partial or non-JSON keepalive frame; skip it.
          }
        }
      }

      return { usage, headers: res.headers };
    } finally {
      cancel();
    }
  }

  /** Fetch the provider's model catalog. */
  async catalog(
    provider: ProviderConfig,
    creds: Credentials,
  ): Promise<CatalogEntry[] | HttpFailure> {
    const url =
      provider.modelsUrl ??
      (provider.modelsPath ? joinUrl(this.baseUrl(provider, creds), provider.modelsPath) : null);
    if (!url) return [];

    const { signal, cancel } = this.signal();
    try {
      const res = await fetch(url, { headers: this.headers(provider, creds), signal });
      if (!res.ok) {
        return { ok: false, status: res.status, body: await res.text(), headers: res.headers };
      }
      const json = (await res.json()) as unknown;

      // OpenAI shape: { data: [...] }. GitHub's catalog returns a bare array.
      const rows: unknown[] = Array.isArray(json)
        ? json
        : ((json as { data?: unknown[] }).data ?? []);

      const out: CatalogEntry[] = [];
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const id = (row.id ?? row.name ?? row.model) as string | undefined;
        if (!id) continue;
        const ctx = (row.context_length ??
          row.context_window ??
          (row.limits as Record<string, unknown> | undefined)?.max_input_tokens) as unknown;
        const entry: CatalogEntry = { id };
        if (typeof ctx === "number") entry.contextWindow = ctx;
        if (row.pricing) entry.pricing = row.pricing as CatalogEntry["pricing"];
        out.push(entry);
      }
      return out;
    } finally {
      cancel();
    }
  }
}

export function isFailure(x: unknown): x is HttpFailure {
  return typeof x === "object" && x !== null && (x as HttpFailure).ok === false;
}
