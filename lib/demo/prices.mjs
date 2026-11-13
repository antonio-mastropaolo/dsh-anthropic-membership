// lib/demo/prices.mjs: the bundled, offline price table the demo ledger is priced with (LiteLLM-shaped entries, plus a
// pinned Ollama table). The rates are synthetic: they exist so that every demo row re-prices exactly. No file or
// socket is touched here.
import { normalizeOverrides } from "../cost/prices.mjs";
import { sanitizeOllamaModels } from "../cost/ollama-prices.mjs";

/** Providers the demo treats as holding an OAuth grant (so their calls are billed as subscription). */
export const DEMO_OAUTH_PROVIDERS = Object.freeze(["anthropic", "openai-codex"]);
export const DEMO_LOCAL_PROVIDERS = Object.freeze(["demo-gpu"]);

/** The prices.json written into every demo folder. */
export const DEMO_OVERRIDES = Object.freeze({ "dashscope/qwen-flash": Object.freeze({ inPerM: 0, outPerM: 0, billing: "free" }) });

// USD per TOKEN, as in LiteLLM's table.
export const DEMO_ENTRIES = Object.freeze({
  "claude-sonnet-5-5": { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6, litellm_provider: "anthropic", mode: "chat" },
  "gpt-5.5-codex": { input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 1.25e-7, litellm_provider: "openai", mode: "chat" },
  "gemini/gemini-3.8-flash": { input_cost_per_token: 5e-7, output_cost_per_token: 3e-6, cache_read_input_token_cost: 1.25e-7, litellm_provider: "gemini", mode: "chat" },
  "openrouter/deepseek/deepseek-v4-pro": { input_cost_per_token: 1.5e-6, output_cost_per_token: 6e-6, cache_read_input_token_cost: 1.5e-7, litellm_provider: "openrouter", mode: "chat" },
});

const T = (inPerM, cachedPerM, outPerM) => ({ inPerM, cachedPerM, outPerM });
/** Ollama Cloud rates for the two plan models, pinned here (same numbers as the bundled snapshot of 2026-11-09). */
export const DEMO_OLLAMA_MODELS = Object.freeze({
  "glm-5.3-flash": T(0.15, 0.03, 0.50),
  "deepseek-v4.1-flash": { ...T(0.30, 0.006, 1.20), offPeak: T(0.15, 0.003, 0.60) },
});

/** The table shape priceFor() reads: { entries, overrides, ollama, source, fetchedAt, count, warnings }. */
export function demoPriceTable({ overrides = DEMO_OVERRIDES } = {}) {
  const models = sanitizeOllamaModels(DEMO_OLLAMA_MODELS);
  return {
    entries: { ...DEMO_ENTRIES },
    overrides: normalizeOverrides(overrides),
    ollama: { models, source: "snapshot", date: "2026-11-09", fetchedAt: 0, count: Object.keys(models).length, url: "demo", warnings: [] },
    source: "demo", fetchedAt: 0, count: Object.keys(DEMO_ENTRIES).length, warnings: [],
  };
}

/** A loadTable() for the cost engine that cannot reach anything: the bundled table, nothing read or written. */
export async function demoLoadTable() { return demoPriceTable(); }
export async function demoLoadOllama() { return demoPriceTable().ollama; }
