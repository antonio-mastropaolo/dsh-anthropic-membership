import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDemo } from "./write.mjs";
import { resolveDemo } from "./gate.mjs";
import { createDemoHub } from "./host.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const INDEX = join(HERE, "..", "index.js");
const AT = "2026-11-12T15:00:00Z";
const ORIGIN = "http://127.0.0.1:3080";
const tmp = () => mkdtempSync(join(tmpdir(), "demo-host-"));

/** base/{data,dsh,home} are "real" dirs holding canary files; base/demo is a sealed demo folder. */
function layout() {
  const base = tmp();
  const dirs = { data: join(base, "data"), dsh: join(base, "dsh"), home: join(base, "home") };
  for (const d of Object.values(dirs)) mkdirSync(d);
  for (const d of [".dsh", ".codex", ".claude"]) mkdirSync(join(dirs.home, d));
  const canaries = [
    join(dirs.data, "spend.jsonl"), join(dirs.data, "config.json"), join(dirs.dsh, ".credentials.yaml"),
    join(dirs.home, ".dsh", "settings.yaml"), join(dirs.home, ".codex", "auth.json"), join(dirs.home, ".claude", "credentials.json"),
  ];
  for (const c of canaries) writeFileSync(c, "canary\n");
  const env = { DSH_HUB_DATA_DIR: dirs.data, DSH_HOME: dirs.dsh, HOME: dirs.home };
  const w = writeDemo({ out: join(base, "demo"), at: AT, seed: 3, tzOffsetMin: 0, env, home: dirs.home });
  return { base, dirs, env, demoDir: w.out, canaries };
}

function treeHash(root) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) { out.push(`d ${p}`); walk(p); } else out.push(`f ${p} ${st.size} ${st.mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return createHash("sha256").update(out.join("\n")).digest("hex");
}

async function withDemoHub(fn) {
  const f = layout();
  const demo = resolveDemo({ ...f.env, DSH_HUB_DEMO: f.demoDir }, { home: f.dirs.home });
  assert.ok(demo, "layout demo folder must be accepted");
  let handler;
  const server = createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const hub = createDemoHub({ demo, allowedOrigins: [ORIGIN, "http://localhost:3080"], port });
  handler = hub.handler;
  await hub.replayed;
  const call = (method, path, { headers = {}, body, host, hub: h = method === "GET" } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const hd = { host: host ?? `127.0.0.1:${port}`, origin: ORIGIN, ...(h ? { "x-dsh-model-hub": "1" } : {}), ...headers };
    if (data !== undefined) hd["content-type"] = "application/json";
    const req = request({ host: "127.0.0.1", port, method, path, headers: hd, setHost: false }, (res) => {
      const ch = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => { const text = Buffer.concat(ch).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, text, json }); });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
  try { await fn({ call, f, demo, port, hub }); } finally { hub.stop(); await new Promise((r) => server.close(r)); }
}

test("the demo hub serves every panel's data from the folder", async () => {
  await withDemoHub(async ({ call }) => {
    const st = (await call("GET", "/status")).json;
    assert.equal(st.demo, true);
    assert.equal(st.spendGuard, false);
    assert.equal(st.plan.fiveHour.percent, 62);
    assert.equal(st.plan.sevenDay.percent, 41);
    assert.equal(st.identity.email, "demo@example.com");
    assert.equal(st.identity.org, "Demo Org");

    const ac = (await call("GET", "/accounts")).json;
    const health = Object.fromEntries(ac.accounts.map((a) => [a.provider, a]));
    assert.equal(health.anthropic.health, "ok");
    assert.equal(health.anthropic.identity.org, "Demo Org");
    assert.equal(health["openai-codex"].health, "expiring");
    assert.equal(health["github-copilot"].health, "refresh-failed");
    assert.equal(health["github-copilot"].terminal, true);
    assert.equal(ac.credentialStore.state, "none");
    assert.equal(ac.reportOnly, true);

    const today = (await call("GET", "/spend?since=today")).json;
    assert.equal(today.caps.action, "warn");
    const week = (await call("GET", "/spend?since=7d&by=model")).json;
    assert.ok(Object.keys(week.groups).length > 3 && week.totals.calls > 1000);
    const pr = (await call("GET", "/prices?models=google/gemini-3.8-flash,ollama/glm-5.3-flash")).json;
    assert.ok(pr.count > 0);
    const cache = (await call("GET", "/cache")).json;
    assert.ok(cache.latest, "the replay set a latest session");
    assert.ok(JSON.stringify(cache).includes("demo-s-cache"));
    assert.ok(Array.isArray((await call("GET", "/hub/config")).json.priceModels));

    assert.equal((await call("GET", "/gpu/config")).json.configured, true);
    const gpus = (await call("GET", "/gpu/gpus")).json;
    assert.equal(gpus.gpus.length, 4);
    assert.ok((await call("GET", "/gpu/models")).json.models.length >= 3);
    const before = gpus.loaded_model;
    const sw = await call("POST", "/gpu/switch", { headers: {}, hub: true, body: { model: "demo-llama-70b" } });
    assert.equal(sw.status, 200);
    const after = (await call("GET", "/gpu/gpus")).json;
    assert.notEqual(after.loaded_model, before);
    assert.equal(after.loaded_model, "demo-llama-70b");
  });
});

test("every GET path the client polls answers 2xx on the demo hub (no failed-resource console errors)", async () => {
  const src = readFileSync(join(HERE, "..", "client.js"), "utf8");
  const paths = new Set();
  for (const line of src.split("\n")) {
    if (!line.includes("usePoll(")) continue;
    for (const m of line.matchAll(/"(\/[^"]*)"/g)) {
      if (m[1].endsWith("/")) continue;
      // a path that ends in an id parameter is polled with an id: give it the demo conversation's
      if (/[?&](session|id)=$/.test(m[1])) paths.add(`${m[1]}demo-s-conv`);
      else paths.add(m[1].startsWith("/prices") ? `${m[1]}google/gemini-3.8-flash` : m[1]);
    }
  }
  assert.ok(paths.has("/accounts/flows") && paths.has("/status") && paths.size >= 9, [...paths].join(" "));
  assert.ok(paths.has("/spend/session?id=demo-s-conv"), [...paths].join(" ")); // the Cost tab's poll
  await withDemoHub(async ({ call }) => {
    for (const p of paths) {
      const r = await call("GET", p);
      assert.ok(r.status >= 200 && r.status < 300, `${p} -> ${r.status} ${r.text}`);
    }
    assert.deepEqual((await call("GET", "/accounts/flows")).json, { flows: [] });
  });
});

test("the demo hub never refreshes: DSH's credential seam is refused and the accounts stay report-only", async () => {
  await withDemoHub(async ({ call, hub }) => {
    const seam = { credentials: { modifyRecord: async () => {}, readRecord: async () => null } };
    assert.equal(hub.upgradeRefresher(seam), false);
    const ac = (await call("GET", "/accounts")).json;
    assert.equal(ac.reportOnly, true);
    assert.equal(ac.running, false);
    assert.equal(ac.credentialStore.state, "none");
    assert.equal(ac.demo, true);
  });
});

test("the demo host writes nothing and goes nowhere", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network is forbidden in demo mode"); };
  try {
    await withDemoHub(async ({ call, f }) => {
      const before = treeHash(f.base);
      for (const p of ["/status", "/accounts", "/spend?since=today", "/spend?since=7d&by=model", "/prices?models=google/gemini-3.8-flash", "/cache", "/hub/config", "/gpu/config", "/gpu/gpus", "/gpu/models"]) {
        assert.equal((await call("GET", p)).status, 200, p);
      }
      await call("POST", "/gpu/switch", { hub: true, body: { model: "demo-small-8b" } });
      await call("POST", "/gpu/unload", { hub: true, body: {} });
      await call("POST", "/accounts/refresh", { hub: true, body: {} });
      assert.equal((await call("POST", "/caps", { hub: true, body: { dailyUsd: 1 } })).status, 409);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(treeHash(f.base), before);
    });
  } finally { globalThis.fetch = realFetch; }
});

test("a hostile Origin is 403, a foreign Host is 403, a missing header is 403 against the demo hub", async () => {
  await withDemoHub(async ({ call }) => {
    assert.equal((await call("GET", "/status", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await call("GET", "/status", { headers: { origin: "null" } })).status, 403);
    assert.equal((await call("GET", "/status", { host: "evil.example" })).status, 403);
    assert.equal((await call("GET", "/status", { hub: false })).status, 403);
    assert.equal((await call("POST", "/gpu/unload", { headers: { origin: "https://evil.example" }, hub: true, body: {} })).status, 403);
    assert.equal((await call("POST", "/gpu/unload", { hub: false, body: {} })).status, 403);
  });
});

/** Run apply() from lib/index.js in a child with an fs recorder, a patched listen (port 0) and a refusing fetch. */
function runHost({ env, canaryDirs }) {
  const code = `
    import fs from "node:fs";
    import net from "node:net";
    import http from "node:http";
    import { syncBuiltinESMExports } from "node:module";
    const canary = ${JSON.stringify(canaryDirs)};
    const seen = [];
    const note = (p) => { const s = String(p); if (canary.some((c) => s === c || s.startsWith(c + "/"))) seen.push(s); };
    for (const k of ["readFileSync", "openSync", "readdirSync", "statSync", "lstatSync", "existsSync", "accessSync", "mkdirSync", "chmodSync", "writeFileSync", "renameSync", "appendFileSync"]) {
      const o = fs[k]; fs[k] = (p, ...a) => { note(p); return o(p, ...a); };
    }
    syncBuiltinESMExports();
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error("network forbidden"); };
    const listens = [];
    const servers = [];
    const origListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...a) { listens.push(a.slice(0, 2)); servers.push(this); return origListen.call(this, 0, "127.0.0.1"); };
    const injects = [], ons = [], logs = [], registered = [];
    const ctx = {
      logger: { warn: (m) => logs.push(String(m)) },
      inject: (deps, cb) => {
        injects.push(deps);
        if (deps.length === 1 && deps[0] === "webApp") cb({ webApp: { getAdvertisedUrl: () => "http://127.0.0.1:3080/" } });
        if (deps.length === 1 && deps[0] === "commands") cb({ commands: { register: (def) => { registered.push(def.name); } } });
      },
      on: (name, fn) => { ons.push(name); if (name === "dispose") ctx.dispose = fn; },
      get: () => undefined,
    };
    const m = await import(${JSON.stringify(INDEX)});
    m.apply(ctx);
    await new Promise((r) => { const s = servers[0]; if (s.listening) r(); else s.once("listening", r); });
    const port = servers[0].address().port;
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/status", headers: { host: "127.0.0.1:8185", origin: "http://127.0.0.1:3080", "x-dsh-model-hub": "1" }, setHost: false }, (res) => {
        const ch = []; res.on("data", (c) => ch.push(c)); res.on("end", () => resolve({ code: res.statusCode, body: JSON.parse(Buffer.concat(ch).toString("utf8")) }));
      });
      req.on("error", reject); req.end();
    });
    try { ctx.dispose?.(); } catch {}
    console.log("RESULT " + JSON.stringify({ seen, injects, ons, logs, listens, status, fetchCalls, registered }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { PATH: process.env.PATH, DSH_NODE_MODULES: join(tmpdir(), "no-such-nm"), ...env }, encoding: "utf8", timeout: 60_000 });
  const line = out.split("\n").reverse().find((l) => l.startsWith("RESULT "));
  assert.ok(line, `child printed no RESULT: ${out.slice(0, 400)}`);
  return JSON.parse(line.slice(7));
}
const childEnv = (f, extra = {}) => ({ ...f.env, ...extra });
// HOME itself is not a canary: lib/cost/prices.mjs probes ~/Library/Python and ~/.local/lib for a pip litellm price
// backup at import time (a read-only directory listing, unrelated to the data dir or any credential).
const dirsOf = (f) => [f.dirs.data, f.dirs.dsh, join(f.dirs.home, ".dsh"), join(f.dirs.home, ".codex"), join(f.dirs.home, ".claude")];

test("the real data dir is never opened, 8185 is never bound, and the ctx sees only webApp, commands and dispose", () => {
  const f = layout();
  const r = runHost({ env: childEnv(f, { DSH_HUB_DEMO: f.demoDir }), canaryDirs: dirsOf(f) });
  assert.deepEqual(r.seen, [], "no path inside a real dir was touched");
  assert.equal(r.status.body.demo, true);
  assert.equal(r.status.body.plan.fiveHour.percent, 62);
  assert.deepEqual(r.injects, [["webApp"], ["commands"]]);
  assert.deepEqual(r.registered, ["cost", "caps", "route", "receipt"], "the demo host registers the same four commands");
  assert.deepEqual(r.status.body.commands, { registered: ["cost", "caps", "route", "receipt"], collided: [] });
  assert.deepEqual(r.ons, ["dispose"]);
  assert.equal(r.fetchCalls, 0);
  assert.deepEqual(r.listens, [[8185, "127.0.0.1"]], "it asked for the fixed loopback port only (the child redirected it to 0)");
  assert.ok(r.logs.some((l) => /DEMO MODE ON/.test(l)));
  assert.equal(r.status.body.webOrigin, "http://127.0.0.1:3080");
});

test("a refused DSH_HUB_DEMO is logged and the host runs normally; a valid one logs DEMO MODE ON", () => {
  const f = layout();
  const marked = join(f.base, "marked-only");
  mkdirSync(marked);
  writeFileSync(join(marked, "DEMO"), "x\n");
  const tampered = join(f.base, "tampered");
  mkdirSync(tampered);
  for (const n of readdirSync(f.demoDir)) writeFileSync(join(tampered, n), readFileSync(join(f.demoDir, n)));
  writeFileSync(join(tampered, "spend.jsonl"), "{}\n");
  const cases = { relative: "relative/demo", markerOnly: marked, tampered, realDataDir: f.dirs.data };
  for (const [name, value] of Object.entries(cases)) {
    const r = runHost({ env: childEnv(f, { DSH_HUB_DEMO: value }), canaryDirs: [] });
    assert.ok(r.logs.some((l) => l.includes("DSH_HUB_DEMO ignored (")), `${name}: ${r.logs.join(" | ")}`);
    assert.ok(!r.logs.some((l) => /DEMO MODE ON/.test(l)), name);
    assert.equal(r.status.body.demo, false, name);
    assert.ok(r.injects.some((d) => d.includes("llm")), `${name}: the normal host ran`);
  }
  const ok = runHost({ env: childEnv(f, { DSH_HUB_DEMO: f.demoDir }), canaryDirs: [] });
  assert.ok(ok.logs.some((l) => /DEMO MODE ON/.test(l)));
  assert.ok(!ok.logs.some((l) => l.includes("DSH_HUB_DEMO ignored")));
});

test("demo mode cannot be entered by accident", () => {
  const f = layout();
  const normal = (r, name) => {
    assert.equal(r.status.body.demo, false, name);
    assert.ok(!r.logs.some((l) => /DEMO MODE ON/.test(l)), name);
    assert.ok(r.injects.some((d) => d.includes("llm")), name);
  };
  normal(runHost({ env: childEnv(f), canaryDirs: [] }), "unset");
  normal(runHost({ env: childEnv(f, { DSH_HUB_DEMO: "" }), canaryDirs: [] }), "empty");
  // a DEMO file dropped into the configured data dir does nothing without the env var
  for (const n of readdirSync(f.demoDir)) writeFileSync(join(f.dirs.data, n), readFileSync(join(f.demoDir, n)));
  normal(runHost({ env: childEnv(f), canaryDirs: [] }), "marker in data dir, no env");
  // and the env var pointing at that data dir is refused, with a log line
  const r = runHost({ env: childEnv(f, { DSH_HUB_DEMO: f.dirs.data }), canaryDirs: [] });
  normal(r, "env at the data dir");
  assert.ok(r.logs.some((l) => l.includes("DSH_HUB_DEMO ignored (")));
});

test("source scan: the demo host imports no node:net/dgram and listens only on 127.0.0.1", () => {
  const src = readFileSync(join(HERE, "host.mjs"), "utf8");
  assert.doesNotMatch(src, /node:net|node:dgram|child_process|fetch\(/);
  const listens = src.match(/\.listen\(/g) || [];
  assert.equal(listens.length, 1);
  assert.match(src, /\.listen\(port, "127\.0\.0\.1"\)/);
  for (const reg of [/"llm\/stream"/, /"session\/event"/, /"tools\/pre-execute"/, /inject\(\[(?!"webApp"|"commands")/]) assert.doesNotMatch(src, reg);
});
