// lib/cost/ollama-snapshot.mjs — bundled copy of Ollama Cloud's published per-token rates (USD per million tokens).
// Source: https://ollama.com/pricing, copied 2026-11-09. A refreshed copy (<dataDir>/ollama-prices.json) replaces
// it at run time; this one only answers when the page was never fetched. Tuples are [input, cachedInput, output];
// null = the page lists "-" (not offered): that rate stays unknown. offPeak applies outside 12:00-18:00 UTC on
// weekdays and all day on weekends.
export const OLLAMA_PRICING_URL = 'https://ollama.com/pricing';
export const OLLAMA_SNAPSHOT_DATE = '2026-11-09';

const T = (inPerM, cachedPerM, outPerM) => ({ inPerM, cachedPerM, outPerM });
const models = {
  beam: T(0.125, 0.015, 0.40),
  clef: T(0.24, null, null),
  'deepseek-v4.1-flash': { ...T(0.30, 0.006, 1.20), offPeak: T(0.15, 0.003, 0.60) },
  'deepseek-v4-pro': { ...T(1.32, 0.044, 3.96), offPeak: T(0.66, 0.022, 1.98) },
  gemma4: T(0.14, 0.05, 0.40),
  'glm-5.3': T(1.40, 0.26, 4.40),
  'glm-5.3-flash': T(0.15, 0.03, 0.50),
  'glm-5.2': T(1.40, 0.26, 4.40),
  'gpt-oss:120b': T(0.15, 0.014, 0.60),
  'gpt-oss:20b': T(0.07, 0.035, 0.30),
  'kimi-k3.1-pro': T(2.00, 0.20, 10.00),
  'kimi-k3': T(3.00, 0.30, 15.00),
  'kimi-k2.7-code': T(0.95, 0.19, 4.00),
  'kimi-k2.6': T(0.95, 0.16, 4.00),
  'mimo-v2.6-flash': T(0.14, 0.0028, 0.28),
  'mimo-v2.6-pro': T(0.435, 0.0036, 0.87),
  'minimax-m3.1-flash': T(0.15, 0.015, 0.60),
  'minimax-m3': T(0.60, 0.12, 2.40),
  'mistral-large-4': T(0.70, 0.07, 2.10),
  'muse-spark-open': T(1.25, 0.15, 4.25),
  'nemotron-3-super': T(0.015, 0.015, 0.60),
  'nemotron-3-ultra': T(0.10, 0.10, 3.00),
};
export const OLLAMA_SNAPSHOT = Object.freeze({ source: OLLAMA_PRICING_URL, date: OLLAMA_SNAPSHOT_DATE, models });
