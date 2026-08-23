/**
 * Offline self-test. No network, no keys. Run with:  npm run selftest
 *
 * Covers the branches that are easy to get wrong and expensive to get wrong:
 * Groq's inverted header naming, anchor+delta reconciliation, reservation
 * rollback, the free-model filter, and the 400-vs-context-length split.
 */
import { classifyHttp, consumesQuota, shouldCascade } from "./errors.js";
import { resolveFamily } from "./families.js";
import { harvestHeaders, mine429 } from "./harvester.js";
import { Ledger } from "./ledger.js";
import { filterFree } from "./discovery.js";
import { REGISTRY, registryById } from "./registry/providers.js";
import { MemoryStore } from "./store/memory.js";
import { parseDuration, windowKey } from "./util.js";

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

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const byId = registryById();
const groq = byId.get("groq")!;
const samba = byId.get("sambanova")!;
const mistral = byId.get("mistral")!;
const openrouter = byId.get("openrouter")!;
const gemini = byId.get("gemini")!;

async function main(): Promise<void> {
  console.log("\n— duration parsing —");
  eq("2m59.56s", parseDuration("2m59.56s"), 179560);
  eq("7.66s", parseDuration("7.66s"), 7660);
  eq("bare seconds", parseDuration("30"), 30000);
  eq("1h2m3s", parseDuration("1h2m3s"), 3723000);

  console.log("\n— Groq header dialect (naming is INVERTED) —");
  {
    const q = harvestHeaders(groq, {
      "x-ratelimit-limit-requests": "14400",
      "x-ratelimit-remaining-requests": "14370",
      "x-ratelimit-limit-tokens": "18000",
      "x-ratelimit-remaining-tokens": "17997",
      "x-ratelimit-reset-requests": "2m59.56s",
      "x-ratelimit-reset-tokens": "7.66s",
    })!;
    // limit-requests is RPD, not RPM. limit-tokens is TPM, not TPD.
    eq("requests land on the DAY window", q.reqRemaining?.day, 14370);
    check("requests do NOT land on minute", q.reqRemaining?.min === undefined);
    eq("tokens land on the MINUTE window", q.tokRemaining?.min, 17997);
    check("tokens do NOT land on day", q.tokRemaining?.day === undefined);
  }

  console.log("\n— SambaNova dual-window headers —");
  {
    const q = harvestHeaders(samba, {
      "x-ratelimit-remaining-requests": "17",
      "x-ratelimit-limit-requests": "20",
      "x-ratelimit-remaining-requests-day": "6",
      "x-ratelimit-limit-requests-day": "20",
    })!;
    eq("minute window", q.reqRemaining?.min, 17);
    eq("day window", q.reqRemaining?.day, 6);
  }

  console.log("\n— Mistral is per-SECOND —");
  {
    const q = harvestHeaders(mistral, { "x-ratelimit-remaining": "1" })!;
    eq("lands on sec window", q.reqRemaining?.sec, 1);
    check("registry marks rateUnit=rps", mistral.rateUnit === "rps");
  }

  console.log("\n— 429 body mining —");
  {
    const body =
      "Rate limit reached for model `llama-3.1-8b-instant` in organization org_x " +
      "on tokens per minute (TPM): Limit 200000, Used 199336, Requested 1524. " +
      "Please try again in 6m11.52s.";
    const q = mine429(body)!;
    eq("mines remaining tokens", q.tokRemaining?.min, 664);
    eq("mines retry-after", q.retryAfterMs, 371520);
    eq("source is mined", q.source, "mined");
  }

  console.log("\n— error taxonomy —");
  eq("429 → RATE_LIMITED", classifyHttp(429, "too many requests"), "RATE_LIMITED");
  eq("429 naming a daily cap → QUOTA_EXHAUSTED", classifyHttp(429, "exceeded requests per day"), "QUOTA_EXHAUSTED");
  eq("401 → AUTH", classifyHttp(401, "invalid key"), "AUTH");
  eq("400 → INVALID_REQUEST", classifyHttp(400, "unknown parameter foo"), "INVALID_REQUEST");
  eq(
    "400 about length → CONTEXT_LENGTH_EXCEEDED (must NOT halt the loop)",
    classifyHttp(400, "This model's maximum context length is 8192 tokens"),
    "CONTEXT_LENGTH_EXCEEDED",
  );
  eq("403 region → REGION_BLOCKED", classifyHttp(403, "User location is not supported for the API use"), "REGION_BLOCKED");
  eq("413 → CONTEXT_LENGTH_EXCEEDED", classifyHttp(413, ""), "CONTEXT_LENGTH_EXCEEDED");
  eq("500 → SERVER", classifyHttp(503, "upstream"), "SERVER");

  check("INVALID_REQUEST stops the cascade", shouldCascade("INVALID_REQUEST") === false);
  check("CONTEXT_LENGTH_EXCEEDED cascades", shouldCascade("CONTEXT_LENGTH_EXCEEDED") === true);
  check("RATE_LIMITED cascades", shouldCascade("RATE_LIMITED") === true);
  check("429 consumed provider quota", consumesQuota("RATE_LIMITED") === true);
  check("network error did NOT consume quota", consumesQuota("NETWORK") === false);

  console.log("\n— free-model filter (this is what stops the router spending money) —");
  {
    const catalog = [
      { id: "meta-llama/llama-3.3-70b-instruct:free", pricing: { prompt: "0", completion: "0" } },
      { id: "anthropic/claude-opus-4-5", pricing: { prompt: "0.000015", completion: "0.000075" } },
      { id: "openai/gpt-5", pricing: { prompt: "0.00001", completion: "0.00003" } },
      { id: "deepseek/deepseek-r1:free", pricing: { prompt: "0", completion: "0" } },
    ];
    const free = filterFree(openrouter, catalog);
    eq("only the free two survive", free.map((m) => m.id), [
      "meta-llama/llama-3.3-70b-instruct:free",
      "deepseek/deepseek-r1:free",
    ]);
  }
  {
    const sf = byId.get("siliconflow")!;
    const free = filterFree(sf, [{ id: "Qwen/Qwen3-8B" }, { id: "Pro/deepseek-ai/DeepSeek-V3" }]);
    eq("allowlist filter", free.map((m) => m.id), ["Qwen/Qwen3-8B"]);
  }

  console.log("\n— family resolution —");
  eq("groq gpt-oss", resolveFamily("openai/gpt-oss-120b").family, "gpt-oss-120b");
  eq("cloudflare gpt-oss", resolveFamily("@cf/openai/gpt-oss-120b").family, "gpt-oss-120b");
  eq("sambanova llama", resolveFamily("Meta-Llama-3.3-70B-Instruct").family, "llama-3.3-70b");
  eq("ovh llama", resolveFamily("Meta-Llama-3_3-70B-Instruct").family, "llama-3.3-70b");
  eq("nvidia llama", resolveFamily("meta/llama-3.3-70b-instruct").family, "llama-3.3-70b");
  eq("unknown model is kept, not dropped", resolveFamily("brand-new-model-9000").family, "unknown");
  eq("unknown defaults to balanced", resolveFamily("brand-new-model-9000").tier, "balanced");

  console.log("\n— window keys honour provider timezone —");
  {
    // 08:00 UTC on Aug 19 is still Aug 18 in Pacific time.
    const t = new Date("2026-08-19T05:00:00Z");
    const utcDay = windowKey("day", groq, t);
    const pacificDay = windowKey("day", gemini, t);
    eq("UTC provider", utcDay, "d2026-08-19");
    eq("Gemini rolls over at midnight Pacific", pacificDay, "d2026-08-18");
    check("the two differ", utcDay !== pacificDay);
  }

  console.log("\n— ledger: local counting is the floor —");
  {
    const store = new MemoryStore(0);
    const ledger = new Ledger(store, new Map([["sambanova", "account:test"]]));
    const before = await ledger.headroom(samba, "Meta-Llama-3.3-70B-Instruct");
    eq("seeded from registry defaults", before.req.day, 20);
    eq("source is estimated with no live data", before.source, "estimated");

    const r = await ledger.reserve(samba, "Meta-Llama-3.3-70B-Instruct", 500);
    const after = await ledger.headroom(samba, "Meta-Llama-3.3-70B-Instruct");
    eq("reservation decrements before the call is made", after.req.day, 19);
    await ledger.commit(r, 500);
    store.dispose();
  }

  console.log("\n— ledger: reported anchors upgrade estimates —");
  {
    const store = new MemoryStore(0);
    const ledger = new Ledger(store, new Map([["sambanova", "account:test"]]));
    const model = "Meta-Llama-3.3-70B-Instruct";

    // Burn 5 locally; estimate says 15 left.
    for (let i = 0; i < 5; i++) await ledger.commit(await ledger.reserve(samba, model, 10), 10);
    eq("estimate after 5 local calls", (await ledger.headroom(samba, model)).req.day, 15);

    // Provider then discloses the truth: only 3 remain (other clients used it).
    await ledger.ingest(samba, model, { source: "reported", reqRemaining: { day: 3 } });
    const anchored = await ledger.headroom(samba, model);
    eq("reported value overrides the estimate", anchored.req.day, 3);
    eq("source upgrades to reported", anchored.source, "reported");

    // Two more local calls must subtract from the ANCHOR, not from the seed.
    await ledger.commit(await ledger.reserve(samba, model, 10), 10);
    await ledger.commit(await ledger.reserve(samba, model, 10), 10);
    eq("anchor + local delta", (await ledger.headroom(samba, model)).req.day, 1);
    store.dispose();
  }

  console.log("\n— ledger: rollback returns quota that was never spent —");
  {
    const store = new MemoryStore(0);
    const ledger = new Ledger(store, new Map([["sambanova", "account:test"]]));
    const model = "Meta-Llama-3.3-70B-Instruct";
    const r = await ledger.reserve(samba, model, 100);
    eq("held during flight", (await ledger.headroom(samba, model)).req.day, 19);
    await ledger.rollback(r);
    eq("returned after a network failure", (await ledger.headroom(samba, model)).req.day, 20);

    const r2 = await ledger.reserve(samba, model, 100);
    await ledger.rollback(r2);
    await ledger.rollback(r2); // double rollback must be a no-op
    eq("double rollback is idempotent", (await ledger.headroom(samba, model)).req.day, 20);
    store.dispose();
  }

  console.log("\n— ledger: exhaustion is visible to the selector —");
  {
    const store = new MemoryStore(0);
    const ledger = new Ledger(store, new Map([["sambanova", "account:test"]]));
    const model = "Meta-Llama-3.3-70B-Instruct";
    await ledger.exhaust(samba, model, "day");
    const hr = await ledger.headroom(samba, model);
    eq("day window reads zero", hr.req.day, 0);
    check("a reset time is reported", (hr.resetInMs ?? 0) > 0);
    store.dispose();
  }

  console.log("\n— concurrency semaphore (Z.ai gates on concurrency, not rate) —");
  {
    const store = new MemoryStore(0);
    const zai = byId.get("zai")!;
    eq("registry records maxConcurrent", zai.maxConcurrent, 1);
    check("first slot granted", (await store.acquire("sem:zai", 1)) === true);
    check("second slot refused", (await store.acquire("sem:zai", 1)) === false);
    await store.release("sem:zai");
    check("slot reusable after release", (await store.acquire("sem:zai", 1)) === true);
    store.dispose();
  }

  console.log("\n— registry sanity —");
  {
    check("every provider has a base URL", REGISTRY.every((p) => /^https:\/\//.test(p.baseUrl)));
    check("ids are unique", new Set(REGISTRY.map((p) => p.id)).size === REGISTRY.length);
    check(
      "providers with account-scoped URLs declare an account env var",
      REGISTRY.every((p) => !p.baseUrl.includes("{accountId}") || Boolean(p.envAccountId)),
    );
    check(
      "non-keyless providers declare at least one env var",
      REGISTRY.every((p) => p.keyless || p.auth.type === "none" || p.envKeys.length > 0),
    );
    check("gemini is region-flagged", (gemini.regionBlocked ?? []).includes("EU"));
    check("nvidia is production-gated", byId.get("nvidia")!.productionAllowed === false);
    check("cohere is production-gated", byId.get("cohere")!.productionAllowed === false);
    check("github models declares per-request caps", byId.get("githubmodels")!.perRequestCaps?.maxInput === 8000);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
