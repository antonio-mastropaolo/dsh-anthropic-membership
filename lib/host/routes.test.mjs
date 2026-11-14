import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes, sameInstanceOrigin } from "./routes.mjs";
import * as capsLib from "../cost/caps.mjs";

const ALLOWED = ["http://127.0.0.1:3080", "http://localhost:3080"];
const SECRETISH = /sk-[A-Za-z0-9]|AIza|eyJ|refresh/i;

const CONFIGURED = { gpuServer: { id: "box", name: "Test Box", url: "http://127.0.0.1:1", icon: "nvidia" }, localProviders: ["box"] };
function makeDeps() {
  const calls = [];
  const rec = (name, ret) => (...a) => { calls.push([name, ...a]); return ret(...a); };
  const deps = {
    calls,
    config: CONFIGURED,
    accounts: { state: rec("accounts.state", () => ({ running: true, reportOnly: false, lastTickAt: 1, accounts: [{ provider: "anthropic", health: "expired" }] })), tick: rec("accounts.tick", async () => ({ running: true, accounts: [] })) },
    signin: {
      flows: rec("signin.flows", async () => [{ provider: "xai", label: "xAI", methods: ["oauth"], inFlight: false }]),
      start: rec("signin.start", (p) => ({ provider: p, state: "running", notices: [], prompt: null })),
      status: rec("signin.status", (p) => ({ provider: p, state: "idle", notices: [], prompt: null })),
      answer: rec("signin.answer", () => ({ ok: true })),
      cancel: rec("signin.cancel", async (p) => ({ provider: p, state: "cancelled", notices: [], prompt: null })),
    },
    getConfig: () => deps.config,
    gpu: {
      gpus: rec("gpu.gpus", async () => ({ status: 200, body: { ok: true, gpus: [] } })),
      models: rec("gpu.models", async () => ({ status: 200, body: { models: [{ id: "model-a", loaded: false, owner: "box" }] } })),
      switch: rec("gpu.switch", async () => ({ status: 202, body: { status: "switching" } })),
      unload: rec("gpu.unload", async () => ({ status: 200, body: { status: "unloading" } })),
    },
    engine: {
      spendReport: rec("engine.spend", async (o) => ({ ...o, totals: { usd: 0 }, caps: { action: "ok" } })),
      ledgerVerify: rec("engine.ledgerVerify", async (o) => ({ ok: true, ...o })),
      prices: rec("engine.prices", async (m) => ({ models: Object.fromEntries(m.map((x) => [x, { priced: true }])) })),
      cacheReport: rec("engine.cache", (s) => (s === "nope" ? null : s ? { sessionId: s, lastHit: 0.9 } : { latest: null, sessions: [] })),
    },
    legacy: {
      status: rec("legacy.status", async () => ({ signedIn: false, plan: { mode: "signed-out" } })),
    },
    forecast: { report: rec("forecast.report", () => ({ estimate: true, generatedAt: 1, spend: { complete: true } })) },
  };
  return deps;
}

async function withServer(fn, extra = {}) {
  const deps = makeDeps();
  let handler;
  const server = createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  handler = createRoutes({ allowedOrigins: ALLOWED, port, ...deps, ...extra });
  // GETs carry the hub header by default, as the UI and the CLI send it; hub: false sends a bare GET
  const call = (method, path, { headers = {}, body, host, hub = method === "GET" } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const h = { host: host ?? `127.0.0.1:${port}`, ...(hub ? { "x-dsh-model-hub": "1" } : {}), ...headers };
    if (data !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["content-type"] = "application/json";
    const req = request({ host: "127.0.0.1", port, method, path, headers: h, setHost: false }, (res) => {
      const ch = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => {
        const text = Buffer.concat(ch).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
  try { await fn({ call, deps, port }); } finally { await new Promise((r) => server.close(r)); }
}

const GET_PATHS = ["/healthz", "/hub/config", "/status", "/accounts", "/accounts/flows", "/accounts/signin/xai", "/gpu/config", "/gpu/gpus", "/gpu/models", "/rocco/gpus", "/rocco/models", "/spend", "/ledger/verify", "/prices?models=google/gemini-3.8-flash", "/cache", "/forecast", "/nope"];
const POST_PATHS = [
  ["/gpu/switch", { model: "model-a" }],
  ["/gpu/unload", {}],
  ["/rocco/switch", { model: "model-a" }],
  ["/rocco/unload", {}],
  ["/accounts/signin", { provider: "xai" }],
  ["/accounts/refresh", {}],
  ["/accounts/signin/xai/answer", { text: "x" }],
  ["/accounts/signin/xai/cancel", {}],
];
const HOSTILE = ["http://evil.example", "null", "http://127.0.0.1:3081", "https://127.0.0.1:3080", "http://127.0.0.1:3080.evil.example", "http://127.0.0.1:8185", "http://127.0.0.1:3080/"];

test("every GET: no Origin ok, allowed Origin ok + echoed, hostile Origin 403 with no CORS", async () => {
  await withServer(async ({ call, deps }) => {
    for (const p of GET_PATHS) {
      // sign-in GETs expose a pending flow's authorize URL: they need the UI's Origin + header like POSTs
      const gated = p.startsWith("/accounts/signin");
      const plain = await call("GET", p);
      if (gated) assert.equal(plain.status, 403, `${p} no origin must be refused`);
      else assert.notEqual(plain.status, 403, `${p} no origin`);
      const good = await call("GET", p, { headers: gated ? { origin: ALLOWED[0], "x-dsh-model-hub": "1" } : { origin: ALLOWED[0] } });
      assert.notEqual(good.status, 403, `${p} allowed origin`);
      assert.equal(good.headers["access-control-allow-origin"], ALLOWED[0]);
      for (const o of HOSTILE) {
        const before = deps.calls.length;
        const bad = await call("GET", p, { headers: { origin: o } });
        assert.equal(bad.status, 403, `${p} origin ${o}`);
        assert.equal(bad.headers["access-control-allow-origin"], undefined);
        assert.equal(deps.calls.length, before, `${p} must not reach a handler for ${o}`);
      }
    }
  });
});

test("every POST: hostile origin 403, missing origin 403, missing header 403, wrong header 403; none reach a handler", async () => {
  await withServer(async ({ call, deps }) => {
    for (const [p, body] of POST_PATHS) {
      for (const o of HOSTILE) {
        const r = await call("POST", p, { headers: { origin: o, "x-dsh-model-hub": "1" }, body });
        assert.equal(r.status, 403, `${p} hostile ${o}`);
        assert.equal(r.headers["access-control-allow-origin"], undefined);
      }
      assert.equal((await call("POST", p, { headers: { "x-dsh-model-hub": "1" }, body })).status, 403, `${p} missing origin`);
      assert.equal((await call("POST", p, { headers: { origin: ALLOWED[0] }, body })).status, 403, `${p} missing header`);
      assert.equal((await call("POST", p, { headers: { origin: ALLOWED[0], "x-dsh-model-hub": "0" }, body })).status, 403, `${p} header 0`);
      assert.equal((await call("POST", p, { headers: { origin: ALLOWED[0], "x-dsh-model-hub": "true" }, body })).status, 403, `${p} header true`);
    }
    assert.equal(deps.calls.length, 0, `no handler ran: ${JSON.stringify(deps.calls)}`);
  });
});

test("legacy header and /login /logout are gone", async () => {
  await withServer(async ({ call }) => {
    for (const p of ["/login", "/logout"]) {
      const viaLegacy = await call("POST", p, { headers: { origin: ALLOWED[0], "x-dsh-membership": "1" }, body: {} });
      assert.equal(viaLegacy.status, 403, `${p} legacy header`);
      const viaHub = await call("POST", p, { headers: { origin: ALLOWED[0], "x-dsh-model-hub": "1" }, body: {} });
      assert.equal(viaHub.status, 404, `${p} hub header`);
    }
  });
});

test("every POST succeeds with an allowed origin and the hub header", async () => {
  await withServer(async ({ call }) => {
    for (const [p, body] of POST_PATHS) {
      const r = await call("POST", p, { headers: { origin: ALLOWED[1], "x-dsh-model-hub": "1" }, body });
      assert.ok(r.status >= 200 && r.status < 300, `${p} -> ${r.status} ${r.text}`);
      assert.equal(r.headers["access-control-allow-origin"], ALLOWED[1]);
    }
  });
});

test("OPTIONS preflight: allowed origin 204, hostile 403, never wildcard", async () => {
  await withServer(async ({ call }) => {
    const ok = await call("OPTIONS", "/rocco/switch", { headers: { origin: ALLOWED[0] } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-origin"], ALLOWED[0]);
    assert.match(ok.headers["access-control-allow-headers"], /x-dsh-model-hub/);
    for (const o of HOSTILE) assert.equal((await call("OPTIONS", "/rocco/switch", { headers: { origin: o } })).status, 403);
    assert.equal((await call("OPTIONS", "/rocco/switch")).status, 403);
  });
});

test("Host header must be loopback on this port (DNS rebinding)", async () => {
  await withServer(async ({ call, deps }) => {
    for (const h of ["evil.example", "evil.example:8185", "127.0.0.1", "127.0.0.1:1", "attacker.test:8185"]) {
      const r = await call("GET", "/status", { host: h });
      assert.equal(r.status, 403, h);
    }
    assert.equal(deps.calls.length, 0);
  });
});

test("disallowed methods", async () => {
  await withServer(async ({ call }) => {
    for (const m of ["PUT", "DELETE", "PATCH"]) assert.equal((await call(m, "/status", { headers: { origin: ALLOWED[0], "x-dsh-model-hub": "1" } })).status, 405);
  });
});

test("gpu switch validation: model, gpus, content type, size; bad input never reaches the shim", async () => {
  await withServer(async ({ call, deps }) => {
    const h = { origin: ALLOWED[0], "x-dsh-model-hub": "1" };
    const post = (body, extra = {}) => call("POST", "/gpu/switch", { headers: { ...h, ...extra }, body });
    for (const body of [{}, { model: 5 }, { model: "a b" }, { model: "../x" }, { model: "-x" }, { model: "x".repeat(81) }, { model: "m", gpus: [] }, { model: "m", gpus: [64] }, { model: "m", gpus: [-1] }, { model: "m", gpus: [1, 1] }, { model: "m", gpus: ["1"] }, { model: "m", gpus: "2,3" }, { model: "m", gpus: [0, 1, 2, 3, 0] }]) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post("[]")).status, 400);
    assert.equal((await post(JSON.stringify({ model: "m" }), { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(JSON.stringify({ model: "m", pad: "x".repeat(20000) }))).status, 413);
    assert.equal(deps.calls.filter((c) => c[0] === "gpu.switch").length, 0);
    const ok = await post({ model: "model-a", gpus: [3, 2] });
    assert.equal(ok.status, 202);
    assert.deepEqual(deps.calls.find((c) => c[0] === "gpu.switch").slice(1), ["model-a", [2, 3], { force: false, auto: false }]);
    assert.equal((await post({ model: "model-a", gpus: [1], auto: true })).status, 400);
    const au = await post({ model: "model-a", auto: true, force: true });
    assert.equal(au.status, 202);
    assert.deepEqual(deps.calls.filter((c) => c[0] === "gpu.switch").at(-1).slice(1), ["model-a", undefined, { force: true, auto: true }]);
  });
});

test("spend / prices / cache query validation", async () => {
  await withServer(async ({ call, deps }) => {
    assert.equal((await call("GET", "/spend?since=yesterday")).status, 400);
    assert.equal((await call("GET", "/spend?by=../x")).status, 400);
    assert.equal((await call("GET", "/spend?since=7d&by=model")).status, 200);
    assert.deepEqual(deps.calls.find((c) => c[0] === "engine.spend")[1], { since: "7d", by: "model" });
    assert.equal((await call("GET", "/prices")).status, 400);
    assert.equal((await call("GET", `/prices?models=${encodeURIComponent("a;b")}`)).status, 400);
    assert.equal((await call("GET", `/prices?models=${Array.from({ length: 51 }, (_, i) => `p/m${i}`).join(",")}`)).status, 400);
    assert.equal((await call("GET", "/cache?session=bad%20id")).status, 400);
    assert.equal((await call("GET", "/cache?session=nope")).status, 404);
    assert.equal((await call("GET", "/cache?session=s1")).status, 200);
  });
});

test("sign-in routes: provider path is restricted; errors carry the signin status", async () => {
  await withServer(async ({ call, deps }) => {
    const ui = { headers: { origin: ALLOWED[0], "x-dsh-model-hub": "1" } };
    assert.equal((await call("GET", "/accounts/signin/..%2Fx", ui)).status, 404);
    assert.equal((await call("GET", "/accounts/signin/XAI", ui)).status, 404);
    assert.equal((await call("GET", "/accounts/signin/xai")).status, 403, "no Origin: the flow (auth URL) is not readable");
    assert.equal((await call("GET", "/accounts/signin/xai", { headers: { origin: ALLOWED[0] }, hub: false })).status, 403, "Origin without the hub header is refused");
    deps.signin.start = () => { const e = new Error("sign-in already in progress"); e.status = 409; throw e; };
    const r = await call("POST", "/accounts/signin", { headers: { origin: ALLOWED[0], "x-dsh-model-hub": "1" }, body: { provider: "xai" } });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /in progress/);
  });
});

test("internal errors never leak details", async () => {
  await withServer(async ({ call, deps }) => {
    deps.gpu.gpus = async () => { throw new Error("secret sk-abcdefghijklmnop path /Users/x"); };
    const r = await call("GET", "/rocco/gpus");
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: "internal error" });
  });
});

test("GET /forecast with the hub header returns the report and calls report once", async () => {
  await withServer(async ({ call, deps }) => {
    const r = await call("GET", "/forecast");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { estimate: true, generatedAt: 1, spend: { complete: true } });
    assert.equal(deps.calls.filter((c) => c[0] === "forecast.report").length, 1);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["access-control-allow-origin"], undefined, "no Origin sent: no CORS header");
  });
});

test("GET /forecast without the hub header is 403 and never calls report", async () => {
  await withServer(async ({ call, deps }) => {
    const r = await call("GET", "/forecast", { hub: false });
    assert.equal(r.status, 403);
    const withOrigin = await call("GET", "/forecast", { hub: false, headers: { origin: ALLOWED[0] } });
    assert.equal(withOrigin.status, 403);
    assert.equal(deps.calls.filter((c) => c[0] === "forecast.report").length, 0);
  });
});

test("GET /forecast answers 503 when no forecast dependency is wired", async () => {
  await withServer(async ({ call }) => {
    const r = await call("GET", "/forecast");
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: "forecast unavailable" });
  }, { forecast: null });
});

test("a forecast report that throws is a 500 \"internal error\" with no message leaked", async () => {
  await withServer(async ({ call }) => {
    const r = await call("GET", "/forecast");
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: "internal error" });
    assert.ok(!/secret|Users|sk-/.test(r.text));
  }, { forecast: { report: () => { throw new Error("secret sk-abcdefghijklmnop path /Users/x"); } } });
});

test("no response body anywhere contains token-like strings", async () => {
  await withServer(async ({ call }) => {
    const all = [];
    for (const p of GET_PATHS) all.push((await call("GET", p)).text);
    for (const [p, body] of POST_PATHS) all.push((await call("POST", p, { headers: { origin: ALLOWED[0], "x-dsh-model-hub": "1" }, body })).text);
    for (const t of all) assert.doesNotMatch(t, /sk-[A-Za-z0-9]|AIza|eyJ/);
  });
});

test("/gpu/* and /rocco/* error replies are always { error: string }; success bodies pass through", async () => {
  await withServer(async ({ call, deps }) => {
    deps.gpu.gpus = async () => ({ status: 502, body: { detail: { error: { message: "shim exploded" } } } });
    let r = await call("GET", "/rocco/gpus");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: "shim exploded" });
    deps.gpu.models = async () => ({ status: 409, body: { detail: { error: { reason: "lease" } } } });
    r = await call("GET", "/rocco/models");
    assert.equal(r.status, 409);
    assert.equal(typeof r.json.error, "string");
    assert.doesNotMatch(r.text, /object Object/);
    deps.gpu.unload = async () => ({ status: 502, body: { ok: false, error: "GPU server unreachable (timeout)" } });
    r = await call("POST", "/rocco/unload", { headers: { origin: ALLOWED[0], "x-dsh-model-hub": "1" }, body: {} });
    assert.deepEqual(r.json, { error: "GPU server unreachable (timeout)" });
    deps.gpu.gpus = async () => ({ status: 200, body: { ok: true, gpus: [1] } });
    assert.deepEqual((await call("GET", "/rocco/gpus")).json, { ok: true, gpus: [1] });
  });
});

test("POST /accounts/refresh forces a watchdog tick", async () => {
  await withServer(async ({ call, deps }) => {
    const r = await call("POST", "/accounts/refresh", { headers: { origin: ALLOWED[0], "x-dsh-model-hub": "1" }, body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(deps.calls.find((c) => c[0] === "accounts.tick").slice(1), [{ force: true }]);
  });
});

test("/gpu/config: configured shape, unconfigured shape, no URL leaked", async () => {
  await withServer(async ({ call, deps }) => {
    const ok = await call("GET", "/gpu/config");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { configured: true, id: "box", name: "Test Box", icon: "nvidia", hideModels: [], defaultModel: null });
    assert.ok(!ok.text.includes("127.0.0.1:1"));
    deps.config = { gpuServer: null, localProviders: [] };
    const off = await call("GET", "/gpu/config");
    assert.deepEqual(off.json, { configured: false });
  });
});

test("/rocco/* aliases behave identically to /gpu/*", async () => {
  await withServer(async ({ call, deps }) => {
    for (const leaf of ["gpus", "models"]) {
      const a = await call("GET", `/gpu/${leaf}`);
      const b = await call("GET", `/rocco/${leaf}`);
      assert.equal(a.status, 200);
      assert.deepEqual(b.json, a.json);
    }
    const H = { origin: ALLOWED[0], "x-dsh-model-hub": "1" };
    for (const [leaf, body] of [["switch", { model: "model-a", gpus: [1] }], ["unload", {}]]) {
      const a = await call("POST", `/gpu/${leaf}`, { headers: H, body });
      const b = await call("POST", `/rocco/${leaf}`, { headers: H, body });
      assert.equal(a.status, b.status);
      assert.deepEqual(b.json, a.json);
    }
    assert.equal((await call("POST", "/rocco/switch", { headers: H, body: { model: "bad model" } })).status, 400);
    assert.equal((await call("GET", "/rocco/config")).status, 404);
    assert.equal(deps.calls.filter((c) => c[0] === "gpu.switch").length, 2);
  });
});

test("unconfigured: GPU GETs -> 200 {ok:false,configured:false}; POSTs -> 409; the client is never called", async () => {
  await withServer(async ({ call, deps }) => {
    deps.config = { gpuServer: null, localProviders: [] };
    const H = { origin: ALLOWED[0], "x-dsh-model-hub": "1" };
    for (const p of ["/gpu/gpus", "/gpu/models", "/rocco/gpus", "/rocco/models"]) {
      const r = await call("GET", p);
      assert.equal(r.status, 200, p);
      assert.deepEqual(r.json, { ok: false, configured: false });
    }
    for (const p of ["/gpu/switch", "/gpu/unload", "/rocco/switch", "/rocco/unload"]) {
      const r = await call("POST", p, { headers: H, body: { model: "model-a" } });
      assert.equal(r.status, 409, p);
      assert.deepEqual(r.json, { error: "no GPU server configured", configured: false }, "the same configured:false field as the GETs");
    }
    assert.equal(deps.calls.filter((c) => c[0].startsWith("gpu.")).length, 0);
    // the Origin/CSRF rules still apply first
    assert.equal((await call("POST", "/gpu/switch", { headers: { "x-dsh-model-hub": "1" }, body: {} })).status, 403);
  });
});

test("the URL cannot be set through the API", async () => {
  await withServer(async ({ call, deps }) => {
    const H = { origin: ALLOWED[0], "x-dsh-model-hub": "1" };
    for (const p of ["/gpu/config", "/gpu/url", "/gpu/configure"]) {
      const r = await call("POST", p, { headers: H, body: { url: "http://evil.example" } });
      assert.equal(r.status, 404, p);
    }
    await call("POST", "/gpu/switch", { headers: H, body: { model: "model-a", url: "http://evil.example", base: "http://evil.example" } });
    assert.equal(deps.config.gpuServer.url, "http://127.0.0.1:1");
  });
});

test("/hub/config serves config.json priceModels and subscriptions (and nothing else)", async () => {
  await withServer(async ({ call, deps }) => {
    deps.config = { gpuServer: null, localProviders: [], priceModels: ["google/gemini-3.8-flash"], subscriptions: ["zai"], plans: { x: 1 } };
    const r = await call("GET", "/hub/config");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { priceModels: ["google/gemini-3.8-flash"], subscriptions: ["zai"] });
    deps.config = { gpuServer: null, localProviders: [] };
    assert.deepEqual((await call("GET", "/hub/config")).json, { priceModels: [], subscriptions: [] });
  });
});

test("/healthz and /status name the DSH web origin this hub serves (null until advertised)", async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call("GET", "/healthz")).json.webOrigin, null);
  });
  await withServer(async ({ call }) => {
    assert.equal((await call("GET", "/healthz")).json.webOrigin, "http://127.0.0.1:3311");
    const s = (await call("GET", "/status")).json;
    assert.equal(s.webOrigin, "http://127.0.0.1:3311");
    assert.equal(s.signedIn, false);
  }, { webOrigin: () => "http://127.0.0.1:3311" });
});

test("every POST needs Content-Type application/json and a JSON object body (an empty body is refused)", async () => {
  await withServer(async ({ call, deps }) => {
    const h = { origin: ALLOWED[0], "x-dsh-model-hub": "1" };
    const noBody = await call("POST", "/accounts/refresh", { headers: h });
    assert.equal(noBody.status, 415);
    const empty = await call("POST", "/accounts/refresh", { headers: { ...h, "content-type": "application/json" } });
    assert.equal(empty.status, 400);
    assert.ok(!deps.calls.some((c) => c[0] === "accounts.tick"), "nothing ran");
    assert.equal((await call("POST", "/accounts/refresh", { headers: h, body: {} })).status, 200);
  });
});

test("a GET without the hub header (what an <img> or <script> tag sends) is refused before any handler, except /healthz", async () => {
  await withServer(async ({ call, deps }) => {
    for (const p of GET_PATHS) {
      const before = deps.calls.length;
      const r = await call("GET", p, { hub: false });
      if (p === "/healthz") { assert.equal(r.status, 200); continue; }
      assert.equal(r.status, 403, p);
      assert.equal(deps.calls.length, before, `${p} must not reach a handler`);
    }
  });
});

test("/status reports how DSH's routes authenticate", async () => {
  await withServer(async ({ call }) => {
    const r = await call("GET", "/status");
    assert.deepEqual(r.json.routeAuth, { known: true, apiKeyRoutes: ["anthropic"] });
  }, { routeAuth: () => ({ known: true, apiKeyRoutes: ["anthropic"] }) });
});

test("/accounts adds identity to the provider it is known for, and a failing identity lookup never fails the list", async () => {
  const accounts = { state: () => ({ accounts: [{ provider: "anthropic", signedIn: true }, { provider: "xai", signedIn: true }] }), tick: async () => ({}) };
  await withServer(async ({ call }) => {
    const r = await call("GET", "/accounts");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.accounts.map((a) => a.identity ?? null), [{ email: "a@x.io", plan: "Pro" }, null]);
  }, { accounts, legacy: { status: async () => ({}), identities: async () => ({ anthropic: { email: "a@x.io", plan: "Pro" } }) } });
  await withServer(async ({ call }) => {
    const r = await call("GET", "/accounts");
    assert.equal(r.status, 200); assert.equal(r.json.accounts.length, 2);
  }, { accounts, legacy: { status: async () => ({}), identities: async () => { throw new Error("boom"); } } });
});

// ---- /caps -------------------------------------------------------------------------------------------------
const capsDeps = () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-caps-route-"));
  const caps = { view: () => capsLib.capsView(dir), set: (i) => capsLib.setCaps(dir, i), brief: () => { const v = capsLib.capsView(dir); return { problem: v.problem, fatal: v.fatal, stopAtPlanLimit: v.stopAtPlanLimit }; } };
  return { dir, caps, file: join(dir, "caps.json") };
};
const OWNER = "http://127.0.0.1:3080";
const postHdr = { origin: OWNER, "x-dsh-model-hub": "1" };

test("GET /caps needs the hub header and returns the view", async () => {
  const c = capsDeps();
  await withServer(async ({ call }) => {
    assert.equal((await call("GET", "/caps", { hub: false })).status, 403);
    const r = await call("GET", "/caps");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ["caps", "defaults", "exists", "fatal", "problem", "stopAtPlanLimit", "warnings"]);
    assert.equal(r.json.caps.dailyUsd, 40); assert.equal(r.json.problem, null);
  }, { caps: c.caps, webOrigin: () => OWNER });
  await withServer(async ({ call }) => { assert.equal((await call("GET", "/caps")).status, 503); });
});

test("POST /caps: hostile Origin, missing Origin, missing header, wrong header are 403 and write nothing", async () => {
  const c = capsDeps();
  await withServer(async ({ call }) => {
    const body = { set: { dailyUsd: 1 } };
    for (const o of HOSTILE) assert.equal((await call("POST", "/caps", { headers: { origin: o, "x-dsh-model-hub": "1" }, body })).status, 403, o);
    assert.equal((await call("POST", "/caps", { headers: { "x-dsh-model-hub": "1" }, body })).status, 403, "no origin");
    assert.equal((await call("POST", "/caps", { headers: { origin: OWNER }, body })).status, 403, "no header");
    assert.equal((await call("POST", "/caps", { headers: { origin: OWNER, "x-dsh-model-hub": "0" }, body })).status, 403, "wrong header");
    assert.equal(existsSync(c.file), false);
  }, { caps: c.caps, webOrigin: () => OWNER });
});

test("POST /caps: non-JSON 415, invalid JSON 400, array 400, empty 400, over 16 KB 413; nothing written", async () => {
  const c = capsDeps();
  await withServer(async ({ call }) => {
    const post = (body, extra = {}) => call("POST", "/caps", { headers: { ...postHdr, ...extra }, body });
    assert.equal((await post('{"set":{"dailyUsd":1}}', { "content-type": "text/plain" })).status, 415);
    assert.equal((await post("{nope")).status, 400);
    assert.equal((await post("[1]")).status, 400);
    assert.equal((await post("")).status, 400);
    assert.equal((await post(JSON.stringify({ set: { dailyUsd: 1 }, pad: "x".repeat(20000) }))).status, 413);
    assert.equal(existsSync(c.file), false);
  }, { caps: c.caps, webOrigin: () => OWNER });
});

test("POST /caps: a cross-instance page cannot change caps; unknown owner 409; the owner's localhost twin is accepted", async () => {
  const c = capsDeps();
  const body = { set: { dailyUsd: 3 } };
  await withServer(async ({ call }) => {
    const r = await call("POST", "/caps", { headers: postHdr, body });
    assert.equal(r.status, 403); assert.match(r.json.error, /3290/); assert.equal(existsSync(c.file), false);
  }, { caps: c.caps, webOrigin: () => "http://127.0.0.1:3290" });
  await withServer(async ({ call }) => {
    const r = await call("POST", "/caps", { headers: postHdr, body });
    assert.equal(r.status, 409); assert.equal(existsSync(c.file), false);
  }, { caps: c.caps, webOrigin: () => null });
  await withServer(async ({ call }) => {
    const r = await call("POST", "/caps", { headers: postHdr, body });
    assert.equal(r.status, 200); assert.equal(r.json.caps.dailyUsd, 3);
  }, { caps: c.caps, webOrigin: () => "http://localhost:3080" });
});

test("POST /caps validation: every error returned; __proto__, 1e999, extra keys and empty set are 400", async () => {
  const c = capsDeps();
  await withServer(async ({ call }) => {
    const post = (body) => call("POST", "/caps", { headers: postHdr, body });
    const r = await post({ set: { dailyUsd: -1, "provider.constructor": 1, foo: 1 } });
    assert.equal(r.status, 400); assert.equal(r.json.errors.length, 3);
    assert.equal((await post('{"set":{"__proto__":{"x":1}}}')).status, 400);
    assert.equal(Object.prototype.x, undefined); assert.equal(({}).x, undefined);
    assert.equal((await post('{"set":{"dailyUsd":1e999}}')).status, 400);
    assert.equal((await post({ set: { dailyUsd: 1 }, x: 1 })).status, 400);
    assert.equal((await post({ set: {} })).status, 400);
    assert.equal((await post({ set: [1] })).status, 400);
    assert.equal((await post({ dailyUsd: 1 })).status, 400);
    assert.equal(existsSync(c.file), false);
  }, { caps: c.caps, webOrigin: () => OWNER });
});

test("POST /caps success returns the new view and the next GET shows it; /status carries caps.problem", async () => {
  const c = capsDeps();
  await withServer(async ({ call }) => {
    const r = await call("POST", "/caps", { headers: postHdr, body: { set: { dailyUsd: 12, "provider.google": 4 } } });
    assert.equal(r.status, 200); assert.equal(r.headers["access-control-allow-origin"], OWNER);
    assert.deepEqual(r.json.caps.perProviderDailyUsd, { google: 4 });
    const g = await call("GET", "/caps");
    assert.equal(g.json.caps.dailyUsd, 12);
    assert.equal((await call("GET", "/status")).json.caps.problem, null);
    writeFileSync(c.file, "{nope");
    const st = (await call("GET", "/status")).json.caps;
    assert.equal(st.problem, "caps.json invalid: not valid JSON; using defaults"); assert.equal(st.fatal, true);
    assert.doesNotMatch(JSON.stringify(st), /hub-caps-route/, "no file path in /status");
  }, { caps: c.caps, webOrigin: () => OWNER });
});

test("GET and POST /caps never return the caps.json path (a page sees the limits, not the user's home directory)", async () => {
  const c = capsDeps();
  await withServer(async ({ call }) => {
    const g = await call("GET", "/caps");
    assert.equal(g.status, 200);
    assert.equal("file" in g.json, false);
    assert.doesNotMatch(JSON.stringify(g.json), /hub-caps-route/);
    const p = await call("POST", "/caps", { headers: postHdr, body: { set: { dailyUsd: 7 } } });
    assert.equal(p.status, 200);
    assert.equal(p.json.caps.dailyUsd, 7);
    assert.equal("file" in p.json, false);
    assert.doesNotMatch(JSON.stringify(p.json), /hub-caps-route/);
  }, { caps: c.caps, webOrigin: () => OWNER });
});

test("sameInstanceOrigin matches the client's sameInstance table but fails closed", () => {
  assert.ok(sameInstanceOrigin("http://127.0.0.1:3080", "http://localhost:3080"));
  assert.ok(sameInstanceOrigin("http://localhost:3080", "http://localhost:3080"));
  assert.ok(!sameInstanceOrigin("http://127.0.0.1:3080", "http://127.0.0.1:3290"));
  assert.ok(!sameInstanceOrigin("http://127.0.0.1:3080", "https://127.0.0.1:3080"));
  assert.ok(!sameInstanceOrigin("not a url", "http://127.0.0.1:3080"));
  assert.ok(!sameInstanceOrigin(undefined, "http://127.0.0.1:3080"));
  assert.ok(!sameInstanceOrigin("http://127.0.0.1:3080", null));
});

test("POST /caps {set:{stopAtPlanLimit}} works through the ownership check and /status caps.stopAtPlanLimit follows; a non-boolean is 400", async () => {
  const c = capsDeps();
  await withServer(async ({ call }) => {
    assert.equal((await call("GET", "/status")).json.caps.stopAtPlanLimit, false);
    const r = await call("POST", "/caps", { headers: postHdr, body: { set: { stopAtPlanLimit: true } } });
    assert.equal(r.status, 200); assert.equal(r.json.stopAtPlanLimit, true);
    assert.equal((await call("GET", "/status")).json.caps.stopAtPlanLimit, true);
    assert.equal((await call("GET", "/caps")).json.stopAtPlanLimit, true);
    const bad = await call("POST", "/caps", { headers: postHdr, body: { set: { stopAtPlanLimit: "true" } } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.errors.some((m) => m.includes("stopAtPlanLimit must be true or false")));
    const hostile = await call("POST", "/caps", { headers: { origin: "http://evil.example", "x-dsh-model-hub": "1" }, body: { set: { stopAtPlanLimit: false } } });
    assert.equal(hostile.status, 403);
    assert.equal((await call("GET", "/status")).json.caps.stopAtPlanLimit, true, "a hostile page did not turn it off");
    assert.equal((await call("POST", "/caps", { headers: postHdr, body: { set: { stopAtPlanLimit: false } } })).status, 200);
    assert.equal((await call("GET", "/status")).json.caps.stopAtPlanLimit, false);
  }, { caps: c.caps, webOrigin: () => OWNER });
});

test("/prices passes up to 50 ids to the engine (which prices each with its own route) and reports the host platform; origin and header checks still apply", async () => {
  await withServer(async ({ call, deps }) => {
    const ids = Array.from({ length: 50 }, (_, i) => `rocco-gateway/m${i}:cloud`);
    const r = await call("GET", `/prices?models=${encodeURIComponent(ids.join(","))}`, { headers: { origin: ALLOWED[0] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.hostPlatform, "linux");
    assert.equal(Object.keys(r.json.models).length, 50);
    assert.deepEqual(deps.calls.find((c) => c[0] === "engine.prices")[1], ids);
    assert.equal((await call("GET", "/prices?models=a/b", { hub: false })).status, 403, "no hub header");
    assert.equal((await call("GET", "/prices?models=a/b", { headers: { origin: "http://evil.example" } })).status, 403, "foreign origin");
  }, { platform: "linux" });
});
