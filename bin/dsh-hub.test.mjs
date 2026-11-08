import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "./dsh-hub.mjs";

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

test("accounts --json lists providers, never secrets", async () => {
  const r = await run(["accounts", "--json"]);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.accounts.find((a) => a.provider === "anthropic").health, "ok");
  assert.doesNotMatch(r.out, /SECRET-VALUE/);
  const h = await run(["accounts"]);
  assert.match(h.out, /anthropic\s+ok/);
});

test("status: reachable -> 0, unreachable -> 1 with the data still printed", async () => {
  const f = hubFetch({ "/healthz": [200, { ok: true }], "/status": [200, { signedIn: true, plan: { mode: "plan" }, imageCap: true, compactionSlim: true, spendGuard: true, access: { full: true } }] });
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

test("real process: runs via the bin entry, JSON on stdout, exit codes propagate", () => {
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
