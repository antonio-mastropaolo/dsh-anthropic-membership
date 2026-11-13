import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCostEngine, spendGuardMiddleware } from "./engine.mjs";
import { KNOWN_FIELDS } from "../cost/ledger.mjs";

const TABLE = {
  entries: { "gemini/gemini-3.8-flash": { input_cost_per_token: 0.75e-6, output_cost_per_token: 3.75e-6, cache_read_input_token_cost: 0.075e-6, mode: "chat" } },
  overrides: {}, source: "network", fetchedAt: 1, count: 1, warnings: [],
};
const mk = (extra = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-engl-"));
  const engine = createCostEngine({ dataDir, loadTable: async () => TABLE, localProviders: ["box"], oauthProviders: () => ["anthropic", "openai-codex"], ...extra });
  return { dataDir, engine };
};
const rows = (dir) => readFileSync(join(dir, "spend.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const drain = async (it) => { const out = []; for await (const c of it) out.push(c); return out; };
const stream = (...chunks) => () => (async function* () { yield* chunks; })();
const O = { provider: "google", model: "gemini-3.8-flash", sessionId: "s1", messages: [] };
const USAGE = { type: "usage", usage: { inputTokens: 10, outputTokens: 1 } };
const STOP = { type: "finish", reason: { kind: "stop" } };

test("the row carries purpose, finish, ttft and duration from the stream; exactly three clock reads on a normal stream", async () => {
  const { engine, dataDir } = mk(); await engine.getTable();
  const ticks = [1000, 1040, 1100]; let reads = 0;
  const mw = spendGuardMiddleware(engine, { clock: () => { reads++; return ticks.shift(); } });
  await drain(mw({ ...O, purpose: "compaction" }, stream({ type: "block-start", index: 0, blockType: "text" }, { type: "text-delta", index: 0, text: "hi" }, { type: "usage", usage: { inputTokens: 1000, outputTokens: 50, reasoningTokens: 10 } }, STOP)));
  await engine.guard(O); // settles pending captures
  const [r] = rows(dataDir);
  assert.equal(reads, 3);
  assert.deepEqual([r.v, r.purpose, r.finish, r.ttftMs, r.durationMs, r.reasoning, r.tier], [2, "compaction", "stop", 40, 100, 10, "base"]);
});

test("the first token is a non-empty text/reasoning fragment or a name-bearing tool call; empty deltas do not count", async () => {
  const { engine, dataDir } = mk(); await engine.getTable();
  const ticks = [0, 70, 90]; let reads = 0;
  const mw = spendGuardMiddleware(engine, { clock: () => { reads++; return ticks.shift(); } });
  await drain(mw(O, stream({ type: "text-delta", index: 0, text: "" }, { type: "tool-call-delta", index: 1, argumentsDelta: "" }, { type: "tool-call-delta", index: 1, name: "read_file" }, { type: "text-delta", index: 0, text: "late" }, USAGE, STOP)));
  await engine.guard(O);
  const [r] = rows(dataDir);
  assert.equal(reads, 3); assert.deepEqual([r.ttftMs, r.durationMs], [70, 90]);
});

test("an error finish with usage is recorded with finish error; an unknown finish shape is null", async () => {
  const { engine, dataDir } = mk(); await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  await drain(mw(O, stream(USAGE, { type: "finish", reason: { kind: "error", failure: { message: "boom" } } })));
  await drain(mw(O, stream(USAGE, { type: "finish", reason: { kind: "Weird Kind!" } })));
  await engine.guard(O);
  assert.deepEqual(rows(dataDir).map((r) => r.finish), ["error", null]);
});

test("unset purpose is chat; a consumer that stops after the usage chunk still gets the row, with finish null", async () => {
  const { engine, dataDir } = mk(); await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  for await (const c of mw(O, stream(USAGE, STOP))) { if (c.type === "usage") break; }
  await engine.guard(O);
  const [r] = rows(dataDir);
  assert.equal(r.purpose, "chat"); assert.equal(r.finish, null); assert.equal(r.durationMs, null);
});

test("an odd purpose is sanitised: a declared one is kept, anything else is 'other'", async () => {
  const { engine, dataDir } = mk(); await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  for (const purpose of ["session-title", "auto-review", "Has Spaces!", "x".repeat(80)]) await drain(mw({ ...O, purpose }, stream(USAGE, STOP)));
  await engine.guard(O);
  assert.deepEqual(rows(dataDir).map((r) => r.purpose), ["session-title", "auto-review", "other", "other"]);
});

test("turn, step and the subagent parent come from session events; null outside a chat step; an ordinary fork has no parent", async () => {
  const { engine, dataDir } = mk(); await engine.getTable();
  const child = { id: "c1", header: { origin: "subagent", parentSession: "p1" } };
  const ordinaryFork = { id: "f1", header: { parentSession: "p1" } };
  const mw = spendGuardMiddleware(engine);
  const call = (opts) => drain(mw(opts, stream(USAGE, STOP)));
  await engine.onSessionEvent(child, { type: "turn/start", data: { turn: 2 } });
  await engine.onSessionEvent(child, { type: "step/start", data: { turn: 2, step: 5 } });
  await call({ ...O, sessionId: "c1" });                         // chat inside a step
  await call({ ...O, sessionId: "c1", purpose: "compaction" });  // not chat: no turn/step
  await engine.onSessionEvent(child, { type: "step/end", data: { turn: 2, step: 5 } });
  await call({ ...O, sessionId: "c1" });                         // chat between steps
  await engine.onSessionEvent(ordinaryFork, { type: "step/start", data: { turn: 1, step: 1 } });
  await call({ ...O, sessionId: "f1" });
  await call({ ...O, sessionId: "never-seen" });
  await engine.guard(O);
  const r = rows(dataDir);
  assert.deepEqual(r.map((x) => [x.turn, x.step, x.parentSessionId]), [[2, 5, "p1"], [null, null, "p1"], [null, null, "p1"], [1, 1, null], [null, null, null]]);
});

test("a throwing session event never breaks the cost path; the next step still records", async () => {
  const { engine, dataDir } = mk(); await engine.getTable();
  await engine.onSessionEvent(null, null);
  await engine.onSessionEvent({ id: "s1", get header() { throw new Error("boom"); } }, { type: "step/start", data: { turn: 1, step: 1 } });
  await drain(spendGuardMiddleware(engine)(O, stream(USAGE, STOP)));
  await engine.guard(O);
  assert.equal(rows(dataDir).length, 1);
});

test("plan-credit rows keep usd re-derivable: planCoveredUsd + usd == apiEquivUsd", async () => {
  const plans = { ollama: { name: "Pro", includedUsd: 2, resetsOnDay: 9 } };
  const { engine, dataDir } = mk({ now: () => Date.UTC(2026, 10, 18, 19, 0, 0), plans, routeBaseURLs: () => ({ ollama: "https://ollama.com/v1" }), oauthProviders: () => [] });
  await engine.getTable();
  const rec = async () => (await engine.recordUsage({ provider: "ollama", model: "glm-5.3", sessionId: "s" }, { inputTokens: 500_000, outputTokens: 100_000 })).record;
  const a = await rec(); const b = await rec(); const c = await rec();
  assert.equal(a.billing, "credits"); assert.equal(a.usd, 0); assert.equal(a.planCoveredUsd, a.apiEquivUsd);
  assert.equal(b.billing, "metered"); assert.ok(b.planCoveredUsd > 0 && b.usd > 0);
  assert.ok(Math.abs(b.planCoveredUsd + b.usd - b.apiEquivUsd) < 1e-6);
  assert.equal(c.planCoveredUsd, 0); assert.equal(c.usd, c.apiEquivUsd);
  const stored = rows(dataDir);
  assert.deepEqual(stored.map((r) => r.planCoveredUsd), [a.planCoveredUsd, b.planCoveredUsd, 0]);
  assert.equal(stored[0].offPeak, false, "19:00 UTC on a Wednesday: glm-5.3 has no off-peak card");
});

test("spendReport carries byPurpose for the period", async () => {
  const { engine } = mk(); await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  await drain(mw(O, stream({ type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 0 } }, STOP)));
  await drain(mw({ ...O, purpose: "compaction" }, stream({ type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 0 } }, STOP)));
  await engine.guard(O);
  const r = await engine.spendReport({ since: "all", by: "purpose" });
  assert.deepEqual(Object.keys(r.groups).sort(), ["chat", "compaction"]);
  assert.equal(r.byPurpose, r.groups);
  assert.equal(r.byPurpose.chat.calls, 1);
  const p = await engine.spendReport({ since: "all" });
  assert.deepEqual(Object.keys(p.byPurpose).sort(), ["chat", "compaction"], "byPurpose is present whatever `by` is");
});

test("rows hold no prompt or completion text", async () => {
  const { engine, dataDir } = mk(); await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  const opts = { ...O, messages: [{ role: "user", content: "TOPSECRET prompt" }], system: "TOPSECRET system", tools: [{ name: "TOPSECRET_tool" }] };
  await drain(mw(opts, stream({ type: "text-delta", index: 0, text: "TOPSECRET completion" }, { type: "reasoning-delta", index: 1, text: "TOPSECRET thought" }, USAGE, STOP)));
  await engine.guard(O);
  const raw = readFileSync(join(dataDir, "spend.jsonl"), "utf8");
  assert.ok(!/TOPSECRET/.test(raw));
  for (const r of rows(dataDir)) for (const k of Object.keys(r)) assert.ok(KNOWN_FIELDS.has(k), k);
});

test("engine.ledgerVerify verifies the engine's own data dir with the injected clock, re-reading every byte", async () => {
  const { engine, dataDir } = mk({ now: () => Date.parse("2026-11-08T12:00:00Z") });
  await engine.getTable();
  const mw = spendGuardMiddleware(engine);
  await drain(mw(O, stream(USAGE, STOP)));
  await engine.guard(O);
  const ok = await engine.ledgerVerify();
  assert.equal(ok.ok, true); assert.deepEqual([ok.rows, ok.checked, ok.since], [1, 1, "all"]);
  assert.equal((await engine.ledgerVerify({ since: "today" })).rows, 1);
  // an edit made in place after the first check, same size: only a full re-read can see it
  const file = join(dataDir, "spend.jsonl");
  const text = readFileSync(file, "utf8");
  const edited = text.replace(/"usd":([0-9.e-]+)/, (m, v) => `"usd":${v.slice(0, -1)}${v.endsWith("1") ? "2" : "1"}`);
  assert.equal(edited.length, text.length);
  writeFileSync(file, edited);
  const bad = await engine.ledgerVerify({ fresh: true }); // a plain call inside the memo window would repeat the earlier report
  assert.equal(bad.ok, false); assert.equal(bad.mismatches[0].field, "usd");
});

test("turn, step and parent are taken when the call is recorded, not after a slow price-table load", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { engine, dataDir } = mk({ loadTable: async () => { await gate; return TABLE; } });
  const sess = { id: "s1", header: { origin: "subagent", parentSession: "p1" } };
  await engine.onSessionEvent(sess, { type: "step/start", data: { turn: 1, step: 3 } });
  const pending = engine.recordUsage({ ...O, model: "no-such-model" }, { inputTokens: 10, outputTokens: 1 }); // waits for the first table load
  await engine.onSessionEvent(sess, { type: "step/end", data: { turn: 1, step: 3 } });
  await engine.onSessionEvent(sess, { type: "step/start", data: { turn: 1, step: 4 } });
  await engine.onSessionEvent({ id: "s1", header: {} }, { type: "turn/end", data: { turn: 1 } });
  release();
  const out = await pending;
  assert.ok(out?.written, "the row was written");
  const [r] = rows(dataDir);
  assert.deepEqual([r.turn, r.step, r.parentSessionId], [1, 3, "p1"], "the step the call was made in, not the one running when the table arrived");
});

// ---- Verify must not be a way to keep the host's event loop busy ----
const countingVerify = (calls, report = {}) => (dir, o) => { calls.push(o); return { ok: true, complete: true, unreadable: false, since: o.since, rows: calls.length, ...report }; };

test("concurrent verifies of the same period share one read; a repeat inside the window and with no new row reuses it", async () => {
  const calls = []; let t = 0;
  const { engine } = mk({ verifyImpl: countingVerify(calls), verifyClock: () => t, verifyTtlMs: 5000 });
  const [a, b, c] = await Promise.all([engine.ledgerVerify(), engine.ledgerVerify(), engine.ledgerVerify({ since: "all" })]);
  assert.equal(calls.length, 1); assert.equal(a, b); assert.equal(b, c);
  t = 4999;
  assert.equal(await engine.ledgerVerify(), a);
  assert.equal(calls.length, 1, "inside the window");
  await engine.ledgerVerify({ since: "7d" });
  assert.equal(calls.length, 2, "another period is its own read");
});

test("a verify after the window, after a new row, or with fresh:true reads again", async () => {
  const calls = []; let t = 0;
  const { engine } = mk({ verifyImpl: countingVerify(calls), verifyClock: () => t, verifyTtlMs: 5000 });
  await engine.getTable();
  await engine.ledgerVerify();
  t = 5000;
  await engine.ledgerVerify();
  assert.equal(calls.length, 2, "window over");
  await drain(spendGuardMiddleware(engine)(O, stream(USAGE, STOP)));
  await engine.guard(O); // settles the capture: a row was written
  await engine.ledgerVerify();
  assert.equal(calls.length, 3, "a row was written since");
  await engine.ledgerVerify({ fresh: true });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.full), [true, true, true, true], "every real read re-reads every byte");
});

test("an incomplete or unreadable report is never reused", async () => {
  const calls = [];
  const { engine } = mk({ verifyImpl: countingVerify(calls, { complete: false }), verifyClock: () => 0, verifyTtlMs: 5000 });
  await engine.ledgerVerify(); await engine.ledgerVerify();
  assert.equal(calls.length, 2);
});

test("a verify that throws is not reused and the next call tries again", async () => {
  let n = 0;
  const { engine } = mk({ verifyImpl: () => { n++; if (n === 1) throw new Error("disk"); return { ok: true, complete: true, unreadable: false }; }, verifyClock: () => 0, verifyTtlMs: 5000 });
  await assert.rejects(engine.ledgerVerify(), /disk/);
  assert.equal((await engine.ledgerVerify()).ok, true);
  assert.equal(n, 2);
});

test("a verify yields to the event loop before it reads, so queued stream work runs first", async () => {
  const order = [];
  const { engine } = mk({ verifyImpl: () => { order.push("read"); return { ok: true, complete: true, unreadable: false }; } });
  setImmediate(() => order.push("queued")); // work already waiting for the loop when the request arrives
  const p = engine.ledgerVerify();
  assert.deepEqual(order, [], "nothing read synchronously");
  await p;
  assert.deepEqual(order, ["queued", "read"]);
});
