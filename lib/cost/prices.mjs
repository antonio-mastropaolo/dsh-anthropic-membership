// lib/cost/prices.mjs — price table (LiteLLM + operator overrides) and per-model lookup.
// Node built-ins only; network is an injected fetch. Never guesses: unknown model => source "unpriced".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../accounts/errors.mjs';
import { isCloudModelId, isOffPeak, isOllamaCloudHost, ollamaModelKey, snapshotTable } from './ollama-prices.mjs';

/** A provider/model id as used by priceModels, /prices and the ledger: provider slug + "/" + model (the model part
 *  may itself contain "/", e.g. openrouter/vendor/model). At most 120 characters. The client keeps a copy of this
 *  pattern (lib/client.js PRICE_ID_SRC); a test asserts the two are identical. */
export const PRICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}\/[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,78}$/;
export const PRICE_ID_MAX = 120;
export const isPriceId = (s) => typeof s === 'string' && s.length <= PRICE_ID_MAX && PRICE_ID_RE.test(s);
export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const BACKUP_NAME = 'model_prices_and_context_window_backup.json';
/** Offline fallback table: $DSH_HUB_PRICE_FALLBACK, else the newest pip-installed litellm backup found under ~/Library/Python and ~/.local, else null. */
export function discoverFallbackPath(home = os.homedir(), env = process.env) {
  if (env.DSH_HUB_PRICE_FALLBACK) return env.DSH_HUB_PRICE_FALLBACK;
  const roots = [path.join(home, 'Library', 'Python'), path.join(home, '.local', 'lib')];
  const found = [];
  for (const root of roots) {
    let vers = [];
    try { vers = fs.readdirSync(root); } catch { continue; }
    for (const v of vers) {
      const f = path.join(root, v, 'lib', 'python', 'site-packages', 'litellm', BACKUP_NAME);
      const g = path.join(root, v, 'site-packages', 'litellm', BACKUP_NAME);
      for (const c of [f, g]) { try { found.push({ c, m: fs.statSync(c).mtimeMs }); } catch { /* absent */ } }
    }
  }
  found.sort((a, b) => b.m - a.m);
  return found[0]?.c ?? null;
}
export const DEFAULT_FALLBACK_PATH = discoverFallbackPath();
export const CACHE_TTL_MS = 24 * 3600e3;
const MIN_ENTRIES = 100; // a "price table" smaller than this is an error page / wrong file, not data

export const BILLING = Object.freeze({
  google: 'metered', openrouter: 'metered', xai: 'metered', 'ollama-cloud': 'metered', ollama: 'metered',
  // "subscription" = billed to a Pro/Max/ChatGPT-style plan, which only holds when the user signed in with OAuth;
  // priceFor() downgrades these to metered when opts.oauthProviders says there is no OAuth grant (e.g. an API key).
  anthropic: 'subscription', 'openai-codex': 'subscription', 'github-copilot': 'subscription',
});

/** Providers with built-in pricing (a billing default or LiteLLM key mapping): never treated as local, even when
 *  listed in localProviders, so a config typo cannot make a paid API free and uncapped. README lists the same set
 *  (a test keeps them identical). */
export const PAID_PROVIDERS = Object.freeze(['anthropic', 'dashscope', 'deepseek-account', 'deepseek-official', 'github-copilot', 'google', 'ollama', 'ollama-cloud', 'openai-codex', 'openrouter', 'xai']);

// LiteLLM key candidates per provider, tried in order ({m} = model id as given).
const KEYS = {
  google: (m) => [`gemini/${m}`, m, `vertex_ai/${m}`],
  openrouter: (m) => [`openrouter/${m}`, m],
  xai: (m) => [`xai/${m}`, m],
  'ollama-cloud': (m) => [`ollama/${m}`, m],
  ollama: (m) => [`ollama/${m}`, m],
  anthropic: (m) => [m, `anthropic/${m}`],
  'openai-codex': (m) => [m, `openai/${m}`],
  'github-copilot': (m) => [`github_copilot/${m}`, m],
  dashscope: (m) => [`dashscope/${m}`],
  // DSH's own DeepSeek routes (API key, and the DeepSeek account sign-in)
  'deepseek-official': (m) => [m, `deepseek/${m}`],
  'deepseek-account': (m) => [m, `deepseek/${m}`],
};

const r = (x) => Number(Number(x).toPrecision(12));
const perM = (perToken) => (typeof perToken === 'number' && Number.isFinite(perToken) && perToken >= 0 ? r(perToken * 1e6) : null);
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }

/** Keep only entries that carry a token price (shrinks the 3.4 MB table for the on-disk cache). */
function slim(raw) {
  const out = Object.create(null); // a "__proto__" key from the network can never reach Object.prototype
  for (const [k, v] of Object.entries(raw || {})) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (v && typeof v === 'object' && (num(v.input_cost_per_token) || num(v.output_cost_per_token))) {
      const e = {};
      for (const f of ['input_cost_per_token', 'output_cost_per_token', 'cache_read_input_token_cost', 'cache_creation_input_token_cost',
        'input_cost_per_token_above_200k_tokens', 'output_cost_per_token_above_200k_tokens',
        'cache_read_input_token_cost_above_200k_tokens', 'cache_creation_input_token_cost_above_200k_tokens', 'litellm_provider', 'mode']) {
        if (v[f] !== undefined) e[f] = v[f];
      }
      out[k] = e;
    }
  }
  return out;
}

const MAX_TABLE_BYTES = 25 * 1024 * 1024; // the real table is ~3.4 MB
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Read a fetch Response with a hard size cap (streamed when possible); falls back to json() for minimal fakes. */
async function readCapped(res, max = MAX_TABLE_BYTES) {
  const len = Number(res.headers?.get?.('content-length') || 0);
  if (len > max) throw new Error('price table too large');
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('price table too large'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  if (typeof res.text === 'function') {
    const t = await res.text();
    if (t.length > max) throw new Error('price table too large');
    return JSON.parse(t);
  }
  return res.json();
}

async function fetchTable(fetchImpl, url, timeoutMs = 20000) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, ac ? { signal: ac.signal } : undefined);
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
    const raw = await readCapped(res);
    if (!raw || typeof raw !== 'object' || Object.keys(raw).length < MIN_ENTRIES) throw new Error('price table too small / malformed');
    return raw;
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Load the price table. Order: fresh (<24h) cache -> network -> stale cache -> offline fallback file.
 * Returns { entries, overrides, source, fetchedAt, count, warnings }.
 */
export async function loadPriceTable({ dataDir, fetchImpl = globalThis.fetch, now = Date.now(), fallbackPath = DEFAULT_FALLBACK_PATH, url = LITELLM_URL, ttlMs = CACHE_TTL_MS } = {}) {
  const warnings = [];
  const cacheFile = dataDir ? path.join(dataDir, 'prices.litellm.json') : null;
  const overrides = dataDir ? loadOverrides(dataDir, warnings) : {};
  const cache = cacheFile ? readJson(cacheFile) : null;
  const cacheOk = cache && typeof cache === 'object' && cache.entries && typeof cache.fetchedAt === 'number';
  // warnings can carry error text from the network (e.g. a JSON parser quoting the response): redact them
  const done = (entries, source, fetchedAt) => ({ entries, overrides, source, fetchedAt, count: Object.keys(entries).length, warnings: warnings.map(redactSecrets) });

  if (cacheOk && now - cache.fetchedAt < ttlMs && now >= cache.fetchedAt) return done(cache.entries, 'cache', cache.fetchedAt);

  if (typeof fetchImpl === 'function') {
    try {
      const entries = slim(await fetchTable(fetchImpl, url));
      if (cacheFile) {
        try { ensureDir(dataDir); writeAtomic(cacheFile, JSON.stringify({ fetchedAt: now, entries })); }
        catch (e) { warnings.push(`could not write price cache: ${e.code || e.message}`); }
      }
      return done(entries, 'network', now);
    } catch (e) { warnings.push(`price fetch failed: ${String(e.message).slice(0, 120)}`); }
  } else warnings.push('no fetch available');

  if (cacheOk) { warnings.push('using stale price cache'); return done(cache.entries, 'stale-cache', cache.fetchedAt); }

  const fb = fallbackPath ? readJson(fallbackPath) : null;
  if (fb && typeof fb === 'object' && Object.keys(fb).length >= MIN_ENTRIES) {
    warnings.push('using offline fallback price table (may be missing the newest models)');
    return done(slim(fb), 'fallback', 0);
  }
  warnings.push('no price table available: every model is unpriced');
  return done({}, 'none', 0);
}

/** The operator's prices.json in dataDir, validated (missing file = no overrides). */
export function loadOverrides(dataDir, warnings = []) {
  return normalizeOverrides(readJson(path.join(dataDir, 'prices.json')), warnings);
}

/** prices.json: { "provider/model": {inPerM,outPerM,cacheReadPerM?,cacheWritePerM?,billing?} }. Bad rows are dropped with a warning. */
export function normalizeOverrides(obj, warnings = []) {
  const out = Object.create(null);
  if (obj == null) return out;
  if (typeof obj !== 'object' || Array.isArray(obj)) { warnings.push('prices.json: not an object, ignored'); return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (UNSAFE_KEYS.has(k)) { warnings.push(`prices.json: "${k}" ignored`); continue; }
    if (v && typeof v === 'object' && num(v.inPerM) && num(v.outPerM)
      && (v.cacheReadPerM === undefined || num(v.cacheReadPerM)) && (v.cacheWritePerM === undefined || num(v.cacheWritePerM))) {
      out[k] = { inPerM: v.inPerM, outPerM: v.outPerM, cacheReadPerM: v.cacheReadPerM, cacheWritePerM: v.cacheWritePerM,
        billing: ['metered', 'subscription', 'free', 'local'].includes(v.billing) ? v.billing : undefined };
    } else warnings.push(`prices.json: "${k}" is invalid (needs numeric inPerM and outPerM >= 0), ignored`);
  }
  return out;
}

function fromEntry(e, billing, source) {
  const inPerM = perM(e.input_cost_per_token), outPerM = perM(e.output_cost_per_token);
  if (inPerM === null || outPerM === null) return null;
  const derived = [];
  let cacheReadPerM = perM(e.cache_read_input_token_cost);
  let cacheWritePerM = perM(e.cache_creation_input_token_cost);
  // Missing cache prices are charged at the full input rate (over-, never under-estimate); flagged in `derived`.
  if (cacheReadPerM === null) { cacheReadPerM = inPerM; derived.push('cacheRead'); }
  if (cacheWritePerM === null) { cacheWritePerM = inPerM; derived.push('cacheWrite'); }
  const p = { inPerM, outPerM, cacheReadPerM, cacheWritePerM, source, billing };
  const i2 = perM(e.input_cost_per_token_above_200k_tokens), o2 = perM(e.output_cost_per_token_above_200k_tokens);
  if (i2 !== null && o2 !== null) {
    const cr2 = perM(e.cache_read_input_token_cost_above_200k_tokens);
    const cw2 = perM(e.cache_creation_input_token_cost_above_200k_tokens);
    // a missing high-context cache-write rate is never charged below the base cache-write or high-context input rate
    p.above200k = { inPerM: i2, outPerM: o2, cacheReadPerM: cr2 !== null ? cr2 : i2, cacheWritePerM: cw2 !== null ? cw2 : Math.max(cacheWritePerM, i2) };
  }
  if (derived.length) p.derived = derived;
  return p;
}

const zeroPrice = (source, billing) => ({ inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, source, billing });

/** Split "google/gemini-3.8-flash" into provider + model when called with a single combined id. */
function split(provider, modelId) {
  if (modelId === undefined) {
    const s = String(provider || ''); const i = s.indexOf('/');
    return i < 0 ? { provider: '', model: s } : { provider: s.slice(0, i), model: s.slice(i + 1) };
  }
  let m = String(modelId || ''); const p = String(provider || '');
  if (p && m.startsWith(`${p}/`)) m = m.slice(p.length + 1);
  return { provider: p, model: m };
}

/** True for a loopback or private-network base URL (localhost, 127/8, ::1, 10/8, 172.16/12, 192.168/16, 100.64/10, *.local). */
export function isLocalBaseURL(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return false;
  let host;
  try { host = new URL(baseURL.trim()).hostname.toLowerCase(); } catch { return false; }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** True for a Z.ai Coding Plan route: https://api.z.ai/api/coding/... (host compared exactly after URL parsing). Coding Plan
 *  keys only work on that endpoint, so a call there is covered by the plan even though it carries an API key. */
export function isZaiCodingEndpoint(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return false;
  try {
    const u = new URL(baseURL.trim());
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 'api.z.ai' && u.pathname.startsWith('/api/coding/');
  } catch { return false; }
}

const OLLAMA_PROVIDERS = ['ollama', 'ollama-cloud'];
const hasBaseURL = (b) => typeof b === 'string' && b.trim() !== '';

/** Ollama Cloud rates for one model at one moment, as a price row; null when the model is not on the table or lacks an input/output rate. */
function ollamaPrice(table, model, billing, at) {
  const ot = table?.ollama || snapshotTable();
  const key = ollamaModelKey(ot.models, model);
  if (!key) return null;
  const e = ot.models[key];
  const off = e.offPeak && isOffPeak(at) ? e.offPeak : null;
  const rate = off || e;
  if (rate.inPerM === null || rate.outPerM === null) return null; // "-" on the page: not offered, never guessed
  const derived = [];
  let cacheReadPerM = rate.cachedPerM;
  if (cacheReadPerM === null || cacheReadPerM === undefined) { cacheReadPerM = rate.inPerM; derived.push('cacheRead'); }
  derived.push('cacheWrite'); // Ollama publishes no cache-write rate: charged at the input rate
  return {
    inPerM: rate.inPerM, outPerM: rate.outPerM, cacheReadPerM, cacheWritePerM: rate.inPerM,
    source: ot.source === 'snapshot' ? 'ollama-snapshot' : 'ollama', billing, derived,
    offPeak: Boolean(off), ollamaKey: key, ollamaDate: ot.date || null,
  };
}

/**
 * priceFor(table, provider, modelId, { localProviders?, baseURL?, oauthProviders?, subscriptions?, at? }) -> {inPerM,outPerM,cacheReadPerM,cacheWritePerM,above200k?,source,billing}.
 * oauthProviders: providers DSH holds an OAuth grant for; only those are billed as subscription.
 * subscriptions: providers declared as subscription in config.json (billed subscription, API-equivalent price shown).
 * A route on https://api.z.ai/api/coding/... is a Z.ai Coding Plan route: subscription even with an API key.
 * Ollama (provider ollama / ollama-cloud) is Ollama Cloud when the host is exactly ollama.com, the model id ends in
 * :cloud / -cloud, or the base URL is unknown; it is priced from Ollama's own table (table.ollama, else the bundled
 * snapshot), with the off-peak row when the model has one and `at` (ms, default now; UTC) is off-peak. Ollama on a
 * loopback/private base URL with a non-cloud model is local.
 * Also accepts priceFor(table, "provider/model"). Subscription providers return the API-equivalent
 * price (charged $0 by the caller); dashscope returns free (API-equivalent rates shown when known);
 * providers in opts.localProviders (from config.json), or a route whose opts.baseURL is loopback/private, return
 * local (all zero). Unknown => source "unpriced" with zero rates (never a guess).
 */
export function priceFor(table, provider, modelId, opts = {}) {
  const { provider: prov, model } = split(provider, modelId);
  const baseURL = opts?.baseURL;
  const isOllama = OLLAMA_PROVIDERS.includes(prov);
  const cloudModel = isCloudModelId(model);
  const urlLocal = isLocalBaseURL(baseURL);
  // A provider with built-in pricing (PAID_PROVIDERS) is never treated as local because of a config.json typo
  // such as localProviders:["google"], which would make a paid provider free and uncapped. Ollama is the exception
  // for a route that really is local: a loopback/private base URL with a model that is not a :cloud one.
  const paid = PAID_PROVIDERS.includes(prov);
  const isLocal = isOllama
    ? urlLocal && !cloudModel
    : !paid && ((Array.isArray(opts?.localProviders) && opts.localProviders.includes(prov)) || urlLocal);
  const codingPlan = !isLocal && isZaiCodingEndpoint(baseURL);
  const declared = !isLocal && Array.isArray(opts?.subscriptions) && opts.subscriptions.includes(prov);
  let billingDefault = isLocal ? 'local' : codingPlan || declared ? 'subscription' : (BILLING[prov] || 'metered');
  // Subscription billing needs positive evidence of an OAuth grant for this provider. With an API key, or when
  // the grants cannot be read (no oauthProviders given), the same calls are metered: counted and capped.
  // (A Z.ai Coding Plan endpoint and a config.json declaration are their own evidence.)
  if (billingDefault === 'subscription' && !codingPlan && !declared && !(Array.isArray(opts?.oauthProviders) && opts.oauthProviders.includes(prov))) billingDefault = 'metered';
  const ov = table?.overrides || {};
  const own = (k) => (Object.prototype.hasOwnProperty.call(ov, k) ? ov[k] : null);
  const hit = own(`${prov}/${model}`) || own(model);
  if (hit) {
    const p = { inPerM: hit.inPerM, outPerM: hit.outPerM, cacheReadPerM: hit.cacheReadPerM ?? hit.inPerM, cacheWritePerM: hit.cacheWritePerM ?? hit.inPerM,
      source: 'override', billing: hit.billing || billingDefault };
    return p;
  }
  if (billingDefault === 'local') return zeroPrice('local', 'local');
  // Ollama Cloud: its own table decides; LiteLLM's ollama/* rows describe local models (priced $0), so they are never used here.
  const ollamaCloud = isOllama && (cloudModel || !hasBaseURL(baseURL) || isOllamaCloudHost(baseURL));
  if (ollamaCloud) {
    const at = Number.isFinite(opts?.at) ? opts.at : Date.now();
    const op = ollamaPrice(table, model, billingDefault, at);
    if (op) return op;
  }
  const entries = table?.entries || {};
  const keys = ollamaCloud ? [] : codingPlan ? [model, `zai/${model}`] : (KEYS[prov] || ((m) => [m]))(model);
  for (const k of keys) {
    const e = Object.prototype.hasOwnProperty.call(entries, k) ? entries[k] : null;
    if (e) {
      const p = fromEntry(e, billingDefault, billingDefault === 'free' ? 'free' : billingDefault === 'subscription' ? 'subscription' : 'litellm');
      if (p) { p.litellmKey = k; return p; }
    }
  }
  if (billingDefault === 'free') return zeroPrice('free', 'free');
  if (billingDefault === 'subscription') return { ...zeroPrice('subscription', 'subscription'), apiEquivKnown: false };
  return { ...zeroPrice('unpriced', billingDefault), litellmKey: null };
}

/** True when the price carries a real rate (a metered model with source "unpriced" must not be trusted as $0). */
export const isPriced = (p) => !!p && p.source !== 'unpriced';
