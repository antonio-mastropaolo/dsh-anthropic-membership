import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "./app.mjs";
import { appendSpend } from "../cost/ledger.mjs";

test("a credential read failure resets subscription billing at once: a grant seen earlier is never reused", () => {
  let t = 1_000_000;
  let mode = "ok";
  const readAccountsFn = () => {
    if (mode === "fail") throw new Error("credentials unreadable");
    return [{ provider: "anthropic", signedIn: true, kind: "oauth" }, { provider: "openai", signedIn: true, kind: "api_key" }];
  };
  const hub = createHub({
    dataDir: mkdtempSync(join(tmpdir(), "hub-app-")), legacy: { status: async () => ({}) },
    credentialsPath: join(mkdtempSync(join(tmpdir(), "hub-app-creds-")), "none.yaml"),
    engine: { onSessionEvent: async () => null }, now: () => t, readAccountsFn, refreshEnabled: false,
  });
  assert.deepEqual(hub.oauthProviders(), ["anthropic"], "only the OAuth grant counts");
  mode = "fail";
  assert.deepEqual(hub.oauthProviders(), ["anthropic"], "within the 30 s cache window the last answer stands");
  t += 30_001;
  assert.deepEqual(hub.oauthProviders(), [], "after it, a failed read means no subscription (metered)");
  mode = "ok"; t += 30_001;
  assert.deepEqual(hub.oauthProviders(), ["anthropic"], "a good read restores it");
  hub.stop();
});

test("GET /accounts reports the credential store the refresher will use, and whether DSH replaced it", () => {
  let current = { readRecord() {}, modifyRecord() {}, isClosed: () => false };
  const first = current;
  const hub = createHub({
    dataDir: mkdtempSync(join(tmpdir(), "hub-cs-")), legacy: { status: async () => ({}) },
    credentialsPath: join(mkdtempSync(join(tmpdir(), "hub-cs-creds-")), "none.yaml"),
    engine: { onSessionEvent: async () => null }, readAccountsFn: () => [],
  });
  assert.deepEqual(hub.accounts.state().credentialStore, { state: "none", replacedSinceStart: false });
  const pluginCtx = { get: (n) => (n === "credentials" ? current : undefined) };
  assert.equal(hub.upgradeRefresher(pluginCtx), true);
  assert.deepEqual(hub.accounts.state().credentialStore, { state: "live", replacedSinceStart: false });
  first.isClosed = () => true; // DSH disposes it...
  assert.equal(hub.accounts.state().credentialStore.state, "disposed");
  current = { readRecord() {}, modifyRecord() {}, isClosed: () => false }; // ...and registers a new one
  assert.deepEqual(hub.accounts.state().credentialStore, { state: "live", replacedSinceStart: true });
  hub.stop();
});

test("GET /accounts never fails when the credential store cannot be read: empty list plus the reason", () => {
  const hub = createHub({
    dataDir: mkdtempSync(join(tmpdir(), "hub-noyaml-")), legacy: { status: async () => ({}) },
    credentialsPath: join(mkdtempSync(join(tmpdir(), "hub-noyaml-creds-")), "c.yaml"),
    engine: { onSessionEvent: async () => null },
    readAccountsFn: () => { throw new Error("no YAML parser available (DSH yaml package not found)"); },
  });
  const s = hub.accounts.state();
  assert.deepEqual(s.accounts, []);
  assert.match(s.unavailable, /no YAML parser/);
  assert.equal(s.reportOnly, true);
  hub.stop();
});

test("a route that sends an API key is metered even while an OAuth grant is stored; unknown route config = metered", async () => {
  const grant = [{ provider: "anthropic", signedIn: true, kind: "oauth", health: "ok" }];
  const subscribed = (apiKeyRoutes) => {
    const hub = createHub({ dataDir: mkdtempSync(join(tmpdir(), "hub-route-")), legacy: { status: async () => ({}) }, engine: { onSessionEvent: async () => null }, readAccountsFn: () => grant, apiKeyRoutes });
    const v = hub.oauthProviders();
    hub.stop();
    return v;
  };
  assert.deepEqual(subscribed(() => []), ["anthropic"], "grant + OAuth route: subscription");
  assert.deepEqual(subscribed(() => ["anthropic"]), [], "the route's apiKeyEnv key is what DSH sends: metered");
  assert.deepEqual(subscribed(() => null), [], "route config unknown: no subscription assumed");
  assert.deepEqual(subscribed(() => { throw new Error("loader gone"); }), []);
});

test("hub.forecast.report(): includes the session in use, is memoised for 5 s, survives a throwing capsStatus", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-forecast-"));
  const T0 = new Date(2026, 10, 12, 14, 0).getTime();
  for (let i = 0; i < 20; i++) {
    appendSpend(dataDir, { ts: new Date(T0 - (i + 0.5) * 60e3).toISOString(), sessionId: i % 2 ? "s2" : "s1", provider: "openai", model: "m", usd: 0.02, apiEquivUsd: 0.02, billing: "metered", priceSource: "litellm" });
  }
  let t = T0;
  let status = () => ({ session: "s1" });
  let statusCalls = 0;
  const hub = createHub({
    dataDir, legacy: { status: async () => ({}) }, getConfig: () => ({ plans: {} }),
    engine: { onSessionEvent: async () => null, capsStatus: () => { statusCalls++; return status(); } },
    now: () => t, readAccountsFn: () => [], refreshEnabled: false,
  });
  const first = hub.forecast.report();
  assert.equal(first.estimate, true);
  const sess = first.spend.caps.find((c) => c.which === "session");
  assert.equal(sess.sessionId, "s1", "the session in use, from capsStatus");
  assert.ok(first.spend.caps.some((c) => c.which === "daily"));
  t += 4_999;
  assert.equal(hub.forecast.report(), first, "within 5 s: the memoised object");
  assert.equal(statusCalls, 1);
  t += 2; // 5 001 ms after the first report
  const second = hub.forecast.report();
  assert.notEqual(second, first, "after 5 s it is recomputed");
  assert.equal(second.generatedAt, T0 + 5_001);
  // a throwing capsStatus never fails the report: the session falls back to the newest ledger row's
  status = () => { throw new Error("engine gone"); };
  t += 5_001;
  const third = hub.forecast.report();
  assert.equal(third.spend.caps.find((c) => c.which === "session").sessionId, "s1", "newest row (i = 0) is s1");
  // no capsStatus on the engine at all
  const bare = createHub({ dataDir, legacy: { status: async () => ({}) }, getConfig: () => ({ plans: {} }), engine: { onSessionEvent: async () => null }, now: () => T0, readAccountsFn: () => [], refreshEnabled: false });
  assert.equal(bare.forecast.report().spend.complete, true);
  hub.stop(); bare.stop();
});

test("the hub exposes routeAuth (what the /route command reads): known keyed routes, or unknown when the route config cannot be read", () => {
  const mk = (apiKeyRoutes) => createHub({ dataDir: mkdtempSync(join(tmpdir(), "hub-app-")), legacy: { status: async () => ({}) }, engine: { onSessionEvent: async () => null }, apiKeyRoutes, refreshEnabled: false });
  const a = mk(() => ["zeta", "google"]);
  assert.deepEqual(a.routeAuth(), { known: true, apiKeyRoutes: ["google", "zeta"] });
  const b = mk(() => null);
  assert.deepEqual(b.routeAuth(), { known: false, apiKeyRoutes: [] });
  const c = mk(() => { throw new Error("loader gone"); });
  assert.deepEqual(c.routeAuth(), { known: false, apiKeyRoutes: [] });
  for (const h of [a, b, c]) h.stop();
});
