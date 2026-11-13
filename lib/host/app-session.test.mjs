import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { chmodSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "./app.mjs";
import { appendSpend, _resetLedgerCache } from "../cost/ledger.mjs";
import { makeSpendRecord } from "../cost/cost.mjs";
import { buildReceipt, receiptMarkdown } from "../cost/receipt.mjs";
import { ledgerRows } from "../cost/ledger.mjs";
import { DEMO_TEXT } from "../demo/constants.mjs";

const P = { inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, source: "litellm", billing: "metered" };
const rec = (sessionId, turn, step, extra = {}) => makeSpendRecord({ sessionId, provider: "google", model: "m", usage: { inputTokens: 100, outputTokens: 10 }, price: P, meta: { purpose: "chat", turn, step, ttftMs: 400, durationMs: 1500 }, ...extra });

async function withHub(fn, { dataDir = mkdtempSync(join(tmpdir(), "hub-sess-")) , hubOpts = {} } = {}) {
  const clock = { t: 1_000_000 };
  let handler;
  const server = createServer((q, r) => handler(q, r));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const hub = createHub({ allowedOrigins: ["http://127.0.0.1:3080"], port, dataDir, legacy: { status: async () => ({}) }, refreshEnabled: false, now: () => clock.t, ...hubOpts });
  handler = hub.handler;
  const get = (path) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, "x-dsh-model-hub": "1" }, setHost: false }, (res) => {
      const ch = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(ch).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end();
  });
  try { await fn({ get, dataDir, clock, hub }); } finally { hub.stop(); await new Promise((r) => server.close(r)); }
}

test("a real hub over a temp ledger returns the session's turns with complete:true", async () => {
  await withHub(async ({ get, dataDir }) => {
    appendSpend(dataDir, rec("s", 1, 1)); appendSpend(dataDir, rec("s", 1, 2)); appendSpend(dataDir, rec("s", 2, 1)); appendSpend(dataDir, rec("other", 1, 1));
    const r = await get("/spend/turns?session=s");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.turns.map((t) => [t.turn, t.calls]), [[1, 2], [2, 1]]);
    assert.equal(r.json.complete, true); assert.equal(r.json.unreadable, false);
    assert.ok(r.json.turns[0].usd > 0);
  });
});

test("rows in a rotated spend.<ms>.jsonl and in spend.jsonl are both counted", async () => {
  await withHub(async ({ get, dataDir }) => {
    appendSpend(dataDir, rec("s", 1, 1));
    renameSync(join(dataDir, "spend.jsonl"), join(dataDir, "spend.1700000000000.jsonl"));
    appendSpend(dataDir, rec("s", 2, 1));
    const r = await get("/spend/turns?session=s");
    assert.deepEqual(r.json.turns.map((t) => t.turn), [1, 2]);
  });
});

test("the ledger rows are memoised for 2 s: a row appended inside the window is not seen, one after it is", async () => {
  await withHub(async ({ get, dataDir, clock }) => {
    appendSpend(dataDir, rec("s", 1, 1));
    assert.equal((await get("/spend/turns?session=s")).json.turns.length, 1);
    appendSpend(dataDir, rec("s", 2, 1));
    clock.t += 1999;
    assert.equal((await get("/spend/turns?session=s")).json.turns.length, 1);
    clock.t += 1;
    assert.equal((await get("/spend/turns?session=s")).json.turns.length, 2);
  });
});

test("after the 2 s window the ledger is read again only when a ledger file changed (inode, size, mtime or ctime); an unchanged one is not re-parsed", async () => {
  let reads = 0;
  const readLedger = (d) => { reads++; return ledgerRows(d); };
  await withHub(async ({ get, dataDir, clock }) => {
    appendSpend(dataDir, rec("s", 1, 1));
    assert.equal((await get("/spend/turns?session=s")).json.turns.length, 1);
    assert.equal(reads, 1);
    clock.t += 60_000;
    assert.equal((await get("/spend/turns?session=s")).json.turns.length, 1);
    clock.t += 60_000;
    assert.equal((await get("/spend/session?id=s")).json.calls, 1);
    assert.equal(reads, 1, "nothing changed: the rows already held are served");
    appendSpend(dataDir, rec("s", 2, 1));
    assert.equal((await get("/spend/turns?session=s")).json.turns.length, 1, "inside the 2 s window the held rows are still served");
    assert.equal(reads, 1);
    clock.t += 2000;
    assert.equal((await get("/spend/turns?session=s")).json.turns.length, 2);
    assert.equal(reads, 2, "a changed file is read again");
    clock.t += 60_000;
    await get("/spend/turns?session=s");
    assert.equal(reads, 2);
    renameSync(join(dataDir, "spend.jsonl"), join(dataDir, "spend.1700000000000.jsonl"));
    clock.t += 60_000;
    assert.equal((await get("/spend/turns?session=s")).json.turns.length, 2);
    assert.equal(reads, 3, "a rotation changes the listing");
  }, { hubOpts: { readLedger } });
});

test("a read that was incomplete is never held past the window, even when no file changed", async () => {
  let reads = 0;
  const readLedger = () => { reads++; return { rows: [], complete: false, unreadable: false }; };
  await withHub(async ({ get, dataDir, clock }) => {
    appendSpend(dataDir, rec("s", 1, 1));
    assert.equal((await get("/spend/turns?session=s")).json.complete, false);
    clock.t += 5000;
    await get("/spend/turns?session=s");
    assert.equal(reads, 2);
  }, { hubOpts: { readLedger } });
});

test("an unreadable ledger gives complete:false and no turns, never a 500", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root can read a mode 000 file");
  _resetLedgerCache();
  await withHub(async ({ get, dataDir }) => {
    appendSpend(dataDir, rec("s", 1, 1));
    _resetLedgerCache();
    chmodSync(join(dataDir, "spend.jsonl"), 0);
    try {
      const r = await get("/spend/turns?session=s");
      assert.equal(r.status, 200);
      assert.equal(r.json.complete, false); assert.equal(r.json.unreadable, true);
      assert.deepEqual(r.json.turns, []);
    } finally { chmodSync(join(dataDir, "spend.jsonl"), 0o600); }
  });
});

test("an empty data dir gives turns [] and complete:true; an unknown id is 200 with zeros", async () => {
  await withHub(async ({ get }) => {
    const r = await get("/spend/turns?session=nobody");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.turns, []); assert.equal(r.json.complete, true); assert.equal(r.json.v1Calls, 0);
  });
});

test("GET /spend/session: the body is buildReceipt over the real ledger plus markdown, caps and complete; the markdown is receiptMarkdown of the same receipt", async () => {
  await withHub(async ({ get, dataDir }) => {
    appendSpend(dataDir, rec("s", 1, 1)); appendSpend(dataDir, rec("s", 1, 2)); appendSpend(dataDir, rec("s", 2, 1)); appendSpend(dataDir, rec("other", 1, 1));
    const r = await get("/spend/session?id=s");
    assert.equal(r.status, 200);
    const { markdown, caps, complete, unreadable, ...rc } = r.json;
    assert.deepEqual(rc, JSON.parse(JSON.stringify(buildReceipt(ledgerRows(dataDir).rows, "s"))));
    assert.equal(rc.calls, 3); assert.equal(rc.turns, 2);
    assert.equal(markdown, receiptMarkdown(rc, { demo: false }));
    assert.equal(complete, true); assert.equal(unreadable, false);
    assert.ok(!r.json.demo);
    assert.ok(!JSON.stringify(r.json).includes(dataDir));
  });
});

test("GET /spend/session: subagent rows with parentSessionId appear under subagents", async () => {
  await withHub(async ({ get, dataDir }) => {
    appendSpend(dataDir, rec("s", 1, 1));
    appendSpend(dataDir, makeSpendRecord({ sessionId: "s-sub", provider: "google", model: "m", usage: { inputTokens: 10, outputTokens: 1 }, price: P, meta: { purpose: "chat", turn: 1, step: 1, parentSessionId: "s" } }));
    const r = await get("/spend/session?id=s");
    assert.equal(r.json.subagents.calls, 1); assert.equal(r.json.subagents.sessions[0].sessionId, "s-sub");
    assert.equal(r.json.withSubagents.calls, 2);
    assert.ok(r.json.markdown.includes("## Subagents (one level)"));
  });
});

test("GET /spend/session: caps carry numbers only (or null), unknown id is 200 with zeros, an unreadable ledger is complete:false", async (t) => {
  await withHub(async ({ get, dataDir }) => {
    appendSpend(dataDir, rec("s", 1, 1));
    const r = await get("/spend/session?id=s");
    for (const k of ["dailyUsd", "sessionUsd", "todayUsd"]) assert.equal(typeof r.json.caps[k], "number", k);
    assert.ok(["ok", "warn", "block"].includes(r.json.caps.action));
    assert.deepEqual(Object.keys(r.json.caps).sort(), ["action", "dailyUsd", "sessionUsd", "todayUsd"]);
    const none = await get("/spend/session?id=nobody");
    assert.equal(none.status, 200); assert.equal(none.json.calls, 0); assert.equal(none.json.complete, true);
  });
  await withHub(async ({ get }) => {
    const r = await get("/spend/session?id=s");
    assert.equal(r.json.caps, null);
  }, { hubOpts: { engine: { capsStatus: () => { throw new Error("nope"); }, onSessionEvent() {}, guard: async () => null } } });
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  _resetLedgerCache();
  await withHub(async ({ get, dataDir }) => {
    appendSpend(dataDir, rec("s", 1, 1));
    _resetLedgerCache();
    chmodSync(join(dataDir, "spend.jsonl"), 0);
    try {
      const r = await get("/spend/session?id=s");
      assert.equal(r.status, 200); assert.equal(r.json.complete, false); assert.equal(r.json.unreadable, true); assert.equal(r.json.calls, 0);
    } finally { chmodSync(join(dataDir, "spend.jsonl"), 0o600); }
  });
});

test("GET /spend/session in demo mode: the markdown starts with the DEMO line and the body has demo:true", async () => {
  await withHub(async ({ get, dataDir }) => {
    appendSpend(dataDir, rec("s", 1, 1));
    const r = await get("/spend/session?id=s");
    assert.equal(r.json.demo, true);
    assert.equal(r.json.markdown.split("\n")[0], DEMO_TEXT);
  }, { hubOpts: { demo: { note: "n" } } });
});
