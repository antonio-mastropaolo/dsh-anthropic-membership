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
import { sanitizeError } from "../accounts/errors.mjs";
import { loadConfig } from "../config.mjs";
import {
  appendSpend, checkCaps, createCacheTracker, isPriced, loadCaps, loadPriceTable, makeSpendRecord,
  normalizeUsage, priceFor, summarize, summarizeExternal, externalLedgerPaths, loadOverrides,
} from "../cost/index.mjs";

import { DEFAULT_DATA_DIR } from "../paths.mjs";
export { DEFAULT_DATA_DIR };
export const SPEND_CAP_CODE = "SPEND_CAP";
const TABLE_TTL_MS = 24 * 3600e3;
const SUMMARY_TTL_MS = 3000;
const TABLE_WAIT_MS = 3000;

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
  // providers with an OAuth grant (subscription-billed); a function, an array, or null when unknown
  oauthProviders = null,
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
  const log = (level, msg) => {
    try { logger?.[level]?.(`model-hub: ${msg}`); } catch { /* ignore */ }
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
        tableAt = now();
        overridesMtime = startMtime;
        for (const w of t?.warnings ?? []) log("warn", `price table: ${w}`);
      })
      .catch((e) => log("warn", `price table load failed: ${String(e?.message || e).slice(0, 120)}`))
      .finally(() => { loading = null; });
    return loading;
  }

  async function getTable({ wait = true } = {}) {
    if (!table || now() - tableAt > TABLE_TTL_MS) {
      const p = refreshTable();
      if (!table && wait) {
        await Promise.race([p, new Promise((r) => setTimeout(r, TABLE_WAIT_MS).unref?.())]);
      }
    }
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
      const caps = loadCaps(dataDir);
      const res = checkCaps({
        // Metered requests only reach here: read the ledger fresh so another DSH process's spend counts at once.
        summary: summary({ since: "today" }, { fresh: true }),
        sessionSummary: summary({ since: "30d" }, { fresh: true }),
        provider, sessionId, billing: price.billing, caps, priced: isPriced(price),
      });
      if (res.which === "unpriced" && !warnedUnpriced.has(`${provider}/${model}`)) {
        warnedUnpriced.add(`${provider}/${model}`);
        log("warn", `${provider}/${model} has no known price: its spend is not counted toward caps (add it to prices.json)`);
      }
      return { ...res, price };
    } catch (e) {
      log("warn", `guard failed open: ${String(e?.message || e).slice(0, 120)}`);
      return { action: "ok" };
    }
  }

  /** Handle one session event; returns the ledger record when a step was billed. */
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
      const t = await getTable({ wait: false });
      const price = priceFor(t, provider, model, priceOpts());
      const rec = makeSpendRecord({ sessionId, provider, model, usage: u, price });
      appendSpend(dataDir, rec);
      invalidate();
      const r = tracker.observe({ sessionId, step: data.step, provider, model, usage: normalizeUsage(u), fingerprints: fps.get(sessionId) });
      lastSession = sessionId;
      return { record: rec, cache: r };
    } catch (e) {
      log("warn", `capture failed: ${String(e?.message || e).slice(0, 120)}`);
      return null;
    }
  }

  function capsStatus() {
    const caps = loadCaps(dataDir);
    const today = summary({ since: "today" });
    const res = checkCaps({ summary: today, provider: "", sessionId: "", billing: "metered", caps });
    const perProvider = {};
    for (const [p, cap] of Object.entries(caps.perProviderDailyUsd || {})) {
      perProvider[p] = { capUsd: cap, spentUsd: today.byProvider?.[p]?.usd || 0 };
    }
    return {
      limits: { dailyUsd: caps.dailyUsd, sessionUsd: caps.sessionUsd, perProviderDailyUsd: caps.perProviderDailyUsd, warnPct: caps.warnPct },
      todayUsd: today.totals?.usd || 0,
      action: res.action, reason: res.reason, pct: res.pct, which: res.which,
      perProvider,
      warnings: [...(caps.warnings || [])],
    };
  }

  async function spendReport({ since = "today", by = "provider" } = {}) {
    const s = summary({ since, by });
    return {
      since, by, sinceMs: s.sinceMs, totals: s.totals,
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

  return { guard, onSessionEvent, recordProviderFailure, clearProviderHealth, providerHealth: () => JSON.parse(JSON.stringify(health)), capsStatus, spendReport, prices, cacheReport, getTable, warm: () => refreshTable(), tracker, dataDir };
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
        // Pass every chunk through untouched; only watch the terminal `finish` chunk for credit failures.
        for await (const chunk of next()) {
          try {
            if (chunk?.type === "finish") {
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
