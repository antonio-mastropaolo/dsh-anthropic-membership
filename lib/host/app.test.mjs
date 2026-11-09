import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "./app.mjs";

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
