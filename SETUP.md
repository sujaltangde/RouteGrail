# RouteGrail — Setup Guide

Installation, key acquisition, code layout, and how to extend the registry.

---

## 1. Requirements

- **Node.js 18.17+** — the SDK uses native `fetch`, `AbortController` and `ReadableStream`. Node 20 or 22 recommended.
- **TypeScript 5.x** if you're building from source.
- No runtime dependencies.

Check:

```bash
node --version   # v18.17.0 or higher
```

---

## 2. Install

### As a dependency

Published to the npm registry — pick whichever client you already use:

```bash
npm install routegrail
yarn add routegrail
pnpm add routegrail
# bun add routegrail
```

### From source

This repo uses a shared `node_modules` layout (not Yarn Plug'n'Play), so npm, Yarn, and pnpm all work. Lockfiles for each are committed.

```bash
# install (one of)
npm install
yarn
pnpm install

# then
npm run build          # or: yarn build / pnpm build
npm run selftest       # or: yarn selftest / pnpm selftest
npm run e2etest        # or: yarn e2etest / pnpm e2etest
```

Both suites run without network access or API keys.

---

## 3. Configure keys

Copy the template and fill in whatever you have:

```bash
cp .env.example .env
```

**Every key is optional.** The router works with one and improves with each addition. `new Router()` with no arguments auto-detects everything below.

```bash
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...
NVIDIA_API_KEY=nvapi-...
MISTRAL_API_KEY=...
OPENROUTER_API_KEY=sk-or-v1-...
GITHUB_TOKEN=github_pat_...
SILICONFLOW_API_KEY=sk-...
SAMBANOVA_API_KEY=...
CF_API_TOKEN=...
CF_ACCOUNT_ID=...
COHERE_API_KEY=...
ZAI_API_KEY=...
LLM7_API_KEY=          # optional; raises 30 -> 120 RPM
```

Node 20.6+ loads it natively:

```bash
node --env-file=.env your-app.js
```

Or pass keys explicitly:

```ts
const router = new Router({
  providers: {
    groq: { apiKey: process.env.GROQ_API_KEY },
    cloudflare: { apiKey: process.env.CF_API_TOKEN, accountId: process.env.CF_ACCOUNT_ID },
  },
});
```

### Security

Never commit `.env` (it's already in `.gitignore`) and never paste keys into chat logs, issues or screenshots. If a key is ever exposed, **rotate it at the provider console** — most of these can be regenerated in under a minute, and several (Cloudflare, Cohere) are attached to accounts that can incur real charges beyond the free tier.

---

## 4. Where to get each key

| Provider | Where | Signup friction | Key format |
|---|---|---|---|
| **Groq** | `console.groq.com/keys` | Email/Google/GitHub, instant | `gsk_...` |
| **Gemini** | `aistudio.google.com/app/apikey` | Google account, instant | opaque |
| **NVIDIA NIM** | `build.nvidia.com` | Developer Program; may need phone verification | `nvapi-...` |
| **Mistral** | `console.mistral.ai/api-keys` | Email; phone verification typically required | opaque |
| **OpenRouter** | `openrouter.ai/keys` | Email or GitHub, instant | `sk-or-v1-...` |
| **GitHub Models** | `github.com/settings/tokens` | Any GitHub account; PAT needs **`models:read`** scope | `ghp_...` / `github_pat_...` |
| **SiliconFlow** | `cloud.siliconflow.cn/account/ak` | Account signup; check regional requirements | `sk-...` |
| **SambaNova** | `cloud.sambanova.ai/apis` | Email, no card | opaque |
| **Cloudflare** | `dash.cloudflare.com/profile/api-tokens` | Also copy your **Account ID** from the dashboard sidebar | token + account ID |
| **Cohere** | `dashboard.cohere.com/api-keys` | Email, instant — choose the **Trial** key | opaque |
| **Z.ai** | `z.ai` console (international) or `open.bigmodel.cn` (China) | Email | opaque |
| **LLM7.io** | `token.llm7.io` (optional) | None needed for 30 RPM | optional |
| **OVHcloud** | — | None | none |
| **Pollinations** | — | None | none |

Cloudflare needs **two** values. Without the account ID there is no valid endpoint — the base URL embeds it — and the provider is disabled with an explanatory reason rather than failing at request time.

---

## 5. First run

```ts
// hello.ts
import { Router } from "routegrail";

const router = new Router({ keylessFallback: true });

const res = await router.generate({ prompt: "Say hello in five words." });
console.log(res.text);
console.log(`served by ${res.provider}/${res.model}`);

console.table(await router.status());
router.dispose();
```

```bash
npx tsx hello.ts
```

With `keylessFallback: true` this runs with **zero keys** — it falls through to LLM7/OVHcloud/Pollinations. Add keys to get real capacity.

The bundled examples:

```bash
npx tsx examples/01-generate.ts
npx tsx examples/02-stream.ts
npx tsx examples/03-status.ts     # capacity dashboard
npx tsx examples/04-advanced.ts   # affinity, tiers, privacy filtering
```

---

## 6. Code layout

```
src/
├── index.ts              Public exports
├── router.ts             Router class — generate / stream / status
├── types.ts              All type definitions
├── errors.ts             Error classes + the taxonomy classifier
├── registry/
│   └── providers.ts      13 providers as DATA, not code
├── families.ts           Canonical family patterns + tier mapping
├── discovery.ts          Catalog fetch, key validation, FREE-MODEL FILTER
├── ledger.ts             Quota accounting: anchors, reservations, windows
├── harvester.ts          Header dialects + 429 body miner
├── selector.ts           Hard filters, scoring, weighted-random pick
├── executor.ts           Attempt loop, error branching, ledger updates
├── transport/
│   └── openai.ts         One OpenAI-compatible transport for all providers
├── store/
│   └── memory.ts         Default StateStore
├── tokens.ts             Token + neuron estimation
├── util.ts               Window keys, timezone math, duration parsing
├── selftest.ts           64 offline assertions
└── e2etest.ts            46 mocked-HTTP assertions
```

**Reading order if you're picking this up cold:** `types.ts` → `registry/providers.ts` → `ledger.ts` → `selector.ts` → `executor.ts`. The ledger is where the real design lives.

---

## 7. Extending it

### Add a provider

Providers are data. No code changes required:

```ts
import { Router, REGISTRY, type ProviderConfig } from "routegrail";

const cerebras: ProviderConfig = {
  id: "cerebras",
  label: "Cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  modelsPath: "/models",
  auth: { type: "bearer" },
  quota: { source: "headers", dialect: "standard" },
  scope: "account",
  resetTz: "UTC",
  rateUnit: "rpm",
  productionAllowed: true,
  freeFilter: { kind: "all" },
  envKeys: ["CEREBRAS_API_KEY"],
  defaultLimits: { default: { rpm: 30, rpd: 14_400 } },
};

const router = new Router({ registry: [...REGISTRY, cerebras] });
```

If it speaks OpenAI chat-completions, it works immediately.

### Add a model family

```ts
import { FAMILIES } from "routegrail";
FAMILIES.push({ id: "my-model", tier: "strong", patterns: [/my-model/i] });
```

### Override stale limits

`defaultLimits` is a seed, not a source of truth:

```ts
const registry = REGISTRY.map((p) =>
  p.id === "groq" ? { ...p, defaultLimits: { ...p.defaultLimits, default: { rpm: 30, rpd: 14_400, tpm: 6_000 } } } : p,
);
```

### Redis-backed store for serverless

```ts
import type { StateStore } from "routegrail";
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

export const redisStore: StateStore = {
  async get(k) { return redis.get(k); },
  async set(k, v, ttl) { await redis.set(k, v, { PX: ttl }); },
  async incr(k, by, ttl) {
    const n = await redis.incrBy(k, by);
    if (n === by) await redis.pExpire(k, ttl);   // only set TTL on creation
    return n;
  },
  async del(k) { await redis.del(k); },
  async acquire(k, max) {
    const n = await redis.incr(k);
    if (n === 1) await redis.pExpire(k, 120_000); // guard against leaked slots
    if (n > max) { await redis.decr(k); return false; }
    return true;
  },
  async release(k) { await redis.decr(k); },
};

const router = new Router({ store: redisStore });
```

Set the TTL only when the counter is created, or a busy key's window slides forward forever and never resets.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ConfigError: No providers configured` | No keys found in config or env | Set one key, or `keylessFallback: true` |
| Gemini always `disabled: region_blocked` | Free tier is unavailable in EU/UK/CH | Expected. Use other providers, or a non-blocked region |
| `NoRouteError: every route is out of quota` | All daily windows exhausted | Wait for reset, add a key, or enable keyless fallback |
| Cloudflare disabled: `missing account id` | `CF_ACCOUNT_ID` not set | Copy it from the Cloudflare dashboard sidebar |
| GitHub Models 401 | PAT lacks the right scope | Regenerate with **`models:read`** |
| Fewer OpenRouter models than expected | The free filter is working | Only zero-price / `:free` models are kept — by design |
| `AllProvidersFailedError` after one attempt | `INVALID_REQUEST` — your request is malformed | Check the trail; the loop stops deliberately |
| Every provider `degraded`, 0 models | Network/DNS blocked, or all catalogs failed | Check egress; `refresh()` re-attempts |
| Limits look wrong | Registry seeds are stale | Override `defaultLimits`, or let headers correct it on first call |

Enable logging to see routing decisions:

```ts
const router = new Router({ logger: (level, msg, meta) => console.error(`[${level}]`, msg, meta ?? "") });
```

---

## 9. Publishing

```bash
npm run clean && npm run build     # or: yarn clean && yarn build / pnpm clean && pnpm build
npm publish --access public        # or: yarn npm publish --access public / pnpm publish --access public
```

`files` is limited to `dist`, `README.md` and `SETUP.md`, so tests and examples stay out of the tarball.
