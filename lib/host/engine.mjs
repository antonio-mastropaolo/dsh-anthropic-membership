/**
 * Cost engine for the host: usage capture -> normalize -> price -> ledger -> cache tracker, plus the
 * pre-request spend-cap guard that wraps `llm.stream`.
 *
 * Epistemic note: the event path (session/event -> assistant/message -> data.usage, message.source) is
 * read from DSH source; it is exercised live by the deploy checks in the host notes.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactSecrets, sanitizeError } from "../accounts/errors.mjs";
import { loadConfig } from "../config.mjs";
import { PLAN_LIMIT_CODE, planBlockedStream } from "../cost/plan-guard.mjs";
import {
  appendSpend, checkCaps, createCacheTracker, createLedgerTotals, isPriced, loadCaps, loadPriceTable, makeSpendRecord, sessionKey,
  normalizeUsage, priceFor, summarize, summarizeExternal, externalLedgerPaths, loadOverrides,
  loadOllamaTable, loadOllamaTableSync, providerSpend, cycleStart, applyCredits, planStatus, verifyLedger,
  estimateRequest, createReservations,
} from "../cost/index.mjs";

import { DEFAULT_DATA_DIR } from "../paths.mjs";
export { DEFAULT_DATA_DIR };
export const SPEND_CAP_CODE = "SPEND_CAP";
const TABLE_TTL_MS = 24 * 3600e3;
const SUMMARY_TTL_MS = 3000;
const TABLE_WAIT_MS = 3000;
const NONE_RETRY_MS = 60_000; // no price data could be loaded at all: try again after a minute, not after 24 h

const PURPOSE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const FINISH_RE = /^[a-z][a-z-]{0,23}$/;

const CREDIT_RE = /insufficient[_ ]?(quota|credit|fund|balance)|credit|prepa(y|id)|out of (credit|quota)|quota (exceeded|exhausted)|payment required/i;

/** A provider-side credit/quota failure (HTTP 402, insufficient_quota, "credit ...")? Our own spend cap is never one. */
export function isCreditFailure(failure) {
  if (!failure || typeof failure !== "object" || failure.code === SPEND_CAP_CODE) return false;
  if (failure.status === 402) return true;
  return CREDIT_RE.test(`${failure.code ?? ""} ${failure.message ?? ""}`);
}

const sha1 = (v) => {
  try {
    return createHash("sha1").update(typeof v === "string" ? v : JSON.stringify(v ?? null)).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
};

/** Fingerprints of the cache-relevant prefix parts of a model request (hashes only, never content). */
export function fingerprintsOf(options) {
  let system = options?.system;
  if (system === undefined && Array.isArray(options?.messages)) {
    const first = options.messages.find((m) => m && m.role === "system");
    system = first?.content;
  }
  const tools = Array.isArray(options?.tools) ? options.tools.map((t) => t?.name).sort() : undefined;
  return { system: system === undefined ? undefined : sha1(system), tools: tools === undefined ? undefined : sha1(tools) };
}

const r6 = (x) => Number(x.toFixed(6));

const VERIFY_TTL_MS = 5000;

export function createCostEngine({
  dataDir = DEFAULT_DATA_DIR,
  fetchImpl,
  now = () => Date.now(),
  loadTable = loadPriceTable,
  logger = null,
  // display-only extra ledgers: env DSH_HUB_EXTRA_LEDGERS or config.json extraLedgers, re-read per report
  externalLedger = () => externalLedgerPaths(process.env, loadConfig({ dataDir })),
  localProviders = () => loadConfig({ dataDir }).localProviders,
  // providers with an OAuth grant in DSH (array, or a function returning one). Absent = none: every
  // subscription-capable provider is then priced as metered (counted and capped), never as $0.
  oauthProviders = null,
  // config.json `plans` (prepaid credits per provider) and `subscriptions` (declared subscription providers); re-read per call
  plans = () => loadConfig({ dataDir }).plans,
  subscriptions = () => loadConfig({ dataDir }).subscriptions,
  // provider id -> the route's base URL (from DSH's provider config); null/absent when unknown. A call's own
  // options.baseURL wins. Used for: Ollama cloud vs local, the Z.ai Coding Plan endpoint.
  routeBaseURLs = () => null,
  loadOllama = loadOllamaTable,
  // how long a request waits for the first price-table load, and for finished steps still being priced
  tableWaitMs = TABLE_WAIT_MS,
  // opt-in stop of Claude subscription requests at 100% of a plan window (lib/cost/plan-guard.mjs); null = off
  planGuard = null,
  // what the guard does when it throws internally: "allow" (default) or "block". config.json guard.onError, re-read per call.
  guardPolicy = () => loadConfig({ dataDir }).guard.onError,
  // the in-flight reservation store (tests inject one); default: a fresh store on the engine's clock
  reservations = null,
  // Ledger verify re-reads every byte on this process's event loop, so the host shares one read between callers: a
  // report is reused for verifyTtlMs while no row has been written here. verifyImpl / verifyClock are test seams.
  verifyTtlMs = VERIFY_TTL_MS,
  verifyClock = () => performance.now(),
  verifyImpl = verifyLedger,
} = {}) {
  // Providers billed "local" ($0): from config.json (a function, re-evaluated per call) or a fixed array.
  const priceOpts = (provider = "", callOptions = null, at = now()) => {
    const opts = { at };
    try {
      const own = callOptions && typeof callOptions.baseURL === "string" ? callOptions.baseURL : "";
      const routes = typeof routeBaseURLs === "function" ? routeBaseURLs() : routeBaseURLs;
      const fromRoute = routes && typeof routes === "object" && Object.prototype.hasOwnProperty.call(routes, provider) ? routes[provider] : "";
      const b = own || (typeof fromRoute === "string" ? fromRoute : "");
      if (b) opts.baseURL = b;
    } catch { /* unknown base URL */ }
    try { const sub = typeof subscriptions === "function" ? subscriptions() : subscriptions; if (Array.isArray(sub)) opts.subscriptions = sub; } catch { /* none */ }
    try { opts.localProviders = typeof localProviders === "function" ? localProviders() : localProviders; } catch { /* none */ }
    try {
      const o = typeof oauthProviders === "function" ? oauthProviders() : oauthProviders;
      if (Array.isArray(o)) opts.oauthProviders = o;
    } catch { /* unknown: keep the provider's default billing */ }
    return opts;
  };
  // the Ollama pricing page is fetched with the same fetch as the LiteLLM table; an injected loadTable without a
  // fetchImpl (tests) never touches the network
  const ollamaFetch = fetchImpl ?? (loadTable === loadPriceTable ? globalThis.fetch : null);
  const plansNow = () => { try { const p = typeof plans === "function" ? plans() : plans; return p && typeof p === "object" ? p : {}; } catch { return {}; } };
  const tracker = createCacheTracker();
  const warnedUnpriced = new Set();
  const fps = new Map(); // sessionId -> latest request fingerprints
  const held = reservations || createReservations({ now }); // spend reserved by requests in flight (this process only)
  const lastPrompt = new Map(); // "session|provider/model" -> billed prompt tokens of the last call (bounded), the reservation's best estimate
  const routeKey = (sessionId, provider, model) => `${sessionKey(sessionId)}|${provider}/${model}`;
  // sessionId -> { parent, turn, step, inStep }: where a session is in its turn/step, from session events. Set
  // synchronously by the session/event listener (DSH runs listeners inside append, and appends step/start before the
  // step dispatches its request), so a request's row can say which turn and step it belongs to.
  const sessions = new Map();
  const SESSIONS_MAX = 500;
  const intOrNull = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  function observeSession(session, event) {
    const id = String(session?.id ?? "");
    if (!id || typeof event?.type !== "string") return;
    let s = sessions.get(id);
    if (!s) {
      s = { parent: null, turn: null, step: null, inStep: false };
      sessions.set(id, s);
      if (sessions.size > SESSIONS_MAX) sessions.delete(sessions.keys().next().value);
    }
    // only a subagent session names its parent: an ordinary fork also carries header.parentSession
    const h = session?.header;
    if (s.parent === null && h?.origin === "subagent" && typeof h.parentSession === "string" && h.parentSession) s.parent = h.parentSession.slice(0, 200);
    const d = event.data || {};
    if (event.type === "turn/start") { s.turn = intOrNull(d.turn); s.step = null; s.inStep = false; }
    else if (event.type === "step/start") { s.turn = intOrNull(d.turn); s.step = intOrNull(d.step); s.inStep = true; }
    else if (event.type === "step/end" || event.type === "turn/end") s.inStep = false;
  }
  /** The ledger's `purpose` of a request: DSH's options.purpose (compaction, session-title, auto-review, ...), `chat` when unset. */
  const purposeOf = (p) => {
    if (typeof p !== "string" || p === "") return "chat";
    const k = p.toLowerCase();
    return PURPOSE_RE.test(k) ? k : "other";
  };
  /** purpose, turn, step and parentSessionId of a request's row. turn/step only for a chat call made inside a step. */
  function callContext(options) {
    const purpose = purposeOf(options?.purpose);
    const sid = String(options?.sessionId ?? "");
    const s = sid ? sessions.get(sid) : null;
    const inStep = purpose === "chat" && s?.inStep === true;
    return { purpose, turn: inStep ? s.turn : null, step: inStep ? s.step : null, parentSessionId: s?.parent ?? null };
  }
  let table = null;
  let tableAt = 0;
  let loading = null;
  let lastSession = null;
  const sumCache = new Map();
  // providerHealth: observed credit/quota failures per provider, persisted so a restart does not forget them.
  const healthPath = join(dataDir, "provider-health.json");
  const health = {};
  // Re-read whenever the file changes: another DSH process (headless runs, automation) may record a
  // credit failure, and the web host must show it at once, the same way caps read the ledger fresh.
  let healthMtime = -1;
  const syncHealth = () => {
    try {
      const m = existsSync(healthPath) ? statSync(healthPath).mtimeMs : -1;
      if (m === healthMtime) return;
      healthMtime = m;
      for (const k of Object.keys(health)) delete health[k];
      if (m < 0) return;
      const h = JSON.parse(readFileSync(healthPath, "utf8"));
      for (const [k, v] of Object.entries(h && typeof h === "object" ? h : {})) {
        if (v && Number.isFinite(v.code) && typeof v.message === "string" && Number.isFinite(v.at)) health[k] = { code: v.code, message: v.message, at: v.at };
      }
    } catch { /* corrupt or mid-write: keep what we have */ }
  };
  syncHealth();
  const persistHealth = () => {
    try {
      mkdirSync(dirname(healthPath), { recursive: true, mode: 0o700 });
      const tmp = `${healthPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(health), { encoding: "utf8", mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, healthPath);
    } catch { /* best effort */ }
  };
  function recordProviderFailure(provider, failure) {
    try {
      if (!provider || !isCreditFailure(failure)) return false;
      syncHealth(); // merge other processes' entries before this write replaces the file
      health[provider] = {
        code: Number.isFinite(failure.status) ? failure.status : 402,
        message: sanitizeError(failure.message || "credit exhausted"),
        at: now(),
      };
      persistHealth();
      return true;
    } catch { return false; }
  }
  function clearProviderHealth(provider) {
    syncHealth();
    if (provider && health[provider]) { delete health[provider]; persistHealth(); }
  }
  // every host log line goes through the redactor (price-fetch errors can echo response text)
  const log = (level, msg) => {
    try { logger?.[level]?.(`model-hub: ${redactSecrets(msg)}`); } catch { /* ignore */ }
  };

  // prices.json edits apply without a restart: its mtime is checked on every lookup (one stat, no network)
  const pricesPath = join(dataDir, "prices.json");
  const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return -1; } };
  let overridesMtime = null;

  function refreshTable() {
    if (loading) return loading;
    let startMtime;
    loading = Promise.resolve()
      .then(() => {
        startMtime = mtimeOf(pricesPath);
        return Promise.all([
          loadTable({ dataDir, fetchImpl, now: now() }),
          Promise.resolve().then(() => loadOllama({ dataDir, fetchImpl: ollamaFetch, now: now() })).catch(() => null),
        ]);
      })
      .then(([t, ollama]) => {
        table = ollama ? { ...t, ollama } : t;
        for (const w of ollama?.warnings ?? []) log("warn", w);
        // an empty result (offline first run, every source failed) is retried soon instead of kept for 24 h
        tableAt = t?.source === "none" ? now() - TABLE_TTL_MS + NONE_RETRY_MS : now();
        overridesMtime = startMtime;
        for (const w of t?.warnings ?? []) log("warn", `price table: ${w}`);
      })
      .catch((e) => log("warn", `price table load failed: ${String(e?.message || e).slice(0, 120)}`))
      .finally(() => { loading = null; });
    return loading;
  }

  // While the first load is in flight, prices.json overrides and the last cached LiteLLM table (any age) apply
  // at once, so a known price is never seen as "unpriced" just because the network is slow.
  let provisional = null;
  function provisionalTable() {
    if (provisional) return provisional;
    const warnings = [];
    let entries = {};
    try {
      const c = JSON.parse(readFileSync(join(dataDir, "prices.litellm.json"), "utf8"));
      if (c && typeof c.entries === "object" && c.entries) entries = c.entries;
    } catch { /* no cache yet */ }
    provisional = { entries, overrides: loadOverrides(dataDir, warnings), ollama: loadOllamaTableSync(dataDir), source: "provisional", fetchedAt: 0, count: Object.keys(entries).length, warnings };
    return provisional;
  }

  /** wait: up to 3 s for a first load (the request guard); full: until the load settles (spend capture). */
  // a table with prices in it (an empty "none" result from a failed load is not one: callers wait for the retry)
  const usableTable = () => Boolean(table && table.source !== "none");
  async function getTable({ wait = true, full = false } = {}) {
    if (!table || now() - tableAt > TABLE_TTL_MS) {
      const p = refreshTable();
      if (!usableTable() && full) await p;
      else if (!usableTable() && wait) {
        await Promise.race([p, new Promise((r) => setTimeout(r, tableWaitMs).unref?.())]);
      }
    }
    if (!table) return provisionalTable();
    provisional = null;
    if (table && overridesMtime !== null && !loading) {
      const m = mtimeOf(pricesPath);
      if (m !== overridesMtime) {
        const warnings = [];
        table = { ...table, overrides: loadOverrides(dataDir, warnings) };
        overridesMtime = m;
        log("info", "prices.json changed: overrides reloaded");
        for (const w of warnings) log("warn", `price table: ${w}`);
      }
    }
    return table;
  }

  function summary(opts, { fresh = false } = {}) {
    const key = `${opts.since}|${opts.by || ""}`;
    const hit = sumCache.get(key);
    if (!fresh && hit && now() - hit.at < SUMMARY_TTL_MS) return hit.value;
    const value = summarize(dataDir, { ...opts, now: now() });
    sumCache.set(key, { at: now(), value });
    return value;
  }
  let rowGen = 0; // bumped whenever this process writes a row (a remembered verify report no longer describes the ledger)
  const invalidate = () => { sumCache.clear(); rowGen++; };
  const totals = createLedgerTotals(dataDir); // running totals for the guard (capsStatus and spendReport still use summary())

  // Finished steps whose cost is not in the ledger yet. Normally a step is recorded at once; it waits only when
  // its model has no override or cached price and the first price-table load is still in flight. The guard waits
  // for these, so a cap is never checked against a ledger that is missing a finished step.
  const pendingCaptures = new Set();
  // Spend rows that could not be appended (disk full, permissions). They are kept in memory and written, oldest
  // first, before any later row and before any metered request is let through; until then the guard holds metered
  // requests back. Only an actual append clears the failure. (Rows still unwritten when DSH exits are lost.)
  const unwritten = [];
  let writeError = null;
  const UNWRITTEN_MAX = 100_000;
  function flushUnwritten() {
    while (unwritten.length) {
      try { appendSpend(dataDir, unwritten[0]); }
      catch (e) { writeError = String(e?.code || "write failed"); return false; }
      unwritten.shift();
      invalidate();
    }
    writeError = null;
    return true;
  }
  function writeRow(rec) {
    if (flushUnwritten()) {
      try { appendSpend(dataDir, rec); invalidate(); return true; }
      catch (e) { writeError = String(e?.code || "write failed"); }
    }
    unwritten.push(rec);
    if (unwritten.length > UNWRITTEN_MAX) { unwritten.shift(); log("warn", "spend ledger unwritable: oldest unwritten row dropped"); }
    log("warn", `spend row kept in memory, ledger not writable (${writeError}); ${unwritten.length} waiting`);
    return false;
  }
  async function settleCaptures(ms) {
    if (!pendingCaptures.size) return true;
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r(false), ms); timer.unref?.(); });
    try {
      return await Promise.race([Promise.allSettled([...pendingCaptures]).then(() => true), timeout]);
    } finally { clearTimeout(timer); }
  }

  // Guard exceptions, counted per process (they reset when DSH restarts). `last` is the newest one, already redacted.
  const guardErrors = { count: 0, last: null };
  /** The policy in force now: only the exact string "block" blocks; a policy that throws or returns anything else is "allow". */
  function currentGuardPolicy() {
    try { return guardPolicy() === "block" ? "block" : "allow"; } catch { return "allow"; }
  }
  function onGuardError(e) {
    let message = "guard failed";
    try { message = sanitizeError(e).slice(0, 300); } catch { /* keep the generic message */ }
    guardErrors.count += 1;
    let at = 0;
    try { at = now(); } catch { /* an injected clock that throws must not break the guard */ }
    guardErrors.last = { at, message };
    const policy = currentGuardPolicy();
    log("warn", `guard failed (${policy === "block" ? "request blocked" : "failed open"}): ${message.slice(0, 120)}`);
    if (policy === "block") {
      return { action: "block", reason: `the spend guard hit an internal error (${message}) and config.json guard.onError is "block"`, pct: 0, which: "guard-error" };
    }
    return { action: "ok" };
  }
  /** { onError, errors: { count, last } } for GET /status, dsh-hub status/doctor and the Costs card. */
  const guardStatus = () => ({ onError: currentGuardPolicy(), errors: { count: guardErrors.count, last: guardErrors.last ? { ...guardErrors.last } : null }, reserved: reservedStatus() });

  /** Decide whether a request may be sent. Never throws: an internal failure is counted and then follows guard.onError (default: the request is allowed). */
  async function guard(options) {
    try {
      const provider = String(options?.provider || "");
      const model = String(options?.model || "");
      const sessionId = String(options?.sessionId || "");
      if (sessionId) fps.set(sessionId, fingerprintsOf(options));
      if (fps.size > 500) fps.delete(fps.keys().next().value);
      const t = await getTable();
      const price = priceFor(t, provider, model, priceOpts(provider, options));
      if (planGuard && provider === "anthropic" && price.billing === "subscription") {
        const v = await planGuard.check({ provider, model, billing: price.billing });
        if (v.action === "block") return { ...v, price };
      }
      if (price.billing !== "metered") return { action: "ok", price };
      // No price data at all (first run offline, or every source failed): this request's cost could not be
      // counted, so it is held back until a table loads (retried every minute) or the model gets a prices.json row.
      if (!isPriced(price) && !(t?.count > 0)) {
        return { action: "block", reason: "No price table could be loaded yet (offline?), so the cost of this metered request could not be counted. The table is retried every minute; add the model to prices.json in the model-hub data dir to allow it now.", pct: 0, which: "prices-unavailable", price };
      }
      if (!(await settleCaptures(tableWaitMs))) {
        log("warn", "a finished step is still being priced: metered request held back");
        return { action: "block", reason: "A finished step's cost is still being recorded (the price table is loading), so caps cannot be checked against all spend yet. Retry in a moment.", pct: 0, which: "spend-pending", price };
      }
      // spend rows that could not be written yet: write them now; until they are in the ledger, hold metered requests
      if (!flushUnwritten()) {
        return { action: "block", reason: `The spend ledger cannot be written (${writeError}), so ${unwritten.length} finished call(s) are not counted yet. Fix the model-hub data dir (dsh-hub doctor); they are written as soon as it accepts writes.`, pct: 0, which: "ledger-unwritable", price };
      }
      const caps = loadCaps(dataDir);
      // Metered requests only reach here: the running totals fold in whatever any DSH process has appended since the
      // last request (the reader is incremental per file), so another process's spend counts at once.
      const spent = totals.read({ now: now(), provider, sessionId });
      // never check a cap against partial spend: an unreadable ledger, or rotations that kept racing the read
      if (!spent.complete) {
        if (spent.unreadable) {
          log("warn", "spend ledger could not be read: metered request held back");
          return { action: "block", reason: "The spend ledger could not be read (check the model-hub data dir permissions with dsh-hub doctor), so caps could not be checked against your spend.", pct: 0, which: "ledger-unreadable", price };
        }
        log("warn", "spend ledger was being rotated while it was read: metered request held back");
        return { action: "block", reason: "The spend ledger was being rotated by another DSH process while it was read, so caps could not be checked against all spend. Retry in a moment.", pct: 0, which: "ledger-busy", price };
      }
      const res = checkCaps({
        summary: { totals: { usd: spent.todayUsd }, byProvider: { [provider]: { usd: spent.providerUsd } } },
        sessionSummary: { bySession: { [sessionKey(sessionId)]: { usd: spent.sessionUsd } } }, // the session's whole history
        provider, sessionId, billing: price.billing, caps, priced: isPriced(price),
      });
      // an unpriced metered model is logged once, whatever the cap decision (a cap warning can outrank it)
      if (!isPriced(price) && !warnedUnpriced.has(`${provider}/${model}`)) {
        warnedUnpriced.add(`${provider}/${model}`);
        log("warn", res.which === "unpriced-capped"
          ? `${provider}/${model} has no known price and ${provider} has a daily cap: it is blocked (add it to prices.json)`
          : `${provider}/${model} has no known price: its spend is not counted toward caps (add it to prices.json)`);
      }
      if (res.action === "block") return { ...res, price };
      return { ...res, price, ...reserveInFlight({ options, price, provider, model, sessionId, spent, caps }) };
    } catch (e) {
      return onGuardError(e);
    }
  }

  const usdText = (n) => `$${n.toFixed(2)}`;
  /** Reserve this request's worst case, after checking it against what other requests in flight already hold.
   *  ALL SYNCHRONOUS: nothing awaits between reading the reservation totals and reserving, so of N parallel guards the
   *  check-then-reserve of each runs whole before the next one starts. -> { reservation, reservedUsd } or a block verdict.
   *  The reserve is the last statement, so an exception in here never leaves a reservation behind. */
  function reserveInFlight({ options, price, provider, model, sessionId, spent, caps }) {
    if (!isPriced(price)) return { reservation: null, reservedUsd: 0 };
    const est = estimateRequest(options, price, { previousPromptTokens: lastPrompt.get(routeKey(sessionId, provider, model)) });
    if (!(est.usd > 0)) return { reservation: null, reservedUsd: 0 };
    const others = held.totals();
    if (others.count > 0) {
      // another request is in flight: recorded spend + what they may still cost + this request's own worst case
      const again = checkCaps({
        summary: { totals: { usd: spent.todayUsd + others.usd + est.usd }, byProvider: { [provider]: { usd: spent.providerUsd + (others.byProvider[provider] || 0) + est.usd } } },
        sessionSummary: { bySession: { [sessionKey(sessionId)]: { usd: spent.sessionUsd + (others.bySession[sessionId] || 0) + est.usd } } },
        provider, sessionId, billing: price.billing, caps, priced: true,
      });
      if (again.action === "block") {
        return { action: "block", which: "in-flight", pct: again.pct,
          reason: `${again.which} cap would be exceeded by requests already in flight: ${usdText(others.usd)} reserved (worst case) plus up to ${usdText(est.usd)} for this request, on top of what is already recorded` };
      }
    }
    return { reservation: held.reserve({ provider, sessionId, usd: est.usd }), reservedUsd: est.usd };
  }

  /** The middleware calls these for a verdict's reservation. They never throw: a failure is counted (guard.onError does not
   *  apply, the request is already past the guard) and a reservation that could not be released is swept by its idle TTL. */
  function touchReservation(token) {
    if (token == null) return;
    try { held.touch(token); } catch (e) { onGuardError(e); }
  }
  function releaseReservation(token) {
    if (token == null) return false;
    try { return held.release(token); } catch (e) { onGuardError(e); return false; }
  }
  /** Dollars reserved by requests in flight, this process only. */
  function reservedStatus() {
    const t = held.totals();
    const byProvider = {};
    for (const k of Object.keys(t.byProvider)) byProvider[k] = r6(t.byProvider[k]);
    return { usd: r6(t.usd), count: t.count, byProvider, stats: held.stats() };
  }

  /** Record the spend of one model call from its stream's `usage` chunk (spendGuardMiddleware calls this for every
   *  request DSH sends: chat steps, compaction, reviews, and failed attempts that report usage). The guard sees it as
   *  pending from the moment it is called (the stream does not wait for it). `meta` = { finish, ttftMs, durationMs }
   *  from the stream (absent = null in the row). -> { record } | null */
  function recordUsage(options, usage, meta = null) {
    const p = recordCall(options, usage, meta);
    pendingCaptures.add(p);
    p.finally(() => pendingCaptures.delete(p));
    return p;
  }

  /** A metered, priced call on a provider with a plan: inside this cycle's included credits it is billed "credits"
   *  ($0, api value kept); the part beyond them stays metered. Fails safe: if the ledger cannot be read in full or
   *  unwritten rows are pending, the call is left metered at its full cost. */
  function applyPlanCredits(rec, price, at) {
    try {
      const plan = plansNow()[rec.provider];
      if (!plan || rec.billing !== "metered" || !isPriced(price) || !(rec.apiEquivUsd > 0)) return;
      if (!flushUnwritten()) return;
      const s = providerSpend(dataDir, rec.provider, cycleStart(plan.resetsOnDay, at));
      if (!s.complete || s.unreadable) return;
      const r = applyCredits(plan, s.apiEquivUsd, rec.apiEquivUsd);
      rec.billing = r.billing; rec.usd = r.usd;
      // the part of the API value the plan covered, so `usd` stays re-derivable from the row (apiEquivUsd - planCoveredUsd)
      rec.planCoveredUsd = r.billing === "credits" ? rec.apiEquivUsd : Number((rec.apiEquivUsd - r.usd).toFixed(6));
    } catch (e) { log("warn", `plan credits skipped: ${String(e?.message || e).slice(0, 120)}`); }
  }

  async function recordCall(options, u, meta) {
    try {
      const provider = String(options?.provider || "");
      const model = String(options?.model || "");
      const sessionId = String(options?.sessionId ?? "");
      if (!u || !provider) return null;
      // Where the call was made (turn, step, parent) is read NOW, before any await: a first-ever table load can take
      // seconds, and by then the session may be in its next step.
      const ctx = callContext(options);
      const n = normalizeUsage(u);
      if (!(n.input + n.output + n.cacheRead + n.cacheWrite > 0)) return null; // no tokens, no cost
      // A recorded price is permanent. Use the price known now (an override, the cached or loaded table); only a
      // model with no price yet waits for the first table load, instead of storing a loading state as $0.
      const at = now();
      let price = priceFor(await getTable({ wait: false }), provider, model, priceOpts(provider, options, at));
      if (!isPriced(price) && !usableTable()) price = priceFor(await getTable({ full: true }), provider, model, priceOpts(provider, options, at));
      lastPrompt.delete(routeKey(sessionId, provider, model));
      lastPrompt.set(routeKey(sessionId, provider, model), n.input + n.cacheRead + n.cacheWrite);
      if (lastPrompt.size > 500) lastPrompt.delete(lastPrompt.keys().next().value);
      const rec = makeSpendRecord({ ts: new Date(at).toISOString(), sessionId, provider, model, usage: u, price, meta: { ...ctx, ...(meta || {}) } });
      applyPlanCredits(rec, price, at);
      return { record: rec, written: writeRow(rec) };
    } catch (e) {
      log("warn", `capture failed: ${String(e?.message || e).slice(0, 120)}`);
      return null;
    }
  }

  /** Session events feed the prompt-cache tracker (spend is recorded from the stream, see recordUsage). */
  async function onSessionEvent(session, event) {
    try { observeSession(session, event); } catch { /* turn/step stay null; observation never breaks the cost path */ }
    try {
      if (event?.type !== "assistant/message") return null;
      const data = event.data || {};
      const u = data.usage;
      const src = data.message?.source || {};
      const provider = String(src.provider || "");
      clearProviderHealth(provider); // a successful step from this provider means its credit is back
      const model = String(src.model || "");
      if (!u || !provider) return null;
      const sessionId = String(session?.id ?? "");
      const r = tracker.observe({ sessionId, step: data.step, provider, model, usage: normalizeUsage(u), fingerprints: fps.get(sessionId) });
      lastSession = sessionId;
      return { cache: r };
    } catch (e) {
      log("warn", `cache tracking failed: ${String(e?.message || e).slice(0, 120)}`);
      return null;
    }
  }

  function capsStatus() {
    const caps = loadCaps(dataDir);
    const today = summary({ since: "today" });
    const all = summary({ since: "all" });
    // The caps the guard applies: daily, every per-provider cap, and the session cap of the session in use (the one
    // this host last saw, else the session of the newest ledger row); the worst one is shown.
    const session = lastSession || all.latestSession || null;
    const base = { summary: today, sessionSummary: all, billing: "metered", caps: session ? caps : { ...caps, sessionUsd: 0 }, sessionId: session || "" };
    const rank = { block: 2, warn: 1, ok: 0 };
    const res = [checkCaps({ ...base, provider: "" }), ...Object.keys(caps.perProviderDailyUsd || {}).map((p) => checkCaps({ ...base, provider: p }))]
      .reduce((a, b) => (rank[b.action] > rank[a.action] || (rank[b.action] === rank[a.action] && b.pct > a.pct) ? b : a));
    const perProvider = {};
    for (const [p, cap] of Object.entries(caps.perProviderDailyUsd || {})) {
      perProvider[p] = { capUsd: cap, spentUsd: today.byProvider?.[p]?.usd || 0 };
    }
    return {
      limits: { dailyUsd: caps.dailyUsd, sessionUsd: caps.sessionUsd, perProviderDailyUsd: caps.perProviderDailyUsd, warnPct: caps.warnPct },
      todayUsd: today.totals?.usd || 0,
      session,
      // what the session in use has spent over its whole history (the session cap's measure); null without a session
      sessionSpentUsd: session ? all.bySession?.[sessionKey(session)]?.usd || 0 : null,
      complete: today.complete !== false,
      unreadable: Boolean(today.unreadable),
      unwritten: unwritten.length,
      guard: guardStatus(),
      reserved: (({ usd, count }) => ({ usd, count }))(reservedStatus()),
      action: res.action, reason: res.reason, pct: res.pct, which: res.which,
      perProvider,
      warnings: [...(caps.warnings || [])],
    };
  }

  async function spendReport({ since = "today", by = "provider" } = {}) {
    const s = summary({ since, by });
    return {
      since, by, sinceMs: s.sinceMs, totals: s.totals,
      // false when the ledger could not be read (unreadable: true) or other DSH processes kept rotating it during
      // every read pass: the totals may be low
      complete: s.complete !== false,
      unreadable: Boolean(s.unreadable),
      byProvider: s.byProvider, byPurpose: s.byPurpose, groups: s.groups,
      caps: capsStatus(),
      // DISPLAY ONLY: extra ledgers (config.json extraLedgers / DSH_HUB_EXTRA_LEDGERS). Never read by caps/guard.
      plans: planStatus(dataDir, plansNow(), now()),
      external: summarizeExternal(typeof externalLedger === "function" ? externalLedger() : externalLedger, { since, now: now() }),
    };
  }

  async function prices(models) {
    const t = await getTable();
    const out = {};
    for (const m of models) {
      const i = m.indexOf("/");
      const p = i > 0 ? priceFor(t, m.slice(0, i), m.slice(i + 1), priceOpts(m.slice(0, i))) : null;
      out[m] = p ? { ...p, priced: isPriced(p) } : { error: "use provider/model", priced: false };
      // Ollama Cloud rows also carry both rate cards (peak and off-peak) for display
      if (p && t?.ollama && p.ollamaKey) {
        const e = t.ollama.models[p.ollamaKey];
        out[m].ollama = { peak: { inPerM: e.inPerM, outPerM: e.outPerM, cachedPerM: e.cachedPerM }, offPeakRate: e.offPeak ? { inPerM: e.offPeak.inPerM, outPerM: e.offPeak.outPerM, cachedPerM: e.offPeak.cachedPerM } : null, date: t.ollama.date ?? null };
      }
    }
    syncHealth();
    return {
      source: t?.source ?? "none", fetchedAt: t?.fetchedAt ?? null, count: t?.count ?? 0, warnings: [...(t?.warnings ?? []), ...(t?.ollama?.warnings ?? [])], models: out,
      // where the Ollama Cloud rates came from: network | cache | stale-cache | snapshot, and the date of that copy
      ollama: t?.ollama ? { source: t.ollama.source, date: t.ollama.date ?? null, fetchedAt: t.ollama.fetchedAt ?? null, count: t.ollama.count ?? 0, url: t.ollama.url ?? null } : null,
      providerHealth: JSON.parse(JSON.stringify(health)),
    };
  }

  function cacheReport(sessionId) {
    if (sessionId) {
      const s = tracker.stats(sessionId);
      return s ? { sessionId, ...s } : null;
    }
    const ids = tracker.sessionIds();
    const sessions = ids.map((id) => ({ sessionId: id, ...tracker.stats(id) }));
    const latest = lastSession ? sessions.find((x) => x.sessionId === lastSession) ?? null : null;
    return { latest, sessions };
  }

  /** Ledger integrity (GET /ledger/verify; `dsh-hub ledger verify` reads the files itself). Every real read re-reads every
   *  byte: a check that trusts the bytes this process already parsed could not see a file edited in place. That read runs
   *  on the host's event loop, so it is rationed: it starts on a later turn of the loop (queued stream work goes first),
   *  callers that arrive while one runs share it, and a complete report is reused for `verifyTtlMs` (5 s) unless a row
   *  was written here since. `fresh: true` skips the reuse. */
  const verifyMemo = new Map(); // since -> { at, gen, report }
  const verifyFlight = new Map(); // since -> Promise<report>
  function ledgerVerify({ since = "all", fresh = false } = {}) {
    if (!fresh) {
      const m = verifyMemo.get(since);
      if (m && m.gen === rowGen && verifyClock() - m.at < verifyTtlMs) return Promise.resolve(m.report);
      const f = verifyFlight.get(since);
      if (f) return f;
    }
    const p = (async () => {
      await new Promise((r) => setImmediate(r));
      const gen = rowGen;
      const report = verifyImpl(dataDir, { since, now: now(), full: true });
      if (report?.complete && !report.unreadable) verifyMemo.set(since, { at: verifyClock(), gen, report });
      else verifyMemo.delete(since);
      return report;
    })().finally(() => { if (verifyFlight.get(since) === p) verifyFlight.delete(since); });
    verifyFlight.set(since, p);
    return p;
  }

  /** Prepaid plan credits: one entry per config.json plan (used / remaining / overage this cycle, cycle dates). */
  const plansReport = () => planStatus(dataDir, plansNow(), now());

  return { guard, guardStatus, touchReservation, releaseReservation, plansReport, onSessionEvent, recordUsage, recordProviderFailure, clearProviderHealth, providerHealth: () => JSON.parse(JSON.stringify(health)), capsStatus, spendReport, ledgerVerify, prices, cacheReport, getTable, warm: () => refreshTable(), tracker, dataDir };
}

/** A terminal error stream for a blocked request (what LlmRuntime itself yields for an adapter failure). */
export function blockedStream(reason, which = "") {
  // the guard itself failed (guard.onError is "block"): the remedy is the config key, not a cap. The code stays SPEND_CAP.
  const message = which === "guard-error"
    ? `Request blocked by model-hub spend guard: ${reason}. Set guard.onError to "allow" in config.json (in the model-hub data dir; \`dsh-hub doctor\` shows where) to let requests through when the guard itself fails.`
    : `Request blocked by model-hub spend cap: ${reason}. Raise it in caps.json in the model-hub data dir (\`dsh-hub doctor\` shows where) or run \`dsh-hub spend\`.`;
  const failure = Object.freeze({ message, code: SPEND_CAP_CODE });
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "finish", reason: { kind: "error", failure } };
    },
  };
}

/** Whether a stream chunk carries the model's first output token: a non-empty text/reasoning fragment, or a tool call
 *  that has a name or a non-empty arguments fragment. (DSH's isTokenDelta, restated: no DSH import.) */
const isTokenDelta = (c) => {
  if (c?.type === "text-delta" || c?.type === "reasoning-delta") return typeof c.text === "string" && c.text !== "";
  if (c?.type === "tool-call-delta") return Boolean(c.name) || (typeof c.argumentsDelta === "string" && c.argumentsDelta !== "");
  return false;
};

/** How long a usage chunk waits for the `finish` chunk behind it before its row is written without one. */
export const USAGE_FLUSH_MS = 1000;

/**
 * `llm/stream` waterfall listener: `(options, next) => AsyncIterable<StreamChunk>`. Every model request
 * (the agent loop's prepared calls AND plain `llm.stream` calls such as compaction) passes this
 * waterfall, so a metered request over its cap is stopped here BEFORE the adapter is dispatched.
 * Register with `ctx.on("llm/stream", spendGuardMiddleware(engine))`. `clock` (default performance.now) is read exactly
 * three times on a normal stream: dispatch, first token, finish. `usageFlushMs` (default 1000): if no `finish` follows a
 * `usage` chunk within that time (a consumer that read the usage and walked away without return(), or a stalled stream),
 * the row is written then, with finish/duration null, and the reservation is released.
 */
export function spendGuardMiddleware(engine, { onBlock, clock = () => performance.now(), usageFlushMs = USAGE_FLUSH_MS } = {}) {
  return function spendGuard(options, next) {
    return {
      async *[Symbol.asyncIterator]() {
        const verdict = await engine.guard(options);
        if (verdict.action === "block") {
          try { onBlock?.(verdict, options); } catch { /* ignore */ }
          yield* (verdict.code === PLAN_LIMIT_CODE ? planBlockedStream(verdict.reason) : blockedStream(verdict.reason, verdict.which));
          return;
        }
        // Pass every chunk through untouched. The `usage` chunk is this call's spend (every call DSH makes passes
        // here, compaction and failed attempts included); the terminal `finish` chunk reports credit failures and
        // ends the call. The row is written ONCE, when `finish` arrives (or when the stream ends or its consumer
        // stops without one), so it can carry finish, time to first token and duration. Exactly three clock reads on
        // a normal stream: dispatch, first token, finish.
        const token = verdict.reservation ?? null; // spend held for this request until its row is written
        let t0 = 0;
        let firstAt = null, finishAt = null, finish = null;
        const usages = [], recs = [];
        const flush = () => {
          const meta = {
            finish,
            ttftMs: firstAt === null ? null : Math.max(0, Math.round(firstAt - t0)),
            durationMs: finishAt === null ? null : Math.max(0, Math.round(finishAt - t0)),
          };
          for (const u of usages.splice(0)) recs.push(engine.recordUsage?.(options, u, meta));
        };
        // the reservation is released once, after the row is written (or its capture failed); never waits in return()
        let released = false;
        const settle = () => {
          if (token === null || released) return;
          released = true;
          const pending = recs.filter((p) => p && typeof p.then === "function");
          if (pending.length) void Promise.allSettled(pending).then(() => engine.releaseReservation?.(token));
          else engine.releaseReservation?.(token);
        };
        let timer = null;
        const stopTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
        const armTimer = () => {
          if (timer !== null || !(usageFlushMs > 0)) return;
          timer = setTimeout(() => {
            timer = null;
            try { flush(); settle(); } catch { /* observation must never break the stream */ }
          }, usageFlushMs);
          timer.unref?.();
        };
        try {
          t0 = clock();
          for await (const chunk of next()) {
            try {
              engine.touchReservation?.(token);
              if (chunk?.type === "usage" && chunk.usage) { usages.push(chunk.usage); armTimer(); }
              else if (chunk?.type === "finish") {
                stopTimer();
                finishAt = clock();
                const k = chunk.reason?.kind;
                finish = typeof k === "string" && FINISH_RE.test(k) ? k : null;
                const provider = String(options?.provider || "");
                if (k === "error") engine.recordProviderFailure?.(provider, chunk.reason.failure);
                else if (k !== "aborted") engine.clearProviderHealth?.(provider);
                flush();
              } else if (firstAt === null && isTokenDelta(chunk)) firstAt = clock();
            } catch { /* observation must never break the stream */ }
            yield chunk;
          }
        } finally {
          // finish, error, abort, the consumer stopping early (return()) and a throwing next() all end up here
          stopTimer();
          try { flush(); } catch { /* observation must never break the stream */ }
          try { settle(); } catch { /* observation must never break the stream */ }
        }
      },
    };
  };
}
