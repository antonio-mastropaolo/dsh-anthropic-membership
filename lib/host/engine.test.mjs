import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCaps } from "../cost/caps.mjs";
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
// one model call as DSH makes it: the stream's usage chunk records the spend, the session event feeds the cache tracker
const step = async (eng, session, event) => {
  const src = event?.data?.message?.source || {};
  const p = event?.type === "assistant/message" ? eng.recordUsage({ provider: src.provider, model: src.model, sessionId: session?.id }, event.data?.usage) : null;
  const cache = await eng.onSessionEvent(session, event);
  const rec = await p;
  return rec || cache ? { record: rec?.record ?? null, cache: cache?.cache ?? null } : null;
};

test("capture writes a ledger row with real charged/api-equivalent USD and feeds the cache tracker", async () => {
  const { engine, dataDir } = mk();
  await engine.getTable();
  const r = await step(engine, { id: "s1" }, ev("google", "gemini-3.8-flash", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000 }));
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
  assert.equal(await step(engine, { id: "s" }, { type: "step/end", data: {} }), null);
  assert.equal(await step(engine, { id: "s" }, ev("google", "m", undefined)), null);
  assert.equal(await step(engine, { id: "s" }, ev("", "m", { inputTokens: 5 })), null);
  assert.equal(await step(engine, { id: "s" }, null), null);
  const r = await step(engine, { id: "s" }, ev("box", "model-a", { inputTokens: 100, outputTokens: 10 }));
  assert.equal(r.record.usd, 0);
  assert.equal(r.record.billing, "local");
});

test("guard blocks a metered request past the daily cap, never subscription/local/free", async () => {
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0.001, sessionUsd: 0 }));
  await engine.getTable();
  await step(engine, { id: "s1" }, ev("google", "gemini-3.8-flash", { inputTokens: 100000, outputTokens: 10000 }));
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
  await step(engine, { id: "sA" }, ev("google", "gemini-3.8-flash", { inputTokens: 100000, outputTokens: 10000 }));
  assert.equal((await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "sA" })).action, "block");
  assert.notEqual((await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "sB" })).action, "block");
});

test("guard fails open when internals throw", async () => {
  const { engine } = mk();
  const v = await engine.guard(new Proxy({}, { get() { throw new Error("malformed request options"); } }));
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
  await step(engine, { id: "c" }, ev("google", "gemini-3.8-flash", { inputTokens: 100, cacheReadTokens: 9900 }, 1));
  await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "c", system: "B", tools: [] });
  const r = await step(engine, { id: "c" }, ev("google", "gemini-3.8-flash", { inputTokens: 10000, cacheReadTokens: 0 }, 2));
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
  await step(engine, { id: "s" }, ev("box", "model-a", { inputTokens: 1 }));
  assert.ok(engine.providerHealth().google);
  await step(engine, { id: "s" }, ev("google", "gemini-3.8-flash", { inputTokens: 1 }));
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
  const r = await step(engine, { id: "s" }, ev("mybox", "m", { inputTokens: 100, outputTokens: 10 }));
  assert.equal(r.record.billing, "local");
  const bare = createCostEngine({ dataDir: mkdtempSync(join(tmpdir(), "hub-eng-none-")), loadTable: async () => TABLE });
  const r2 = await step(bare, { id: "s" }, ev("rocco", "m", { inputTokens: 100, outputTokens: 10 }));
  assert.equal(r2.record.billing, "metered");
});

test("Claude via an API key (no OAuth grant) is metered: priced into the ledger and blocked past the cap", async () => {
  const CLAUDE = { ...TABLE, entries: { ...TABLE.entries, "claude-opus-4-8": { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, mode: "chat" } } };
  const { engine, dataDir } = mk({ oauthProviders: () => [], loadTable: async () => CLAUDE });
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0.001, sessionUsd: 0 }));
  await engine.getTable();
  const r = await step(engine, { id: "k1" }, ev("anthropic", "claude-opus-4-8", { inputTokens: 100000, outputTokens: 10000 }));
  assert.equal(r.record.billing, "metered");
  assert.ok(r.record.usd > 0, "API-key Claude spend is charged, not $0");
  assert.equal((await engine.guard({ provider: "anthropic", model: "claude-opus-4-8", sessionId: "k1", messages: [] })).action, "block");
  const sub = mk({ oauthProviders: () => ["anthropic"], loadTable: async () => CLAUDE });
  await sub.engine.getTable();
  const r2 = await step(sub.engine, { id: "k2" }, ev("anthropic", "claude-opus-4-8", { inputTokens: 100000, outputTokens: 10000 }));
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
  const r = await step(engine, { id: "u1" }, ev("anthropic", "claude-opus-4-8", { inputTokens: 100000, outputTokens: 10000 }));
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

test("a session cap counts the session's whole history, not only the last 30 days", async () => {
  const { appendSpend } = await import("../cost/ledger.mjs");
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0, sessionUsd: 15 }));
  appendSpend(dataDir, { ts: new Date(Date.now() - 31 * 864e5).toISOString(), sessionId: "old", provider: "google", model: "gemini-3.8-flash", usd: 20, billing: "metered", priceSource: "litellm" });
  await engine.getTable();
  const v = await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "old", messages: [] });
  assert.equal(v.action, "block");
});

test("an unpriced model is logged once even when a daily-cap warning outranks it", async () => {
  const { appendSpend } = await import("../cost/ledger.mjs");
  const logs = [];
  const { engine, dataDir } = mk({ logger: { warn: (m) => logs.push(m), info: () => {} } });
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 40, sessionUsd: 0, warnPct: 50 }));
  appendSpend(dataDir, { sessionId: "s", provider: "google", model: "gemini-3.8-flash", usd: 25, billing: "metered", priceSource: "litellm" });
  await engine.getTable();
  for (let i = 0; i < 3; i++) {
    const v = await engine.guard({ provider: "google", model: "unknown-y", sessionId: "s", messages: [] });
    assert.equal(v.action, "warn");
  }
  assert.equal(logs.filter((m) => /google\/unknown-y has no known price/.test(m)).length, 1);
});

test("the guard refuses a metered request when the ledger read was incomplete (never checks a cap on partial spend)", async () => {
  const { _setLedgerAfterListHook, appendSpend } = await import("../cost/ledger.mjs");
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 100, sessionUsd: 0 }));
  appendSpend(dataDir, { sessionId: "s", provider: "google", model: "gemini-3.8-flash", usd: 1, billing: "metered", priceSource: "litellm" });
  await engine.getTable();
  _setLedgerAfterListHook(() => { appendSpend(dataDir, { sessionId: "x", provider: "google", model: "m", usd: 0.01, billing: "metered" }, { rotateBytes: 10 }); });
  let v;
  try { v = await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] }); } finally { _setLedgerAfterListHook(null); }
  assert.equal(v.action, "block");
  assert.equal(v.which, "ledger-busy");
  assert.equal((await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] })).action, "ok", "a quiet ledger is checked normally");
});

test("while the price table is still loading, prices.json overrides apply and a captured step is never stored as $0", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng-load-"));
  writeFileSync(join(dataDir, "prices.json"), JSON.stringify({ "acme/model-q": { inPerM: 1, outPerM: 2 } }));
  // the network load is slow and then fails
  const loadTable = () => new Promise((_, rej) => setTimeout(() => rej(new Error("offline")), 150));
  const engine = createCostEngine({ dataDir, loadTable, oauthProviders: () => [] });
  const v = await engine.guard({ provider: "acme", model: "model-q", sessionId: "s", messages: [] });
  assert.notEqual(v.which, "unpriced", "the override is known before the table loads");
  assert.equal(v.price.source, "override");
  const r = await step(engine, { id: "s" }, ev("acme", "model-q", { inputTokens: 1_000_000, outputTokens: 0 }));
  assert.equal(r.record.usd, 1);
  assert.equal(r.record.priceSource, "override");
});

test("host log lines are redacted (a price-table error quoting a token never reaches the log)", async () => {
  const logs = [];
  const engine = createCostEngine({
    dataDir: mkdtempSync(join(tmpdir(), "hub-eng-log-")),
    loadTable: async () => { throw new Error("bad table: sk-demo1234567890abcdefgh"); },
    logger: { warn: (m) => logs.push(m), info: (m) => logs.push(m) },
  });
  await engine.getTable({ full: true });
  assert.ok(logs.some((m) => /price table load failed/.test(m)));
  assert.ok(!logs.some((m) => /sk-demo1234567890/.test(m)), logs.join("\n"));
});

test("a finished step with a known override counts toward caps at once, even while the price table is loading", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng-pend1-"));
  writeFileSync(join(dataDir, "prices.json"), JSON.stringify({ "acme/model-q": { inPerM: 1, outPerM: 2 } }));
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0.5, sessionUsd: 0 }));
  let release;
  const loadTable = () => new Promise((r) => { release = () => r({ entries: {}, overrides: {}, source: "network", fetchedAt: 1, count: 0, warnings: [] }); });
  const engine = createCostEngine({ dataDir, loadTable, oauthProviders: () => [], tableWaitMs: 50 });
  const cap = step(engine, { id: "s" }, ev("acme", "model-q", { inputTokens: 1_000_000, outputTokens: 0 })); // not awaited, as in lib/index.js
  const v = await engine.guard({ provider: "acme", model: "model-q", sessionId: "s", messages: [] });
  assert.equal(v.action, "block", "the $1 step is already counted against the $0.50 daily cap");
  assert.equal(v.which, "daily");
  assert.equal((await cap).record.usd, 1);
  release();
});

test("a finished step that must wait for the price table holds the next metered request back, then counts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng-pend2-"));
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0.5, sessionUsd: 0 }));
  writeFileSync(join(dataDir, "prices.json"), JSON.stringify({ "google/gemini-known": { inPerM: 0.1, outPerM: 0.1 } }));
  let release;
  const loaded = { entries: { "gemini/gemini-new-z": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }, overrides: {}, source: "network", fetchedAt: 1, count: 1, warnings: [] };
  const loadTable = () => new Promise((r) => { release = () => r(loaded); });
  const engine = createCostEngine({ dataDir, loadTable, oauthProviders: () => [], tableWaitMs: 50 });
  const cap = step(engine, { id: "s" }, ev("google", "gemini-new-z", { inputTokens: 1_000_000, outputTokens: 0 }));
  const held = await engine.guard({ provider: "google", model: "gemini-known", sessionId: "s", messages: [] });
  assert.equal(held.action, "block", "never checked against a ledger missing the finished step");
  assert.equal(held.which, "spend-pending");
  release();
  assert.equal((await cap).record.usd, 1, "recorded at the loaded price, not $0");
  const after = await engine.guard({ provider: "google", model: "gemini-new-z", sessionId: "s", messages: [] });
  assert.equal(after.action, "block");
  assert.equal(after.which, "daily", "the step now counts");
});

test("spend reports say when a read was incomplete (never partial totals presented as complete)", async () => {
  const { _setLedgerAfterListHook, appendSpend } = await import("../cost/ledger.mjs");
  const { engine, dataDir } = mk();
  appendSpend(dataDir, { sessionId: "s", provider: "google", model: "gemini-3.8-flash", usd: 1, billing: "metered", priceSource: "litellm" });
  assert.equal((await engine.spendReport({ since: "today" })).complete, true);
  _setLedgerAfterListHook(() => { appendSpend(dataDir, { sessionId: "x", provider: "google", model: "m", usd: 0.01, billing: "metered" }, { rotateBytes: 10 }); });
  let rep;
  try { rep = await createCostEngine({ dataDir, loadTable: async () => TABLE }).spendReport({ since: "today" }); } finally { _setLedgerAfterListHook(null); }
  assert.equal(rep.complete, false);
  assert.equal(rep.caps.complete, false);
});

test("every call DSH streams is recorded from its usage chunk: compaction and failed attempts too, each exactly once", async () => {
  const { engine, dataDir } = mk();
  await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  const run = async (opts, chunks) => { for await (const _ of mw(opts, async function* () { yield* chunks; })) { /* drain */ } };
  // a compaction request: no assistant/message session event is ever emitted for it
  await run({ provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [] },
    [{ type: "usage", usage: { inputTokens: 900_000, outputTokens: 8000 } }, { type: "finish", reason: { kind: "stop" } }]);
  // a request that failed after consuming tokens
  await run({ provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [] },
    [{ type: "usage", usage: { inputTokens: 1000, outputTokens: 0 } }, { type: "finish", reason: { kind: "error", failure: { message: "boom" } } }]);
  await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [] }); // settles pending captures
  const rows = readFileSync(join(dataDir, "spend.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, "one row per call, no double count");
  assert.ok(rows[0].usd > 0.6, "the compaction call is priced");
  assert.equal(rows[1].input, 1000, "the failed attempt's tokens are recorded too");
  assert.ok(rows[1].usd > 0);
  // the session event alone records nothing (it only feeds the cache tracker)
  await engine.onSessionEvent({ id: "s1" }, ev("google", "gemini-3.8-flash", { inputTokens: 5, outputTokens: 5 }));
  await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [] });
  assert.equal(readFileSync(join(dataDir, "spend.jsonl"), "utf8").split("\n").filter(Boolean).length, 2);
});

test("with no price data at all, a metered request is held back, and the table is retried after a minute (not 24 h)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng-none-"));
  let t = 1_000_000;
  let loads = 0;
  const loadTable = async () => (++loads === 1 ? { entries: {}, overrides: {}, source: "none", fetchedAt: 0, count: 0, warnings: ["no price table available"] } : TABLE);
  const engine = createCostEngine({ dataDir, loadTable, now: () => t, oauthProviders: () => [], tableWaitMs: 50 });
  const v = await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] });
  assert.equal(v.action, "block");
  assert.equal(v.which, "prices-unavailable");
  t += 30_000;
  await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] });
  assert.equal(loads, 1, "not hammered: still the first attempt after 30 s");
  t += 31_000;
  const ok = await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] });
  assert.equal(loads, 2, "retried after a minute");
  assert.equal(ok.action, "ok");
  assert.equal(ok.price.source, "litellm");
});

test("an unreadable ledger is never taken as no spend, and an unwritable one holds metered requests back", async () => {
  const { chmodSync } = await import("node:fs");
  const { appendSpend, _resetLedgerCache } = await import("../cost/ledger.mjs");
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 40, sessionUsd: 0 }));
  appendSpend(dataDir, { sessionId: "s", provider: "google", model: "gemini-3.8-flash", usd: 99, billing: "metered", priceSource: "litellm" });
  await engine.getTable();
  const g = () => engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] });
  assert.equal((await g()).which, "daily", "readable: the $99 counts");
  const file = join(dataDir, "spend.jsonl");
  chmodSync(file, 0o000);
  _resetLedgerCache(); // a fresh DSH process: nothing read from the file before it became unreadable
  try {
    const v = await createCostEngine({ dataDir, loadTable: async () => TABLE, oauthProviders: () => [] }).guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] });
    assert.equal(v.action, "block");
    assert.equal(v.which, "ledger-unreadable");
  } finally { chmodSync(file, 0o600); }
  // unwritable: the call's cost is kept, the next metered request is refused until it is in the ledger
  writeFileSync(join(file), ""); // start from an empty ledger
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0.5, sessionUsd: 0 }));
  chmodSync(file, 0o400);
  try {
    const r = await engine.recordUsage({ provider: "google", model: "gemini-3.8-flash", sessionId: "s" }, { inputTokens: 1_000_000, outputTokens: 0 });
    assert.equal(r.written, false, "the row could not be written yet");
    assert.ok(r.record.usd > 0.5);
    assert.equal((await g()).which, "ledger-unwritable");
    assert.equal((await g()).which, "ledger-unwritable", "an open-only probe never clears it: only an actual write does");
  } finally { chmodSync(file, 0o600); }
  const after = await g();
  assert.equal(after.which, "daily", "writable again: the kept $0.75 row is written first and counts against the $0.50 cap");
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 1, "written exactly once");
});

test("the caps status shows the same caps the guard applies (a per-provider cap that blocks is not 'within caps')", async () => {
  const { appendSpend } = await import("../cost/ledger.mjs");
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 40, sessionUsd: 0, perProviderDailyUsd: { google: 0.5 } }));
  appendSpend(dataDir, { sessionId: "s", provider: "google", model: "gemini-3.8-flash", usd: 1, billing: "metered", priceSource: "litellm" });
  await engine.getTable();
  assert.equal((await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s", messages: [] })).action, "block");
  const st = engine.capsStatus();
  assert.equal(st.action, "block");
  assert.match(st.reason, /google daily cap/);
});

test("the caps status checks the session cap of the session in use even in a fresh process (e.g. the CLI)", async () => {
  const { appendSpend } = await import("../cost/ledger.mjs");
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng-sess-"));
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0, sessionUsd: 15 }));
  appendSpend(dataDir, { ts: new Date(Date.now() - 60_000).toISOString(), sessionId: "old", provider: "google", model: "m", usd: 1, billing: "metered", priceSource: "litellm" });
  appendSpend(dataDir, { sessionId: "s", provider: "google", model: "m", usd: 20, billing: "metered", priceSource: "litellm" });
  const fresh = createCostEngine({ dataDir, loadTable: async () => TABLE, oauthProviders: () => [] });
  const st = fresh.capsStatus();
  assert.equal(st.session, "s", "the newest row's session");
  assert.equal(st.action, "block");
  assert.match(st.reason, /per-session cap/);
});

test("the caps status reports what the session in use has spent (the session cap's measure)", async () => {
  const { appendSpend } = await import("../cost/ledger.mjs");
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng-sessspent-"));
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 40, sessionUsd: 15 }));
  appendSpend(dataDir, { ts: new Date(Date.now() - 86400e3 * 2).toISOString(), sessionId: "s", provider: "google", model: "m", usd: 3, billing: "metered", priceSource: "litellm" });
  appendSpend(dataDir, { sessionId: "s", provider: "google", model: "m", usd: 2, billing: "metered", priceSource: "litellm" });
  const st = createCostEngine({ dataDir, loadTable: async () => TABLE, oauthProviders: () => [] }).capsStatus();
  assert.equal(st.session, "s");
  assert.equal(st.sessionSpentUsd, 5, "the whole history, not just today");
  assert.equal(createCostEngine({ dataDir: mkdtempSync(join(tmpdir(), "hub-eng-nosess-")), loadTable: async () => TABLE }).capsStatus().sessionSpentUsd, null);
});

// ---------------- Ollama Cloud pricing, plan credits, declared subscriptions, Z.ai Coding Plan ----------------
import { readFileSync as rf } from "node:fs";
const NOW = Date.UTC(2026, 10, 18, 19, 0, 0); // Wed 2026-11-18 19:00 UTC: off-peak
const mkAt = (extra = {}, now = NOW) => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng2-"));
  const engine = createCostEngine({ dataDir, now: () => now, loadTable: async () => TABLE, localProviders: [], oauthProviders: () => [], plans: {}, subscriptions: [], routeBaseURLs: () => ({ ollama: "https://ollama.com/v1" }), ...extra });
  return { dataDir, engine };
};
const rec = async (engine, provider, model, usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }, extra = {}) =>
  (await engine.recordUsage({ provider, model, sessionId: "s", ...extra }, usage)).record;

test("ollama on ollama.com is priced from Ollama's table (snapshot offline) and recorded metered with priceSource ollama-snapshot", async () => {
  const { engine } = mkAt();
  await engine.getTable();
  const r = await rec(engine, "ollama", "glm-5.3-flash");
  assert.equal(r.billing, "metered"); assert.equal(r.priceSource, "ollama-snapshot");
  assert.ok(Math.abs(r.usd - (0.15 + 0.50)) < 1e-9, String(r.usd));
  assert.equal(r.apiEquivUsd, r.usd);
});

test("ollama off-peak rate is chosen by the engine clock", async () => {
  const peak = Date.UTC(2026, 10, 17, 13, 0, 0); // Tue 13:00 UTC
  const a = mkAt({}, NOW), b = mkAt({}, peak);
  await a.engine.getTable(); await b.engine.getTable();
  const off = await rec(a.engine, "ollama", "deepseek-v4.1-flash");
  const on = await rec(b.engine, "ollama", "deepseek-v4.1-flash");
  assert.ok(Math.abs(off.usd - (0.15 + 0.60)) < 1e-9, String(off.usd));
  assert.ok(Math.abs(on.usd - (0.30 + 1.20)) < 1e-9, String(on.usd));
});

test("an unknown ollama cloud model is unpriced (metered, $0), never guessed", async () => {
  const { engine } = mkAt();
  await engine.getTable();
  const r = await rec(engine, "ollama", "no-such-model");
  assert.equal(r.priceSource, "unpriced"); assert.equal(r.billing, "metered"); assert.equal(r.usd, 0);
});

test("ollama on a loopback base URL with a non-cloud model is local; a :cloud model over loopback is billed", async () => {
  const { engine } = mkAt({ routeBaseURLs: () => ({ ollama: "http://127.0.0.1:11434/v1" }) });
  await engine.getTable();
  const local = await rec(engine, "ollama", "gemma4:26b");
  assert.equal(local.billing, "local"); assert.equal(local.usd, 0);
  const cloud = await rec(engine, "ollama", "glm-5.3:cloud");
  assert.equal(cloud.billing, "metered"); assert.equal(cloud.priceSource, "ollama-snapshot"); assert.ok(cloud.usd > 0);
});

test("a base URL that only contains ollama.com is not Ollama Cloud (exact host match)", async () => {
  const { engine } = mkAt({ routeBaseURLs: () => ({ ollama: "https://ollama.com.evil.example/v1" }) });
  await engine.getTable();
  const r = await rec(engine, "ollama", "glm-5.3-flash");
  assert.equal(r.priceSource, "unpriced");
});

test("plan credits: calls inside the included amount are billed credits ($0), the crossing call pays only the overage", async () => {
  const plans = { ollama: { name: "Pro", includedUsd: 2, resetsOnDay: 9 } };
  const { engine, dataDir } = mkAt({ plans });
  await engine.getTable();
  const a = await rec(engine, "ollama", "glm-5.3", { inputTokens: 500_000, outputTokens: 100_000 }); // 0.7 + 0.44 = 1.14
  assert.equal(a.billing, "credits"); assert.equal(a.usd, 0); assert.ok(Math.abs(a.apiEquivUsd - 1.14) < 1e-9);
  const b = await rec(engine, "ollama", "glm-5.3", { inputTokens: 500_000, outputTokens: 100_000 }); // used 1.14 + 1.14 = 2.28 > 2
  assert.equal(b.billing, "metered"); assert.ok(Math.abs(b.usd - 0.28) < 1e-9, String(b.usd)); assert.ok(Math.abs(b.apiEquivUsd - 1.14) < 1e-9);
  const c = await rec(engine, "ollama", "glm-5.3", { inputTokens: 500_000, outputTokens: 100_000 });
  assert.equal(c.billing, "metered"); assert.ok(Math.abs(c.usd - 1.14) < 1e-9);
  const [p] = engine.plansReport();
  assert.equal(p.provider, "ollama"); assert.equal(p.usedUsd, 2); assert.equal(p.remainingUsd, 0); assert.ok(Math.abs(p.overageUsd - 1.42) < 1e-9);
  assert.match(rf(join(dataDir, "spend.jsonl"), "utf8"), /"billing":"credits"/);
});

test("the credit cycle resets: spend before the cycle start does not count", async () => {
  const plans = { ollama: { name: "Pro", includedUsd: 2, resetsOnDay: 18 } }; // cycle started 2026-11-18 00:00 UTC
  const { engine, dataDir } = mkAt({ plans });
  const { appendSpend } = await import("../cost/ledger.mjs");
  appendSpend(dataDir, { ts: "2026-11-17T23:00:00Z", provider: "ollama", model: "glm-5.3", usd: 0, apiEquivUsd: 50, billing: "credits", priceSource: "ollama" });
  await engine.getTable();
  const a = await rec(engine, "ollama", "glm-5.3", { inputTokens: 500_000, outputTokens: 100_000 });
  assert.equal(a.billing, "credits");
});

test("a provider without a plan stays plain metered", async () => {
  const { engine } = mkAt({ plans: { google: { name: "x", includedUsd: 100, resetsOnDay: 1 } } });
  await engine.getTable();
  const r = await rec(engine, "ollama", "glm-5.3");
  assert.equal(r.billing, "metered"); assert.ok(r.usd > 0);
});

test("caps count only real spend: credits rows never trip a cap, and the overage does", async () => {
  const plans = { ollama: { name: "Pro", includedUsd: 5, resetsOnDay: 9 } };
  const { engine, dataDir } = mkAt({ plans });
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 0.5, sessionUsd: 0 }));
  await engine.getTable();
  await rec(engine, "ollama", "glm-5.3", { inputTokens: 1_000_000, outputTokens: 500_000 }); // 1.4 + 2.2 = 3.6, inside 5 credits
  let v = await engine.guard({ provider: "ollama", model: "glm-5.3", sessionId: "s", messages: [] });
  assert.equal(v.action, "ok", v.reason);
  await rec(engine, "ollama", "glm-5.3", { inputTokens: 1_000_000, outputTokens: 500_000 }); // crosses: 2.2 overage
  v = await engine.guard({ provider: "ollama", model: "glm-5.3", sessionId: "s", messages: [] });
  assert.equal(v.action, "block");
});

test("Z.ai Coding Plan endpoint is subscription even with an API key; lookalike hosts and paths are not", async () => {
  const coding = mkAt({ routeBaseURLs: () => ({ zai: "https://api.z.ai/api/coding/paas/v4" }) });
  await coding.engine.getTable();
  const r = await rec(coding.engine, "zai", "glm-4.6");
  assert.equal(r.billing, "subscription"); assert.equal(r.usd, 0);
  for (const url of ["https://api.z.ai/api/paas/v4", "https://api.z.ai.evil.example/api/coding/paas/v4", "https://evil.example/api.z.ai/api/coding/", "https://api.z.ai@evil.example/api/coding/x", "http://api.z.ai/api/coding/x"]) {
    const o = mkAt({ routeBaseURLs: () => ({ zai: url }) });
    await o.engine.getTable();
    assert.equal((await rec(o.engine, "zai", "glm-4.6")).billing, "metered", url);
  }
});

test("declared subscriptions are billed subscription (uncapped); undeclared providers are not", async () => {
  const { engine } = mkAt({ subscriptions: ["acme"] });
  await engine.getTable();
  assert.equal((await rec(engine, "acme", "m1")).billing, "subscription");
  assert.equal((await rec(engine, "other", "m1")).billing, "metered");
  const v = await engine.guard({ provider: "acme", model: "m1", sessionId: "s", messages: [] });
  assert.equal(v.action, "ok");
});

test("the Ollama table is refreshed in the background from the pricing page (once), and prices() reports its source", async () => {
  let fetches = 0;
  const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>m${i}</td><td>$${i + 1}</td><td>$0.1</td><td>$${i + 2}</td></tr>`).join("");
  const page = `<table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr></thead><tbody>${rows}</tbody></table>`;
  const fetchImpl = async () => { fetches++; return { ok: true, status: 200, url: "https://ollama.com/pricing", text: async () => page }; };
  const { engine } = mkAt({ fetchImpl });
  const p = await engine.prices(["ollama/m3", "ollama/glm-5.3"]);
  assert.equal(p.ollama.source, "network"); assert.equal(p.models["ollama/m3"].inPerM, 4); assert.equal(p.models["ollama/m3"].source, "ollama");
  assert.equal(p.models["ollama/glm-5.3"].priced, false); // the refreshed table replaces the snapshot wholesale
  await engine.prices(["ollama/m3"]);
  assert.equal(fetches, 1);
});

test("the guard sees a caps change without a restart", async () => {
  const { engine, dataDir } = mk();
  await engine.getTable();
  await step(engine, { id: "s1" }, ev("google", "gemini-3.8-flash", { inputTokens: 100000, outputTokens: 10000 }));
  const ask = () => engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [] });
  assert.notEqual((await ask()).action, "block");
  assert.equal(setCaps(dataDir, { dailyUsd: 0.001 }).ok, true);
  const v = await ask();
  assert.equal(v.action, "block"); assert.equal(v.which, "daily");
  assert.equal(setCaps(dataDir, { dailyUsd: 100 }).ok, true);
  assert.notEqual((await ask()).action, "block");
});

test("a corrupt caps.json: the guard still applies the finite defaults, and capsStatus names the problem", async () => {
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "caps.json"), "{nope");
  await engine.getTable();
  await step(engine, { id: "s1" }, ev("google", "gemini-3.8-flash", { inputTokens: 30_000_000, outputTokens: 0 }));
  const v = await engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [] });
  assert.equal(v.action, "block"); assert.equal(v.which, "session"); assert.match(v.reason, /\$15/);
  const st = engine.capsStatus();
  assert.ok(st.warnings.some((w) => /not valid JSON/.test(w)), st.warnings.join("|"));
  assert.equal(st.limits.sessionUsd, 15);
});

// ---- opt-in plan stop (lib/cost/plan-guard.mjs) -----------------------------------------------------------------
import { createPlanGuard, PLAN_LIMIT_CODE } from "../cost/plan-guard.mjs";

const PLAN_NOW = Date.parse("2026-11-12T12:00:00Z");
const hotPlan = { mode: "plan", fetchedAt: PLAN_NOW - 1000, fiveHour: { percent: 100, resetsAt: "2026-11-12T15:00:00Z" }, sevenDay: { percent: 10, resetsAt: "2026-11-17T15:00:00Z" } };
const planDir = (on = true) => { const d = mkdtempSync(join(tmpdir(), "hub-planguard-")); writeFileSync(join(d, "caps.json"), JSON.stringify({ stopAtPlanLimit: on })); return d; };
const CLAUDE_TABLE = { ...TABLE, entries: { ...TABLE.entries, "claude-opus-4-8": { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, mode: "chat" } } };

test("a Claude subscription request is blocked at 100% of a plan window; metered Claude and Google are not", async () => {
  const dataDir = planDir();
  const planGuard = createPlanGuard({ dataDir, getPlan: async () => hotPlan, now: () => PLAN_NOW });
  const sub = createCostEngine({ dataDir, loadTable: async () => CLAUDE_TABLE, oauthProviders: () => ["anthropic"], planGuard, now: () => PLAN_NOW });
  const v = await sub.guard({ provider: "anthropic", model: "claude-opus-4-8", sessionId: "p1", messages: [] });
  assert.equal(v.action, "block"); assert.equal(v.which, "plan-limit"); assert.equal(v.code, PLAN_LIMIT_CODE);
  assert.match(v.reason, /5-hour window is at 100%/);
  assert.equal(v.price.billing, "subscription");
  const metered = createCostEngine({ dataDir, loadTable: async () => CLAUDE_TABLE, oauthProviders: () => [], planGuard, now: () => PLAN_NOW });
  const mv = await metered.guard({ provider: "anthropic", model: "claude-opus-4-8", sessionId: "p2", messages: [] });
  assert.notEqual(mv.which, "plan-limit"); assert.equal(mv.action, "ok");
  const g = await sub.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "p3", messages: [] });
  assert.equal(g.action, "ok");
  const off = planDir(false);
  const quiet = createCostEngine({ dataDir: off, loadTable: async () => CLAUDE_TABLE, oauthProviders: () => ["anthropic"], planGuard: createPlanGuard({ dataDir: off, getPlan: async () => hotPlan, now: () => PLAN_NOW }), now: () => PLAN_NOW });
  assert.equal((await quiet.guard({ provider: "anthropic", model: "claude-opus-4-8", sessionId: "p4", messages: [] })).action, "ok");
});

test("a throwing planGuard fails open", async () => {
  const dataDir = planDir();
  const eng = createCostEngine({ dataDir, loadTable: async () => CLAUDE_TABLE, oauthProviders: () => ["anthropic"], planGuard: { check: async () => { throw new Error("x"); } } });
  assert.equal((await eng.guard({ provider: "anthropic", model: "claude-opus-4-8", sessionId: "p5", messages: [] })).action, "ok");
});

test("spendGuardMiddleware turns a plan-limit verdict into a PLAN_LIMIT finish chunk and never calls next(); a spend verdict still gives SPEND_CAP", async () => {
  let nexted = 0;
  const next = () => { nexted++; return (async function* () { yield { type: "finish", reason: { kind: "stop" } }; })(); };
  const engine = { guard: async (o) => (o.provider === "anthropic"
    ? { action: "block", which: "plan-limit", code: PLAN_LIMIT_CODE, reason: "your Claude 5-hour window is at 100% of the plan" }
    : { action: "block", which: "daily", reason: "daily cap $1 reached (spent $2.00 today)" }) };
  const mw = spendGuardMiddleware(engine);
  const plan = [];
  for await (const c of mw({ provider: "anthropic", model: "claude-opus-4-8" }, next)) plan.push(c);
  assert.equal(nexted, 0);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].reason.failure.code, PLAN_LIMIT_CODE);
  assert.match(plan[0].reason.failure.message, /plan guard: your Claude 5-hour window is at 100%/);
  const spend = [];
  for await (const c of mw({ provider: "google", model: "m" }, next)) spend.push(c);
  assert.equal(nexted, 0);
  assert.equal(spend[0].reason.failure.code, SPEND_CAP_CODE);
  assert.match(spend[0].reason.failure.message, /spend cap: daily cap/);
});

test("rocco-gateway :cloud calls are priced in DSH's ledger and the meter's copy of the same call is not counted again", async () => {
  const d = mkdtempSync(join(tmpdir(), "hub-eng-dedupe-"));
  const meter = join(d, "meter.jsonl");
  const { engine } = mk({ routeBaseURLs: () => ({ "rocco-gateway": "http://127.0.0.1:4000/v1" }), localProviders: ["rocco-gateway"], externalLedger: meter });
  await engine.getTable();
  const r = await step(engine, { id: "s1" }, ev("rocco-gateway", "glm-5.2:cloud", { inputTokens: 1000, outputTokens: 120 }));
  assert.equal(r.record.billing, "metered");
  assert.ok(r.record.usd > 0, "priced from the Ollama cloud table, not $0 local");
  const ts = Date.parse(r.record.ts);
  const row = (o) => JSON.stringify({ model: "glm-5.2:cloud", provider: "rocco-meter", ms: 900, ...o });
  writeFileSync(meter, [
    row({ ts: new Date(ts - 300).toISOString(), output_tokens: 120, usd: r.record.usd }), // the same call, seen by the meter
    row({ ts: new Date(ts - 90e3).toISOString(), output_tokens: 55, usd: 0.0123 }), // a call that never went through DSH
  ].join("\n") + "\n");
  const rep = await engine.spendReport({ since: "all" });
  assert.equal(rep.totals.calls, 1);
  assert.deepEqual(rep.external.totals, { usd: 0.0123, calls: 1 });
  assert.equal(rep.external.deduped.calls, 1);
});
