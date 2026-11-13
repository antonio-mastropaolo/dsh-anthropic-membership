import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createRoutes } from "./routes.mjs";

const ALLOWED = ["http://127.0.0.1:3080", "http://localhost:3080"];

async function withServer(fn, { guardStatus } = {}) {
  const calls = [];
  const verifyCalls = [];
  const REPORT = { ok: true, since: "all", rows: 3, checked: 2, v1: 1, mismatchCount: 0, mismatches: [], tornLines: 0, duplicateCount: 0, duplicateIds: [], unknownFields: [], complete: true, unreadable: false, note: "n" };
  const engine = {
    spendReport: async (o) => { calls.push(o); return { ...o, totals: { usd: 0 }, byPurpose: { chat: { calls: 1 } }, groups: { chat: { calls: 1 } } }; },
    ledgerVerify: async (o) => { verifyCalls.push(o); return { ...REPORT, since: o.since }; },
    ...(guardStatus ? { guardStatus } : {}),
  };
  const legacy = { status: async () => ({ signedIn: false, plan: { mode: "signed-out" }, spendGuard: true }) };
  let handler;
  const server = createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  handler = createRoutes({ allowedOrigins: ALLOWED, port, engine, legacy });
  const call = (path, { hub = true, origin } = {}) => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, ...(hub ? { "x-dsh-model-hub": "1" } : {}), ...(origin ? { origin } : {}) };
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers, setHost: false }, (res) => {
      const ch = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => { const text = Buffer.concat(ch).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on("error", reject);
    req.end();
  });
  try { await fn({ call, calls, verifyCalls, REPORT }); } finally { await new Promise((r) => server.close(r)); }
}

test("GET /spend?by=purpose is 200 and forwards by:purpose; the body carries byPurpose", () => withServer(async ({ call, calls }) => {
  const r = await call("/spend?since=7d&by=purpose");
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [{ since: "7d", by: "purpose" }]);
  assert.ok(r.json.byPurpose.chat);
}));

test("GET /spend?by=nope is 400 and names every valid value; no hub header is 403; a hostile Origin is 403", () => withServer(async ({ call, calls }) => {
  const bad = await call("/spend?by=nope");
  assert.equal(bad.status, 400); assert.match(bad.json.error, /provider\|model\|session\|day\|purpose/);
  assert.equal((await call("/spend?by=purpose", { hub: false })).status, 403);
  const hostile = await call("/spend?by=purpose", { origin: "http://evil.example" });
  assert.equal(hostile.status, 403); assert.equal(hostile.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(calls, []);
}));

test("GET /ledger/verify is 200 with the hub header (no Origin or an allowed one) and returns exactly the engine's report", () => withServer(async ({ call, verifyCalls }) => {
  const plain = await call("/ledger/verify");
  assert.equal(plain.status, 200); assert.equal(plain.json.ok, true); assert.equal(plain.json.since, "all");
  const week = await call("/ledger/verify?since=7d", { origin: ALLOWED[0] });
  assert.equal(week.status, 200); assert.equal(week.json.since, "7d");
  assert.equal(week.headers["access-control-allow-origin"], ALLOWED[0]);
  assert.deepEqual(verifyCalls, [{ since: "all" }, { since: "7d" }]);
}));

test("GET /ledger/verify without the hub header is 403, a hostile Origin is 403 with no CORS header, and neither reaches the engine", () => withServer(async ({ call, verifyCalls }) => {
  assert.equal((await call("/ledger/verify", { hub: false })).status, 403);
  for (const o of ["http://evil.example", "null", "http://127.0.0.1:3081"]) {
    const r = await call("/ledger/verify", { origin: o });
    assert.equal(r.status, 403, o); assert.equal(r.headers["access-control-allow-origin"], undefined, o);
  }
  const bothBad = await call("/ledger/verify", { hub: false, origin: "http://evil.example" });
  assert.equal(bothBad.status, 403); assert.equal(bothBad.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(verifyCalls, []);
}));

test("GET /ledger/verify rejects a bad since with 400 and never reaches the engine", () => withServer(async ({ call, verifyCalls }) => {
  for (const q of ["junk", "", "7d%0a", "../x", "99d", "today%20"]) {
    const r = await call("/ledger/verify?since=" + q);
    assert.equal(r.status, 400, q); assert.match(r.json.error, /since must be today\|7d\|30d\|all/);
  }
  assert.deepEqual(verifyCalls, []);
}));

// ---- GET /status carries the guard status ----
const GUARD = { onError: "block", errors: { count: 2, last: { at: 1700000000000, message: "boom" } } };

test("GET /status includes guard from engine.guardStatus(), beside the legacy status", () => withServer(async ({ call }) => {
  const r = await call("/status");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.guard, GUARD);
  assert.equal(r.json.spendGuard, true);
  assert.equal(r.json.signedIn, false);
}, { guardStatus: () => GUARD }));

test("GET /status has guard: null when the engine has no guardStatus, and is still 200", () => withServer(async ({ call }) => {
  const r = await call("/status");
  assert.equal(r.status, 200);
  assert.equal(r.json.guard, null);
}));

test("GET /status stays gated: no hub header is 403 and a hostile Origin is 403 with no CORS header; guardStatus is never called", () => {
  let calls = 0;
  return withServer(async ({ call }) => {
    assert.equal((await call("/status", { hub: false })).status, 403);
    const r = await call("/status", { origin: "http://evil.example" });
    assert.equal(r.status, 403); assert.equal(r.headers["access-control-allow-origin"], undefined);
    assert.equal(calls, 0);
  }, { guardStatus: () => { calls++; return GUARD; } });
});

test("GET /status survives a guardStatus that throws: guard is null and the status is still served", () => withServer(async ({ call }) => {
  const r = await call("/status");
  assert.equal(r.status, 200);
  assert.equal(r.json.guard, null);
}, { guardStatus: () => { throw new Error("nope"); } }));
