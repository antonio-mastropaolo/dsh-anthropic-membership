// lib/cost/caps.mjs — spend caps. Semantics ported from agent-patcher/meter/quota.mjs: a cap of 0 is
// OFF, caps are checked session -> provider daily -> global daily, a value that cannot be trusted
// falls back to the DEFAULT (never to "no limit"), and only the first breach blocks.
// DSH difference (spec): block ONLY when billing === "metered". Subscription/free/local never block.
import { sessionKey } from './ledger.mjs';
import { atomicWriteFile } from '../paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CAPS = Object.freeze({ dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: {}, warnPct: 50 });
const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Merge a parsed caps.json over the defaults. Invalid fields fall back to the default and are named in `warnings`. */
export function normalizeCaps(obj) {
  const caps = { dailyUsd: DEFAULT_CAPS.dailyUsd, sessionUsd: DEFAULT_CAPS.sessionUsd, perProviderDailyUsd: {}, warnPct: DEFAULT_CAPS.warnPct };
  const warnings = [];
  let stopAtPlanLimit = false;
  if (obj == null) return { caps, warnings, stopAtPlanLimit };
  if (typeof obj !== 'object' || Array.isArray(obj)) return { caps, warnings: ['caps.json: not an object, defaults used'], stopAtPlanLimit };
  if (obj.stopAtPlanLimit !== undefined) {
    if (typeof obj.stopAtPlanLimit === 'boolean') stopAtPlanLimit = obj.stopAtPlanLimit; else warnings.push('caps.json: stopAtPlanLimit must be true or false, default (off) kept');
  }
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
        if (p in Object.prototype) { warnings.push(`caps.json: perProviderDailyUsd.${p} is not a provider id, ignored`); continue; }
        if (ok(v)) caps.perProviderDailyUsd[p] = v; else warnings.push(`caps.json: perProviderDailyUsd.${p} must be a number >= 0, ignored`);
      }
    } else warnings.push('caps.json: perProviderDailyUsd must be an object, ignored');
  }
  return { caps, warnings, stopAtPlanLimit };
}

export const CAPS_FILE = 'caps.json';
export const CAP_MAX_USD = 1_000_000;
export const MAX_PROVIDER_CAPS = 64;
// the same pattern as SLUG_RE in lib/config.mjs (a test pins that they are equal)
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const capsPath = (dataDir) => path.join(dataDir, CAPS_FILE);

/** Raw read: { file, exists, text, parsed, problem }; problem: null | 'not valid JSON' | 'not a JSON object' | 'unreadable (EACCES)'. A missing file is not a problem. */
export function readCapsFile(dataDir) {
  const file = capsPath(dataDir);
  const r = { file, exists: false, text: null, parsed: undefined, problem: null };
  try { r.text = fs.readFileSync(file, 'utf8'); r.exists = true; }
  catch (e) {
    if (e.code === 'ENOENT') return r;
    r.exists = true; r.problem = `unreadable (${e.code || 'error'})`; return r;
  }
  try { r.parsed = JSON.parse(r.text); } catch { r.problem = 'not valid JSON'; return r; }
  if (r.parsed === null || typeof r.parsed !== 'object' || Array.isArray(r.parsed)) { r.problem = 'not a JSON object'; r.parsed = undefined; }
  return r;
}

/** loadCaps(dataDir) -> caps (defaults when caps.json is missing/invalid). Non-enumerable extras: warnings, problem, exists, file, stopAtPlanLimit (the opt-in plan stop, default false). */
export function loadCaps(dataDir) {
  const r = readCapsFile(dataDir);
  const { caps, warnings, stopAtPlanLimit } = normalizeCaps(r.parsed);
  if (r.problem) warnings.push(`caps.json: ${r.problem}, defaults used`);
  for (const [k, value] of Object.entries({ warnings, problem: r.problem, exists: r.exists, file: r.file, stopAtPlanLimit })) Object.defineProperty(caps, k, { value, enumerable: false });
  return caps;
}

const strip = (w) => w.replace(/^caps\.json:\s*/, '').replace(/,\s*(default kept|defaults used|ignored)$/, '');
/** What the UI/CLI/host show: { file, exists, caps, defaults, problem, fatal, warnings }. fatal = the whole file is ignored. */
export function capsView(dataDir) {
  const c = loadCaps(dataDir);
  const reasons = c.problem ? [c.problem] : c.warnings.map(strip);
  return {
    file: c.file, exists: c.exists,
    caps: { dailyUsd: c.dailyUsd, sessionUsd: c.sessionUsd, perProviderDailyUsd: { ...c.perProviderDailyUsd }, warnPct: c.warnPct },
    stopAtPlanLimit: c.stopAtPlanLimit,
    defaults: { dailyUsd: DEFAULT_CAPS.dailyUsd, sessionUsd: DEFAULT_CAPS.sessionUsd, perProviderDailyUsd: {}, warnPct: DEFAULT_CAPS.warnPct, stopAtPlanLimit: false },
    problem: reasons.length ? `caps.json invalid: ${reasons.join('; ')}; using defaults` : null,
    fatal: Boolean(c.problem),
    warnings: [...c.warnings],
  };
}

/** Strict validation of ONE flat change map (CLI and host share it) -> { ok:true, changes } | { ok:false, errors:[string] }. */
export function validateCapsChange(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['set must be an object'] };
  const keys = Object.keys(input); // own enumerable keys only
  if (!keys.length) return { ok: false, errors: ['nothing to change'] };
  if (keys.length > MAX_PROVIDER_CAPS + 5) return { ok: false, errors: ['too many keys'] };
  const errors = [];
  const changes = Object.create(null);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const k of keys) {
    const v = input[k];
    if (k === 'dailyUsd' || k === 'sessionUsd') {
      if (isNum(v) && v >= 0 && v <= CAP_MAX_USD) changes[k] = v; else errors.push(`${k} must be a number from 0 to ${CAP_MAX_USD} (0 = off)`);
    } else if (k === 'warnPct') {
      if (Number.isInteger(v) && v >= 1 && v <= 99) changes[k] = v; else errors.push('warnPct must be a whole number from 1 to 99');
    } else if (k === 'stopAtPlanLimit') {
      if (typeof v === 'boolean') changes[k] = v; else errors.push('stopAtPlanLimit must be true or false');
    } else if (k.startsWith('provider.')) {
      const id = k.slice(9);
      if (!PROVIDER_ID_RE.test(id) || id in Object.prototype) { errors.push(`${JSON.stringify(k.slice(0, 60))}: provider id must match ${PROVIDER_ID_RE.source}`); continue; }
      if (v === null || (isNum(v) && v === 0)) changes[k] = null;
      else if (isNum(v) && v > 0 && v <= CAP_MAX_USD) changes[k] = v;
      else errors.push(`${k} must be a number from 0 to ${CAP_MAX_USD}, or off/null to remove it`);
    } else errors.push(`unknown key ${JSON.stringify(k).slice(0, 60)}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, changes: { ...changes } };
}

const NUM_RE = /^\d{1,9}(\.\d{1,6})?$/;
/** CLI words -> the same flat map: `dailyUsd=40 provider.google=5 provider.xai=off` -> { ok:true, input } | { ok:false, errors }. A value that is not a plain decimal stays a string and fails validation. */
export function parseCapsAssignments(args) {
  if (!Array.isArray(args) || !args.length) return { ok: false, errors: ['nothing to change: give key=value pairs (dailyUsd= sessionUsd= warnPct= stopAtPlanLimit=on|off provider.<id>=)'] };
  const input = Object.create(null);
  const errors = [];
  for (const a of args) {
    const i = String(a).indexOf('=');
    if (i < 1) { errors.push(`${JSON.stringify(String(a).slice(0, 60))}: expected key=value`); continue; }
    const k = a.slice(0, i), raw = a.slice(i + 1);
    if (k in input) { errors.push(`${JSON.stringify(k.slice(0, 60))} given twice`); continue; }
    if (k === 'stopAtPlanLimit' && (raw === 'on' || raw === 'off')) input[k] = raw === 'on';
    else if (raw === 'off') input[k] = k.startsWith('provider.') ? null : 0;
    else if (NUM_RE.test(raw)) input[k] = Number(raw);
    else input[k] = raw;
  }
  return errors.length ? { ok: false, errors } : { ok: true, input };
}

/** Merge `changes` over the NORMALIZED current file and write exactly the caps keys atomically (0600).
 *  No lock: the file is re-read right before the write and the merge is redone (up to 3 times) when another writer changed
 *  it in between, so two writers lose an update only if both land inside the few microseconds between that re-read and the rename.
 *  -> { ok:true, replaced: <old problem>|null, view } | { ok:false, errors } */
export function applyCapsChange(dataDir, changes) {
  for (let attempt = 0; ; attempt++) {
    const cur = readCapsFile(dataDir);
    if (cur.problem && cur.problem.startsWith('unreadable')) return { ok: false, errors: [`caps.json is ${cur.problem}: fix it first`] };
    const { caps, warnings, stopAtPlanLimit } = normalizeCaps(cur.parsed);
    const doc = { dailyUsd: caps.dailyUsd, sessionUsd: caps.sessionUsd, perProviderDailyUsd: { ...caps.perProviderDailyUsd }, warnPct: caps.warnPct, stopAtPlanLimit };
    for (const [k, v] of Object.entries(changes)) {
      if (k.startsWith('provider.')) { const id = k.slice(9); if (v === null) delete doc.perProviderDailyUsd[id]; else doc.perProviderDailyUsd[id] = v; }
      else doc[k] = v;
    }
    if (Object.keys(doc.perProviderDailyUsd).length > MAX_PROVIDER_CAPS) return { ok: false, errors: [`at most ${MAX_PROVIDER_CAPS} provider caps`] };
    if (attempt < 2 && readCapsFile(dataDir).text !== cur.text) continue; // someone else wrote meanwhile: merge over their version
    const reasons = cur.problem ? [cur.problem] : warnings.map(strip);
    const replaced = reasons.length ? reasons.join('; ') : null;
    if (replaced && cur.text) atomicWriteFile(`${cur.file}.broken`, cur.text.slice(0, 65536), 0o600);
    atomicWriteFile(cur.file, JSON.stringify(doc, null, 2) + '\n', 0o600);
    return { ok: true, replaced, view: capsView(dataDir) };
  }
}
export const setCaps = (dataDir, input) => { const v = validateCapsChange(input); return v.ok ? applyCapsChange(dataDir, v.changes) : v; };

/** Kept export: normalize + atomic write (no predictable temp name, never follows a symlink). */
export function saveCaps(dataDir, caps) {
  const { caps: clean, stopAtPlanLimit } = normalizeCaps(caps);
  atomicWriteFile(capsPath(dataDir), JSON.stringify({ ...clean, stopAtPlanLimit }, null, 2) + '\n', 0o600);
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
  const sess = (sessionSummary || summary)?.bySession?.[sessionKey(sessionId)]?.usd || 0;
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
    return { action: 'block', reason: `${provider} has a daily cap but this model has no confirmed price, so its spend cannot be counted. Add a price to prices.json in the model-hub data dir or remove the ${provider} cap`, pct: Math.min(100, Math.max(pct, pctOf(prov, c.perProviderDailyUsd[provider]))), which: 'unpriced-capped' };
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
