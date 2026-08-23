import type { ProviderConfig } from "../types.js";

/**
 * Bundled provider registry.
 *
 * Every entry was checked against provider documentation in August 2026.
 * These numbers are SEEDS. They are the floor the ledger starts from and are
 * overwritten by live headers or quota endpoints the moment real data arrives.
 * Re-verify on a schedule; free tiers change monthly.
 *
 * Notable finding: Cloudflare Workers AI and Cohere both ship OpenAI-compatible
 * endpoints, so every provider here speaks one wire format. No custom adapters.
 */
export const REGISTRY: ProviderConfig[] = [
  // -------------------------------------------------------------------------
  // Tier 1 — permanent, no credit card, meaningful volume
  // -------------------------------------------------------------------------
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    modelsPath: "/models",
    auth: { type: "bearer" },
    quota: { source: "headers", dialect: "groq" },
    scope: "organization",
    resetTz: "UTC",
    rateUnit: "rpm",
    productionAllowed: true,
    freeFilter: { kind: "all" },
    envKeys: ["GROQ_API_KEY"],
    defaultLimits: {
      // Free plan, per Groq's published table (Aug 2026). Most models sit at
      // 30 RPM / 1K RPD / 8K TPM / 200K TPD. The widely-repeated 14.4K RPD
      // figure now applies only to the prompt-guard models.
      default: { rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000 },
      "meta-llama/llama-prompt-guard-2-22m": { rpm: 30, rpd: 14_400, tpm: 15_000, tpd: 500_000 },
      "meta-llama/llama-prompt-guard-2-86m": { rpm: 30, rpd: 14_400, tpm: 15_000, tpd: 500_000 },
      "groq/compound": { rpm: 30, rpd: 250, tpm: 70_000 },
      "groq/compound-mini": { rpm: 30, rpd: 250, tpm: 70_000 },
    },
    notes:
      "Fastest inference on the list (LPU). Header naming is inverted: " +
      "limit-requests is RPD and limit-tokens is TPM. RPM is not exposed at all.",
  },

  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelsPath: "/models",
    auth: { type: "bearer" },
    quota: { source: "opaque", dialect: "none" },
    scope: "project",
    // Gemini's daily quota rolls over at midnight Pacific, not UTC.
    resetTz: "America/Los_Angeles",
    rateUnit: "rpm",
    productionAllowed: true,
    regionBlocked: ["EU", "UK", "CH"],
    logsPrompts: true,
    freeFilter: { kind: "all" },
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    defaultLimits: {
      default: { rpm: 15, rpd: 1_500, tpm: 1_000_000 },
      "gemini-2.5-flash-lite": { rpm: 30, rpd: 1_500 },
      "gemini-2.5-pro": { rpm: 5, rpd: 50 },
    },
    notes:
      "Free tier unavailable in EU/UK/CH — a European user gets total failure " +
      "with no obvious cause unless flagged. Free-tier prompts may train Google models.",
  },

  {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelsPath: "/models",
    auth: { type: "bearer" },
    quota: { source: "opaque", dialect: "none" },
    scope: "account",
    resetTz: "UTC",
    rateUnit: "rpm",
    // ToS restricts the free tier to development, testing, research, evaluation.
    productionAllowed: false,
    freeFilter: { kind: "all" },
    envKeys: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
    defaultLimits: {
      // The most forgiving daily policy here: rate-limited but no daily cap.
      default: { rpm: 40 },
    },
    notes: "100+ models, often first to host new open-weight releases. No daily cap.",
  },

  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    modelsPath: "/models",
    auth: { type: "bearer" },
    quota: { source: "headers", dialect: "mistral" },
    scope: "organization",
    resetTz: "UTC",
    // Mistral meters per SECOND. Treating 1 RPS as 1 RPM under-uses it 60x;
    // treating it as 60 RPM causes constant 429s.
    rateUnit: "rps",
    productionAllowed: true,
    logsPrompts: true,
    freeFilter: { kind: "all" },
    envKeys: ["MISTRAL_API_KEY"],
    defaultLimits: {
      default: { rps: 1, tpm: 500_000, tpMonth: 1_000_000_000 },
    },
    notes:
      "Free 'Experiment' plan: 1 RPS, 500K TPM, 1B tokens/month. The token budget " +
      "is enormous; the 1 RPS ceiling is the binding constraint.",
  },

  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelsPath: "/models",
    auth: { type: "bearer" },
    quota: { source: "endpoint", dialect: "standard", endpoint: "https://openrouter.ai/api/v1/key" },
    scope: "key",
    resetTz: "UTC",
    rateUnit: "rpm",
    productionAllowed: true,
    logsPrompts: true,
    // CRITICAL: OpenRouter's catalog is ~370 models, of which only ~20 are free.
    // Without this filter the router spends real credits.
    freeFilter: { kind: "zero-price" },
    envKeys: ["OPENROUTER_API_KEY"],
    extraHeaders: {
      "HTTP-Referer": "https://github.com/routegrail",
      "X-Title": "RouteGrail",
    },
    defaultLimits: {
      // 20 RPM; 50 RPD under $10 lifetime credit, 1000 RPD after.
      default: { rpm: 20, rpd: 50 },
    },
    notes:
      "Low volume but broad: ~20 free models behind one key, routed to providers " +
      "you may not hold keys for. Live quota via GET /api/v1/key.",
  },

  {
    id: "githubmodels",
    label: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    modelsPath: null,
    modelsUrl: "https://models.github.ai/catalog/models",
    auth: { type: "bearer" },
    quota: { source: "opaque", dialect: "none" },
    scope: "user",
    resetTz: "UTC",
    rateUnit: "rpm",
    productionAllowed: true,
    // 8K in / 4K out regardless of the model's advertised context window.
    // Filtering on contextWindow alone routes oversized prompts here and fails.
    perRequestCaps: { maxInput: 8_000, maxOutput: 4_000 },
    freeFilter: { kind: "all" },
    envKeys: ["GITHUB_TOKEN", "GITHUB_MODELS_TOKEN"],
    defaultLimits: {
      default: { rpm: 15, rpd: 150 },
      "openai/gpt-5": { rpm: 10, rpd: 50 },
      "openai/gpt-4.1": { rpm: 10, rpd: 50 },
      "openai/gpt-4o": { rpm: 10, rpd: 50 },
      "openai/o4-mini": { rpm: 10, rpd: 50 },
    },
    notes:
      "The only free path to GPT-class proprietary models. PAT needs models:read scope. " +
      "Copilot entitlements are billed separately and do not raise these limits.",
  },

  {
    id: "siliconflow",
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    modelsPath: "/models",
    auth: { type: "bearer" },
    quota: { source: "opaque", dialect: "none" },
    scope: "account",
    resetTz: "UTC",
    rateUnit: "rpm",
    productionAllowed: true,
    // Only a couple of models are permanently free; the rest are paid.
    freeFilter: {
      kind: "allowlist",
      ids: [
        "Qwen/Qwen3-8B",
        "THUDM/GLM-4-9B-0414",
        "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
        "internlm/internlm2_5-7b-chat",
      ],
    },
    envKeys: ["SILICONFLOW_API_KEY"],
    defaultLimits: {
      default: { rpm: 30, tpm: 60_000 },
    },
    notes: "China-hosted. Verify regional signup friction and latency before relying on it.",
  },

  {
    id: "sambanova",
    label: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    modelsPath: "/models",
    auth: { type: "bearer" },
    quota: { source: "headers", dialect: "sambanova" },
    scope: "account",
    resetTz: "UTC",
    rateUnit: "rpm",
    productionAllowed: true,
    freeFilter: { kind: "all" },
    envKeys: ["SAMBANOVA_API_KEY"],
    defaultLimits: {
      default: { rpm: 20, rpd: 20, tpd: 200_000 },
    },
    notes:
      "20 requests per day — nearly unusable for volume. Included because it is the " +
      "only provider exposing both minute and day windows in headers, which makes it " +
      "the best integration test for the ledger.",
  },

  // -------------------------------------------------------------------------
  // Tier 2 — real caveats
  // -------------------------------------------------------------------------
  {
    id: "cloudflare",
    label: "Cloudflare Workers AI",
    // OpenAI-compatible endpoint; {accountId} is substituted from credentials.
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
    modelsPath: null,
    auth: { type: "bearer" },
    quota: { source: "opaque", dialect: "none" },
    scope: "account",
    resetTz: "UTC",
    rateUnit: "rpm",
    productionAllowed: true,
    freeFilter: { kind: "all" },
    envKeys: ["CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"],
    envAccountId: "CF_ACCOUNT_ID",
    defaultLimits: {
      // 10,000 neurons/day shared across all models, resets 00:00 UTC.
      // Neuron cost varies sharply by model, so this is a low-confidence estimate.
      default: { neuronsPerDay: 10_000, rpm: 300 },
    },
    staticModels: [
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/meta/llama-3.1-8b-instruct",
      "@cf/openai/gpt-oss-120b",
      "@cf/openai/gpt-oss-20b",
      "@cf/qwen/qwen2.5-coder-32b-instruct",
      "@cf/google/gemma-3-12b-it",
      "@cf/mistralai/mistral-small-3.1-24b-instruct",
    ],
    notes:
      "Neuron-denominated, not request-denominated. Neuron cost per request is " +
      "estimated, never authoritative — routed to only when counted providers are dry.",
  },

  {
    id: "cohere",
    label: "Cohere",
    // Compatibility API — OpenAI SDK shape, no custom adapter needed.
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    modelsPath: "/models",
    auth: { type: "bearer" },
    quota: { source: "opaque", dialect: "none" },
    scope: "organization",
    resetTz: "UTC",
    rateUnit: "rpm",
    // Trial keys are explicitly not permitted for production or commercial use.
    productionAllowed: false,
    freeFilter: { kind: "all" },
    envKeys: ["COHERE_API_KEY"],
    defaultLimits: {
      // 1,000 calls per month across ALL endpoints combined, 20 RPM on chat.
      default: { rpm: 20, rpMonth: 1_000 },
    },
    notes: "Trial key: 1,000 calls/month total. Non-commercial use only.",
  },

  {
    id: "zai",
    label: "Z.ai (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    modelsPath: null,
    auth: { type: "bearer" },
    quota: { source: "opaque", dialect: "none" },
    scope: "account",
    resetTz: "UTC",
    rateUnit: "rpm",
    // Gated on CONCURRENCY, not rate. Needs a semaphore, not a counter.
    maxConcurrent: 1,
    productionAllowed: true,
    freeFilter: {
      kind: "allowlist",
      ids: ["glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash"],
    },
    envKeys: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    staticModels: ["glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash"],
    defaultLimits: {
      default: { rpm: 60 },
    },
    notes: "Free Flash models allow exactly 1 concurrent request. China-hosted.",
  },

  // -------------------------------------------------------------------------
  // Tier 3 — keyless fallbacks (opt-in)
  // -------------------------------------------------------------------------
  {
    id: "llm7",
    label: "LLM7.io",
    baseUrl: "https://api.llm7.io/v1",
    modelsPath: "/models",
    // Accepts an optional token; "unused" works for the anonymous tier.
    auth: { type: "bearer" },
    quota: { source: "opaque", dialect: "none" },
    scope: "key",
    resetTz: "UTC",
    rateUnit: "rpm",
    productionAllowed: true,
    keyless: true,
    freeFilter: { kind: "all" },
    envKeys: ["LLM7_API_KEY"],
    defaultLimits: {
      // 30 RPM anonymous, 120 RPM with a free token from token.llm7.io.
      default: { rpm: 30 },
    },
    notes: "Anonymous access works with the literal token 'unused'. GDPR-compliant.",
  },

  {
    id: "ovhcloud",
    label: "OVHcloud AI Endpoints",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    modelsPath: "/models",
    auth: { type: "none" },
    quota: { source: "opaque", dialect: "none" },
    scope: "key",
    resetTz: "UTC",
    rateUnit: "rpm",
    productionAllowed: true,
    keyless: true,
    freeFilter: { kind: "all" },
    envKeys: [],
    defaultLimits: {
      // 2 RPM per IP PER MODEL — so spreading across model IDs multiplies it.
      default: { rpm: 2 },
    },
    notes:
      "Anonymous, EU-hosted. The per-model limit is worth exploiting: 2 RPM across " +
      "12 models is ~24 RPM aggregate if requests are spread over model IDs.",
  },

  {
    id: "pollinations",
    label: "Pollinations",
    baseUrl: "https://text.pollinations.ai/openai",
    modelsPath: null,
    auth: { type: "none" },
    quota: { source: "opaque", dialect: "none" },
    scope: "key",
    resetTz: "UTC",
    rateUnit: "rpm",
    productionAllowed: true,
    keyless: true,
    freeFilter: { kind: "all" },
    envKeys: [],
    staticModels: ["openai", "openai-fast", "mistral", "qwen-coder"],
    defaultLimits: {
      default: { rpm: 10 },
    },
    notes: "No signup at all. Small limits, best used as the last resort before failing.",
  },
];

export function registryById(registry = REGISTRY): Map<string, ProviderConfig> {
  return new Map(registry.map((p) => [p.id, p]));
}
