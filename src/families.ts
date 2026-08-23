import type { Family, Tier } from "./types.js";

/**
 * Canonical model families.
 *
 * The same weights appear on six providers under six different ID strings.
 * Ranking FAMILIES rather than model IDs means fallback is "same model,
 * different provider" instead of "worse model" — the difference between
 * graceful failover and visible quality collapse.
 */
export const FAMILIES: Family[] = [
  {
    id: "gpt-oss-120b",
    tier: "balanced",
    patterns: [/gpt-oss-120b/i],
  },
  {
    id: "gpt-oss-20b",
    tier: "fast",
    patterns: [/gpt-oss-20b/i, /gpt-oss-safeguard-20b/i],
  },
  {
    id: "llama-3.3-70b",
    tier: "balanced",
    patterns: [/llama[-_. ]?3[._]3[-_. ]?70b/i, /Meta-Llama-3\.3-70B/i, /llama-3_3-70b/i],
  },
  {
    id: "llama-3.1-8b",
    tier: "fast",
    patterns: [/llama[-_. ]?3[._]1[-_. ]?8b/i, /llama-3\.1-8b-instant/i],
  },
  {
    id: "llama-4-scout",
    tier: "balanced",
    patterns: [/llama-4-scout/i, /llama4.*scout/i],
  },
  {
    id: "qwen3",
    tier: "balanced",
    patterns: [/qwen3(?![.\d])/i, /qwen\/qwen3-/i, /qwen3\.\d/i],
  },
  {
    id: "qwen-coder",
    tier: "balanced",
    patterns: [/qwen.*coder/i],
  },
  {
    id: "deepseek-r1",
    tier: "strong",
    patterns: [/deepseek[-_. ]?r1/i],
  },
  {
    id: "deepseek-v3",
    tier: "strong",
    patterns: [/deepseek[-_. ]?v3/i, /deepseek-chat/i],
  },
  {
    id: "glm-flash",
    tier: "fast",
    patterns: [/glm-4\.[567].*flash/i, /glm-4-\d+-flash/i],
  },
  {
    id: "glm",
    tier: "balanced",
    patterns: [/glm-[45](\.\d)?(?!.*flash)/i],
  },
  {
    id: "gemini-flash",
    tier: "balanced",
    patterns: [/gemini-[\d.]+-flash(?!-lite)/i],
  },
  {
    id: "gemini-flash-lite",
    tier: "fast",
    patterns: [/gemini-[\d.]+-flash-lite/i],
  },
  {
    id: "gemini-pro",
    tier: "strong",
    patterns: [/gemini-[\d.]+-pro/i],
  },
  {
    id: "gpt-4o-mini",
    tier: "fast",
    patterns: [/gpt-4o-mini/i, /gpt-4\.1-mini/i, /gpt-5-mini/i],
  },
  {
    id: "gpt-frontier",
    tier: "strong",
    patterns: [/gpt-5(?!-mini)/i, /gpt-4\.1(?!-mini)/i, /gpt-4o(?!-mini)/i, /o[34]-mini/i],
  },
  {
    id: "mistral-small",
    tier: "fast",
    patterns: [/mistral-small/i, /ministral/i, /open-mistral/i],
  },
  {
    id: "mistral-large",
    tier: "strong",
    patterns: [/mistral-large/i, /mistral-medium/i],
  },
  {
    id: "codestral",
    tier: "balanced",
    patterns: [/codestral/i],
  },
  {
    id: "gemma",
    tier: "fast",
    patterns: [/gemma/i],
  },
  {
    id: "command",
    tier: "balanced",
    patterns: [/command-a/i, /command-r/i, /command(?!.*light)/i],
  },
  {
    id: "kimi",
    tier: "strong",
    patterns: [/kimi/i, /moonshot/i],
  },
  {
    id: "nemotron",
    tier: "balanced",
    patterns: [/nemotron/i],
  },
];

const TIER_ORDER: Record<Tier, number> = { fast: 0, balanced: 1, strong: 2 };

export function tierRank(t: Tier): number {
  return TIER_ORDER[t];
}

/**
 * Map a provider-native model ID onto a canonical family.
 *
 * Unknown models get a conservative `balanced` default rather than being
 * dropped — dropping means new models stay invisible until the next release.
 */
export function resolveFamily(
  modelId: string,
  families: Family[] = FAMILIES,
): { family: string; tier: Tier } {
  for (const f of families) {
    if (f.patterns.some((p) => p.test(modelId))) {
      return { family: f.id, tier: f.tier };
    }
  }
  return { family: "unknown", tier: "balanced" };
}

/** Filter out non-chat models that show up in `/models` catalogs. */
const NON_CHAT = [
  /whisper/i,
  /embed/i,
  /bge-/i,
  /rerank/i,
  /tts/i,
  /text-to-speech/i,
  /speech/i,
  /orpheus/i,
  /guard/i,
  /moderation/i,
  /flux/i,
  /stable-diffusion/i,
  /sdxl/i,
  /resnet/i,
  /detr/i,
  /melotts/i,
  /distil/i,
  /vision-encoder/i,
];

export function isChatModel(modelId: string): boolean {
  return !NON_CHAT.some((p) => p.test(modelId));
}
