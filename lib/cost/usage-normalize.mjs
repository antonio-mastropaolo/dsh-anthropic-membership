// lib/cost/usage-normalize.mjs — any usage shape -> {input, output, cacheRead, cacheWrite}.
//
// The four buckets are DISJOINT: `input` EXCLUDES cache reads and cache writes, so
// input + cacheRead + cacheWrite = billed prompt tokens and nothing is counted twice.
//
// Shapes seen (field names verified against DSH 0.2.2-rc.1 + pi-ai 1.5.0 source on 2026-11-08):
//  - DSH TokenUsage (assistant/message event `usage`): inputTokens (uncached), outputTokens,
//    cacheReadTokens?, cacheWriteTokens?, reasoningTokens?, totalTokens?   -> already disjoint.
//  - pi-ai Usage: input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost{}  -> already disjoint
//    (pi-ai subtracts cached from prompt_tokens / promptTokenCount itself).
//  - OpenAI chat: prompt_tokens (INCLUDES cached), completion_tokens, prompt_tokens_details.cached_tokens,
//    prompt_tokens_details.cache_write_tokens?; DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens;
//    Kimi: top-level cached_tokens.
//  - OpenAI Responses: input_tokens (INCLUDES cached) + input_tokens_details.cached_tokens.
//  - Anthropic: input_tokens (excludes cache), output_tokens, cache_read_input_tokens, cache_creation_input_tokens.
//  - Gemini: promptTokenCount (INCLUDES cached), candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount.
// Reasoning tokens are a subset of output for OpenAI/DSH/pi-ai (not added), but Gemini reports
// thoughtsTokenCount separately from candidatesTokenCount, so it is added there (matches pi-ai).

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const has = (o, k) => o[k] !== undefined && o[k] !== null;

export const ZERO_USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...ZERO_USAGE };
  const u = raw;

  // DSH TokenUsage (disjoint)
  if (has(u, 'inputTokens') || has(u, 'outputTokens')) {
    return { input: n(u.inputTokens), output: n(u.outputTokens), cacheRead: n(u.cacheReadTokens), cacheWrite: n(u.cacheWriteTokens) };
  }
  // Gemini usageMetadata
  if (has(u, 'promptTokenCount') || has(u, 'candidatesTokenCount')) {
    const cached = n(u.cachedContentTokenCount);
    return {
      input: Math.max(0, n(u.promptTokenCount) - cached),
      output: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount),
      cacheRead: cached,
      cacheWrite: 0,
    };
  }
  // pi-ai Usage / our own normalized shape (disjoint)
  if (has(u, 'cacheRead') || has(u, 'cacheWrite') || (has(u, 'input') && has(u, 'output'))) {
    return { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite) };
  }
  // OpenAI chat / DeepSeek / Kimi (prompt_tokens includes cache)
  if (has(u, 'prompt_tokens') || has(u, 'completion_tokens')) {
    const d = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {};
    const read = n(d.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens);
    const write = n(d.cache_write_tokens);
    return { input: Math.max(0, n(u.prompt_tokens) - read - write), output: n(u.completion_tokens), cacheRead: read, cacheWrite: write };
  }
  // Anthropic (input excludes cache)
  if (has(u, 'cache_read_input_tokens') || has(u, 'cache_creation_input_tokens')) {
    return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
  }
  // OpenAI Responses (input_tokens includes cached) or a bare {input_tokens, output_tokens}
  if (has(u, 'input_tokens') || has(u, 'output_tokens')) {
    const d = u.input_tokens_details && typeof u.input_tokens_details === 'object' ? u.input_tokens_details : null;
    const read = d ? n(d.cached_tokens) : 0;
    return { input: Math.max(0, n(u.input_tokens) - read), output: n(u.output_tokens), cacheRead: read, cacheWrite: 0 };
  }
  return { ...ZERO_USAGE };
}

/** Billed prompt tokens of a normalized usage (disjoint buckets summed). */
export const promptTokens = (u) => n(u?.input) + n(u?.cacheRead) + n(u?.cacheWrite);
