// lib/cost/cache-check.mjs — prompt-cache hit tracking and "why did the cache just die" alerts.
import { normalizeUsage, promptTokens } from './usage-normalize.mjs';

const PREV_HIT_MIN = 0.5, HIT_MAX = 0.05, MIN_PROMPT = 2000, MAX_SESSIONS = 200;

export function createCacheTracker({ maxSessions = MAX_SESSIONS } = {}) {
  const sessions = new Map(); // LRU by insertion order

  function get(id) {
    let s = sessions.get(id);
    if (s) { sessions.delete(id); sessions.set(id, s); return s; }
    s = { steps: 0, last: null, cacheReadTotal: 0, promptTotal: 0, alerts: 0, lastAlert: null };
    sessions.set(id, s);
    if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return s;
  }

  /**
   * observe({sessionId, step, provider, model, usage, fingerprints:{system,tools}}) -> {hitRatio, promptTokens, alert?}
   * alert when the previous step hit >= 0.5, this one < 0.05 and the prompt >= 2000 tokens. reason, first match:
   * model-changed (provider/model differs) > system-prompt-changed > tools-changed (fingerprints differ)
   * > compaction (prompt shrank below 60% of the previous) > unknown (likely cache expiry/eviction).
   */
  function observe({ sessionId = '', step, provider = '', model = '', usage, fingerprints } = {}) {
    const u = normalizeUsage(usage);
    const prompt = promptTokens(u);
    const hitRatio = prompt > 0 ? u.cacheRead / prompt : 0;
    const s = get(sessionId);
    const prev = s.last;
    let alert;
    if (prev && prev.hitRatio >= PREV_HIT_MIN && hitRatio < HIT_MAX && prompt >= MIN_PROMPT) {
      let reason = 'unknown';
      if (prev.provider !== provider || prev.model !== model) reason = 'model-changed';
      else if (fingerprints?.system !== undefined && prev.fp?.system !== undefined && fingerprints.system !== prev.fp.system) reason = 'system-prompt-changed';
      else if (fingerprints?.tools !== undefined && prev.fp?.tools !== undefined && fingerprints.tools !== prev.fp.tools) reason = 'tools-changed';
      else if (prompt < prev.promptTokens * 0.6) reason = 'compaction';
      alert = { reason, prevHit: prev.hitRatio, hit: hitRatio };
      s.alerts++; s.lastAlert = { ...alert, step: step ?? s.steps + 1 };
    }
    s.steps++;
    s.cacheReadTotal += u.cacheRead; s.promptTotal += prompt;
    s.last = { step: step ?? s.steps, provider, model, hitRatio, promptTokens: prompt, fp: fingerprints ? { system: fingerprints.system, tools: fingerprints.tools } : undefined };
    return alert ? { hitRatio, promptTokens: prompt, alert } : { hitRatio, promptTokens: prompt };
  }

  /** stats(sessionId) -> {steps, lastHit, avgHit (token-weighted), cacheReadTokens, promptTokens, alerts, lastAlert} | null */
  function stats(sessionId = '') {
    const s = sessions.get(sessionId);
    if (!s) return null;
    return {
      steps: s.steps, lastHit: s.last ? s.last.hitRatio : 0,
      avgHit: s.promptTotal > 0 ? s.cacheReadTotal / s.promptTotal : 0,
      cacheReadTokens: s.cacheReadTotal, promptTokens: s.promptTotal, alerts: s.alerts, lastAlert: s.lastAlert,
      provider: s.last?.provider, model: s.last?.model,
    };
  }
  return { observe, stats, forget: (id) => sessions.delete(id), sessionIds: () => [...sessions.keys()] };
}
