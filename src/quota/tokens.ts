/**
 * Token estimation. No tokenizer is bundled — every provider uses a different
 * one. Deliberately over-counts: under-counting eats a failed request against
 * a hard input cap.
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
 * Rough neuron cost for Cloudflare Workers AI, which meters GPU compute rather
 * than requests. Always low confidence; faking a request count would be worse.
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
