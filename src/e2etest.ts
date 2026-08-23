/**
 * End-to-end routing test against a mocked HTTP layer.
 * Proves failover, the 400 rule, streaming, and status() without touching a network.
 *
 * Run with:  npm run e2etest
 */
import { Router } from "./router.js";
import { MemoryStore } from "./store/memory.js";
import { AllProvidersFailedError } from "./errors.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, detail ?? "");
  }
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
function mockFetch(handler: Handler): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function catalog(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id, context_length: 131072 })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function completion(text: string, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json", ...headers } },
  );
}

function sse(chunks: string[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const KEYS = {
  groq: { apiKey: "test-groq" },
  sambanova: { apiKey: "test-samba" },
  nvidia: { apiKey: "test-nvidia" },
};

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  console.log("\n— happy path —");
  {
    mockFetch((url) => {
      if (url.includes("/models")) return catalog(["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]);
      return completion("hello from groq", {
        "x-ratelimit-remaining-requests": "998",
        "x-ratelimit-limit-requests": "1000",
      });
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { groq: KEYS.groq }, store });
    const res = await r.generate({ prompt: "hi" });
    check("returns text", res.text === "hello from groq", res.text);
    check("names the provider", res.provider === "groq");
    check("resolves a canonical family", res.family === "llama-3.3-70b" || res.family === "gpt-oss-120b", res.family);
    check("one attempt, no fallback", res.routing.attempts === 1 && res.routing.fallbackUsed === false);
    check("reports usage", res.usage?.totalTokens === 15);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— 429 on provider A cascades to provider B —");
  {
    // Which provider is tried FIRST is deliberately non-deterministic — the
    // selector spreads load by weighted random. So fail whichever one is
    // contacted first, and assert the cascade rather than a specific order.
    let inferenceCalls = 0;
    const contacted: string[] = [];
    mockFetch((url) => {
      if (url.includes("/models")) {
        return url.includes("groq")
          ? catalog(["llama-3.3-70b-versatile"])
          : catalog(["Meta-Llama-3.3-70B-Instruct"]);
      }
      inferenceCalls++;
      contacted.push(url.includes("groq") ? "groq" : "sambanova");
      if (inferenceCalls === 1) {
        return new Response("Rate limit reached. Limit 1000, Used 1000, Requested 1. Please try again in 5m0s", {
          status: 429,
          headers: { "retry-after": "300" },
        });
      }
      return completion("hello from the fallback");
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { groq: KEYS.groq, sambanova: KEYS.sambanova }, store });
    const res = await r.generate({ prompt: "hi" });
    check("recovered on the second provider", res.text === "hello from the fallback");
    check("recorded 2 attempts", res.routing.attempts === 2, res.routing.attempts);
    check("flagged fallbackUsed", res.routing.fallbackUsed === true);
    check("trail names the failure class", res.routing.trail[0]?.errorClass === "RATE_LIMITED", res.routing.trail);
    check("fell back to a DIFFERENT provider", contacted[0] !== contacted[1], contacted);
    check("exactly two inference calls", inferenceCalls === 2, inferenceCalls);

    const st = await r.status();
    const cooled = contacted[0]!;
    check("the 429'd provider is now in cooldown", st.providers[cooled]?.state === "cooldown", {
      cooled,
      state: st.providers[cooled],
    });
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— the 400 rule: a malformed request must NOT burn every quota —");
  {
    let inferenceCalls = 0;
    mockFetch((url) => {
      if (url.includes("/models")) return catalog(["llama-3.3-70b-versatile", "Meta-Llama-3.3-70B-Instruct"]);
      inferenceCalls++;
      return new Response(JSON.stringify({ error: { message: "unknown parameter: frequency_penaltyy" } }), {
        status: 400,
      });
    });
    const store = new MemoryStore(0);
    const r = new Router({
      providers: { groq: KEYS.groq, sambanova: KEYS.sambanova, nvidia: KEYS.nvidia },
      store,
    });
    let threw = false;
    try {
      await r.generate({ prompt: "hi" });
    } catch (e) {
      threw = true;
      check("throws AllProvidersFailedError", e instanceof AllProvidersFailedError);
      const err = e as AllProvidersFailedError;
      check("stopped after ONE attempt", err.trail.length === 1, err.trail);
      check("classified as INVALID_REQUEST", err.trail[0]?.errorClass === "INVALID_REQUEST");
    }
    check("did throw", threw);
    check("only one provider was contacted", inferenceCalls === 1, inferenceCalls);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— a context-length 400 DOES cascade —");
  {
    let calls = 0;
    mockFetch((url) => {
      if (url.includes("/models")) return catalog(["llama-3.3-70b-versatile", "Meta-Llama-3.3-70B-Instruct"]);
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }),
          { status: 400 },
        );
      }
      return completion("recovered on a bigger model");
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { groq: KEYS.groq, sambanova: KEYS.sambanova }, store });
    const res = await r.generate({ prompt: "hi" });
    check("recovered rather than halting", res.text === "recovered on a bigger model");
    check("classified as CONTEXT_LENGTH_EXCEEDED", res.routing.trail[0]?.errorClass === "CONTEXT_LENGTH_EXCEEDED");
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— 401 disables the provider for the session —");
  {
    mockFetch((url) => {
      if (url.includes("/models")) {
        if (url.includes("groq")) return new Response("invalid api key", { status: 401 });
        return catalog(["Meta-Llama-3.3-70B-Instruct"]);
      }
      return completion("from the healthy one");
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { groq: KEYS.groq, sambanova: KEYS.sambanova }, store });
    const res = await r.generate({ prompt: "hi" });
    check("routed around the bad key", res.provider === "sambanova");
    const st = await r.status();
    check("status marks it disabled", st.providers.groq?.state === "disabled", st.providers.groq);
    check("reason names auth, not a generic error", /auth/i.test(st.providers.groq?.reason ?? ""), st.providers.groq?.reason);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— region block is reported distinctly, not as auth failure —");
  {
    mockFetch((url) => {
      if (url.includes("/models")) {
        if (url.includes("generativelanguage")) {
          return new Response(
            JSON.stringify({ error: { message: "User location is not supported for the API use." } }),
            { status: 403 },
          );
        }
        return catalog(["llama-3.3-70b-versatile"]);
      }
      return completion("ok");
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { groq: KEYS.groq, gemini: { apiKey: "g" } }, store });
    await r.generate({ prompt: "hi" });
    const st = await r.status();
    check("gemini disabled", st.providers.gemini?.state === "disabled");
    check("reason says region, not auth", /region_blocked/.test(st.providers.gemini?.reason ?? ""), st.providers.gemini?.reason);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— region config skips Gemini before any request is spent —");
  {
    mockFetch((url) => (url.includes("/models") ? catalog(["llama-3.3-70b-versatile"]) : completion("ok")));
    const store = new MemoryStore(0);
    const r = new Router({ providers: { groq: KEYS.groq, gemini: { apiKey: "g" } }, store, region: "DE" });
    const res = await r.generate({ prompt: "hi" });
    const skippedGemini = res.routing.skipped.find((s) => s.provider === "gemini");
    check("gemini skipped up front", Boolean(skippedGemini), res.routing.skipped);
    check("skip reason explains why", /region_blocked/.test(skippedGemini?.detail ?? ""), skippedGemini);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— production mode filters ToS-restricted providers —");
  {
    mockFetch((url) => (url.includes("/models") ? catalog(["meta/llama-3.3-70b-instruct"]) : completion("ok")));
    const store = new MemoryStore(0);
    const r = new Router({ providers: { nvidia: KEYS.nvidia }, store, mode: "production" });
    let threw = false;
    try {
      await r.generate({ prompt: "hi" });
    } catch (e) {
      threw = true;
      check("explains the ToS reason", /production/i.test((e as Error).message), (e as Error).message);
    }
    check("refuses to route to a dev-only tier in production", threw);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— allowPromptLogging=false excludes training-on-prompts tiers —");
  {
    mockFetch((url) => (url.includes("/models") ? catalog(["mistral-small-latest"]) : completion("ok")));
    const store = new MemoryStore(0);
    const r = new Router({ providers: { mistral: { apiKey: "m" } }, store, allowPromptLogging: false });
    let threw = false;
    try {
      await r.generate({ prompt: "sensitive" });
    } catch (e) {
      threw = true;
      check("names prompt logging as the reason", /train|logging/i.test((e as Error).message), (e as Error).message);
    }
    check("excluded the provider", threw);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— GitHub Models per-request cap blocks oversized prompts —");
  {
    mockFetch((url) => {
      if (url.includes("catalog") || url.includes("/models")) return catalog(["openai/gpt-4o-mini"]);
      return completion("should not be reached");
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { githubmodels: { apiKey: "gh" } }, store });
    // ~40k tokens of prompt, far beyond the hard 8K input cap.
    const huge = "word ".repeat(40_000);
    let threw = false;
    try {
      await r.generate({ prompt: huge });
    } catch (e) {
      threw = true;
      check("explains it was a size problem", /too large|context/i.test((e as Error).message), (e as Error).message);
    }
    check("blocked before spending the request", threw);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— streaming —");
  {
    mockFetch((url) => {
      if (url.includes("/models")) return catalog(["llama-3.3-70b-versatile"]);
      return sse(["Hel", "lo ", "world"]);
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { groq: KEYS.groq }, store });
    let out = "";
    let sawDone = false;
    for await (const c of r.stream({ prompt: "hi" })) {
      out += c.text;
      if (c.done) sawDone = true;
    }
    check("reassembles the full stream", out === "Hello world", out);
    check("emits a terminal chunk", sawDone);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— streaming reroutes on a pre-first-token failure —");
  {
    let calls = 0;
    mockFetch((url) => {
      if (url.includes("/models")) return catalog(["llama-3.3-70b-versatile", "Meta-Llama-3.3-70B-Instruct"]);
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return sse(["recovered"]);
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { groq: KEYS.groq, sambanova: KEYS.sambanova }, store });
    let out = "";
    for await (const c of r.stream({ prompt: "hi" })) out += c.text;
    check("caller never saw the failure", out === "recovered", out);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— quota accounting across many calls —");
  {
    mockFetch((url) => (url.includes("/models") ? catalog(["Meta-Llama-3.3-70B-Instruct"]) : completion("ok")));
    const store = new MemoryStore(0);
    const r = new Router({ providers: { sambanova: KEYS.sambanova }, store });
    for (let i = 0; i < 5; i++) await r.generate({ prompt: "hi" });
    const st = await r.status();
    // SambaNova free tier is 20 RPD; five calls should leave fifteen.
    check("daily headroom decremented correctly", st.providers.sambanova?.quota?.remainingDay === 15, st.providers.sambanova?.quota);
    check("state still healthy", st.providers.sambanova?.state === "healthy");
    check("success rate tracked", st.providers.sambanova?.successRate === 1);
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— exhaustion is enforced, not just reported —");
  {
    let inferenceCalls = 0;
    mockFetch((url) => {
      if (url.includes("/models")) return catalog(["Meta-Llama-3.3-70B-Instruct"]);
      inferenceCalls++;
      return completion("ok");
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { sambanova: KEYS.sambanova }, store });
    for (let i = 0; i < 20; i++) await r.generate({ prompt: "hi" });
    check("spent exactly the daily allowance", inferenceCalls === 20, inferenceCalls);
    let threw = false;
    try {
      await r.generate({ prompt: "one too many" });
    } catch {
      threw = true;
    }
    check("21st call refused without contacting the provider", threw && inferenceCalls === 20, inferenceCalls);
    const st = await r.status();
    check("status reports exhausted", st.providers.sambanova?.state === "exhausted");
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— session affinity keeps follow-ups on one family —");
  {
    mockFetch((url) => {
      if (url.includes("/models")) {
        if (url.includes("groq")) return catalog(["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]);
        return catalog(["Meta-Llama-3.3-70B-Instruct", "gpt-oss-120b"]);
      }
      return completion("ok");
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { groq: KEYS.groq, sambanova: KEYS.sambanova }, store, affinity: true });
    const first = await r.generate({ prompt: "hi", sessionId: "s1" });
    const families = new Set<string>();
    for (let i = 0; i < 6; i++) {
      families.add((await r.generate({ prompt: "again", sessionId: "s1" })).family);
    }
    check("follow-ups stayed on the first family", families.size === 1 && families.has(first.family), {
      first: first.family,
      seen: [...families],
    });
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— headroom-weighted spreading actually spreads —");
  {
    mockFetch((url) => {
      if (url.includes("/models")) {
        if (url.includes("groq")) return catalog(["llama-3.3-70b-versatile"]);
        if (url.includes("nvidia")) return catalog(["meta/llama-3.3-70b-instruct"]);
        return catalog(["Meta-Llama-3.3-70B-Instruct"]);
      }
      return completion("ok");
    });
    const store = new MemoryStore(0);
    const r = new Router({
      providers: { groq: KEYS.groq, sambanova: KEYS.sambanova, nvidia: KEYS.nvidia },
      store,
      affinity: false,
    });
    const hits = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const res = await r.generate({ prompt: "hi" });
      hits.set(res.provider, (hits.get(res.provider) ?? 0) + 1);
    }
    check("used more than one provider", hits.size >= 2, Object.fromEntries(hits));
    check("no single provider took everything", Math.max(...hits.values()) < 30, Object.fromEntries(hits));
    r.dispose();
    store.dispose();
  }

  // -------------------------------------------------------------------------
  console.log("\n— OpenRouter free filter is applied end to end —");
  {
    mockFetch((url) => {
      if (url.includes("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "deepseek/deepseek-r1:free", pricing: { prompt: "0", completion: "0" }, context_length: 64000 },
              { id: "anthropic/claude-opus-4-5", pricing: { prompt: "0.000015", completion: "0.000075" }, context_length: 200000 },
              { id: "openai/gpt-5", pricing: { prompt: "0.00001", completion: "0.00003" }, context_length: 400000 },
            ],
          }),
          { status: 200 },
        );
      }
      return completion("ok");
    });
    const store = new MemoryStore(0);
    const r = new Router({ providers: { openrouter: { apiKey: "or" } }, store });
    await r.ready();
    const models = r.listModels("openrouter").map((m) => m.id);
    check("only the zero-price model was kept", models.length === 1 && models[0] === "deepseek/deepseek-r1:free", models);
    check("no paid model can ever be selected", !models.some((m) => m.includes("claude") || m.includes("gpt-5")));
    r.dispose();
    store.dispose();
  }

  restoreFetch();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  restoreFetch();
  console.error(e);
  process.exit(1);
});
