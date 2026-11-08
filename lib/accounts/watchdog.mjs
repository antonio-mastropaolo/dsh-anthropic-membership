/**
 * Credential watchdog. Periodically reads account health and, when a refresher is injected
 * (DSH's own credential seam), refreshes OAuth grants before they expire. With `refresh`
 * null/undefined it is report-only. State (no secrets) is persisted to statePath.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { classifyError, sanitizeError } from "./errors.mjs";
export { classifyError, sanitizeError };

function atomicWriteJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function createWatchdog({
  read,
  refresh = null,
  intervalMs = 300000,
  refreshAheadMs = 600000,
  retryBackoffMs = 900000,
  onChange,
  statePath,
  now = () => Date.now(),
} = {}) {
  if (typeof read !== "function") throw new TypeError("createWatchdog: read is required");
  const st = { lastTickAt: null, providers: {} };
  if (statePath && existsSync(statePath)) {
    try {
      const s = JSON.parse(readFileSync(statePath, "utf8"));
      if (s && typeof s.providers === "object" && s.providers) {
        for (const [k, v] of Object.entries(s.providers)) {
          st.providers[k] = {
            lastRefreshAt: Number.isFinite(v?.lastRefreshAt) ? v.lastRefreshAt : null,
            lastError: typeof v?.lastError === "string" ? v.lastError : null,
            lastAttemptAt: Number.isFinite(v?.lastAttemptAt) ? v.lastAttemptAt : null,
            errorKind: typeof v?.lastError === "string" && v.lastError ? (typeof v?.errorKind === "string" ? v.errorKind : classifyError(v.lastError)) : null,
            terminal: v?.terminal === true,
            terminalExpiresAt: Number.isFinite(v?.terminalExpiresAt) ? v.terminalExpiresAt : null,
          };
        }
      }
    } catch { /* corrupt state: start clean */ }
  }
  let timer = null;
  let ticking = null;
  let lastSig = null;
  let accounts = [];

  // A "revoked" failure is terminal only for the exact credential that failed: a new sign-in changes expiresAt.
  const isTerminal = (s, a) => Boolean(s?.terminal && s.lastError && s.terminalExpiresAt === (a.expiresAt ?? null));

  const overlay = (list) =>
    list.map((a) => {
      const s = st.providers[a.provider];
      if (!s) return a;
      const lastError = s.lastError ?? null;
      const lastRefreshAt = s.lastRefreshAt ?? a.lastRefreshAt ?? null;
      let health = a.health;
      if (lastError && a.signedIn && (a.expired || (a.expiresInMs !== null && a.expiresInMs <= refreshAheadMs))) {
        health = "refresh-failed";
      }
      const terminal = isTerminal(s, a);
      return { ...a, lastError, lastRefreshAt, health, errorKind: lastError ? (s.errorKind ?? "other") : null, terminal };
    });

  const persist = () => {
    if (!statePath) return;
    try { atomicWriteJson(statePath, { updatedAt: now(), providers: st.providers }); } catch { /* best effort */ }
  };

  async function runTick({ force = false } = {}) {
    const t = now();
    let list = await read();
    for (const a of list) {
      if (!a.signedIn || a.kind !== "oauth" || !a.hasRefresh) continue;
      const due = a.expired || (a.expiresInMs !== null && a.expiresInMs <= refreshAheadMs);
      if (!due || typeof refresh !== "function") continue;
      const s = (st.providers[a.provider] ??= { lastRefreshAt: null, lastError: null, lastAttemptAt: null, errorKind: null, terminal: false, terminalExpiresAt: null });
      if (!force && isTerminal(s, a)) continue;
      if (!force && s.lastError && s.lastAttemptAt !== null && t - s.lastAttemptAt < retryBackoffMs) continue;
      s.lastAttemptAt = t;
      try {
        await refresh(a.provider);
        s.lastRefreshAt = now();
        s.lastError = null;
        s.errorKind = null;
        s.terminal = false;
        s.terminalExpiresAt = null;
      } catch (err) {
        s.lastError = sanitizeError(err);
        s.errorKind = classifyError(err);
        s.terminal = s.errorKind === "revoked";
        s.terminalExpiresAt = s.terminal ? (a.expiresAt ?? null) : null;
      }
    }
    // Drop stale errors for providers that are no longer signed in.
    for (const a of list) {
      const p = st.providers[a.provider];
      if (!a.signedIn && p?.lastError) { p.lastError = null; p.errorKind = null; p.terminal = false; p.terminalExpiresAt = null; }
    }
    list = await read();
    accounts = overlay(list);
    st.lastTickAt = now();
    persist();
    const sig = JSON.stringify(accounts.map((a) => [a.provider, a.health, a.expiresAt, a.lastError, a.lastRefreshAt, a.errorKind, a.terminal]));
    if (sig !== lastSig) {
      const first = lastSig === null;
      lastSig = sig;
      if (!first || accounts.length) {
        try { await onChange?.(accounts); } catch { /* listener failure must not stop the watchdog */ }
      }
    }
    return accounts;
  }

  /** `force: true` (POST /accounts/refresh) also retries terminal and backed-off providers. */
  function tick({ force = false } = {}) {
    if (force) {
      const prev = ticking ?? Promise.resolve();
      const p = prev.catch(() => {}).then(() => runTick({ force: true })).finally(() => { if (ticking === p) ticking = null; });
      ticking = p;
      return p;
    }
    if (!ticking) ticking = runTick().finally(() => { ticking = null; });
    return ticking;
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      timer.unref?.();
      tick().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    state() {
      return {
        running: timer !== null,
        reportOnly: typeof refresh !== "function",
        lastTickAt: st.lastTickAt,
        accounts,
      };
    },
  };
}
