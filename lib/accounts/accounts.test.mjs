import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, readAccounts } from "./accounts.mjs";
import { dshNodeModulesOrNull } from "../dsh-nm.mjs";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const SECRET_A = "sk-ant-oat01-SECRETACCESSTOKENVALUE0123456789";
const SECRET_R = "sk-ant-ort01-SECRETREFRESHTOKENVALUE012345678";

function fixture(records, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const parse = (t) => JSON.parse(t);
  const credentialsPath = join(dir, "c.json");
  writeFileSync(credentialsPath, JSON.stringify({ version: 1, refs: {}, records }));
  return { dir, credentialsPath, parse, ...extra };
}
const oauth = (over = {}) => ({ kind: "grant", payload: { type: "oauth", access: SECRET_A, refresh: SECRET_R, expires: NOW + 3600e3, ...over } });

test("one entry per provider, missing when absent", () => {
  const f = fixture({});
  const out = readAccounts({ credentialsPath: f.credentialsPath, now: NOW, parse: f.parse });
  assert.deepEqual(out.map((a) => a.provider), [...OAUTH_PROVIDERS]);
  assert.ok(out.every((a) => a.health === "missing" && !a.signedIn));
  rmSync(f.dir, { recursive: true });
});

test("missing credentials file is all missing", () => {
  const out = readAccounts({ credentialsPath: "/nonexistent/x.yaml", now: NOW });
  assert.equal(out.length, 6);
  assert.ok(out.every((a) => a.health === "missing"));
});

test("ok / expiring / expired classification", () => {
  const f = fixture({
    "llm-pi-ai/anthropic": oauth(),
    "llm-pi-ai/xai": oauth({ expires: NOW + 60e3 }),
    "llm-pi-ai/kimi-coding": oauth({ expires: NOW - 86400e3 }),
  });
  const m = Object.fromEntries(readAccounts({ credentialsPath: f.credentialsPath, now: NOW, parse: f.parse }).map((a) => [a.provider, a]));
  assert.equal(m.anthropic.health, "ok");
  assert.equal(m.anthropic.expiresInMs, 3600e3);
  assert.equal(m.xai.health, "expiring");
  assert.equal(m["kimi-coding"].health, "expired");
  assert.equal(m["kimi-coding"].expired, true);
  assert.equal(m["kimi-coding"].hasRefresh, true);
  assert.equal(m.anthropic.kind, "oauth");
  rmSync(f.dir, { recursive: true });
});

test("no refresh token", () => {
  const f = fixture({ "llm-pi-ai/anthropic": oauth({ refresh: undefined }) });
  const a = readAccounts({ credentialsPath: f.credentialsPath, now: NOW, parse: f.parse })[0];
  assert.equal(a.hasRefresh, false);
  rmSync(f.dir, { recursive: true });
});

test("api-key records are ok with no expiry", () => {
  const f = fixture({ "llm-pi-ai/openrouter": { kind: "api-key", key: "sk-or-xxxxxxxxxxxxxxxxxxxxxxxxxxxx" } });
  const a = readAccounts({ credentialsPath: f.credentialsPath, now: NOW, parse: f.parse }).find((x) => x.provider === "openrouter");
  assert.equal(a.kind, "api-key");
  assert.equal(a.health, "ok");
  assert.equal(a.expiresAt, null);
  rmSync(f.dir, { recursive: true });
});

test("state file adds refresh-failed and lastRefreshAt", () => {
  const f = fixture({ "llm-pi-ai/anthropic": oauth({ expires: NOW - 1000 }) });
  const statePath = join(f.dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ providers: { anthropic: { lastRefreshAt: NOW - 5000, lastError: "invalid_grant" } } }));
  const a = readAccounts({ credentialsPath: f.credentialsPath, now: NOW, parse: f.parse, statePath })[0];
  assert.equal(a.health, "refresh-failed");
  assert.equal(a.lastError, "invalid_grant");
  assert.equal(a.lastRefreshAt, NOW - 5000);
  rmSync(f.dir, { recursive: true });
});

test("never leaks secret values", () => {
  const f = fixture({ "llm-pi-ai/anthropic": oauth(), "client-connection/browser-session": { kind: "grant", payload: { secret: "TOPSECRET" } } });
  const s = JSON.stringify(readAccounts({ credentialsPath: f.credentialsPath, now: NOW, parse: f.parse }));
  assert.ok(!s.includes(SECRET_A) && !s.includes(SECRET_R) && !s.includes("TOPSECRET"));
  rmSync(f.dir, { recursive: true });
});

test("real YAML parser path parses a YAML file", { skip: dshNodeModulesOrNull() ? false : "DeepSeek Harness not installed (needs its yaml); set DSH_NODE_MODULES to run" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const p = join(dir, "c.yaml");
  writeFileSync(p, `version: 1\nrefs: {}\nrecords:\n  llm-pi-ai/anthropic:\n    kind: grant\n    payload:\n      type: oauth\n      access: abc\n      refresh: def\n      expires: ${NOW - 1}\n`);
  const a = readAccounts({ credentialsPath: p, now: NOW })[0];
  assert.equal(a.health, "expired");
  rmSync(dir, { recursive: true });
});

test("report-only rows carry errorKind and terminal from persisted state (terminal only for the same expiry)", () => {
  const expires = NOW - 53 * 864e5;
  const f = fixture({ "llm-pi-ai/anthropic": oauth({ expires }) });
  const statePath = join(f.dir, "s.json");
  writeFileSync(statePath, JSON.stringify({ providers: { anthropic: { lastError: "x invalid_grant", errorKind: "revoked", terminal: true, terminalExpiresAt: expires } } }));
  let a = readAccounts({ credentialsPath: f.credentialsPath, now: NOW, parse: f.parse, statePath }).find((x) => x.provider === "anthropic");
  assert.equal(a.errorKind, "revoked");
  assert.equal(a.terminal, true);
  assert.equal(a.health, "refresh-failed");
  writeFileSync(f.credentialsPath, JSON.stringify({ version: 1, refs: {}, records: { "llm-pi-ai/anthropic": oauth({ expires: NOW + 3600e3 }) } }));
  a = readAccounts({ credentialsPath: f.credentialsPath, now: NOW, parse: f.parse, statePath }).find((x) => x.provider === "anthropic");
  assert.equal(a.terminal, false, "re-signed-in credential is not terminal");
  assert.equal(a.health, "ok");
  assert.equal(a.lastError, null, "a fresh grant does not show the pre-sign-in error");
  assert.equal(a.errorKind, null);
  const none = readAccounts({ credentialsPath: f.credentialsPath, now: NOW, parse: f.parse }).find((x) => x.provider === "anthropic");
  assert.equal(none.errorKind, null);
  assert.equal(none.terminal, false);
  rmSync(f.dir, { recursive: true });
});
