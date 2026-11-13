import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createRoutes } from "./routes.mjs";

const ALLOWED = ["http://127.0.0.1:3080", "http://localhost:3080"];
const TURNS = { sessionId: "s", turns: [{ turn: 1, calls: 2, usd: 0.01, routes: [{ provider: "google", model: "m", calls: 2 }] }], outside: { calls: 0, usd: 0, apiEquivUsd: 0, byPurpose: [] }, v1Calls: 0, truncated: false, complete: true, unreadable: false };

async function withServer(fn, { sessions = true, demo = null } = {}) {
  const asked = [];
  const stub = sessions ? { turns: (id) => { asked.push(id); return { ...TURNS, sessionId: id }; }, receipt: (id) => { asked.push(`receipt:${id}`); return { sessionId: id, calls: 1, usd: 0.5, markdown: '# Session receipt', caps: null, complete: true, unreadable: false }; } } : null;
  const legacy = { status: async () => ({}) };
  let handler;
  const server = createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  handler = createRoutes({ allowedOrigins: ALLOWED, port, engine: {}, legacy, sessions: stub, demo });
  const call = (path, { hub = true, origin } = {}) => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, ...(hub ? { "x-dsh-model-hub": "1" } : {}), ...(origin ? { origin } : {}) };
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers, setHost: false }, (res) => {
      const ch = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => { const text = Buffer.concat(ch).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on("error", reject);
    req.end();
  });
  try { await fn({ call, asked, port }); } finally { await new Promise((r) => server.close(r)); }
}

test("GET /spend/turns?session=<id> is 200 with the hub header and passes the exact id to sessions.turns", () => withServer(async ({ call, asked }) => {
  const id = "agent-session-0b8f3c2e-1111-4222-8333-444455556666";
  const r = await call(`/spend/turns?session=${id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(asked, [id]);
  assert.equal(r.json.sessionId, id);
  assert.equal(r.json.turns[0].calls, 2);
  assert.equal(r.headers["access-control-allow-origin"], undefined);
  const o = await call(`/spend/turns?session=${id}`, { origin: "http://127.0.0.1:3080" });
  assert.equal(o.status, 200);
  assert.equal(o.headers["access-control-allow-origin"], "http://127.0.0.1:3080");
  assert.deepEqual(asked, [id, id]);
}));

test("no hub header is 403; a hostile Origin is 403 with no CORS header; neither reaches sessions", () => withServer(async ({ call, asked, port }) => {
  const bare = await call("/spend/turns?session=s1", { hub: false });
  assert.equal(bare.status, 403);
  assert.equal(bare.headers["access-control-allow-origin"], undefined);
  const bareAllowed = await call("/spend/turns?session=s1", { hub: false, origin: "http://127.0.0.1:3080" });
  assert.equal(bareAllowed.status, 403);
  for (const origin of ["http://evil.example", "null", "http://127.0.0.1:3081", `http://127.0.0.1:${port}.evil.example`]) {
    const r = await call("/spend/turns?session=s1", { origin });
    assert.equal(r.status, 403, origin);
    assert.equal(r.headers["access-control-allow-origin"], undefined, origin);
    assert.ok(!JSON.stringify(r.headers).includes(origin) || origin === "null", origin);
  }
  assert.deepEqual(asked, []);
}));

test("a missing, empty, oversized or path-like session is 400 and never reaches sessions", () => withServer(async ({ call, asked }) => {
  const bad = ["/spend/turns", "/spend/turns?session=", "/spend/turns?session=../x", "/spend/turns?session=a/b", "/spend/turns?session=a%2Fb", "/spend/turns?session=a%20b", `/spend/turns?session=${"x".repeat(129)}`, "/spend/turns?id=s1", "/spend/turns?other=x", "/spend/turns?session=%2e%2e%2f%2e%2e%2fetc", "/spend/turns?session=a%00b"];
  for (const p of bad) {
    const r = await call(p);
    assert.equal(r.status, 400, p);
    assert.match(r.json.error, /session/, p);
    assert.match(r.json.error, /A-Za-z0-9/, p);
  }
  assert.deepEqual(asked, []);
  assert.equal((await call(`/spend/turns?session=${"x".repeat(128)}`)).status, 200);
}));

test("without a sessions dependency the route is 503", () => withServer(async ({ call }) => {
  const r = await call("/spend/turns?session=s1");
  assert.equal(r.status, 503);
}, { sessions: false }));

test("demo mode adds demo: true", () => withServer(async ({ call }) => {
  const r = await call("/spend/turns?session=s1");
  assert.equal(r.status, 200);
  assert.equal(r.json.demo, true);
}, { demo: { note: "n" } }));

test("a normal response has no demo field, no filesystem path and no ledger file name", () => withServer(async ({ call }) => {
  const r = await call("/spend/turns?session=s1");
  assert.equal(r.json.demo, undefined);
  assert.ok(!r.text.includes("/Users"));
  assert.ok(!r.text.includes("spend.jsonl"));
}));

test("GET /spend/session?id=<id> is 200 with the hub header and passes the exact id to sessions.receipt", () => withServer(async ({ call, asked }) => {
  const id = "agent-session-0b8f3c2e-1111-4222-8333-444455556666";
  const r = await call(`/spend/session?id=${id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(asked, [`receipt:${id}`]);
  assert.equal(r.json.sessionId, id);
  assert.equal(r.json.markdown, "# Session receipt");
  assert.equal(r.headers["access-control-allow-origin"], undefined);
  const o = await call(`/spend/session?id=${id}`, { origin: "http://127.0.0.1:3080" });
  assert.equal(o.status, 200);
  assert.equal(o.headers["access-control-allow-origin"], "http://127.0.0.1:3080");
}));

test("/spend/session: no hub header is 403, a hostile Origin is 403 with no CORS header, neither reaches sessions", () => withServer(async ({ call, asked, port }) => {
  const bare = await call("/spend/session?id=s1", { hub: false });
  assert.equal(bare.status, 403);
  assert.equal(bare.headers["access-control-allow-origin"], undefined);
  assert.equal((await call("/spend/session?id=s1", { hub: false, origin: "http://127.0.0.1:3080" })).status, 403);
  for (const origin of ["http://evil.example", "null", "http://127.0.0.1:3081", `http://127.0.0.1:${port}.evil.example`]) {
    const r = await call("/spend/session?id=s1", { origin });
    assert.equal(r.status, 403, origin);
    assert.equal(r.headers["access-control-allow-origin"], undefined, origin);
  }
  assert.deepEqual(asked, []);
}));

test("/spend/session: a missing, empty, oversized or path-like id is 400 (the parameter is id; ?session= is 400) and never reaches sessions", () => withServer(async ({ call, asked }) => {
  const bad = ["/spend/session", "/spend/session?id=", "/spend/session?id=../x", "/spend/session?id=a/b", "/spend/session?id=a%2Fb", "/spend/session?id=a%20b", `/spend/session?id=${"x".repeat(129)}`, "/spend/session?session=s1", "/spend/session?id=%2e%2e%2f%2e%2e%2fetc", "/spend/session?id=a%00b", "/spend/session?id=a%5Cb"];
  for (const p of bad) {
    const r = await call(p);
    assert.equal(r.status, 400, p);
    assert.match(r.json.error, /id/, p);
    assert.match(r.json.error, /A-Za-z0-9/, p);
  }
  assert.deepEqual(asked, []);
  assert.equal((await call(`/spend/session?id=${"x".repeat(128)}`)).status, 200);
}));

test("/spend/session without a sessions dependency is 503; demo mode adds demo: true; a normal body has no demo field, path or ledger file name", async () => {
  await withServer(async ({ call }) => { assert.equal((await call("/spend/session?id=s1")).status, 503); }, { sessions: false });
  await withServer(async ({ call }) => { const r = await call("/spend/session?id=s1"); assert.equal(r.status, 200); assert.equal(r.json.demo, true); }, { demo: { note: "n" } });
  await withServer(async ({ call }) => {
    const r = await call("/spend/session?id=s1");
    assert.equal(r.json.demo, undefined);
    assert.ok(!r.text.includes("/Users")); assert.ok(!r.text.includes("spend.jsonl"));
  });
});

/** A server whose /status is served by createRoutes with a `commandsStatus` dependency (or none). */
async function withStatusServer(fn, { commandsStatus } = {}) {
  const legacy = { status: async () => ({ signedIn: false }) };
  let handler;
  const server = createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  handler = createRoutes({ allowedOrigins: ALLOWED, port, engine: {}, legacy, ...(commandsStatus ? { commandsStatus } : {}) });
  const call = (path, { hub = true, origin } = {}) => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, ...(hub ? { "x-dsh-model-hub": "1" } : {}), ...(origin ? { origin } : {}) };
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers, setHost: false }, (res) => {
      const ch = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => { const text = Buffer.concat(ch).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on("error", reject);
    req.end();
  });
  try { await fn({ call }); } finally { await new Promise((r) => server.close(r)); }
}

test("GET /status carries commands {registered, collided} from the dependency; the default is empty", async () => {
  await withStatusServer(async ({ call }) => {
    assert.deepEqual((await call("/status")).json.commands, { registered: ["cost", "caps", "route", "receipt"], collided: [] });
  }, { commandsStatus: () => ({ registered: ["cost", "caps", "route", "receipt"], collided: [] }) });
  await withStatusServer(async ({ call }) => {
    assert.deepEqual((await call("/status")).json.commands, { registered: [], collided: [] });
  });
});

test("GET /status survives a throwing commands dependency and a malformed one", async () => {
  await withStatusServer(async ({ call }) => {
    const r = await call("/status");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.commands, { registered: [], collided: [] });
  }, { commandsStatus: () => { throw new Error("boom"); } });
  await withStatusServer(async ({ call }) => {
    const r = await call("/status");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.commands, { registered: ["cost"], collided: [] }, "only names survive; junk entries and extra fields are dropped");
  }, { commandsStatus: () => ({ registered: ["cost", 7, { x: 1 }], collided: "nope", extra: "/Users/x" }) });
});

test("GET /status stays gated: no hub header or a hostile Origin is 403 and never reads the commands dependency", async () => {
  let reads = 0;
  await withStatusServer(async ({ call }) => {
    assert.equal((await call("/status", { hub: false })).status, 403);
    assert.equal((await call("/status", { hub: false, origin: "http://127.0.0.1:3080" })).status, 403);
    const hostile = await call("/status", { origin: "http://evil.example" });
    assert.equal(hostile.status, 403);
    assert.equal(hostile.headers["access-control-allow-origin"], undefined);
    assert.equal(reads, 0);
    assert.equal((await call("/status")).status, 200);
    assert.equal(reads, 1);
  }, { commandsStatus: () => { reads++; return { registered: [], collided: [] }; } });
});
