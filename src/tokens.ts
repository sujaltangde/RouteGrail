/**
 * Token estimation.
 *
 * No tokenizer is bundled — every provider here uses a different one, and
 * shipping tiktoken for a routing decision is not worth the weight. The
 * estimate is deliberately conservative (over-counts) because the cost of
 * under-counting is routing an oversized prompt into GitHub Models' hard
 * 8K input cap and eating a failed request.
 */

const CHARS_PER_TOKEN = 3.6; // conservative; real English is ~4
const SAFETY_MARGIN = 1.15;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const byChars = text.length / CHARS_PER_TOKEN;
  // CJK and code tokenize much denser than prose; take the worse estimate.
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const adjusted = byChars + cjk * 0.6;
  return Math.ceil(adjusted * SAFETY_MARGIN);
}

export function estimateRequestTokens(prompt: string, system?: string): number {
  // ~4 tokens of chat-template overhead per message.
  return estimateTokens(prompt) + estimateTokens(system ?? "") + 8;
}

/**
 * Rough neuron cost for Cloudflare Workers AI.
 *
 * Cloudflare meters GPU compute, not requests, and the per-model rate varies
 * sharply. This is an estimate and is always reported with low confidence —
 * the alternative (faking a request count) would silently corrupt the ledger.
 */
export function estimateNeurons(modelId: string, totalTokens: number): number {
  const perKTokens = /120b|70b|72b|large/i.test(modelId)
    ? 90
    : /32b|24b|27b/i.test(modelId)
      ? 45
      : /8b|9b|7b|20b|12b/i.test(modelId)
        ? 20
        : 30;
  return Math.ceil((totalTokens / 1000) * perKTokens) + 1;
}
