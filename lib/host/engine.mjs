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
import {
  appendSpend, checkCaps, createCacheTracker, isPriced, loadCaps, loadPriceTable, makeSpendRecord, sessionKey,
  normalizeUsage, priceFor, summarize, summarizeExternal, externalLedgerPaths, loadOverrides,
} from "../cost/index.mjs";

import { DEFAULT_DATA_DIR } from "../paths.mjs";
export { DEFAULT_DATA_DIR };
export const SPEND_CAP_CODE = "SPEND_CAP";
const TABLE_TTL_MS = 24 * 3600e3;
const SUMMARY_TTL_MS = 3000;
const TABLE_WAIT_MS = 3000;
const NONE_RETRY_MS = 60_000; // no price data could be loaded at all: try again after a minute, not after 24 h

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
  // how long a request waits for the first price-table load, and for finished steps still being priced
  tableWaitMs = TABLE_WAIT_MS,
} = {}) {
  // Providers billed "local" ($0): from config.json (a function, re-evaluated per call) or a fixed array.
  const priceOpts = () => {
    const opts = {};
    try { opts.localProviders = typeof localProviders === "function" ? localProviders() : localProviders; } catch { /* none */ }
    try {
      const o = typeof oauthProviders === "function" ? oauthProviders() : oauthProviders;
      if (Array.isArray(o)) opts.oauthProviders = o;
    } catch { /* unknown: keep the provider's default billing */ }
    return opts;
  };
  const tracker = createCacheTracker();
  const warnedUnpriced = new Set();
  const fps = new Map(); // sessionId -> latest request fingerprints
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
      .then(() => { startMtime = mtimeOf(pricesPath); return loadTable({ dataDir, fetchImpl, now: now() }); })
      .then((t) => {
        table = t;
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
    provisional = { entries, overrides: loadOverrides(dataDir, warnings), source: "provisional", fetchedAt: 0, count: Object.keys(entries).length, warnings };
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
  const invalidate = () => sumCache.clear();

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

  /** Decide whether a request may be sent. Never throws: on internal failure it allows the request. */
  async function guard(options) {
    try {
      const provider = String(options?.provider || "");
      const model = String(options?.model || "");
      const sessionId = String(options?.sessionId || "");
      if (sessionId) fps.set(sessionId, fingerprintsOf(options));
      if (fps.size > 500) fps.delete(fps.keys().next().value);
      const t = await getTable();
      const price = priceFor(t, provider, model, priceOpts());
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
      // Metered requests only reach here: read the ledger fresh so another DSH process's spend counts at once.
      const today = summary({ since: "today" }, { fresh: true });
      const all = summary({ since: "all" }, { fresh: true }); // a session cap counts the session's whole history
      // never check a cap against partial spend: an unreadable ledger, or rotations that kept racing the read
      if (today.complete === false || all.complete === false) {
        if (today.unreadable || all.unreadable) {
          log("warn", "spend ledger could not be read: metered request held back");
          return { action: "block", reason: "The spend ledger could not be read (check the model-hub data dir permissions with dsh-hub doctor), so caps could not be checked against your spend.", pct: 0, which: "ledger-unreadable", price };
        }
        log("warn", "spend ledger was being rotated while it was read: metered request held back");
        return { action: "block", reason: "The spend ledger was being rotated by another DSH process while it was read, so caps could not be checked against all spend. Retry in a moment.", pct: 0, which: "ledger-busy", price };
      }
      const res = checkCaps({
        summary: today,
        sessionSummary: all,
        provider, sessionId, billing: price.billing, caps, priced: isPriced(price),
      });
      // an unpriced metered model is logged once, whatever the cap decision (a cap warning can outrank it)
      if (!isPriced(price) && !warnedUnpriced.has(`${provider}/${model}`)) {
        warnedUnpriced.add(`${provider}/${model}`);
        log("warn", res.which === "unpriced-capped"
          ? `${provider}/${model} has no known price and ${provider} has a daily cap: it is blocked (add it to prices.json)`
          : `${provider}/${model} has no known price: its spend is not counted toward caps (add it to prices.json)`);
      }
      return { ...res, price };
    } catch (e) {
      log("warn", `guard failed open: ${String(e?.message || e).slice(0, 120)}`);
      return { action: "ok" };
    }
  }

  /** Record the spend of one model call from its stream's `usage` chunk (spendGuardMiddleware calls this for every
   *  request DSH sends: chat steps, compaction, reviews, and failed attempts that report usage). The guard sees it as
   *  pending from the moment it is called (the stream does not wait for it). -> { record } | null */
  function recordUsage(options, usage) {
    const p = recordCall(options, usage);
    pendingCaptures.add(p);
    p.finally(() => pendingCaptures.delete(p));
    return p;
  }

  async function recordCall(options, u) {
    try {
      const provider = String(options?.provider || "");
      const model = String(options?.model || "");
      const sessionId = String(options?.sessionId ?? "");
      if (!u || !provider) return null;
      const n = normalizeUsage(u);
      if (!(n.input + n.output + n.cacheRead + n.cacheWrite > 0)) return null; // no tokens, no cost
      // A recorded price is permanent. Use the price known now (an override, the cached or loaded table); only a
      // model with no price yet waits for the first table load, instead of storing a loading state as $0.
      let price = priceFor(await getTable({ wait: false }), provider, model, priceOpts());
      if (!isPriced(price) && !usableTable()) price = priceFor(await getTable({ full: true }), provider, model, priceOpts());
      const rec = makeSpendRecord({ sessionId, provider, model, usage: u, price });
      return { record: rec, written: writeRow(rec) };
    } catch (e) {
      log("warn", `capture failed: ${String(e?.message || e).slice(0, 120)}`);
      return null;
    }
  }

  /** Session events feed the prompt-cache tracker (spend is recorded from the stream, see recordUsage). */
  async function onSessionEvent(session, event) {
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
      byProvider: s.byProvider, groups: s.groups,
      caps: capsStatus(),
      // DISPLAY ONLY: extra ledgers (config.json extraLedgers / DSH_HUB_EXTRA_LEDGERS). Never read by caps/guard.
      external: summarizeExternal(typeof externalLedger === "function" ? externalLedger() : externalLedger, { since, now: now() }),
    };
  }

  async function prices(models) {
    const t = await getTable();
    const out = {};
    for (const m of models) {
      const i = m.indexOf("/");
      const p = i > 0 ? priceFor(t, m.slice(0, i), m.slice(i + 1), priceOpts()) : null;
      out[m] = p ? { ...p, priced: isPriced(p) } : { error: "use provider/model", priced: false };
    }
    syncHealth();
    return {
      source: t?.source ?? "none", fetchedAt: t?.fetchedAt ?? null, count: t?.count ?? 0, warnings: t?.warnings ?? [], models: out,
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

  return { guard, onSessionEvent, recordUsage, recordProviderFailure, clearProviderHealth, providerHealth: () => JSON.parse(JSON.stringify(health)), capsStatus, spendReport, prices, cacheReport, getTable, warm: () => refreshTable(), tracker, dataDir };
}

/** A terminal error stream for a blocked request (what LlmRuntime itself yields for an adapter failure). */
export function blockedStream(reason) {
  const failure = Object.freeze({ message: `Request blocked by model-hub spend cap: ${reason}. Raise it in caps.json in the model-hub data dir (\`dsh-hub doctor\` shows where) or run \`dsh-hub spend\`.`, code: SPEND_CAP_CODE });
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "finish", reason: { kind: "error", failure } };
    },
  };
}

/**
 * `llm/stream` waterfall listener: `(options, next) => AsyncIterable<StreamChunk>`. Every model request
 * (the agent loop's prepared calls AND plain `llm.stream` calls such as compaction) passes this
 * waterfall, so a metered request over its cap is stopped here BEFORE the adapter is dispatched.
 * Register with `ctx.on("llm/stream", spendGuardMiddleware(engine))`.
 */
export function spendGuardMiddleware(engine, { onBlock } = {}) {
  return function spendGuard(options, next) {
    return {
      async *[Symbol.asyncIterator]() {
        const verdict = await engine.guard(options);
        if (verdict.action === "block") {
          try { onBlock?.(verdict, options); } catch { /* ignore */ }
          yield* blockedStream(verdict.reason);
          return;
        }
        // Pass every chunk through untouched. The `usage` chunk is this call's spend (every call DSH makes passes
        // here, compaction and failed attempts included); the terminal `finish` chunk reports credit failures.
        for await (const chunk of next()) {
          try {
            if (chunk?.type === "usage" && chunk.usage) void engine.recordUsage?.(options, chunk.usage);
            else if (chunk?.type === "finish") {
              const k = chunk.reason?.kind;
              const provider = String(options?.provider || "");
              if (k === "error") engine.recordProviderFailure?.(provider, chunk.reason.failure);
              else if (k !== "aborted") engine.clearProviderHealth?.(provider);
            }
          } catch { /* observation must never break the stream */ }
          yield chunk;
        }
      },
    };
  };
}
