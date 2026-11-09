import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "./dsh-hub.mjs";
import { yamlAvailable } from "../lib/accounts/accounts.mjs";

// integration tests that read a real credential file need DSH's own YAML parser
const NEEDS_DSH = yamlAvailable() ? false : "DeepSeek Harness not installed (needs its yaml); set DSH_NODE_MODULES to run";

const BIN = fileURLToPath(new URL("./dsh-hub.mjs", import.meta.url));

function env() {
  const dir = mkdtempSync(join(tmpdir(), "hub-cli-"));
  const creds = join(dir, "creds.yaml");
  writeFileSync(creds, `version: 1\nrecords:\n  llm-pi-ai/anthropic:\n    kind: grant\n    payload:\n      type: oauth\n      access: ACCESS-SECRET-VALUE\n      refresh: REFRESH-SECRET-VALUE\n      expires: ${Date.now() + 3600e3}\n`);
  chmodSync(creds, 0o600);
  return { dir, creds, env: { DSH_HUB_DATA_DIR: join(dir, "data"), DSH_HUB_CREDENTIALS: creds, DSH_HUB_URL: "http://hub.test" } };
}
function run(args, { fetch, gpu, e = env() } = {}) {
  const o = [], er = [];
  return main(args, { out: (s) => o.push(s), err: (s) => er.push(s), env: e.env, fetch, gpu }).then((code) => ({ code, out: o.join("\n"), err: er.join("\n"), e }));
}
const hubFetch = (routes) => async (url) => {
  const p = new URL(url).pathname + new URL(url).search;
  const r = routes[p] ?? routes[new URL(url).pathname];
  if (!r) throw new Error("ECONNREFUSED");
  return { status: r[0], json: async () => r[1] };
};
const gpuOk = {
  gpus: async () => ({ status: 200, body: { ok: true, manager: { active: true }, tier: 28, loaded_model: null, state_age_s: 3, stale: false, gpus: [{ index: 0, used_mib: 10, total_mib: 100, util_pct: 1, processes: [{ user: "u", cmd: "python" }], reserved_by: [] }], reservations: [{ owner: "x", gpus: "all", stale: true }] } }),
  switch: async (m, g) => ({ status: 202, body: { status: "switching", gpus: g } }),
  unload: async () => ({ status: 502, body: { error: "unload failed" } }),
  health: async () => ({ status: 200, body: { status: "ok" } }),
};

test("help / unknown / bad flags exit 2", async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["--help"])).code, 0);
  assert.equal((await run(["nope"])).code, 2);
  assert.equal((await run(["spend", "--bogus"])).code, 2);
  assert.equal((await run(["spend", "--since"])).code, 2);
  assert.equal((await run(["spend", "--since", "yesterday"])).code, 2);
});

test("accounts --json lists providers, never secrets", { skip: NEEDS_DSH }, async () => {
  const r = await run(["accounts", "--json"]);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.accounts.find((a) => a.provider === "anthropic").health, "ok");
  assert.doesNotMatch(r.out, /SECRET-VALUE/);
  const h = await run(["accounts"]);
  assert.match(h.out, /anthropic\s+ok/);
});

test("status: reachable -> 0, unreachable -> 1 with the data still printed", async () => {
  const f = hubFetch({ "/healthz": [200, { ok: true }], "/status": [200, { signedIn: true, plan: { mode: "plan" }, imageCap: true, compactionSlim: true, spendGuard: true }] });
  const r = await run(["status", "--json"], { fetch: f });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).hub.reachable, true);
  assert.match((await run(["status"], { fetch: f })).out, /spendGuard=true/);
  const d = await run(["status"], { fetch: hubFetch({}) });
  assert.equal(d.code, 3);
  assert.match(d.err, /not reachable/);
});

test("gpus / switch / unload go to the shim client", async () => {
  const g = await run(["gpus", "--json"], { gpu: gpuOk });
  assert.equal(JSON.parse(g.out).gpus.length, 1);
  assert.match((await run(["gpus"], { gpu: gpuOk })).out, /reservation x gpus=all \(stale\)/);
  const s = await run(["switch", "model-a", "--gpus", "3,2", "--json"], { gpu: gpuOk });
  assert.equal(s.code, 0);
  assert.deepEqual(JSON.parse(s.out).gpus, [2, 3]);
  assert.equal((await run(["switch", "model-a", "--gpus", "64"], { gpu: gpuOk })).code, 2);
  assert.equal((await run(["switch", "model-a", "--gpus", "1,1"], { gpu: gpuOk })).code, 2);
  assert.equal((await run(["switch", "bad model"], { gpu: gpuOk })).code, 2);
  assert.equal((await run(["switch"], { gpu: gpuOk })).code, 2);
  const u = await run(["unload", "--json"], { gpu: gpuOk });
  assert.equal(u.code, 1);
  assert.equal(JSON.parse(u.out).httpStatus, 502);
  const down = await run(["gpus"], { gpu: { gpus: async () => ({ status: 502, body: { ok: false, error: "x" } }) } });
  assert.equal(down.code, 1);
});

test("spend reads the ledger and caps; --by validated", async () => {
  const e = env();
  const { appendSpend } = await import("../lib/cost/index.mjs");
  appendSpend(e.env.DSH_HUB_DATA_DIR, { ts: new Date().toISOString(), sessionId: "s1", provider: "google", model: "gemini-3.8-flash", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, usd: 0.25, apiEquivUsd: 0.25, priceSource: "litellm", billing: "metered" });
  const r = await run(["spend", "--by", "model", "--json"], { e });
  const j = JSON.parse(r.out);
  assert.equal(j.totals.calls, 1);
  assert.equal(j.totals.usd, 0.25);
  assert.equal(j.by, "model");
  assert.equal(j.caps.limits.dailyUsd, 40);
  assert.match((await run(["spend"], { e })).out, /\$0\.2500 charged/);
});

test("prices: offline table lookups; unpriced -> exit 1; bare name flagged", async () => {
  const f = async () => { throw new Error("offline"); };
  const e = env();
  mkdirSync(e.env.DSH_HUB_DATA_DIR, { recursive: true });
  writeFileSync(join(e.env.DSH_HUB_DATA_DIR, "config.json"), JSON.stringify({ localProviders: ["box"] }));
  const r = await run(["prices", "box/model-a", "--json"], { fetch: f, e });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).models["box/model-a"].billing, "local");
  assert.equal((await run(["prices", "google/definitely-not-a-model"], { fetch: f })).code, 1);
  assert.equal((await run(["prices"], { fetch: f })).code, 2);
});

test("cache: sessions list and 404", async () => {
  const f = hubFetch({ "/cache": [200, { latest: null, sessions: [{ sessionId: "s1", lastHit: 0.9, avgHit: 0.8, steps: 3, provider: "p", model: "m" }] }], "/cache?session=zz": [404, { error: "unknown session" }] });
  assert.match((await run(["cache"], { fetch: f })).out, /s1\s+last 90%/);
  const z = await run(["cache", "--session", "zz"], { fetch: f });
  assert.equal(z.code, 1);
  assert.match(z.err, /unknown session/);
  assert.equal((await run(["cache"], { fetch: hubFetch({}) })).code, 3);
});

test("doctor: all good -> 0; hub down -> 1 with JSON checks", async () => {
  const f = hubFetch({ "/healthz": [200, {}], "/status": [200, { imageCap: true, compactionSlim: true, spendGuard: true }] });
  const lit = async (u) => { if (String(u).includes("hub.test")) return f(u); throw new Error("offline"); };
  const ok = await run(["doctor", "--json"], { fetch: lit, rocco: gpuOk });
  const j = JSON.parse(ok.out);
  assert.equal(j.checks.find((c) => c.name === "host API").level, "ok");
  assert.equal(j.checks.find((c) => c.name === "credentials file").level, "ok");
  const bad = await run(["doctor", "--json"], { fetch: hubFetch({}), rocco: gpuOk });
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.out).ok, false);
});

test("real process: runs via the bin entry, JSON on stdout, exit codes propagate", { skip: NEEDS_DSH }, () => {
  const e = env();
  const r = spawnSync(process.execPath, [BIN, "accounts", "--json"], { env: { ...process.env, ...e.env }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).accounts.length >= 1);
  const bad = spawnSync(process.execPath, [BIN, "nope"], { env: { ...process.env, ...e.env }, encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.ok(execFileSync);
});

test("switch: nested shim errors print the message (never [object Object]); --force and --auto pass through", async () => {
  const seen = [];
  const gpu = {
    switch: async (m, g, o) => { seen.push({ m, g, o }); return { status: 409, body: { error: { message: "lease held for 120 more seconds", type: "gpu_switch" } } }; },
  };
  const r = await run(["switch", "model-a"], { gpu });
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /lease held for 120 more seconds/);
  assert.doesNotMatch(r.out + r.err, /\[object Object\]/);
  await run(["switch", "model-a", "--force"], { gpu });
  await run(["switch", "model-a", "--auto"], { gpu });
  assert.equal(seen[1].o.force, true);
  assert.equal(seen[2].o.auto, true);
  assert.equal((await run(["switch", "model-a", "--auto", "--gpus", "2"], { gpu })).code, 2);
  const down = await run(["gpus"], { gpu: { gpus: async () => ({ status: 500, body: { error: { message: "nested boom" } } }) } });
  assert.match(down.out + down.err, /nested boom/);
});

test("no GPU server configured: gpus/switch/unload print one line and exit 2; doctor says not configured (OK)", async () => {
  for (const args of [["gpus"], ["switch", "model-a"], ["unload"]]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.err, "no GPU server configured (see README: GPU server)");
  }
  const f = hubFetch({ "/healthz": [200, {}], "/status": [200, { imageCap: true, compactionSlim: true, spendGuard: true }] });
  const lit = async (u) => { if (String(u).includes("hub.test")) return f(u); throw new Error("offline"); };
  const d = JSON.parse((await run(["doctor", "--json"], { fetch: lit })).out);
  assert.deepEqual(d.checks.find((c) => c.name === "GPU server"), { name: "GPU server", level: "ok", detail: "not configured" });
});

test("configured via config.json: CLI talks to the config URL and uses the configured name", async () => {
  const e = env();
  mkdirSync(e.env.DSH_HUB_DATA_DIR, { recursive: true });
  writeFileSync(join(e.env.DSH_HUB_DATA_DIR, "config.json"), JSON.stringify({ gpuServer: { id: "lab", name: "Lab box", url: "http://gpu.test:4010" } }));
  const seen = [];
  const f = async (u) => { seen.push(String(u)); return { status: 502, json: async () => ({ error: "boom" }) }; };
  const r = await run(["gpus"], { fetch: f, e });
  assert.equal(r.code, 1);
  assert.deepEqual(seen, ["http://gpu.test:4010/v1/gpus"]);
  assert.match(r.err, /^Lab box: HTTP 502/);
});

test("--json errors are JSON on stdout with the exit code", async () => {
  const e = env();
  const r = await run(["status", "--json"], { env: { ...e.env, DSH_HUB_URL: "http://127.0.0.1:1" }, fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(r.code, 3);
  const j = JSON.parse(r.out);
  assert.equal(j.code, 3);
  assert.match(j.error, /not reachable/);
  const bad = await run(["spend", "--since", "nonsense", "--json"], { env: e.env });
  assert.equal(bad.code, 2);
  assert.equal(JSON.parse(bad.out).code, 2);
});

test("--json: a refused switch/unload is {error, code, httpStatus} like every other failure; secrets redacted", async () => {
  const gpu = {
    switch: async () => ({ status: 409, body: { error: "lease held; token=abc123SECRET" } }),
    unload: async () => ({ status: 502, body: { detail: { error: { message: "unload failed Bearer xyz.secret" } } } }),
  };
  for (const [args, http] of [[["switch", "model-a", "--json"], 409], [["unload", "--json"], 502]]) {
    const r = await run(args, { gpu });
    assert.equal(r.code, 1);
    const j = JSON.parse(r.out);
    assert.equal(j.code, 1);
    assert.equal(j.httpStatus, http);
    assert.equal(typeof j.error, "string");
    assert.doesNotMatch(r.out, /abc123SECRET|xyz\.secret/);
  }
});

test("doctor --json: a failing run carries {error, code} and never prints a GPU server's secret", async () => {
  const gpu = {
    health: async () => ({ status: 200, body: {} }),
    gpus: async () => ({ status: 500, body: { error: "manager down token=SECRET123456 Bearer abc.xyz" } }),
  };
  const r = await run(["doctor", "--json"], { fetch: hubFetch({}), gpu });
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.equal(j.code, 1);
  assert.match(j.error, /check\(s\) failed/);
  assert.doesNotMatch(r.out, /SECRET123456|abc\.xyz/);
  const h = await run(["doctor"], { fetch: hubFetch({}), gpu });
  assert.doesNotMatch(h.out + h.err, /SECRET123456|abc\.xyz/);
});

test("CLI: argument-parser errors are redacted; every nonzero --json result carries error and code", async () => {
  const bad = await run(["status", "--sk-synthetic1234567890abcdef"]);
  assert.notEqual(bad.code, 0);
  assert.doesNotMatch(bad.out + bad.err, /sk-synthetic1234567890/);
  const badJ = await run(["status", "--json", "--sk-synthetic1234567890abcdef"]);
  assert.doesNotMatch(badJ.out + badJ.err, /sk-synthetic1234567890/);
  assert.equal(JSON.parse(badJ.out).code, badJ.code);

  const sick = hubFetch({ "/healthz": [503, { ok: false }], "/status": [200, { signedIn: false }] });
  const s = await run(["status", "--json"], { fetch: sick });
  assert.equal(s.code, 1);
  const sj = JSON.parse(s.out);
  assert.equal(sj.code, 1);
  assert.match(sj.error, /HTTP 503/);
  assert.equal(sj.hub.reachable, false, "the data is still there");

  const offline = async () => { throw new Error("offline"); };
  const p = await run(["prices", "acme/unknown-model-zz", "--json"], { fetch: offline });
  assert.equal(p.code, 1);
  const pj = JSON.parse(p.out);
  assert.equal(pj.code, 1);
  assert.match(pj.error, /no known price for acme\/unknown-model-zz/);
});

test("--json with no command is a JSON error too", async () => {
  const r = await run(["--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, 2);
});

test("the CLI sends the hub header on every GET, and a failing /status is a failing status", async () => {
  const strict = (routes) => async (url, init = {}) => {
    const p = new URL(url).pathname;
    if (p !== "/healthz" && (init.headers || {})["x-dsh-model-hub"] !== "1") return { status: 403, json: async () => ({ error: "missing x-dsh-model-hub header" }) };
    const r = routes[p];
    if (!r) throw new Error("ECONNREFUSED");
    return { status: r.status ?? 200, json: async () => r.body ?? {} };
  };
  const ok = await run(["status", "--json"], { fetch: strict({ "/healthz": { body: { ok: true } }, "/status": { body: { signedIn: true, plan: { mode: "subscription" }, spendGuard: true } } }) });
  assert.equal(ok.code, 0, ok.out + ok.err);
  const bad = await run(["status", "--json"], { fetch: strict({ "/healthz": { body: { ok: true } }, "/status": { status: 500, body: { error: "internal error" } } }) });
  assert.notEqual(bad.code, 0);
  assert.match(JSON.parse(bad.out).error, /\/status failed: HTTP 500/);
});

test("doctor talks to a header-checking host like the real one: every host check passes, none is a false 'not reachable'", async () => {
  const strict = async (url, init = {}) => {
    if (!String(url).includes("hub.test")) throw new Error("offline");
    const p = new URL(url).pathname;
    if (p !== "/healthz" && (init.headers || {})["x-dsh-model-hub"] !== "1") return { status: 403, json: async () => ({ error: "missing x-dsh-model-hub header" }) };
    const body = { "/healthz": { ok: true }, "/status": { imageCap: true, compactionSlim: true, spendGuard: true }, "/accounts": { accounts: [], reportOnly: false, credentialStore: { state: "live", replacedSinceStart: false } } }[p];
    if (!body) throw new Error("ECONNREFUSED");
    return { status: 200, json: async () => body };
  };
  const r = await run(["doctor", "--json"], { fetch: strict, rocco: gpuOk });
  const j = JSON.parse(r.out);
  const host = j.checks.filter((c) => c.name === "host API");
  assert.ok(host.length >= 1 && host.every((c) => c.level === "ok"), JSON.stringify(host));
  assert.equal(j.checks.find((c) => c.name === "credential store")?.level, "ok", "the /accounts read carries the header too");
});
