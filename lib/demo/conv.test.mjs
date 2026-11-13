// The demo conversation: Ledger v2 rows with turns, so the turn cost line and /spend/turns have something to show.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDemo } from "./build.mjs";
import { writeDemo } from "./write.mjs";
import { resolveDemo } from "./gate.mjs";
import { createDemoHub } from "./host.mjs";
import { DEMO_CONV_SESSION, DEMO_CONV_SUB, DEMO_TEXT } from "./constants.mjs";
import { buildTurns } from "../cost/turns.mjs";
import { ledgerRows } from "../cost/ledger.mjs";
import { verifyLedger } from "../cost/verify.mjs";

const AT = "2026-11-12T15:00:00Z";
const ORIGIN = "http://127.0.0.1:3080";
const rowsOf = (files) => files.get("spend.jsonl").trim().split("\n").map((l) => JSON.parse(l));
function dump() {
  const base = mkdtempSync(join(tmpdir(), "demo-conv-"));
  const dirs = { data: join(base, "data"), dsh: join(base, "dsh"), home: join(base, "home") };
  for (const d of Object.values(dirs)) mkdirSync(d);
  const env = { DSH_HUB_DATA_DIR: dirs.data, DSH_HOME: dirs.dsh, HOME: dirs.home };
  const w = writeDemo({ out: join(base, "demo"), at: AT, seed: 3, tzOffsetMin: 0, env, home: dirs.home });
  return { base, dirs, env, dir: w.out };
}

test("the demo conversation has turns 1-4: a compaction call while turn 3 ran, a subscription turn and a metered turn", () => {
  const { files } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const r = buildTurns(rowsOf(files), DEMO_CONV_SESSION);
  assert.deepEqual(r.turns.map((t) => t.turn), [1, 2, 3, 4]);
  assert.equal(r.v1Calls, 0);
  assert.deepEqual(r.turns[2].during.map((d) => d.purpose), ["compaction"]);
  assert.equal(r.turns[3].billing, "metered"); assert.ok(r.turns[3].usd > 0);
  assert.equal(r.turns[0].billing, "subscription"); assert.ok(r.turns[0].notChargedUsd > 0); assert.equal(r.turns[0].usd, 0);
  assert.deepEqual(r.outside.byPurpose.map((p) => p.purpose), ["session-title"]);
  for (const t of r.turns) assert.ok(t.ttftMs >= 400 && t.ttftMs <= 1500 && t.durationMs > 0, `turn ${t.turn}`);
  const sub = rowsOf(files).filter((x) => x.sessionId === DEMO_CONV_SUB);
  assert.equal(sub.length, 2);
  for (const x of sub) assert.equal(x.parentSessionId, DEMO_CONV_SESSION);
});

test("the demo ledger still verifies (the conversation's rows re-derive from their own rates) and the build is deterministic", () => {
  const a = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const b = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  assert.equal(a.files.get("spend.jsonl"), b.files.get("spend.jsonl"));
  const dir = mkdtempSync(join(tmpdir(), "demo-conv-v-"));
  writeFileSync(join(dir, "spend.jsonl"), a.files.get("spend.jsonl"));
  const v = verifyLedger(dir, { since: "all", full: true });
  assert.equal(v.ok, true, JSON.stringify(v.mismatches.slice(0, 3)));
  assert.ok(v.checked >= 12, String(v.checked));
  assert.equal(ledgerRows(dir).rows.filter((r) => r.sessionId === DEMO_CONV_SESSION && r.v === 2).length, 12);
});

test("the conversation ends before the cache session starts reporting, so the newest-row session does not change", () => {
  const { files } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const rows = rowsOf(files);
  const conv = rows.filter((x) => x.sessionId.startsWith(DEMO_CONV_SESSION)).map((x) => Date.parse(x.ts));
  const cache = rows.filter((x) => x.sessionId === "demo-s-cache").map((x) => Date.parse(x.ts));
  assert.ok(Math.max(...conv) < Math.min(...cache));
});

test("the demo host answers /spend/turns?session=demo-s-conv with demo:true, and an unknown id with zeros", async () => {
  const f = dump();
  const demo = resolveDemo({ ...f.env, DSH_HUB_DEMO: f.dir }, { home: f.dirs.home });
  assert.ok(demo);
  let handler;
  const server = createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const hub = createDemoHub({ demo, allowedOrigins: [ORIGIN], port });
  handler = hub.handler;
  await hub.replayed;
  const get = (path) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, origin: ORIGIN, "x-dsh-model-hub": "1" }, setHost: false }, (res) => {
      const ch = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(ch).toString("utf8")) }));
    });
    req.on("error", reject); req.end();
  });
  try {
    const r = await get(`/spend/turns?session=${DEMO_CONV_SESSION}`);
    assert.equal(r.status, 200); assert.equal(r.json.demo, true);
    assert.deepEqual(r.json.turns.map((t) => t.turn), [1, 2, 3, 4]);
    assert.equal(r.json.complete, true);
    const none = await get("/spend/turns?session=demo-s-nope");
    assert.equal(none.status, 200); assert.deepEqual(none.json.turns, []); assert.equal(none.json.demo, true);
  } finally { hub.stop(); await new Promise((r) => server.close(r)); }
});

test("the demo host answers /spend/session?id=demo-s-conv with the receipt, demo:true and the DEMO-first Markdown; the receipt CLI reads the demo folder", async () => {
  const f = dump();
  const demo = resolveDemo({ ...f.env, DSH_HUB_DEMO: f.dir }, { home: f.dirs.home });
  let handler;
  const server = createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const hub = createDemoHub({ demo, allowedOrigins: [ORIGIN], port });
  handler = hub.handler;
  await hub.replayed;
  const get = (path) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, origin: ORIGIN, "x-dsh-model-hub": "1" }, setHost: false }, (res) => {
      const ch = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(ch).toString("utf8")) }));
    });
    req.on("error", reject); req.end();
  });
  try {
    const r = await get(`/spend/session?id=${DEMO_CONV_SESSION}`);
    assert.equal(r.status, 200); assert.equal(r.json.demo, true);
    assert.equal(r.json.subagents.sessionCount, 1);
    assert.equal(r.json.subagents.sessions[0].sessionId, DEMO_CONV_SUB);
    for (const p of ["chat", "compaction", "session-title"]) assert.ok(r.json.byPurpose[p], p);
    assert.equal(r.json.turns, 4);
    assert.equal(r.json.markdown.split("\n")[0], DEMO_TEXT);
    assert.equal(r.json.complete, true);
    assert.ok(!JSON.stringify(r.json).includes(f.dir));
    const none = await get("/spend/session?id=demo-s-nope");
    assert.equal(none.status, 200); assert.equal(none.json.calls, 0);
  } finally { hub.stop(); await new Promise((r) => server.close(r)); }
});
