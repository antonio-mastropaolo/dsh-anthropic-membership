import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedStream, createCostEngine, fingerprintsOf, spendGuardMiddleware, SPEND_CAP_CODE } from "./engine.mjs";

const TABLE = {
  entries: { "gemini/gemini-3.8-flash": { input_cost_per_token: 0.75e-6, output_cost_per_token: 3.75e-6, cache_read_input_token_cost: 0.075e-6, mode: "chat" } },
  overrides: {}, source: "network", fetchedAt: 1, count: 1, warnings: [],
};
const mk = (extra = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng-"));
  const engine = createCostEngine({ dataDir, loadTable: async () => TABLE, localProviders: ["box"], oauthProviders: () => ["anthropic", "openai-codex"], ...extra });
  return { dataDir, engine };
};
const ev = (provider, model, usage, step = 1) => ({ type: "assistant/message", data: { step, usage, message: { source: { provider, model } } } });

test("capture writes a ledger row with real charged/api-equivalent USD and feeds the cache tracker", async () => {
  const { engine, dataDir } = mk();
  await engine.getTable();
  const r = await engine.onSessionEvent({ id: "s1" }, ev("google", "gemini-3.8-flash", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000 }));
  assert.ok(r.record.usd > 0);
  const expected = (1000 * 0.75 + 100 * 3.75 + 9000 * 0.075) / 1e6;
  assert.ok(Math.abs(r.record.usd - expected) < 1e-9, `${r.record.usd} vs ${expected}`);
  assert.equal(r.record.billing, "metered");
  assert.ok(Math.abs(r.cache.hitRatio - 0.9) < 1e-9);
  const line = readFileSync(join(dataDir, "spend.jsonl"), "utf8").trim();
  assert.doesNotMatch(line, /prompt|content|text/);
  const rep = await engine.spendReport({ since: "today" });
  assert.equal(rep.totals.calls, 1);
  assert.equal(engine.cacheReport("s1").steps, 1);
  assert.equal(engine.cacheReport().latest.sessionId, "s1");
});

test("capture ignores non-message events, missing usage and unattributed steps; subscription charges $0 but keeps api-equivalent", async () => {
  const { engine } = mk();
  assert.equal(await engine.onSessionEvent({ id: "s" }, { type: "step/end", data: {} }), null);
  assert.equal(await engine.onSessionEvent({ id: "s" }, ev("google", "m", undefined)), null);
  assert.equal(await engine.onSessionEvent({ id: "s" }, ev("", "m", { inputTokens: 5 })), null);
  assert.equal(await engine.onSessionEvent({ id: "s" }, null), null);
  const r = await engine.onSessionEvent({ id: "s" }, ev("box", "model-a", { inputTokens: 100, outputTokens: 10 }));
  assert.equal(r.record.usd, 0);
  assert.equal(r.record.billing, "local");
});

test("guard blocks a metered request past the daily cap, never subscription/local/free", async () => {
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0.001, sessionUsd: 0 }));
  await engine.getTable();
  await engine.onSessionEvent({ id: "s1" }, ev("google", "gemini-3.8-flash", { inputTokens: 100000, outputTokens: 10000 }));
  const v = await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [] });
  assert.equal(v.action, "block");
  assert.match(v.reason, /daily cap/);
  for (const [p, m] of [["anthropic", "claude-opus-4-8"], ["box", "model-a"]]) {
    assert.equal((await engine.guard({ provider: p, model: m, sessionId: "s1", messages: [] })).action, "ok", p);
  }
});

test("guard blocks on the per-session cap and per-provider cap", async () => {
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0, sessionUsd: 0.0001, perProviderDailyUsd: { xai: 0.0001 } }));
  await engine.getTable();
  await engine.onSessionEvent({ id: "sA" }, ev("google", "gemini-3.8-flash", { inputTokens: 100000, outputTokens: 10000 }));
  assert.equal((await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "sA" })).action, "block");
  assert.notEqual((await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "sB" })).action, "block");
});

test("guard fails open when internals throw", async () => {
  const { engine } = mk({ loadTable: async () => { throw new Error("net down"); } });
  const v = await engine.guard({ provider: "google", model: "x", sessionId: "s" });
  assert.notEqual(v.action, "block");
});

test("spendGuardMiddleware: blocked request never calls next() and yields a clear terminal error", async () => {
  let nexted = 0;
  const next = () => { nexted++; return (async function* () { yield { type: "finish", reason: { kind: "stop" } }; })(); };
  const engine = { guard: async (o) => (o.provider === "google" ? { action: "block", reason: "daily cap $1 reached (spent $2.00 today)", which: "daily" } : { action: "ok" }) };
  const blocked = [];
  const mw = spendGuardMiddleware(engine, { onBlock: (v) => blocked.push(v.which) });
  const chunks = [];
  for await (const c of mw({ provider: "google", model: "m" }, next)) chunks.push(c);
  assert.equal(nexted, 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, "finish");
  assert.equal(chunks[0].reason.kind, "error");
  assert.equal(chunks[0].reason.failure.code, SPEND_CAP_CODE);
  assert.match(chunks[0].reason.failure.message, /spend cap: daily cap \$1 reached/);
  assert.deepEqual(blocked, ["daily"]);
  const ok = [];
  for await (const c of mw({ provider: "box", model: "m" }, next)) ok.push(c);
  assert.equal(nexted, 1);
  assert.equal(ok[0].reason.kind, "stop");
});

test("blockedStream message names the remedy", () => {
  return (async () => { for await (const c of blockedStream("x")) assert.match(c.reason.failure.message, /caps\.json/); })();
});

test("fingerprints are hashes, stable for equal prefixes, differ on change", () => {
  const a = fingerprintsOf({ messages: [{ role: "system", content: "SECRET PROMPT" }], tools: [{ name: "b" }, { name: "a" }] });
  const b = fingerprintsOf({ messages: [{ role: "system", content: "SECRET PROMPT" }], tools: [{ name: "a" }, { name: "b" }] });
  const c = fingerprintsOf({ messages: [{ role: "system", content: "other" }], tools: [{ name: "a" }, { name: "b" }] });
  assert.deepEqual(a, b);
  assert.notEqual(a.system, c.system);
  assert.doesNotMatch(JSON.stringify(a), /SECRET/);
});

test("cache alert surfaces when the system prompt changes between steps", async () => {
  const { engine } = mk();
  await engine.getTable();
  await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "c", system: "A", tools: [] });
  await engine.onSessionEvent({ id: "c" }, ev("google", "gemini-3.8-flash", { inputTokens: 100, cacheReadTokens: 9900 }, 1));
  await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "c", system: "B", tools: [] });
  const r = await engine.onSessionEvent({ id: "c" }, ev("google", "gemini-3.8-flash", { inputTokens: 10000, cacheReadTokens: 0 }, 2));
  assert.equal(r.cache.alert.reason, "system-prompt-changed");
});

test("prices: provider/model rows, unpriced flagged, bare names rejected", async () => {
  const { engine } = mk();
  const p = await engine.prices(["google/gemini-3.8-flash", "google/unknown-x", "bare"]);
  assert.equal(p.models["google/gemini-3.8-flash"].priced, true);
  assert.equal(p.models["google/unknown-x"].priced, false);
  assert.ok(p.models.bare.error);
});

import { isCreditFailure } from "./engine.mjs";
import { existsSync, statSync } from "node:fs";

test("spendReport.external is null without a meter ledger and a display-only block with one; caps ignore it", async () => {
  const d = mkdtempSync(join(tmpdir(), "hub-ext-"));
  const missing = createCostEngine({ dataDir: d, loadTable: async () => TABLE, externalLedger: join(d, "none.jsonl") });
  assert.equal((await missing.spendReport({ since: "all" })).external, null);
  const f = join(d, "meter.jsonl");
  writeFileSync(f, JSON.stringify({ ts: new Date().toISOString(), provider: "nearai", usd: 3 }) + "\n");
  writeFileSync(join(d, "caps.json"), JSON.stringify({ dailyUsd: 0.001, sessionUsd: 0 }));
  const engine = createCostEngine({ dataDir: d, loadTable: async () => TABLE, externalLedger: f });
  await engine.getTable();
  const rep = await engine.spendReport({ since: "today" });
  assert.deepEqual(rep.external.totals, { usd: 3, calls: 1 });
  assert.equal(rep.totals.usd, 0, "hub totals unchanged");
  assert.equal(rep.caps.todayUsd, 0, "caps unchanged");
  assert.equal((await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] })).action, "ok");
});

test("providerHealth: records credit failures from the llm/stream finish chunk, persists 0600, clears on success", async () => {
  const { engine, dataDir } = mk();
  assert.deepEqual((await engine.prices(["google/x"])).providerHealth, {});
  const failing = { async *[Symbol.asyncIterator]() { yield { type: "text-delta", text: "" }; yield { type: "finish", reason: { kind: "error", failure: { message: "Your prepayment credits are depleted. url=https://x.example/v1 key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123", code: "PROVIDER_ERROR", status: 402 } } }; } };
  const mw = spendGuardMiddleware(engine);
  const seen = [];
  for await (const c of mw({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] }, () => failing)) seen.push(c.type);
  assert.deepEqual(seen, ["text-delta", "finish"], "chunks pass through unchanged");
  const h = (await engine.prices(["google/x"])).providerHealth;
  assert.equal(h.google.code, 402);
  assert.ok(Number.isFinite(h.google.at));
  assert.doesNotMatch(JSON.stringify(h), /AIza|https?:/);
  const file = join(dataDir, "provider-health.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // survives a restart
  const again = createCostEngine({ dataDir, loadTable: async () => TABLE });
  assert.equal(again.providerHealth().google.code, 402);
  // an unrelated provider's success does not clear it; the same provider's assistant/message does
  await engine.onSessionEvent({ id: "s" }, ev("box", "model-a", { inputTokens: 1 }));
  assert.ok(engine.providerHealth().google);
  await engine.onSessionEvent({ id: "s" }, ev("google", "gemini-3.8-flash", { inputTokens: 1 }));
  assert.deepEqual(engine.providerHealth(), {});
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});

test("providerHealth ignores our own spend cap, aborts and ordinary errors; finish ok clears", async () => {
  const { engine } = mk();
  const run = async (provider, finish) => {
    const mw = spendGuardMiddleware(engine);
    for await (const _ of mw({ provider, model: "m", messages: [] }, () => ({ async *[Symbol.asyncIterator]() { yield { type: "finish", reason: finish }; } }))) { /* drain */ }
  };
  await run("google", { kind: "error", failure: { message: "blocked by spend cap: daily credit", code: SPEND_CAP_CODE } });
  await run("google", { kind: "error", failure: { message: "overloaded", code: "X", status: 529 } });
  await run("google", { kind: "aborted", failure: { message: "credit", code: "ABORT" } });
  assert.deepEqual(engine.providerHealth(), {});
  await run("xai", { kind: "error", failure: { message: "insufficient_quota", code: "RATE", status: 429 } });
  assert.equal(engine.providerHealth().xai.code, 429);
  await run("xai", { kind: "stop" });
  assert.deepEqual(engine.providerHealth(), {});
  assert.equal(isCreditFailure({ message: "You exceeded your current quota; insufficient_quota" }), true);
  assert.equal(isCreditFailure({ message: "boom", status: 500 }), false);
});

test('provider health written by another process shows up without a restart', async () => {
  const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mh-health-'));
  const eng = createCostEngine({ dataDir: dir, loadTable: async () => null, externalLedger: join(dir, 'none.jsonl') });
  assert.equal(JSON.stringify((await eng.prices(['google/gemini-4-argon'])).providerHealth), '{}');
  const f = join(dir, 'provider-health.json');
  writeFileSync(f, JSON.stringify({ google: { code: 402, message: 'prepayment credits are depleted', at: Date.now() } }));
  utimesSync(f, new Date(), new Date(Date.now() + 5000));
  const ph = (await eng.prices(['google/gemini-4-argon'])).providerHealth;
  assert.equal(ph.google && ph.google.code, 402);
});

test("local providers come from config.json in the data dir (no hardcoded names)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng-cfg-"));
  const { loadConfig } = await import("../config.mjs");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ gpuServer: { id: "mybox", url: "http://127.0.0.1:1" }, localProviders: ["mac"] }));
  assert.deepEqual([...loadConfig({ dataDir, env: {} }).localProviders], ["mac", "mybox"]);
  const engine = createCostEngine({ dataDir, loadTable: async () => TABLE });
  const r = await engine.onSessionEvent({ id: "s" }, ev("mybox", "m", { inputTokens: 100, outputTokens: 10 }));
  assert.equal(r.record.billing, "local");
  const bare = createCostEngine({ dataDir: mkdtempSync(join(tmpdir(), "hub-eng-none-")), loadTable: async () => TABLE });
  const r2 = await bare.onSessionEvent({ id: "s" }, ev("rocco", "m", { inputTokens: 100, outputTokens: 10 }));
  assert.equal(r2.record.billing, "metered");
});

test("Claude via an API key (no OAuth grant) is metered: priced into the ledger and blocked past the cap", async () => {
  const CLAUDE = { ...TABLE, entries: { ...TABLE.entries, "claude-opus-4-8": { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, mode: "chat" } } };
  const { engine, dataDir } = mk({ oauthProviders: () => [], loadTable: async () => CLAUDE });
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0.001, sessionUsd: 0 }));
  await engine.getTable();
  const r = await engine.onSessionEvent({ id: "k1" }, ev("anthropic", "claude-opus-4-8", { inputTokens: 100000, outputTokens: 10000 }));
  assert.equal(r.record.billing, "metered");
  assert.ok(r.record.usd > 0, "API-key Claude spend is charged, not $0");
  assert.equal((await engine.guard({ provider: "anthropic", model: "claude-opus-4-8", sessionId: "k1", messages: [] })).action, "block");
  const sub = mk({ oauthProviders: () => ["anthropic"], loadTable: async () => CLAUDE });
  await sub.engine.getTable();
  const r2 = await sub.engine.onSessionEvent({ id: "k2" }, ev("anthropic", "claude-opus-4-8", { inputTokens: 100000, outputTokens: 10000 }));
  assert.equal(r2.record.billing, "subscription");
  assert.equal(r2.record.usd, 0);
});

test("prices.json edits apply without a restart (mtime-checked, no network)", async () => {
  const { dataDir, engine } = mk();
  const id = "acme/model-z";
  assert.equal((await engine.prices([id])).models[id].priced, false);
  writeFileSync(join(dataDir, "prices.json"), JSON.stringify({ [id]: { inPerM: 1, outPerM: 2 } }));
  const p = (await engine.prices([id])).models[id];
  assert.equal(p.priced, true, "new override picked up");
  writeFileSync(join(dataDir, "prices.json"), "{}");
  const { utimesSync } = await import("node:fs");
  utimesSync(join(dataDir, "prices.json"), new Date(), new Date(Date.now() + 5000)); // make sure the mtime moves
  assert.equal((await engine.prices([id])).models[id].priced, false, "removed override dropped");
});

test("when DSH's grants cannot be read, Claude is metered and capped, never a free $0", async () => {
  const CLAUDE = { ...TABLE, entries: { ...TABLE.entries, "claude-opus-4-8": { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, mode: "chat" } } };
  const { engine, dataDir } = mk({ oauthProviders: null, loadTable: async () => CLAUDE });
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0.001, sessionUsd: 0 }));
  await engine.getTable();
  const r = await engine.onSessionEvent({ id: "u1" }, ev("anthropic", "claude-opus-4-8", { inputTokens: 100000, outputTokens: 10000 }));
  assert.equal(r.record.billing, "metered");
  assert.ok(r.record.usd > 0);
  assert.equal((await engine.guard({ provider: "anthropic", model: "claude-opus-4-8", sessionId: "u1", messages: [] })).action, "block");
});

test("an unpriced model blocked by a provider cap is logged once too", async () => {
  const logs = [];
  const { engine, dataDir } = mk({ logger: { warn: (m) => logs.push(m), info: () => {} } });
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0, sessionUsd: 0, perProviderDailyUsd: { google: 5 } }));
  await engine.getTable();
  for (let i = 0; i < 3; i++) assert.equal((await engine.guard({ provider: "google", model: "unknown-x", sessionId: "s", messages: [] })).action, "block");
  assert.equal(logs.filter((m) => /google\/unknown-x has no known price/.test(m)).length, 1);
});
