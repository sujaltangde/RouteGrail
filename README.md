# RouteGrail

**A quota-aware router over permanently-free LLM tiers.**

Give it whatever free API keys you have. It discovers which models each key can actually reach, tracks how much free capacity remains across every provider, and routes each request to a live one — falling back to *the same model family on a different provider* rather than to a worse model.

```ts
import { Router } from "routegrail";

const router = new Router();                       // reads keys from env
const res = await router.generate({ prompt: "..." });

console.log(res.text, "←", res.provider, res.model);
```

---

## What this is, and what it isn't

**What it delivers: continuity.** Pooled across a dozen free tiers with headroom-weighted routing, a single developer rarely hits a wall. No 429s in your face, no manual key switching.

**What routing cannot fix:**

- **Consistency.** Different providers mean different models mean different output quality and formatting. Session affinity and canonical families reduce this. They don't eliminate it.
- **Frontier capability.** Only GitHub Models offers GPT-class models, at 50 RPD with hard 8K-in/4K-out caps. Everything else tops out at good open-weight models.
- **Concurrency.** These tiers cap at 1–40 RPM. This is a single-user-shaped resource pool. Ten simultaneous users will queue or fail.
- **Terms of service.** NVIDIA (dev/eval only) and Cohere (non-commercial only) are gated behind `mode: "production"`. Gemini and Mistral free tiers may train on your prompts.

The honest positioning is *free-tier quality with paid-tier-like uptime*. Don't let it drift toward "free ChatGPT" — the first person who ships a user-facing product on it and hits nondeterministic output plus a ToS letter will be loud about it.

---

## Install

Published to the npm registry, so any client works:

```bash
npm install routegrail
yarn add routegrail
pnpm add routegrail
```

Node 18.17+ (needs native `fetch`). Zero runtime dependencies.

See **[SETUP.md](./SETUP.md)** for where to get each key and how to build from source.

---

## The core idea

Provider abstraction is a commodity — LiteLLM, the Vercel AI SDK and OpenRouter all do it. What nobody does well is *knowing how much free capacity you have left across providers you personally own, before spending a request to find out.*

The ledger is not a supporting component here. It's the thing being built.

### Three quota sources, composed rather than replaced

```
reported   ← response headers, or a quota endpoint   trust: high
mined      ← parsed out of a 429 body                trust: high
estimated  ← local counter vs seed limits            trust: low, always available
```

A reported value doesn't overwrite the local counter — it becomes an **anchor**: `remaining` at a known local count. Live headroom is then:

```
headroom = anchor.remaining − (currentLocalCount − anchor.atCount)
```

When the anchor ages out (2 min for reported, 5 for mined), the ledger falls back to pure local counting. Local counting is the floor; reported values are the upgrade, never the reverse. **Assume the published tables disappear** — Google has already moved per-model limits behind a login, Cerebras killed its permanent free tier outright. The ledger has to work with zero published data.

Every quota number in `status()` carries its `source`, so you always know which figures are measurements and which are guesses.

### Reservations, not optimistic counting

Each attempt reserves quota *before* the request goes out, then either commits it with the real token count or rolls it back. Rollback only happens for network and timeout failures — a 429 or a 400 *did* consume the provider's counter, and returning that quota would make the ledger believe in capacity the provider has already spent.

Without pre-send reservation, N parallel calls all read the same headroom and blow through the limit together.

### Canonical model families

`gpt-oss-120b` lives on Groq, NVIDIA, SambaNova, Cloudflare, OVHcloud and OpenRouter under six different ID strings. RouteGrail ranks **families** and treats providers as interchangeable routes to one. Fallback means *same model, different provider* — the difference between graceful failover and visible quality collapse.

Unknown models get a conservative `balanced` default rather than being dropped, so new releases are usable the day they appear.

### Headroom-weighted random selection

This is load-bearing, not a detail. Deterministic top-1 selection drains Groq to zero, then Gemini, then NVIDIA — ending your day on the worst provider with everything else exhausted. Weighting by remaining capacity spreads consumption proportionally and keeps every tier alive longer. **When you're pooling a dozen small budgets, the distribution is the value proposition.**

### Never hardcode model lists

Free-tier lineups rotate constantly. A hardcoded `models.ts` is wrong within months, and its 404s look like outages to the fallback engine. RouteGrail discovers models at runtime from each provider's own catalog, caches for 24h, and invalidates on any `model_not_found`.

---

## Provider set

All thirteen speak the OpenAI chat-completions wire format — including Cloudflare Workers AI (via `/accounts/{id}/ai/v1`) and Cohere (via its Compatibility API). One transport covers everything; there are no per-provider adapters.

### Tier 1 — ship these

| Provider | Free limits (seed) | Quota source | Scope |
|---|---|---|---|
| **Groq** | 30 RPM / 1K RPD / 8K TPM / 200K TPD | headers | organization |
| **Google Gemini** | 15 RPM / 1.5K RPD (Flash); 5 RPM / 50 RPD (Pro) | opaque | project |
| **NVIDIA NIM** | ~40 RPM, **no daily cap** | opaque | account |
| **Mistral** | 1 **RPS**, 500K TPM, ~1B tokens/month | headers | organization |
| **OpenRouter** | 20 RPM / 50 RPD (1K after $10 lifetime) | `GET /key` | key |
| **GitHub Models** | 10–15 RPM / 50–150 RPD | opaque | user |
| **SiliconFlow** | 30 RPM / 60K TPM on free models | opaque | account |
| **SambaNova** | 20 RPM / **20 RPD** / 200K TPD | headers | account |

### Tier 2 — real caveats

| Provider | Free limits | Caveat |
|---|---|---|
| **Cloudflare Workers AI** | 10,000 neurons/day, resets 00:00 UTC | Neuron-denominated; cost is estimated, never authoritative |
| **Cohere** | 1,000 calls/month total, 20 RPM | **Non-commercial use only** (`productionAllowed: false`) |
| **Z.ai** | GLM-4.7/4.5/4.6V-Flash free | **1 concurrent request** — gated by semaphore, not counter |

### Tier 3 — keyless, opt in with `keylessFallback: true`

| Provider | Limits |
|---|---|
| **LLM7.io** | 30 RPM anonymous, 120 with a free token, EU/GDPR |
| **OVHcloud** | 2 RPM per IP **per model**, EU-hosted, no signup |
| **Pollinations** | ~10 RPM, no signup |

Off by default: you haven't consented to sending prompts to a provider you never configured. OVHcloud's per-model limit is worth exploiting — 2 RPM across 12 model IDs is ~24 RPM aggregate.

### Per-provider warnings the SDK enforces for you

- **Gemini's free tier is unavailable in the EU, UK and Switzerland.** Set `region` and it's skipped before a request is spent; hit it anyway and you get `region_blocked`, not a confusing auth error.
- **NVIDIA's ToS restricts the free tier to development, testing, research and evaluation.** `mode: "production"` filters it out.
- **Cohere trial keys are non-commercial.** Same treatment.
- **GitHub Models caps 8K in / 4K out** regardless of a model's advertised context. Filtering on context window alone routes oversized prompts there and fails; RouteGrail carries `perRequestCaps` separately.
- **Gemini and Mistral free tiers may train on prompts.** `allowPromptLogging: false` excludes every such provider in one switch.
- **Gemini's daily quota resets at midnight Pacific**, not UTC. Window keys are computed in each provider's own timezone.
- **Groq's rate-limit headers are inverted**: `x-ratelimit-limit-requests` always means requests *per day*, `x-ratelimit-limit-tokens` always means tokens *per minute*. RPM isn't exposed at all and is counted locally.

---

## API

### `new Router(config?)`

```ts
type RouterConfig = {
  providers?: Record<string, { apiKey?: string; accountId?: string }>; // omit = read env
  mode?: "development" | "production";  // production filters ToS-restricted tiers
  keylessFallback?: boolean;            // default false
  allowPromptLogging?: boolean;         // default true
  affinity?: boolean;                   // default true
  region?: string;                      // e.g. "DE" — skips region-blocked providers
  maxAttempts?: number;                 // default 3
  timeoutMs?: number;                   // default 60000
  store?: StateStore;                   // default MemoryStore
  registry?: ProviderConfig[];          // replace/extend the bundled registry
  discoveryTtlMs?: number;              // default 24h
  logger?: (level, msg, meta?) => void;
};
```

Every provider is optional. The router works with one key and improves with each one you add. Discovery starts in the background — the constructor never blocks on it.

### `generate(request)`

```ts
const res = await router.generate({
  prompt: "...",
  system: "...",
  temperature: 0.7,
  maxTokens: 1024,
  tier: "balanced",                 // errors rather than silently downgrading
  requires: { json: true, minContext: 32000 },
  exclude: ["cohere", "groq:openai/gpt-oss-120b"],
  sessionId: "conversation-123",    // pins follow-ups to one family
  signal: controller.signal,
});
```

Returns `text`, `provider`, `model`, `family`, `usage`, `latencyMs`, and a `routing` object with `attempts`, `fallbackUsed`, `skipped[]` (every route that was ruled out, with a reason) and `trail[]` (every attempt that failed, with its error class).

### `stream(request)`

Async generator of `{ text, provider, model, family, done }`. The first chunk is buffered internally so a failure before any output reaches you reroutes invisibly. Once output has started, errors surface — splicing another model's continuation into a partial response would produce text no single model ever wrote.

### `status()`

Async (your store may be Redis). Returns per-provider state, remaining capacity with its `source`, EWMA latency, success rate, and a family view showing how many providers can serve each family and how many are live.

```ts
{
  providers: {
    groq:      { state: "healthy",   discovered: 12, quota: { source: "reported", remainingDay: 987 } },
    sambanova: { state: "exhausted", discovered: 6,  quota: { source: "reported", remainingDay: 0, resetInMs: 41200000 } },
    gemini:    { state: "disabled",  reason: "region_blocked: free tier unavailable in EU/UK/CH" },
    nvidia:    { state: "disabled",  reason: "productionAllowed=false, mode=production" },
  },
  families: { "gpt-oss-120b": { routes: 5, available: 3, tier: "balanced" } },
}
```

### Other methods

`ready()` awaits discovery · `refresh()` forces a catalog re-fetch · `listProviders()` · `listModels(providerId?)` · `listFamilies()` · `dispose()`

---

## Error handling

```ts
import { NoRouteError, AllProvidersFailedError } from "routegrail";
```

- **`NoRouteError`** — nothing was eligible before any request was sent. `.message` explains why in one sentence; `.skipped` has the full breakdown.
- **`AllProvidersFailedError`** — every attempt failed. `.trail` lists each provider, model and error class.
- **`ConfigError`** — no providers configured at all.

### The error taxonomy

| Class | Detection | Action |
|---|---|---|
| `RATE_LIMITED` | 429 | mine body → cooldown from `Retry-After` → next route |
| `QUOTA_EXHAUSTED` | 402, or a 429 naming a daily/monthly cap | zero out the window, not just seconds |
| `AUTH` | 401, 403 | disable for the session, surface loudly |
| `REGION_BLOCKED` | 403 + location message | disable with a *specific* reason |
| `CONTEXT_LENGTH_EXCEEDED` | 413, or 400 about length | **cascade** to a provider with a bigger cap |
| `INVALID_REQUEST` | any other 400 | **stop the whole loop** |
| `MODEL_NOT_FOUND` | 404 | invalidate discovery, refresh |
| `SERVER` / `TIMEOUT` / `NETWORK` | 5xx, abort, ECONNRESET | short cooldown, next route |

**The 400 rule and its exception.** Cascading a malformed request through twelve providers burns twelve quotas to produce the same error twelve times — a 400 means *your request is wrong*, not *their capacity is gone*. But oversized prompts also come back as 400, and those genuinely should try a provider with a larger cap. Collapsing these two into one rule is the most commonly-botched branch in routers of this kind, so RouteGrail splits them and tests both directions.

---

## Multi-instance deployments

The default `MemoryStore` is per-process. On Lambda, Vercel or multiple containers, every instance independently rediscovers limits via 429s. Implement `StateStore` against Redis:

```ts
type StateStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  incr(key: string, by: number, ttlMs: number): Promise<number>;
  del(key: string): Promise<void>;
  acquire(key: string, max: number): Promise<boolean>;  // Z.ai semaphore
  release(key: string): Promise<void>;
};
```

Selection is async throughout so this seam costs nothing to use.

**Scope is not "API key."** Groq bills per organization, Gemini per project, Cloudflare per account, GitHub per user. Two Groq keys share one budget — keying the ledger by credential would double-count headroom that doesn't exist. The registry declares each provider's real billing scope.

---

## Realistic capacity

With all Tier 1 keys configured, outside the EU: roughly **3,000–6,000 requests/day**, plus NVIDIA's uncapped daily allowance and Mistral's ~1B monthly token budget.

Treat that as nominal, not achievable in a burst — per-minute limits bind long before daily ones. Groq's daily allowance at 30 RPM would need hours of continuous saturation to exhaust. The honest claim is that a solo developer doing normal work essentially never hits a wall, which is a different statement from a big number in a table.

---

## Verify before you ship

Every number in the bundled registry was checked against provider documentation in **August 2026**, but these change monthly. `defaultLimits` is a *seed* to be overwritten by live data, not a source of truth. Re-verify the registry on a schedule, or override it:

```ts
import { REGISTRY } from "routegrail";
const registry = REGISTRY.map((p) =>
  p.id === "groq" ? { ...p, defaultLimits: { default: { rpm: 30, rpd: 14_400 } } } : p,
);
const router = new Router({ registry });
```

## License

MIT
