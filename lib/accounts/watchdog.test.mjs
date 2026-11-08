import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyError, createWatchdog, sanitizeError } from "./watchdog.mjs";

const mk = (over = {}) => ({
  provider: "anthropic", signedIn: true, kind: "oauth", expiresAt: 0, expired: true, expiresInMs: -1000,
  hasRefresh: true, health: "expired", lastRefreshAt: null, lastError: null, ...over,
});

function harness({ refresh, accountsFn }) {
  let acc = accountsFn();
  const changes = [];
  const w = createWatchdog({
    read: async () => acc,
    refresh,
    onChange: (a) => changes.push(a),
    now: (() => { let t = 1000; return () => (t += 10); })(),
    retryBackoffMs: 1e12,
  });
  return { w, changes, set: (a) => { acc = a; } };
}

test("refreshes due accounts and clears them", async () => {
  const calls = [];
  let acc = [mk()];
  const w = createWatchdog({
    read: async () => acc,
    refresh: async (p) => { calls.push(p); acc = [mk({ expired: false, expiresInMs: 3.6e6, health: "ok" })]; },
  });
  const out = await w.tick();
  assert.deepEqual(calls, ["anthropic"]);
  assert.equal(out[0].health, "ok");
  assert.ok(out[0].lastRefreshAt > 0);
});

test("failure becomes refresh-failed with sanitized error, and backs off", async () => {
  let n = 0;
  const { w, changes } = harness({
    refresh: async () => { n++; throw new Error("boom sk-ant-ort01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"); },
    accountsFn: () => [mk()],
  });
  const out = await w.tick();
  assert.equal(out[0].health, "refresh-failed");
  assert.ok(!out[0].lastError.includes("AAAAAAAAAAAA"));
  await w.tick();
  assert.equal(n, 1, "second tick respects backoff");
  assert.equal(changes.length, 1, "onChange only on change");
});

test("report-only when refresh is null", async () => {
  const { w } = harness({ refresh: null, accountsFn: () => [mk()] });
  const out = await w.tick();
  assert.equal(out[0].health, "expired");
  assert.equal(w.state().reportOnly, true);
});

test("skips accounts without refresh token, api keys, and healthy ones", async () => {
  const calls = [];
  const { w } = harness({
    refresh: async (p) => calls.push(p),
    accountsFn: () => [
      mk({ provider: "a", hasRefresh: false }),
      mk({ provider: "b", kind: "api-key", expired: false, expiresInMs: null, health: "ok" }),
      mk({ provider: "c", expired: false, expiresInMs: 3.6e6, health: "ok" }),
      mk({ provider: "d", signedIn: false, kind: null, health: "missing", expired: false, expiresInMs: null }),
    ],
  });
  await w.tick();
  assert.deepEqual(calls, []);
});

test("refreshes ahead of expiry", async () => {
  const calls = [];
  const { w } = harness({ refresh: async (p) => calls.push(p), accountsFn: () => [mk({ expired: false, expiresInMs: 300e3, health: "expiring" })] });
  await w.tick();
  assert.deepEqual(calls, ["anthropic"]);
});

test("concurrent ticks share one run", async () => {
  let n = 0;
  const { w } = harness({ refresh: async () => { n++; await new Promise((r) => setTimeout(r, 20)); }, accountsFn: () => [mk()] });
  await Promise.all([w.tick(), w.tick()]);
  assert.equal(n, 1);
});

test("persists state 0600 without secrets and reloads it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-"));
  const statePath = join(dir, "sub", "accounts-state.json");
  const w = createWatchdog({ read: async () => [mk()], refresh: async () => { throw new Error("nope"); }, statePath });
  await w.tick();
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  const raw = readFileSync(statePath, "utf8");
  assert.ok(JSON.parse(raw).providers.anthropic.lastError === "nope");
  const w2 = createWatchdog({ read: async () => [mk()], refresh: null, statePath });
  const out = await w2.tick();
  assert.equal(out[0].health, "refresh-failed");
  rmSync(dir, { recursive: true });
});

test("start/stop manage the timer", async () => {
  const { w } = harness({ refresh: null, accountsFn: () => [mk()] });
  w.start();
  assert.equal(w.state().running, true);
  w.stop();
  assert.equal(w.state().running, false);
  await w.tick();
});

test("sanitizeError redacts token-like runs", () => {
  assert.equal(sanitizeError(new Error("x abcdefghijklmnopqrstuvwxyz0123 y")), "x [redacted] y");
});

const RAW_REVOKED = 'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://console.anthropic.com/v1/oauth/token; details=Error: HTTP request failed. status=400; url=https://console.anthropic.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}';

test("sanitizeError drops urls and url= fragments, keeps the cause, caps at ~160 on a word boundary", () => {
  const s = sanitizeError(new Error(RAW_REVOKED));
  assert.doesNotMatch(s, /https?:|url=|\[redacted\]/);
  assert.match(s, /invalid_grant/);
  assert.ok(s.length <= 161, String(s.length));
  const long = sanitizeError(new Error("word ".repeat(100)));
  assert.ok(long.length <= 161);
  assert.match(long, /word…$/);
  assert.equal(sanitizeError(new Error("sk-ant-ort01-" + "A".repeat(40) + " tail")), "[redacted] tail");
});

test("classifyError kinds", () => {
  assert.equal(classifyError(new Error(RAW_REVOKED)), "revoked");
  assert.equal(classifyError(new Error("unauthorized_client")), "revoked");
  assert.equal(classifyError(new Error("HTTP 401 Unauthorized")), "rejected");
  assert.equal(classifyError(new Error("status=403")), "rejected");
  assert.equal(classifyError(new Error("fetch failed ECONNRESET")), "unreachable");
  assert.equal(classifyError(new Error("request timed out")), "unreachable");
  assert.equal(classifyError(new Error("status=503")), "unreachable");
  assert.equal(classifyError(new Error("weird")), "other");
});

test("revoked refresh is terminal: no automatic retry until expiry changes or a forced tick", async () => {
  let n = 0;
  let acc = [mk({ expiresAt: 111 })];
  const w = createWatchdog({
    read: async () => acc,
    refresh: async () => { n++; throw new Error(RAW_REVOKED); },
    retryBackoffMs: 0, // backoff alone would retry every tick; terminal must still block
  });
  let out = await w.tick();
  assert.equal(n, 1);
  assert.equal(out[0].errorKind, "revoked");
  assert.equal(out[0].terminal, true);
  assert.equal(out[0].health, "refresh-failed");
  await w.tick();
  await w.tick();
  assert.equal(n, 1, "terminal: no retries");
  out = await w.tick({ force: true });
  assert.equal(n, 2, "forced tick retries");
  assert.equal(out[0].terminal, true);
  // user signs in again: new expiry -> terminal flag is stale, watchdog tries again
  acc = [mk({ expiresAt: 222 })];
  await w.tick();
  assert.equal(n, 3, "identity changed");
});

test("non-terminal errors expose errorKind and terminal=false; success clears both", async () => {
  let fail = true;
  const w = createWatchdog({
    read: async () => [mk()],
    refresh: async () => { if (fail) throw new Error("fetch failed ECONNREFUSED"); },
    retryBackoffMs: 0,
  });
  let out = await w.tick();
  assert.equal(out[0].errorKind, "unreachable");
  assert.equal(out[0].terminal, false);
  fail = false;
  out = await w.tick();
  assert.equal(out[0].errorKind, null);
  assert.equal(out[0].lastError, null);
  assert.equal(out[0].terminal, false);
});

test("terminal state survives a restart (persisted) and a healthy row has errorKind null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-t-"));
  const statePath = join(dir, "s.json");
  const w = createWatchdog({ read: async () => [mk({ expiresAt: 5 })], refresh: async () => { throw new Error(RAW_REVOKED); }, statePath });
  await w.tick();
  let n = 0;
  const w2 = createWatchdog({ read: async () => [mk({ expiresAt: 5 })], refresh: async () => { n++; }, statePath, retryBackoffMs: 0 });
  const out = await w2.tick();
  assert.equal(n, 0);
  assert.equal(out[0].terminal, true);
  const ok = createWatchdog({ read: async () => [mk({ provider: "x", expired: false, expiresInMs: 9e9, health: "ok" })], refresh: null });
  assert.equal((await ok.tick())[0].errorKind ?? null, null);
  rmSync(dir, { recursive: true });
});
