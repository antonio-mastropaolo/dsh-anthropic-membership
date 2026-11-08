// lib/cost/caps.mjs — spend caps. Semantics ported from agent-patcher/meter/quota.mjs: a cap of 0 is
// OFF, caps are checked session -> provider daily -> global daily, a value that cannot be trusted
// falls back to the DEFAULT (never to "no limit"), and only the first breach blocks.
// DSH difference (spec): block ONLY when billing === "metered". Subscription/free/local never block.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CAPS = Object.freeze({ dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: {}, warnPct: 50 });
const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Merge a parsed caps.json over the defaults. Invalid fields fall back to the default and are named in `warnings`. */
export function normalizeCaps(obj) {
  const caps = { dailyUsd: DEFAULT_CAPS.dailyUsd, sessionUsd: DEFAULT_CAPS.sessionUsd, perProviderDailyUsd: {}, warnPct: DEFAULT_CAPS.warnPct };
  const warnings = [];
  if (obj == null) return { caps, warnings };
  if (typeof obj !== 'object' || Array.isArray(obj)) return { caps, warnings: ['caps.json: not an object, defaults used'] };
  for (const k of ['dailyUsd', 'sessionUsd']) {
    if (obj[k] === undefined) continue;
    if (ok(obj[k])) caps[k] = obj[k]; else warnings.push(`caps.json: ${k} must be a number >= 0, default kept`);
  }
  if (obj.warnPct !== undefined) {
    if (ok(obj.warnPct) && obj.warnPct <= 100) caps.warnPct = obj.warnPct; else warnings.push('caps.json: warnPct must be 0..100, default kept');
  }
  if (obj.perProviderDailyUsd !== undefined) {
    if (obj.perProviderDailyUsd && typeof obj.perProviderDailyUsd === 'object' && !Array.isArray(obj.perProviderDailyUsd)) {
      for (const [p, v] of Object.entries(obj.perProviderDailyUsd)) {
        if (ok(v)) caps.perProviderDailyUsd[p] = v; else warnings.push(`caps.json: perProviderDailyUsd.${p} must be a number >= 0, ignored`);
      }
    } else warnings.push('caps.json: perProviderDailyUsd must be an object, ignored');
  }
  return { caps, warnings };
}

/** loadCaps(dataDir) -> caps (defaults when caps.json is missing/unreadable). Warnings are on the non-enumerable `warnings`. */
export function loadCaps(dataDir) {
  let obj = null;
  try { obj = JSON.parse(fs.readFileSync(path.join(dataDir, 'caps.json'), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') { const { caps } = normalizeCaps(undefined); Object.defineProperty(caps, 'warnings', { value: ['caps.json unreadable, defaults used'], enumerable: false }); return caps; }
  }
  const { caps, warnings } = normalizeCaps(obj);
  Object.defineProperty(caps, 'warnings', { value: warnings, enumerable: false });
  return caps;
}

export function saveCaps(dataDir, caps) {
  const { caps: clean } = normalizeCaps(caps);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'caps.json');
  const tmp = path.join(dataDir, `.caps.json.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return clean;
}

const usd = (n) => `$${(n || 0).toFixed(2)}`;
const pctOf = (spent, cap) => (cap > 0 ? Math.floor((spent * 100) / cap + 1e-9) : 0);

/**
 * checkCaps({summary, provider, sessionId, billing, caps, priced, sessionSummary}) -> {action, reason, pct, which}
 * summary = ledger.summarize(...) for TODAY (global + provider daily come from summary.totals / summary.byProvider;
 * the session spend comes from sessionSummary.bySession (default: summary.bySession) — pass a wider window so a
 * session that crosses midnight is not under-counted). action: "ok" | "warn" | "block". pct = highest used % of any cap (capped 100).
 * block ONLY for billing "metered"; a metered model with no confirmed price (priced === false) is a warn, or a block when that provider has a daily cap (its spend cannot be counted).
 */
export function checkCaps({ summary, provider, sessionId, billing, caps = DEFAULT_CAPS, priced = true, sessionSummary } = {}) {
  if (billing !== 'metered') return { action: 'ok', reason: `billing is ${billing || 'unknown'}, not metered: caps do not apply`, pct: 0, which: null };
  const c = { ...DEFAULT_CAPS, ...caps };
  const sess = (sessionSummary || summary)?.bySession?.[sessionId]?.usd || 0;
  const prov = summary?.byProvider?.[provider]?.usd || 0;
  const glob = summary?.totals?.usd || 0;
  const checks = [
    { which: 'session', cap: c.sessionUsd, spent: sess, msg: (cap, s) => `per-session cap $${cap} reached (this session spent ${usd(s)})` },
    { which: 'provider-daily', cap: c.perProviderDailyUsd?.[provider] || 0, spent: prov, msg: (cap, s) => `${provider} daily cap $${cap} reached (spent ${usd(s)} today)` },
    { which: 'daily', cap: c.dailyUsd, spent: glob, msg: (cap, s) => `daily cap $${cap} reached (spent ${usd(s)} today)` },
  ];
  let pct = 0, block = null, warn = null;
  // A metered model with no confirmed price adds $0 to the ledger, so a provider cap could never trip.
  // When the operator capped this provider, refuse instead of silently not counting.
  if (!priced && (c.perProviderDailyUsd?.[provider] || 0) > 0) {
    return { action: 'block', reason: `${provider} has a daily cap but this model has no confirmed price, so its spend cannot be counted. Add a price to ~/.dsh/model-hub/prices.json or remove the ${provider} cap`, pct: Math.min(100, Math.max(pct, pctOf(prov, c.perProviderDailyUsd[provider]))), which: 'unpriced-capped' };
  }
  for (const k of checks) {
    if (!(k.cap > 0)) continue;
    const p = pctOf(k.spent, k.cap);
    if (p > pct) pct = p;
    if (k.spent >= k.cap) { if (!block) block = { which: k.which, reason: k.msg(k.cap, k.spent) }; }
    else if (c.warnPct > 0 && p >= c.warnPct && !warn) warn = { which: k.which, reason: `${k.which} ${usd(k.spent)} is ${p}% of $${k.cap}` };
  }
  pct = Math.min(100, pct);
  if (block) return { action: 'block', reason: block.reason, pct, which: block.which };
  if (warn) return { action: 'warn', reason: warn.reason, pct, which: warn.which };
  if (!priced) return { action: 'warn', reason: `${provider} model has no confirmed price: spend is not counted`, pct, which: 'unpriced' };
  return { action: 'ok', reason: 'within caps', pct, which: null };
}
