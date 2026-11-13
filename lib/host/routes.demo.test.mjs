import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createRoutes } from "./routes.mjs";
import { DEMO_TEXT } from "../demo/constants.mjs";

const ALLOWED = ["http://127.0.0.1:3080", "http://localhost:3080"];
const CONFIGURED = { gpuServer: { id: "box", name: "Test Box", url: "http://127.0.0.1:1", icon: "nvidia" }, localProviders: ["box"] };

function makeDeps() {
  const calls = [];
  const rec = (name, ret) => (...a) => { calls.push(name); return ret(...a); };
  return {
    calls,
    accounts: { state: rec("accounts.state", () => ({ running: false, reportOnly: true, accounts: [] })), tick: rec("accounts.tick", async () => ({ running: false, accounts: [] })) },
    signin: {
      flows: rec("signin.flows", async () => []),
      start: rec("signin.start", () => ({ state: "running" })),
      status: rec("signin.status", () => ({ state: "idle" })),
      answer: rec("signin.answer", () => ({ ok: true })),
      cancel: rec("signin.cancel", async () => ({ state: "cancelled" })),
    },
    getConfig: () => CONFIGURED,
    gpu: {
      gpus: rec("gpu.gpus", async () => ({ status: 200, body: { ok: true, gpus: [] } })),
      models: rec("gpu.models", async () => ({ status: 200, body: { models: [] } })),
      switch: rec("gpu.switch", async () => ({ status: 202, body: { status: "switching" } })),
      unload: rec("gpu.unload", async () => ({ status: 200, body: { status: "unloading" } })),
    },
    engine: { spendReport: rec("engine.spend", async () => ({})), prices: rec("engine.prices", async () => ({})), cacheReport: rec("engine.cache", () => ({ latest: null })) },
    legacy: { status: rec("legacy.status", async () => ({ signedIn: false })) },
  };
}

async function withServer(fn, extra = {}) {
  const deps = makeDeps();
  let handler;
  const server = createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  handler = createRoutes({ allowedOrigins: ALLOWED, port, ...deps, ...extra });
  const call = (method, path, { headers = {}, body, host, hub = method === "GET" } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const h = { host: host ?? `127.0.0.1:${port}`, ...(hub ? { "x-dsh-model-hub": "1" } : {}), ...headers };
    if (data !== undefined) h["content-type"] = "application/json";
    const req = request({ host: "127.0.0.1", port, method, path, headers: h, setHost: false }, (res) => {
      const ch = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => {
        const text = Buffer.concat(ch).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
  try { await fn({ call, deps, port }); } finally { await new Promise((r) => server.close(r)); }
}

const OK = { origin: "http://127.0.0.1:3080" };
const POST = { headers: OK, hub: true };

test("/status and /healthz report demo:true with the banner note; without demo they report demo:false", async () => {
  await withServer(async ({ call }) => {
    const h = await call("GET", "/healthz");
    assert.equal(h.json.demo, true);
    const s = await call("GET", "/status", { headers: OK });
    assert.equal(s.json.demo, true);
    assert.equal(s.json.demoNote, DEMO_TEXT);
  }, { demo: { note: DEMO_TEXT } });
  await withServer(async ({ call }) => {
    const h = await call("GET", "/healthz");
    assert.equal(h.json.demo, false);
    const s = await call("GET", "/status", { headers: OK });
    assert.equal(s.json.demo, false);
    assert.equal("demoNote" in s.json, false);
  });
});

test("a demo legacy reporting demo:true cannot make a normal host claim it, and demo:false cannot hide demo", async () => {
  await withServer(async ({ call }) => {
    const s = await call("GET", "/status", { headers: OK });
    assert.equal(s.json.demo, false);
  }, { legacy: { status: async () => ({ demo: true }) } });
  await withServer(async ({ call }) => {
    const s = await call("GET", "/status", { headers: OK });
    assert.equal(s.json.demo, true);
  }, { demo: { note: DEMO_TEXT }, legacy: { status: async () => ({ demo: false }) } });
});

test("in demo mode every POST outside the allow list is 409 and reaches no handler", async () => {
  await withServer(async ({ call, deps }) => {
    for (const [p, body] of [["/caps", { dailyUsd: 1 }], ["/accounts/signin", { provider: "xai" }], ["/accounts/signin/xai/answer", { text: "x" }], ["/accounts/signin/xai/cancel", {}], ["/ledger/export", {}], ["/nope", {}], ["/rocco/nope", {}]]) {
      const r = await call("POST", p, { ...POST, body });
      assert.equal(r.status, 409, p);
      assert.match(r.json.error, /^demo mode: read-only/, p);
    }
    assert.deepEqual(deps.calls, []);
  }, { demo: { note: DEMO_TEXT } });
});

test("in demo mode the three allowed POSTs work (also via the /rocco alias)", async () => {
  await withServer(async ({ call, deps }) => {
    assert.equal((await call("POST", "/gpu/switch", { ...POST, body: { model: "model-a" } })).status, 202);
    assert.equal((await call("POST", "/rocco/switch", { ...POST, body: { model: "model-a" } })).status, 202);
    assert.equal((await call("POST", "/gpu/unload", { ...POST, body: {} })).status, 200);
    assert.equal((await call("POST", "/accounts/refresh", { ...POST, body: {} })).status, 200);
    assert.deepEqual(deps.calls, ["gpu.switch", "gpu.switch", "gpu.unload", "accounts.tick"]);
  }, { demo: { note: DEMO_TEXT } });
});

test("in demo mode a hostile Origin, a wrong Host and a missing header are still 403 first; PUT is 405", async () => {
  await withServer(async ({ call, deps }) => {
    assert.equal((await call("POST", "/caps", { headers: { origin: "https://evil.example" }, hub: true, body: {} })).status, 403);
    assert.equal((await call("POST", "/caps", { hub: true, body: {} })).status, 403);
    assert.equal((await call("POST", "/caps", { headers: OK, hub: false, body: {} })).status, 403);
    assert.equal((await call("POST", "/caps", { ...POST, host: "evil.example", body: {} })).status, 403);
    assert.equal((await call("PUT", "/caps", { headers: OK, hub: true, body: {} })).status, 405);
    assert.deepEqual(deps.calls, []);
  }, { demo: { note: DEMO_TEXT } });
});

test("without demo an unknown POST is still the normal 404", async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call("POST", "/nope", { ...POST, body: {} })).status, 404);
  });
});
