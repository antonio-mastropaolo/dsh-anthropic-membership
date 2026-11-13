import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedStream, createCostEngine, spendGuardMiddleware, SPEND_CAP_CODE, isCreditFailure } from "./engine.mjs";
import { appendSpend } from "../cost/ledger.mjs";
import { costOf } from "../cost/cost.mjs";
import { createReservations } from "../cost/reservation.mjs";

const TABLE = {
  entries: { "gemini/gemini-3.8-flash": { input_cost_per_token: 0.75e-6, output_cost_per_token: 3.75e-6, cache_read_input_token_cost: 0.075e-6, mode: "chat" } },
  overrides: {}, source: "network", fetchedAt: 1, count: 1, warnings: [],
};
const mk = (extra = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-eng-guard-"));
  const engine = createCostEngine({ dataDir, loadTable: async () => TABLE, localProviders: ["box"], oauthProviders: () => ["anthropic", "openai-codex"], ...extra });
  return { dataDir, engine };
};
const SECRET = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
// an options object whose every property read throws: the guard hits an internal error before it prices anything
const boom = () => new Proxy({}, { get() { throw new Error(`boom key=${SECRET}`); } });
const drain = async (it) => { const out = []; for await (const c of it) out.push(c); return out; };

test("default policy keeps today's open behaviour, counts the error, redacts it and stamps it from the injected clock", async () => {
  let t = 1_700_000_000_000;
  const { engine } = mk({ now: () => t });
  assert.deepEqual(JSON.parse(JSON.stringify(engine.guardStatus())), { onError: "allow", errors: { count: 0, last: null }, reserved: { usd: 0, count: 0, byProvider: {}, stats: { reserved: 0, released: 0, expired: 0, active: 0 } } });
  const v = await engine.guard(boom());
  assert.notEqual(v.action, "block");
  const g = engine.guardStatus();
  assert.equal(g.onError, "allow");
  assert.equal(g.errors.count, 1);
  assert.match(g.errors.last.message, /boom/);
  assert.doesNotMatch(JSON.stringify(g), /AIza/);
  assert.equal(g.errors.last.at, 1_700_000_000_000);
});

test("guardPolicy block: the verdict is a block named guard-error that points at guard.onError, and the error is counted", async () => {
  const { engine } = mk({ guardPolicy: () => "block" });
  const v = await engine.guard(boom());
  assert.equal(v.action, "block");
  assert.equal(v.which, "guard-error");
  assert.match(v.reason, /guard\.onError/);
  assert.match(v.reason, /boom/);
  assert.doesNotMatch(v.reason, /AIza/);
  assert.equal(engine.guardStatus().errors.count, 1);
  assert.equal(engine.guardStatus().onError, "block");
});

test("guardPolicy block through spendGuardMiddleware: next() is never called, the message names guard.onError (not caps.json), the code stays SPEND_CAP", async () => {
  const { engine } = mk({ guardPolicy: () => "block" });
  let nexted = 0;
  const next = () => { nexted++; return (async function* () { yield { type: "finish", reason: { kind: "stop" } }; })(); };
  const seen = [];
  const mw = spendGuardMiddleware(engine, { onBlock: (v) => seen.push(v.which) });
  // the middleware passes the options it was given straight to engine.guard; a throwing options object is the synthetic failure
  const chunks = await drain(mw(boom(), next));
  assert.equal(nexted, 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, "finish");
  assert.equal(chunks[0].reason.kind, "error");
  const f = chunks[0].reason.failure;
  assert.equal(f.code, SPEND_CAP_CODE);
  assert.match(f.message, /guard\.onError/);
  assert.match(f.message, /dsh-hub doctor/);
  assert.doesNotMatch(f.message, /caps\.json/);
  assert.doesNotMatch(f.message, /AIza/);
  assert.equal(isCreditFailure(f), false);
  assert.deepEqual(seen, ["guard-error"]);
});

test("blockedStream: one argument keeps the caps.json remedy; which=guard-error switches to the guard.onError remedy", async () => {
  const [a] = await drain(blockedStream("daily cap $1 reached"));
  assert.match(a.reason.failure.message, /caps\.json/);
  assert.doesNotMatch(a.reason.failure.message, /guard\.onError/);
  const [b] = await drain(blockedStream("the spend guard hit an internal error (x)", "guard-error"));
  assert.match(b.reason.failure.message, /Request blocked by model-hub spend guard: the spend guard hit an internal error \(x\)\./);
  assert.match(b.reason.failure.message, /Set guard\.onError to "allow" in config\.json/);
  assert.equal(b.reason.failure.code, SPEND_CAP_CODE);
  const [c] = await drain(blockedStream("daily cap", "daily"));
  assert.match(c.reason.failure.message, /caps\.json/);
});

test("config.json guard.onError is honoured live: written -> blocks, deleted -> opens", async () => {
  const { engine, dataDir } = mk();
  assert.notEqual((await engine.guard(boom())).action, "block");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ guard: { onError: "block" } }));
  const blocked = await engine.guard(boom());
  assert.equal(blocked.action, "block");
  assert.equal(blocked.which, "guard-error");
  assert.equal(engine.guardStatus().onError, "block");
  rmSync(join(dataDir, "config.json"));
  assert.notEqual((await engine.guard(boom())).action, "block");
  assert.equal(engine.guardStatus().onError, "allow");
  assert.equal(engine.guardStatus().errors.count, 3);
});

test("a bad guard.onError in config.json is treated as allow", async () => {
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ guard: { onError: "BLOCK" } }));
  assert.notEqual((await engine.guard(boom())).action, "block");
  assert.equal(engine.guardStatus().onError, "allow");
});

test("a guardPolicy that throws, or returns something else, is treated as allow", async () => {
  for (const guardPolicy of [() => { throw new Error("policy boom"); }, () => "BLOCK", () => undefined, () => 1]) {
    const { engine } = mk({ guardPolicy });
    const v = await engine.guard(boom());
    assert.notEqual(v.action, "block");
    assert.equal(engine.guardStatus().onError, "allow");
    assert.equal(engine.guardStatus().errors.count, 1);
  }
});

test("a healthy request is unaffected under block: the policy is consulted only on an exception", async () => {
  const { engine } = mk({ guardPolicy: () => "block" });
  await engine.getTable();
  for (const [provider, model] of [["box", "model-a"], ["anthropic", "claude-opus-4-8"], ["google", "gemini-3.8-flash"]]) {
    const v = await engine.guard({ provider, model, sessionId: "s", messages: [] });
    assert.equal(v.action, "ok", provider);
  }
  assert.equal(engine.guardStatus().errors.count, 0);
  assert.equal(engine.guardStatus().errors.last, null);
});

test("the counter increments per exception, keeps the newest error, and survives a healthy guard", async () => {
  let t = 100;
  const { engine } = mk({ now: () => t });
  await engine.getTable();
  await engine.guard(boom());
  t = 200;
  await engine.guard(new Proxy({}, { get() { throw new Error("second failure"); } }));
  assert.equal(engine.guardStatus().errors.count, 2);
  assert.match(engine.guardStatus().errors.last.message, /second failure/);
  assert.equal(engine.guardStatus().errors.last.at, 200);
  assert.equal((await engine.guard({ provider: "box", model: "m", sessionId: "s" })).action, "ok");
  assert.equal(engine.guardStatus().errors.count, 2, "a successful guard does not reset the count");
});

test("capsStatus (and so spendReport and /spend) carries the guard status", async () => {
  const { engine } = mk();
  await engine.guard(boom());
  assert.equal(engine.capsStatus().guard.errors.count, 1);
  assert.equal((await engine.spendReport({ since: "today" })).caps.guard.errors.count, 1);
});

test("the last error message is bounded and carries no URL or token", async () => {
  const { engine } = mk();
  await engine.guard(new Proxy({}, { get() { throw new Error("fetch https://user:pw@evil.example/x?token=" + SECRET + " failed " + "y".repeat(2000)); } }));
  const m = engine.guardStatus().errors.last.message;
  assert.ok(m.length <= 400, String(m.length));
  assert.doesNotMatch(m, /AIza|evil\.example|user:pw/);
});

test("50 metered guards over 2000 ledger rows parse the rows once; spend another process appends is seen by the next guard, and parses only its own bytes", async () => {
  const { appendSpend, _ledgerParsedBytes, _resetLedgerCache } = await import("../cost/ledger.mjs");
  _resetLedgerCache();
  const { engine, dataDir } = mk();
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 40, sessionUsd: 0, warnPct: 0 }));
  const mkRow = (usd, i) => ({ ts: new Date().toISOString(), sessionId: `s${i % 7}`, provider: "google", model: "gemini-3.8-flash", input: 10, output: 10, usd, apiEquivUsd: usd, billing: "metered", priceSource: "litellm" });
  for (let i = 0; i < 2000; i++) appendSpend(dataDir, mkRow(0.001, i));
  await engine.getTable();
  const g = () => engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [] });
  const first = await g();
  assert.equal(first.action, "ok");
  const afterFirst = _ledgerParsedBytes();
  assert.ok(afterFirst > 0, "the first guard read the ledger");
  // a full summary visits every row (one Date.parse each); the running totals must not: count the calls over 49 guards
  const realParse = Date.parse;
  let parses = 0;
  Date.parse = (...a) => { parses++; return realParse(...a); };
  try { for (let i = 0; i < 49; i++) assert.equal((await g()).action, "ok"); } finally { Date.parse = realParse; }
  assert.ok(parses < 49 * 20, `49 guards visited ${parses} timestamps; a per-request summary over 2000 rows would visit about 200000`);
  assert.equal(_ledgerParsedBytes(), afterFirst, "49 more guards parsed nothing");
  const stored = appendSpend(dataDir, mkRow(50, 1)); // another DSH process spends past the daily cap
  const v = await g();
  assert.equal(v.action, "block");
  assert.equal(v.which, "daily");
  assert.equal(_ledgerParsedBytes() - afterFirst, Buffer.byteLength(JSON.stringify(stored)) + 2, "only the new row was parsed");
});

test("the guard's verdicts follow the local day and the session's whole history (provider cap, midnight, session cap)", async () => {
  const { appendSpend, _resetLedgerCache } = await import("../cost/ledger.mjs");
  _resetLedgerCache();
  let t = new Date(2026, 10, 8, 23, 0).getTime();
  const { engine, dataDir } = mk({ now: () => t });
  writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: { google: 6 }, warnPct: 50 }));
  await engine.getTable();
  const row = (o) => ({ provider: "google", model: "gemini-3.8-flash", billing: "metered", priceSource: "litellm", ...o });
  appendSpend(dataDir, row({ ts: new Date(2026, 10, 8, 22, 30).toISOString(), sessionId: "night", usd: 10 }));
  const g = () => engine.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "night", messages: [] });
  const before = await g();
  assert.equal(before.action, "block");
  assert.equal(before.which, "provider-daily", "10 spent today against google's $6");
  t = new Date(2026, 10, 9, 1, 0).getTime(); // past local midnight: today's spend is 0, the session still has its $10
  const after = await g();
  assert.equal(after.action, "warn");
  assert.equal(after.which, "session", "10 of 15, the session's history crosses midnight");
  appendSpend(dataDir, row({ ts: new Date(2026, 10, 9, 0, 30).toISOString(), sessionId: "night", usd: 5.5 }));
  const over = await g();
  assert.equal(over.action, "block");
  assert.equal(over.which, "session");
});

// ---- in-flight reservations (Task 5) ----
const G = { provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [{ role: "user", content: "hi" }] };
const USAGE = { type: "usage", usage: { inputTokens: 10, outputTokens: 10 } };
const STOP = { type: "finish", reason: { kind: "stop" } };
const TEXT = { type: "text-delta", index: 0, text: "hi" };
const until = async (f, ms = 2000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timeout: " + f); await new Promise((r) => setTimeout(r, 5)); } };
const rowCount = (dataDir) => { const f = join(dataDir, "spend.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0; };
const setCaps = (dataDir, caps) => writeFileSync(join(dataDir, "caps.json"), JSON.stringify({ sessionUsd: 0, warnPct: 0, ...caps }));
/** a stream that yields one text delta at once, then waits for the latch, then usage + finish */
function gated() {
  const g = { started: 0 };
  const latch = new Promise((r) => { g.open = r; });
  g.next = () => { g.started++; return (async function* () { yield TEXT; await latch; yield USAGE; yield STOP; })(); };
  return g;
}
const firstOf = (mw, opts, next) => { const it = mw(opts, next)[Symbol.asyncIterator](); return it.next().then((r) => ({ it, r })); };
const rest = async (it) => { const out = []; for (;;) { const r = await it.next(); if (r.done) return out; out.push(r.value); } };
const isBlocked = (c) => c?.type === "finish" && c.reason?.kind === "error" && c.reason.failure?.code === SPEND_CAP_CODE;

test("PROOF: five parallel metered streams against a cap one call fits under: exactly two start, the rest are blocked 'in flight'", async () => {
  const { engine, dataDir } = mk();
  setCaps(dataDir, { dailyUsd: 1 });
  await engine.getTable();
  const g = gated();
  const mw = spendGuardMiddleware(engine);
  const opts = { ...G, maxTokens: 100000 }; // worst case about $0.375 each
  const firsts = await Promise.all([1, 2, 3, 4, 5].map(() => firstOf(mw, opts, g.next)));
  assert.equal(g.started, 2, "only two fit under the $1 cap together");
  const blocked = firsts.filter((f) => isBlocked(f.r.value));
  assert.equal(blocked.length, 3);
  for (const b of blocked) { assert.equal(b.r.value.reason.failure.code, SPEND_CAP_CODE); assert.match(b.r.value.reason.failure.message, /in flight/); }
  assert.equal(engine.guardStatus().reserved.count, 2);
  assert.ok(engine.guardStatus().reserved.usd > 0.7 && engine.guardStatus().reserved.usd < 0.8, String(engine.guardStatus().reserved.usd));
  g.open();
  for (const f of firsts) await rest(f.it);
  await until(() => engine.guardStatus().reserved.count === 0);
  assert.equal(engine.guardStatus().reserved.usd, 0);
  assert.notEqual((await engine.guard(opts)).action, "block", "nothing in flight and the recorded spend is tiny");
});

test("a lone request near a cap behaves as before; the same request is blocked while another is in flight", async () => {
  const { engine, dataDir } = mk();
  setCaps(dataDir, { dailyUsd: 1 });
  appendSpend(dataDir, { sessionId: "other", provider: "google", model: "gemini-3.8-flash", usd: 0.9, apiEquivUsd: 0.9, billing: "metered", priceSource: "litellm" });
  await engine.getTable();
  const big = { ...G, maxTokens: 100000 }; // worst case $0.375: over the $0.10 headroom
  const a = await engine.guard(big);
  assert.notEqual(a.action, "block", "recorded $0.90 is under the $1 cap: unchanged behaviour");
  assert.ok(a.reservation, "and it now holds a reservation");
  const b = await engine.guard(big);
  assert.equal(b.action, "block");
  assert.equal(b.which, "in-flight");
  assert.match(b.reason, /already in flight/);
  assert.equal(b.reservation, undefined);
  assert.equal(engine.guardStatus().reserved.count, 1, "the blocked request reserved nothing");
  engine.releaseReservation(a.reservation);
  assert.notEqual((await engine.guard(big)).action, "block", "alone again");
});

test("the in-flight check also covers the provider and session caps", async () => {
  const { engine, dataDir } = mk();
  setCaps(dataDir, { dailyUsd: 100, sessionUsd: 1, perProviderDailyUsd: { google: 100 } });
  await engine.getTable();
  const big = { ...G, maxTokens: 100000 };
  assert.ok((await engine.guard(big)).reservation);
  assert.ok((await engine.guard(big)).reservation);
  const third = await engine.guard(big);
  assert.equal(third.action, "block");
  assert.equal(third.which, "in-flight");
  const otherSession = await engine.guard({ ...big, sessionId: "s2" });
  assert.notEqual(otherSession.action, "block", "the session cap counts only this session's reservations");
  setCaps(dataDir, { dailyUsd: 100, sessionUsd: 0, perProviderDailyUsd: { google: 1 } });
  const prov = await engine.guard({ ...big, sessionId: "s3" });
  assert.equal(prov.action, "block");
  assert.equal(prov.which, "in-flight", "three google reservations against google's $1 daily cap");
});

test("the reservation uses the previous prompt size of the same session and route once a call has been billed", async () => {
  const { engine, dataDir } = mk();
  setCaps(dataDir, { dailyUsd: 1000 });
  await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  const stream = (...cs) => () => (async function* () { for (const c of cs) yield c; })();
  const O = { ...G, maxTokens: 1000 };
  for await (const _ of mw(O, stream({ type: "usage", usage: { inputTokens: 200000, outputTokens: 5 } }, STOP))) { /* drain */ }
  await until(() => rowCount(dataDir) === 1);
  const v = await engine.guard(O);
  const expected = Math.max(costOf({ input: 200000, output: 1000 }, v.price).usd, costOf({ cacheWrite: 200000, output: 1000 }, v.price).usd);
  assert.ok(v.reservation);
  assert.ok(Math.abs(engine.capsStatus().reserved.usd - expected) < 1e-5, `${engine.capsStatus().reserved.usd} vs ${expected}`);
  const other = await engine.guard({ ...O, sessionId: "fresh" });
  assert.ok(engine.capsStatus().reserved.usd - expected < expected / 10, "another session still uses its own (tiny) request size");
  assert.ok(other.reservation);
});

const stats = (engine) => engine.guardStatus().reserved.stats;
const balanced = (engine) => { const s = stats(engine); assert.equal(s.reserved, s.released + s.expired + s.active); return s; };

test("exit path: usage + finish releases after the row is written", async () => {
  const { engine, dataDir } = mk();
  await engine.getTable();
  const seen = [];
  const rel = engine.releaseReservation;
  const wrapped = { ...engine, releaseReservation: (t) => { seen.push(rowCount(dataDir)); return rel(t); } };
  const chunks = await rest(spendGuardMiddleware(wrapped)(G, () => (async function* () { yield TEXT; yield USAGE; yield STOP; })())[Symbol.asyncIterator]());
  assert.equal(chunks.length, 3);
  await until(() => engine.guardStatus().reserved.count === 0);
  assert.deepEqual(seen, [1], "the ledger row existed at the moment of release");
  assert.deepEqual(balanced(engine), { reserved: 1, released: 1, expired: 0, active: 0 });
});

const exitCase = (name, makeNext, consume) => test(`exit path: ${name} releases the reservation`, async () => {
  const { engine } = mk();
  await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  await consume(mw, makeNext);
  await until(() => engine.guardStatus().reserved.count === 0);
  const s = balanced(engine);
  assert.equal(s.reserved, 1);
  assert.equal(s.released, 1);
});
exitCase("finish error without usage", () => () => (async function* () { yield TEXT; yield { type: "finish", reason: { kind: "error", failure: { message: "upstream 500", status: 500 } } }; })(), async (mw, n) => { await rest(mw(G, n())[Symbol.asyncIterator]()); });
exitCase("next() throwing mid-stream", () => () => (async function* () { yield TEXT; throw new Error("socket hang up"); })(), async (mw, n) => { await assert.rejects(rest(mw(G, n())[Symbol.asyncIterator]()), /socket hang up/); });
exitCase("the consumer breaking out (iterator return())", () => () => (async function* () { yield TEXT; yield USAGE; yield STOP; })(), async (mw, n) => { for await (const _ of mw(G, n())) break; });
exitCase("an aborted finish", () => () => (async function* () { yield TEXT; yield { type: "finish", reason: { kind: "aborted" } }; })(), async (mw, n) => { await rest(mw(G, n())[Symbol.asyncIterator]()); });
exitCase("a stream that ends with no finish chunk", () => () => (async function* () { yield TEXT; yield USAGE; })(), async (mw, n) => { await rest(mw(G, n())[Symbol.asyncIterator]()); });
exitCase("return() after the finish chunk (row already requested)", () => () => (async function* () { yield USAGE; yield STOP; yield TEXT; })(), async (mw, n) => {
  const it = mw(G, n())[Symbol.asyncIterator]();
  await it.next(); await it.next();
  await it.return();
});

test("exit path: an iterator that is created but never started reserves nothing", async () => {
  const { engine } = mk();
  await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  const it = mw(G, () => { throw new Error("must not be called"); })[Symbol.asyncIterator]();
  await it.return();
  assert.deepEqual(stats(engine), { reserved: 0, released: 0, expired: 0, active: 0 });
});

test("exit path: a blocked verdict never reserves", async () => {
  const { engine, dataDir } = mk();
  setCaps(dataDir, { dailyUsd: 1 });
  appendSpend(dataDir, { sessionId: "x", provider: "google", model: "gemini-3.8-flash", usd: 5, apiEquivUsd: 5, billing: "metered", priceSource: "litellm" });
  await engine.getTable();
  const chunks = await rest(spendGuardMiddleware(engine)(G, () => { throw new Error("must not be called"); })[Symbol.asyncIterator]());
  assert.ok(isBlocked(chunks[0]));
  assert.deepEqual(stats(engine), { reserved: 0, released: 0, expired: 0, active: 0 });
});

test("exit path: releaseReservation twice releases once; null and unknown tokens are no-ops", async () => {
  const { engine } = mk();
  await engine.getTable();
  const v = await engine.guard(G);
  assert.ok(v.reservation);
  engine.releaseReservation(v.reservation);
  engine.releaseReservation(v.reservation);
  engine.releaseReservation(null);
  engine.releaseReservation(12345);
  assert.deepEqual(balanced(engine), { reserved: 1, released: 1, expired: 0, active: 0 });
  assert.equal(engine.guardStatus().errors.count, 0);
});

test("exit path: an iterator abandoned without return() is swept after the idle TTL and stops holding requests back", async () => {
  let t = 1_800_000_000_000;
  const { engine, dataDir } = mk({ now: () => t });
  setCaps(dataDir, { dailyUsd: 1 });
  await engine.getTable();
  const g = gated();
  const mw = spendGuardMiddleware(engine);
  const big = { ...G, maxTokens: 200000 }; // worst case $0.75
  const { it } = await firstOf(mw, big, g.next); // first chunk taken, then the consumer walks away: no return()
  assert.ok(it);
  assert.equal((await engine.guard(big)).which, "in-flight");
  t += 10 * 60_000;
  assert.equal((await engine.guard(big)).which, "in-flight", "exactly at the limit it is still held");
  t += 1;
  const after = await engine.guard(big);
  assert.notEqual(after.action, "block");
  assert.equal(stats(engine).expired, 1);
  engine.releaseReservation(after.reservation);
  balanced(engine);
});

test("a streaming consumer keeps its reservation alive: every chunk touches it", async () => {
  let t = 1_800_000_000_000;
  const { engine, dataDir } = mk({ now: () => t });
  setCaps(dataDir, { dailyUsd: 1 });
  await engine.getTable();
  const big = { ...G, maxTokens: 200000 };
  const it = spendGuardMiddleware(engine)(big, () => (async function* () { for (let i = 0; i < 5; i++) yield TEXT; yield USAGE; yield STOP; })())[Symbol.asyncIterator]();
  await it.next();
  for (let i = 0; i < 5; i++) { t += 9 * 60_000; const r = await it.next(); assert.equal(r.done, false); }
  assert.equal(engine.guardStatus().reserved.count, 1, "50 minutes in, still held: each chunk touched it");
  await rest(it);
  await until(() => engine.guardStatus().reserved.count === 0);
  assert.equal(stats(engine).expired, 0);
});

test("the reservation is held until the row is written: a slow capture keeps holding parallel requests back", async () => {
  const { engine, dataDir } = mk();
  setCaps(dataDir, { dailyUsd: 1 });
  await engine.getTable();
  let finishRecord;
  const slow = new Promise((r) => { finishRecord = r; });
  const wrapped = { ...engine, recordUsage: (o, u, m) => { const p = engine.recordUsage(o, u, m); return p.then(async (x) => { await slow; return x; }); } };
  const big = { ...G, maxTokens: 200000 };
  const it = spendGuardMiddleware(wrapped)(big, () => (async function* () { yield TEXT; yield USAGE; yield STOP; })())[Symbol.asyncIterator]();
  await rest(it); // the stream is over and its consumer has returned
  assert.equal(engine.guardStatus().reserved.count, 1, "the row is not confirmed yet: still reserved");
  assert.equal((await engine.guard(big)).which, "in-flight");
  finishRecord();
  await until(() => engine.guardStatus().reserved.count === 0);
  assert.equal(rowCount(dataDir), 1);
  assert.notEqual((await engine.guard(big)).action, "block");
});

test("return() is not delayed by a slow capture", async () => {
  const { engine } = mk();
  await engine.getTable();
  const wrapped = { ...engine, recordUsage: () => new Promise(() => {}) }; // never settles
  const it = spendGuardMiddleware(wrapped)(G, () => (async function* () { yield USAGE; yield STOP; yield TEXT; })())[Symbol.asyncIterator]();
  await it.next(); await it.next();
  const r = await Promise.race([it.return().then(() => "returned"), new Promise((x) => setTimeout(() => x("hung"), 500))]);
  assert.equal(r, "returned");
});

test("non-metered (local, subscription) and unpriced metered requests never reserve", async () => {
  const { engine } = mk();
  await engine.getTable();
  for (const [provider, model] of [["box", "model-a"], ["anthropic", "claude-opus-4-8"], ["google", "model-nobody-prices"]]) {
    const v = await engine.guard({ provider, model, sessionId: "s", messages: [], maxTokens: 100000 });
    assert.equal(v.reservation ?? null, null, provider);
  }
  assert.deepEqual(stats(engine), { reserved: 0, released: 0, expired: 0, active: 0 });
});

test("bookkeeping failure: default policy lets the request through, block policy blocks, both are counted and nothing is reserved", async () => {
  const hostile = { provider: "google", model: "gemini-3.8-flash", get messages() { throw new Error("hostile-messages"); } };
  const a = mk();
  await a.engine.getTable();
  const va = await a.engine.guard(hostile);
  assert.equal(va.action, "ok");
  assert.equal(a.engine.guardStatus().errors.count, 1);
  assert.match(a.engine.guardStatus().errors.last.message, /hostile-messages/);
  const b = mk({ guardPolicy: () => "block" });
  await b.engine.getTable();
  const vb = await b.engine.guard(hostile);
  assert.equal(vb.action, "block");
  assert.equal(vb.which, "guard-error");
  assert.equal(b.engine.guardStatus().errors.count, 1);
  for (const e of [a.engine, b.engine]) assert.deepEqual(stats(e), { reserved: 0, released: 0, expired: 0, active: 0 });
});

test("a store whose touch/release throw never breaks the stream; the errors are counted, and a failed release is swept later", async () => {
  let t = 1_800_000_000_000;
  const inner = createReservations({ now: () => t });
  const store = { ...inner, reserve: (x) => inner.reserve(x), touch: () => { throw new Error("touch boom"); }, release: () => { throw new Error("release boom"); } };
  const { engine } = mk({ now: () => t, reservations: store });
  await engine.getTable();
  const chunks = await rest(spendGuardMiddleware(engine)(G, () => (async function* () { yield TEXT; yield TEXT; yield USAGE; yield STOP; })())[Symbol.asyncIterator]());
  assert.equal(chunks.length, 4, "every chunk arrived");
  await until(() => engine.guardStatus().errors.count >= 5);
  assert.match(engine.guardStatus().errors.last.message, /boom/);
  assert.equal(inner.totals().count, 1, "the failed release leaked it, bounded by the idle sweep");
  t += 10 * 60_000 + 1;
  assert.equal(inner.totals().count, 0);
});

test("capsStatus().reserved and spendReport().caps.reserved carry the in-flight dollars", async () => {
  const { engine } = mk();
  await engine.getTable();
  assert.deepEqual(engine.capsStatus().reserved, { usd: 0, count: 0 });
  const v = await engine.guard({ ...G, maxTokens: 100000 });
  const c = engine.capsStatus().reserved;
  assert.equal(c.count, 1);
  assert.ok(c.usd > 0.37 && c.usd < 0.39, String(c.usd));
  assert.deepEqual(Object.keys(c).sort(), ["count", "usd"]);
  assert.deepEqual((await engine.spendReport({ since: "today" })).caps.reserved, c);
  assert.equal(engine.guardStatus().reserved.byProvider.google, c.usd);
  engine.releaseReservation(v.reservation);
  assert.deepEqual(engine.capsStatus().reserved, { usd: 0, count: 0 });
});

// ---- a consumer that reads the usage chunk and walks away without return() ----
const abandoned = async (engine, opts, chunks, ms) => {
  const it = spendGuardMiddleware(engine, { usageFlushMs: ms })(opts, () => (async function* () { yield* chunks; })())[Symbol.asyncIterator]();
  for (;;) { const r = await it.next(); if (r.done || r.value.type === "usage") break; }
  return it; // never advanced again, never returned
};

test("a consumer that drops the iterator after the usage chunk (no return()) still gets its row written and its reservation released", async () => {
  const { engine, dataDir } = mk();
  await engine.getTable();
  await abandoned(engine, G, [TEXT, USAGE, TEXT, STOP], 20);
  assert.equal(engine.guardStatus().reserved.count, 1, "still held right after the usage chunk");
  await until(() => rowCount(dataDir) === 1 && engine.guardStatus().reserved.count === 0);
  const [r] = readFileSync(join(dataDir, "spend.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual([r.input, r.output, r.finish, r.durationMs], [10, 10, null, null], "written with what was observed: no finish, no duration");
  assert.deepEqual(balanced(engine), { reserved: 1, released: 1, expired: 0, active: 0 });
});

test("the deferred write is cancelled by the finish chunk: one row, with its finish", async () => {
  const { engine, dataDir } = mk();
  await engine.getTable();
  await rest(spendGuardMiddleware(engine, { usageFlushMs: 30 })(G, () => (async function* () { yield USAGE; yield STOP; })())[Symbol.asyncIterator]());
  await until(() => engine.guardStatus().reserved.count === 0);
  await new Promise((r) => setTimeout(r, 80)); // well past the timer
  const lines = readFileSync(join(dataDir, "spend.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].finish, "stop");
});

test("a finish that arrives after the timer already wrote the row adds no second row", async () => {
  const { engine, dataDir } = mk();
  await engine.getTable();
  const it = await abandoned(engine, G, [USAGE, STOP], 10);
  await until(() => rowCount(dataDir) === 1 && engine.guardStatus().reserved.count === 0);
  await rest(it);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(rowCount(dataDir), 1);
  assert.deepEqual(balanced(engine), { reserved: 1, released: 1, expired: 0, active: 0 });
});
