import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "./dsh-hub.mjs";
import { _resetLedgerCache, appendSpend } from "../lib/cost/ledger.mjs";
import { yamlAvailable } from "../lib/accounts/accounts.mjs";
import { loadPriceTable } from "../lib/cost/prices.mjs";

// A fresh price cache in the data dir, built by the real loader from a synthetic LiteLLM table: doctor's price check then never
// depends on the network or on a LiteLLM install that happens to exist on the machine running the tests (CI has none).
const PRICE_RAW = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`gemini/test-model-${i}`, { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, litellm_provider: "gemini", mode: "chat" }]));
const seedPrices = (dataDir) => loadPriceTable({ dataDir, fetchImpl: async () => ({ ok: true, status: 200, json: async () => PRICE_RAW }), fallbackPath: null });

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
function run(args, { fetch, gpu, e = env(), now } = {}) {
  const o = [], er = [];
  return main(args, { out: (s) => o.push(s), err: (s) => er.push(s), env: e.env, fetch, gpu, ...(now ? { now: () => now } : {}) }).then((code) => ({ code, out: o.join("\n"), err: er.join("\n"), e }));
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

test("status shows the plan windows and the extra-usage state", async () => {
  const win = (percent) => ({ percent, resetsAt: "2026-09-17T14:00:00.000Z" });
  const mk = (plan) => hubFetch({ "/healthz": [200, { ok: true }], "/status": [200, { signedIn: true, plan, imageCap: true, compactionSlim: true, spendGuard: true }] });
  const full = (await run(["status"], { fetch: mk({ mode: "plan", fiveHour: win(12), sevenDay: win(84), sevenDayOpus: win(100), sevenDaySonnet: win(7), scopedWeekly: { ...win(26), label: "Sonnet only" }, extraKnown: true, extraEnabled: true }) })).out;
  assert.match(full, /^window 5h {1,}12% used, resets \S/m);
  assert.match(full, /^window weekly {1,}84% used, resets \S/m);
  assert.match(full, /^window weekly opus {1,}100% used/m);
  assert.match(full, /^window weekly sonnet {1,}7% used/m);
  assert.match(full, /^window Sonnet only {1,}26% used/m);
  assert.match(full, /^extra usage {1,}on$/m);
  assert.match((await run(["status"], { fetch: mk({ mode: "plan", fiveHour: win(1), extraKnown: true, extraEnabled: false }) })).out, /^extra usage {1,}off$/m);
  const unk = (await run(["status"], { fetch: mk({ mode: "plan", fiveHour: win(1), extraKnown: false, extraEnabled: false }) })).out;
  assert.match(unk, /^extra usage {1,}not reported$/m);
  assert.doesNotMatch(unk, /weekly/);
  const none = (await run(["status"], { fetch: mk({ mode: "signed-out" }) })).out;
  assert.doesNotMatch(none, /extra usage|^window 5h/m);
  const j = JSON.parse((await run(["status", "--json"], { fetch: mk({ mode: "plan", sevenDayOpus: win(5), extraKnown: true }) })).out);
  assert.equal(j.plan.sevenDayOpus.percent, 5);
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
  const refused = hubFetch({}); // no host: spend would otherwise try the real network
  const r = await run(["spend", "--by", "model", "--json"], { e, fetch: refused });
  const j = JSON.parse(r.out);
  assert.equal(j.totals.calls, 1);
  assert.equal(j.totals.usd, 0.25);
  assert.equal(j.by, "model");
  assert.equal(j.caps.limits.dailyUsd, 40);
  assert.match((await run(["spend"], { e, fetch: refused })).out, /\$0\.2500 charged/);
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

test("prices: billing follows the host's route auth; without the host nothing is assumed subscription", { skip: NEEDS_DSH }, async () => {
  const withHost = (routeAuth) => async (url, init = {}) => {
    const u = String(url);
    if (!u.includes("hub.test")) throw new Error("offline");
    if (new URL(u).pathname === "/status" && (init.headers || {})["x-dsh-model-hub"] === "1") return { status: 200, json: async () => ({ routeAuth }) };
    throw new Error("ECONNREFUSED");
  };
  const billing = async (fetch) => JSON.parse((await run(["prices", "anthropic/claude-opus-5-5", "--json"], { fetch })).out).models["anthropic/claude-opus-5-5"].billing;
  assert.equal(await billing(withHost({ known: true, apiKeyRoutes: [] })), "subscription", "OAuth grant, OAuth route");
  assert.equal(await billing(withHost({ known: true, apiKeyRoutes: ["anthropic"] })), "metered", "the route sends an API key");
  assert.equal(await billing(async () => { throw new Error("ECONNREFUSED"); }), "metered", "host not reachable");
});

test("doctor fails when the spend ledger cannot be read, whatever the data dir's mode bits say", async () => {
  const e = env();
  const dataDir = e.env.DSH_HUB_DATA_DIR;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  writeFileSync(join(dataDir, "spend.jsonl"), JSON.stringify({ ts: new Date().toISOString(), sessionId: "s", provider: "google", model: "m", usd: 5, billing: "metered" }) + "\n");
  chmodSync(join(dataDir, "spend.jsonl"), 0o000);
  try {
    const f = hubFetch({ "/healthz": [200, {}], "/status": [200, { imageCap: true, compactionSlim: true, spendGuard: true }] });
    const r = await run(["doctor", "--json"], { fetch: f, rocco: gpuOk, e });
    const j = JSON.parse(r.out);
    assert.equal(r.code, 1);
    assert.equal(j.checks.find((c) => c.name === "spend ledger")?.level, "fail");
  } finally { chmodSync(join(dataDir, "spend.jsonl"), 0o600); }
});

test("a token in DSH_HUB_URL never reaches doctor or status output (JSON or human)", async () => {
  const e = env();
  e.env.DSH_HUB_URL = "http://hub.test/?token=DEMO-SECRET-12345678";
  const down = async () => { throw new Error("ECONNREFUSED"); };
  for (const args of [["doctor", "--json"], ["doctor"], ["status", "--json"], ["status"]]) {
    const r = await run(args, { fetch: down, rocco: gpuOk, e });
    assert.ok(!/DEMO-SECRET/.test(r.out + r.err), `${args.join(" ")}: ${r.out}${r.err}`);
  }
  const up = async (url, init = {}) => {
    const p = new URL(url).pathname;
    if (p !== "/healthz" && (init.headers || {})["x-dsh-model-hub"] !== "1") return { status: 403, json: async () => ({}) };
    return { status: 200, json: async () => (p === "/status" ? { signedIn: false, plan: { mode: "signed-out" } } : { ok: true }) };
  };
  const s = await run(["status", "--json"], { fetch: up, e });
  assert.ok(!/DEMO-SECRET/.test(s.out), s.out);
  assert.match(JSON.parse(s.out).hub.url, /\[redacted\]/);
});

test("status shows DSH's own message and model-call counts when the host has them", async () => {
  const f = async (url, init = {}) => {
    const p = new URL(url).pathname;
    if (p !== "/healthz" && (init.headers || {})["x-dsh-model-hub"] !== "1") return { status: 403, json: async () => ({}) };
    return { status: 200, json: async () => (p === "/status" ? { signedIn: true, plan: { mode: "plan", messages: 13, modelCalls: 29 }, imageCap: true, compactionSlim: true, spendGuard: true } : { ok: true }) };
  };
  assert.match((await run(["status"], { fetch: f })).out, /13 messages · 29 model calls sent from DSH/);
});

test("prices ollama/<model> shows the Ollama rate, off-peak rate, source and date; unknown model exits 1", async () => {
  const offline = async () => { throw new Error("ECONNREFUSED"); };
  const r = await run(["prices", "ollama/deepseek-v4.1-flash", "ollama/gemma4:31b-cloud"], { fetch: offline });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ollama table: snapshot, dated 2026-11-09, 22 models/);
  assert.match(r.out, /ollama\/deepseek-v4\.1-flash {2}metered\/ollama-snapshot/);
  assert.match(r.out, /peak in \$0\.3\/M out \$1\.2\/M cache \$0\.006\/M; off-peak in \$0\.15\/M out \$0\.6\/M/);
  assert.match(r.out, /ollama\/gemma4:31b-cloud {2}metered\/ollama-snapshot {2}in \$0\.14\/M/);
  const u = await run(["prices", "ollama/no-such-model", "--json"], { fetch: offline });
  assert.equal(u.code, 1);
  assert.equal(JSON.parse(u.out).models["ollama/no-such-model"].priced, false);
});

test("plans prints used / remaining / cycle per configured plan, --json too; none configured says how", async () => {
  const e = env();
  const none = await run(["plans"], { e });
  assert.equal(none.code, 0); assert.match(none.out, /no plans configured/);
  mkdirSync(join(e.dir, "data"), { recursive: true });
  writeFileSync(join(e.dir, "data", "config.json"), JSON.stringify({ plans: { ollama: { name: "Pro", includedUsd: 60, resetsOnDay: 9 } } }));
  const r = await run(["plans"], { e });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ollama\s+Pro {2}\$0\.00 of \$60\.00 used {2}remaining \$60\.00 {2}cycle \d{4}-\d\d-\d\d -> resets \d{4}-\d\d-\d\d/);
  const j = JSON.parse((await run(["plans", "--json"], { e })).out);
  assert.equal(j.plans[0].provider, "ollama"); assert.equal(j.plans[0].includedUsd, 60); assert.equal(j.plans[0].remainingUsd, 60);
});

test("prices marks a provider declared as subscription in config.json", async () => {
  const e = env();
  mkdirSync(join(e.dir, "data"), { recursive: true });
  writeFileSync(join(e.dir, "data", "config.json"), JSON.stringify({ subscriptions: ["acme"] }));
  const r = await run(["prices", "acme/m1"], { e, fetch: async () => { throw new Error("x"); } });
  assert.match(r.out, /acme\/m1 {2}subscription\/subscription \(declared in config\.json\)/);
});

// ---- caps ---------------------------------------------------------------------------------------------------
const down = async () => { throw new Error("ECONNREFUSED"); };
const spendRow = (usd, sessionId = "s1") => ({ ts: new Date().toISOString(), sessionId, provider: "google", model: "gemini-3.8-flash", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd, apiEquivUsd: usd, priceSource: "litellm", billing: "metered" });
const capsFile = (e) => join(e.env.DSH_HUB_DATA_DIR, "caps.json");

test("caps shows defaults, the file and today's status; --json has file/caps/status.perCap", async () => {
  const e = env();
  const h = await run(["caps"], { e, fetch: down });
  assert.equal(h.code, 0);
  assert.match(h.out, /daily\s+\$40\.00/); assert.match(h.out, /session\s+\$15\.00/); assert.match(h.out, /warnPct\s+50/);
  assert.match(h.out, /not created yet: defaults in effect/); assert.ok(h.out.includes(capsFile(e)));
  const j = JSON.parse((await run(["caps", "--json"], { e, fetch: down })).out);
  assert.equal(j.file, capsFile(e)); assert.equal(j.caps.dailyUsd, 40); assert.equal(j.problem, null);
  assert.ok(Array.isArray(j.status.perCap) && j.status.perCap.some((c) => c.which === "daily" && c.capUsd === 40));
  assert.equal(j.status.action, "ok");
});

test("caps set round-trips and works with no host; off removes a provider cap", async () => {
  const e = env();
  const r = await run(["caps", "set", "dailyUsd=40", "sessionUsd=15", "warnPct=50", "provider.google=5"], { e, fetch: down });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse((await run(["caps", "--json"], { e, fetch: down })).out);
  assert.deepEqual(j.caps.perProviderDailyUsd, { google: 5 }); assert.equal(j.exists, true);
  assert.equal(statSync(capsFile(e)).mode & 0o777, 0o600);
  assert.match((await run(["caps"], { e, fetch: down })).out, /provider google\s+\$5\.00/);
  assert.equal((await run(["caps", "set", "provider.google=off"], { e, fetch: down })).code, 0);
  assert.deepEqual(JSON.parse((await run(["caps", "--json"], { e, fetch: down })).out).caps.perProviderDailyUsd, {});
  const s = await run(["caps", "set", "sessionUsd=off", "--json"], { e, fetch: down });
  assert.equal(JSON.parse(s.out).caps.sessionUsd, 0);
});

test("caps set rejects bad input with exit 2 and the file untouched", async () => {
  const e = env();
  await run(["caps", "set", "dailyUsd=7"], { e, fetch: down });
  const before = readFileSync(capsFile(e), "utf8");
  for (const bad of [["dailyUsd=-1"], ["dailyUsd=abc"], ["warnPct=100"], ["warnPct=0"], ["provider.Bad=1"], ["provider.constructor=1"], ["foo=1"], ["__proto__=1"], ["dailyUsd"], ["dailyUsd=1e3"], ["dailyUsd=1", "dailyUsd=2"], []]) {
    const r = await run(["caps", "set", ...bad], { e, fetch: down });
    assert.equal(r.code, 2, bad.join(" "));
    assert.equal(readFileSync(capsFile(e), "utf8"), before, bad.join(" "));
  }
  assert.equal((await run(["caps", "--check", "set", "dailyUsd=1"], { e, fetch: down })).code, 2);
  assert.equal((await run(["caps", "extra"], { e, fetch: down })).code, 2);
  const j = JSON.parse((await run(["caps", "set", "dailyUsd=-1", "--json"], { e, fetch: down })).out);
  assert.equal(j.code, 2); assert.match(j.error, /dailyUsd/);
  assert.equal(readFileSync(capsFile(e), "utf8"), before);
});

test("caps --check exit codes: 0 ok, 10 at warnPct, 11 cap reached, 1 ledger unreadable", async () => {
  const e = env();
  const dir = e.env.DSH_HUB_DATA_DIR;
  const { appendSpend } = await import("../lib/cost/index.mjs");
  await run(["caps", "set", "sessionUsd=off", "dailyUsd=40"], { e, fetch: down });
  appendSpend(dir, spendRow(1));
  const ok = await run(["caps", "--check", "--json"], { e, fetch: down });
  assert.equal(ok.code, 0); assert.equal(JSON.parse(ok.out).status.action, "ok");
  appendSpend(dir, spendRow(24, "s2"));
  const warn = await run(["caps", "--check", "--json"], { e, fetch: down });
  assert.equal(warn.code, 10); const w = JSON.parse(warn.out); assert.equal(w.code, 10); assert.ok(w.error); assert.equal(w.status.action, "warn");
  appendSpend(dir, spendRow(20, "s3"));
  const blocked = await run(["caps", "--check", "--json"], { e, fetch: down });
  assert.equal(blocked.code, 11); assert.equal(JSON.parse(blocked.out).code, 11);
  const human = await run(["caps", "--check"], { e, fetch: down });
  assert.equal(human.code, 11); assert.match(human.err, /cap is reached/);
  assert.equal((await run(["caps"], { e, fetch: down })).code, 0, "without --check the status never changes the exit code");
  chmodSync(join(dir, "spend.jsonl"), 0o000);
  _resetLedgerCache(); // a CLI run is a fresh process; here the in-process row cache would hide the unreadable file
  try {
    const u = await run(["caps", "--check", "--json"], { e, fetch: down });
    assert.equal(u.code, 1); assert.equal(JSON.parse(u.out).code, 1);
  } finally { chmodSync(join(dir, "spend.jsonl"), 0o600); }
});

test("caps and doctor name a corrupt caps.json; a field-level problem is a doctor warn", async () => {
  const e = env();
  mkdirSync(e.env.DSH_HUB_DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(capsFile(e), "{nope");
  const c = await run(["caps"], { e, fetch: down });
  assert.equal(c.code, 0); assert.match(c.out, /!! caps\.json invalid: not valid JSON; using defaults/);
  const f = hubFetch({ "/healthz": [200, {}], "/status": [200, { imageCap: true, compactionSlim: true, spendGuard: true }] });
  const d = await run(["doctor", "--json"], { e, fetch: f, rocco: gpuOk });
  const chk = JSON.parse(d.out).checks.find((x) => x.name === "caps");
  assert.equal(chk.level, "fail"); assert.match(chk.detail, /not valid JSON/); assert.equal(d.code, 1);
  writeFileSync(capsFile(e), JSON.stringify({ dailyUsd: "lots" }));
  const d2 = JSON.parse((await run(["doctor", "--json"], { e, fetch: f, rocco: gpuOk })).out).checks.find((x) => x.name === "caps");
  assert.equal(d2.level, "warn"); assert.match(d2.detail, /dailyUsd must be a number/);
});

test("caps --check exits 1 when the whole caps.json is ignored (corrupt), 0 once repaired; a reached cap still wins with 11", async () => {
  const e = env();
  const dir = e.env.DSH_HUB_DATA_DIR;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(capsFile(e), "{bad");
  const h = await run(["caps", "--check"], { e, fetch: down });
  assert.equal(h.code, 1); assert.match(h.err, /caps\.json invalid/); assert.match(h.out, /!! caps\.json invalid: not valid JSON; using defaults/);
  const j = await run(["caps", "--check", "--json"], { e, fetch: down });
  assert.equal(j.code, 1); const jb = JSON.parse(j.out); assert.equal(jb.code, 1); assert.equal(jb.fatal, true); assert.match(jb.error, /caps\.json invalid/);
  assert.equal((await run(["caps"], { e, fetch: down })).code, 0, "without --check the problem never changes the exit code");
  const { appendSpend } = await import("../lib/cost/index.mjs");
  appendSpend(dir, spendRow(41, "s9"));
  assert.equal((await run(["caps", "--check"], { e, fetch: down })).code, 11, "a reached cap (defaults) is the more severe result");
  writeFileSync(capsFile(e), JSON.stringify({ dailyUsd: 400, sessionUsd: 400 }));
  assert.equal((await run(["caps", "--check"], { e, fetch: down })).code, 0, "a valid file: ok");
});

test("caps set repairs a corrupt file and says so; status shows the caps line", async () => {
  const e = env();
  mkdirSync(e.env.DSH_HUB_DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(capsFile(e), "{nope");
  const r = await run(["caps", "set", "dailyUsd=9", "--json"], { e, fetch: down });
  assert.equal(r.code, 0); const j = JSON.parse(r.out);
  assert.equal(j.replaced, "not valid JSON"); assert.equal(j.problem, null);
  assert.equal(readFileSync(`${capsFile(e)}.broken`, "utf8"), "{nope");
  writeFileSync(capsFile(e), "{nope");
  const h = await run(["caps", "set", "dailyUsd=9"], { e, fetch: down });
  assert.match(h.out, /replaced an invalid caps\.json \(kept as caps\.json\.broken\)/);
  const f = hubFetch({ "/healthz": [200, { ok: true }], "/status": [200, { signedIn: true, plan: { mode: "plan" }, imageCap: true, compactionSlim: true, spendGuard: true, caps: { problem: "caps.json invalid: not valid JSON; using defaults", fatal: true } }] });
  assert.match((await run(["status"], { fetch: f })).out, /caps\s+caps\.json invalid: not valid JSON/);
});

test("caps set stopAtPlanLimit=on|off is shown by caps, status and doctor; =maybe exits 2 with the file untouched", async () => {
  const e = env();
  const off = await run(["caps"], { e, fetch: down });
  assert.match(off.out, /^plan stop {2,}off \(Claude subscription requests are not refused at 100% of a plan window\)$/m);
  const on = await run(["caps", "set", "stopAtPlanLimit=on"], { e, fetch: down });
  assert.equal(on.code, 0);
  assert.match(on.out, /^plan stop {2,}on \(Claude subscription requests are refused at 100% of a plan window\)$/m);
  assert.equal(JSON.parse(readFileSync(capsFile(e), "utf8")).stopAtPlanLimit, true);
  const j = JSON.parse((await run(["caps", "--json"], { e, fetch: down })).out);
  assert.equal(j.stopAtPlanLimit, true);
  assert.match((await run(["caps"], { e, fetch: down })).out, /^plan stop {2,}on /m);
  const f = (stop) => hubFetch({ "/healthz": [200, { ok: true }], "/status": [200, { signedIn: true, plan: { mode: "plan" }, imageCap: true, compactionSlim: true, spendGuard: true, caps: { problem: null, fatal: false, stopAtPlanLimit: stop } }] });
  assert.match((await run(["status"], { e, fetch: f(true) })).out, /^plan stop {2,}on$/m);
  assert.match((await run(["status"], { e, fetch: f(false) })).out, /^plan stop {2,}off$/m);
  const chk = JSON.parse((await run(["doctor", "--json"], { e, fetch: f(true), rocco: gpuOk })).out).checks.find((x) => x.name === "plan stop");
  assert.equal(chk.level, "ok"); assert.match(chk.detail, /^on\b/);
  const before = readFileSync(capsFile(e), "utf8");
  const bad = await run(["caps", "set", "stopAtPlanLimit=maybe"], { e, fetch: down });
  assert.equal(bad.code, 2); assert.match(bad.err, /stopAtPlanLimit must be true or false/);
  assert.equal((await run(["caps", "set", "stopAtPlanLimit=1"], { e, fetch: down })).code, 2);
  assert.equal(readFileSync(capsFile(e), "utf8"), before);
  assert.equal((await run(["caps", "set", "stopAtPlanLimit=off"], { e, fetch: down })).code, 0);
  assert.match((await run(["caps"], { e, fetch: down })).out, /^plan stop {2,}off /m);
});

// ---- dsh-hub forecast: estimates from the data dir, DSH stopped ----
const FC_NOW = new Date(2026, 10, 12, 14, 0).getTime(); // local clock: the expected times below do not depend on the time zone
const fcRow = (e, minAgo, o = {}) => appendSpend(join(e.dir, "data"), { ts: new Date(FC_NOW - minAgo * 60e3).toISOString(), sessionId: "s1", provider: "openai", model: "m", usd: 0.02, apiEquivUsd: 0.02, billing: "metered", priceSource: "litellm", ...o });
const fcSteady = (e, minutes, o = {}) => { for (let i = 0; i < minutes; i++) fcRow(e, i + 0.5, o); };
const noFetch = () => { throw new Error("fetch must not be called: forecast works with DSH stopped"); };

test("forecast --json works with DSH stopped, from the data dir (fetch is never called)", async () => {
  _resetLedgerCache();
  const e = env();
  fcSteady(e, 30);
  let fetches = 0;
  const r = await run(["forecast", "--json"], { e, now: FC_NOW, fetch: (...a) => { fetches++; return noFetch(...a); } });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.estimate, true);
  assert.equal(j.spend.estimate, true);
  assert.equal(j.spend.charged.status, "ok");
  assert.equal(j.spend.minCalls, 3);
  assert.deepEqual(j.spend.windowsMin, [15, 60]);
  assert.equal(fetches, 0);
  assert.doesNotMatch(r.out, /ACCESS-SECRET|REFRESH-SECRET|\/Users\//);
});

test("forecast human output: pace line, today projection, one line per cap, API value label, plan", async () => {
  _resetLedgerCache();
  const e = env();
  fcSteady(e, 60);
  for (let i = 0; i < 5; i++) fcRow(e, i + 0.5, { provider: "anthropic", billing: "subscription", usd: 0, apiEquivUsd: 0.1 });
  for (let i = 0; i < 4; i++) fcRow(e, i + 0.5, { provider: "ollama", billing: "credits", usd: 0, apiEquivUsd: 0.5 });
  mkdirSync(join(e.dir, "data"), { recursive: true });
  writeFileSync(join(e.dir, "data", "caps.json"), JSON.stringify({ dailyUsd: 3.6, sessionUsd: 100, perProviderDailyUsd: { openai: 5 } }));
  writeFileSync(join(e.dir, "data", "config.json"), JSON.stringify({ plans: { ollama: { name: "Pro", includedUsd: 3, resetsOnDay: 20 } } }));
  const r = await run(["forecast"], { e, now: FC_NOW, fetch: noFetch });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  assert.equal(lines[0], "forecast (estimates, not limits; nothing here blocks a request)");
  assert.ok(lines.includes("charged now    $1.20/h (15 min) · $1.20/h (60 min) · 15 metered calls in 15 min"), r.out);
  assert.ok(lines.includes("today          $1.20 so far · ~$13.20 by midnight (range $13.20-$13.20)"), r.out);
  assert.ok(lines.includes("daily cap      $3.60: ~16:00 (range 16:00-16:00)"), r.out);
  assert.ok(lines.includes("provider openai cap $5.00: ~17:10 (range 17:10-17:10)"), r.out);
  assert.ok(lines.includes("session cap    $100.00 (s1): not at this pace"), r.out);
  assert.ok(lines.includes("API value      $10.00/h (15 min) · $2.50/h (60 min), not charged (subscription and credits)"), r.out);
  assert.ok(lines.includes("plan ollama    Pro: credits run out ~14:07 (range 14:07-14:30)"), r.out);
});

test("forecast with too few calls prints the reason and no number", async () => {
  _resetLedgerCache();
  const e = env();
  fcRow(e, 1); fcRow(e, 3);
  const r = await run(["forecast"], { e, now: FC_NOW, fetch: noFetch });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^charged now    no forecast: fewer than 3 metered calls in the last 15 min \(2\)$/m);
  assert.match(r.out, /^daily cap      \$40\.00: suppressed, fewer than 3 metered calls in the last 15 min \(2\)$/m);
  assert.match(r.out, /^today          \$0\.04 so far$/m);
  assert.doesNotMatch(r.out, /\/h \(15 min\)|by midnight|~\d\d:\d\d/);
});

test("forecast exits 1 and says partial when the ledger cannot be read in full", { skip: process.getuid?.() === 0 ? "root ignores file modes" : false }, async () => {
  _resetLedgerCache();
  const e = env();
  fcSteady(e, 10);
  const f = join(e.dir, "data", "spend.jsonl");
  _resetLedgerCache();
  chmodSync(f, 0o000);
  try {
    const r = await run(["forecast"], { e, now: FC_NOW, fetch: noFetch });
    assert.equal(r.code, 1);
    assert.match(r.err, /partial forecast: the spend ledger could not be read in full/);
    assert.match(r.out, /no forecast: /);
    const j = await run(["forecast", "--json"], { e, now: FC_NOW, fetch: noFetch });
    assert.equal(j.code, 1);
    const body = JSON.parse(j.out);
    assert.equal(body.code, 1); assert.match(body.error, /partial forecast/);
    assert.equal(body.spend.complete, false); assert.equal(body.spend.charged, null);
  } finally { chmodSync(f, 0o600); }
});

test("forecast never changes the exit code for a predicted or an actual breach", async () => {
  _resetLedgerCache();
  const e = env();
  fcSteady(e, 60);
  mkdirSync(join(e.dir, "data"), { recursive: true });
  writeFileSync(join(e.dir, "data", "caps.json"), JSON.stringify({ dailyUsd: 3.6, sessionUsd: 0 }));
  const predicted = await run(["forecast"], { e, now: FC_NOW, fetch: noFetch });
  assert.equal(predicted.code, 0);
  assert.match(predicted.out, /^daily cap      \$3\.60: ~16:00/m);
  writeFileSync(join(e.dir, "data", "caps.json"), JSON.stringify({ dailyUsd: 1, sessionUsd: 0 }));
  const reached = await run(["forecast", "--json"], { e, now: FC_NOW, fetch: noFetch });
  assert.equal(reached.code, 0);
  assert.equal(JSON.parse(reached.out).spend.caps[0].state, "reached");
  assert.match((await run(["forecast"], { e, now: FC_NOW, fetch: noFetch })).out, /^daily cap      \$1\.00: reached$/m);
});

test("forecast rejects extra arguments with exit 2; help lists forecast", async () => {
  const r = await run(["forecast", "now"], { fetch: noFetch });
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: dsh-hub forecast \[--json\]/);
  const j = await run(["forecast", "now", "--json"], { fetch: noFetch });
  assert.equal(j.code, 2);
  assert.equal(JSON.parse(j.out).code, 2);
  assert.match((await run(["--help"])).out, /^ {2}forecast {20,}estimates: burn rate, when each cap and plan credit is reached at this pace/m);
});

test("forecast prints a short weekday for a time that is not today, and the plan states", async () => {
  _resetLedgerCache();
  const e = env();
  for (let i = 0; i < 5; i++) fcRow(e, i + 0.5, { provider: "ollama", billing: "credits", usd: 0, apiEquivUsd: 0.1 });
  mkdirSync(join(e.dir, "data"), { recursive: true });
  writeFileSync(join(e.dir, "data", "config.json"), JSON.stringify({ plans: { ollama: { name: "Pro", includedUsd: 40, resetsOnDay: 20 } } }));
  const slow = await run(["forecast"], { e, now: FC_NOW, fetch: noFetch });
  assert.match(slow.out, /^plan ollama    Pro: credits run out ~Fri 09:45 \(range Fri 09:45-Sun 21:00\)$/m, slow.out);
  writeFileSync(join(e.dir, "data", "config.json"), JSON.stringify({ plans: { ollama: { name: "Pro", includedUsd: 100000, resetsOnDay: 20 } } }));
  assert.match((await run(["forecast"], { e, now: FC_NOW, fetch: noFetch })).out, /^plan ollama    Pro: credits not used up before the reset on 2026-11-20 at this pace$/m);
  writeFileSync(join(e.dir, "data", "config.json"), JSON.stringify({ plans: { ollama: { name: "Pro", includedUsd: 0.3, resetsOnDay: 20 } } }));
  assert.match((await run(["forecast"], { e, now: FC_NOW, fetch: noFetch })).out, /^plan ollama    Pro: exhausted \(resets 2026-11-20\)$/m);
});

// ---- Claude plan forecast in the CLI (forecast, status, doctor) ----
import { appendReading } from "../lib/plan-history.mjs";
const phRow = (e, window, minAgo, percent, resetsInMin) => appendReading(join(e.dir, "data"), { v: 1, window, percent, resetsAt: new Date(FC_NOW + resetsInMin * 60e3).toISOString(), fetchedAt: FC_NOW - Math.round(minAgo * 60e3) });
const phSteep = (e) => { for (const [i, m] of [50, 40, 30, 20, 10, 1].entries()) phRow(e, "fiveHour", m, 10 + 8 * i, 180); };
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

test("forecast shows the Claude plan windows, the reading count and how old the last reading is", async () => {
  _resetLedgerCache();
  const e = env();
  phSteep(e);
  for (const [i, m] of [3000, 2000, 1000, 500, 100, 1].entries()) phRow(e, "sevenDay", m, 10, 5000 + 0 * i);
  const r = await run(["forecast"], { e, now: FC_NOW, fetch: noFetch });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^claude 5-hour {2}limit ~15:0\d \(range 1[45]:\d\d-15:\d\d\), 6 readings, before the reset at 17:00$/m, r.out);
  assert.match(r.out, /^claude weekly {2}won't reach 100% before the reset at \w{3} \d\d:\d\d$/m, r.out);
  assert.match(r.out, /^claude plan {4}last reading 1 min ago \(13:59\)$/m, r.out);
  assert.match(r.out, /^forecast \(estimates, not limits; nothing here blocks a request\)$/m);
  const j = JSON.parse((await run(["forecast", "--json"], { e, now: FC_NOW, fetch: noFetch })).out);
  assert.equal(j.plan.estimate, true);
  assert.equal(j.plan.windows.fiveHour.status, "limit");
  assert.equal(j.plan.lastReadingAt, FC_NOW - 60e3);
  assert.equal(j.plan.ageMs, 60e3);
});

test("forecast says why a Claude window has no forecast: too few readings, a stale reading, a reset, 100 %, no history", async () => {
  _resetLedgerCache();
  const none = env();
  assert.match((await run(["forecast"], { e: none, now: FC_NOW, fetch: noFetch })).out, /^claude plan {4}no plan readings yet \(written while the Claude plan card is read\)$/m);
  const few = env();
  phRow(few, "fiveHour", 20, 10, 180); phRow(few, "fiveHour", 1, 14, 180);
  const fewOut = (await run(["forecast"], { e: few, now: FC_NOW, fetch: noFetch })).out;
  assert.match(fewOut, /^claude 5-hour {2}not enough readings \(2\)$/m, fewOut);
  const stale = env();
  for (const m of [200, 190, 180]) phRow(stale, "fiveHour", m, 10, 300);
  const staleOut = (await run(["forecast"], { e: stale, now: FC_NOW, fetch: noFetch })).out;
  assert.match(staleOut, /^claude 5-hour {2}no forecast: last reading 3 h ago$/m, staleOut);
  assert.match(staleOut, /^claude plan {4}last reading 3 h ago \(11:00\)$/m, staleOut);
  const full = env();
  for (const m of [20, 10, 1]) phRow(full, "fiveHour", m, 100, 120);
  assert.match((await run(["forecast"], { e: full, now: FC_NOW, fetch: noFetch })).out, /^claude 5-hour {2}at 100% now$/m);
  const reset = env();
  for (const m of [20, 14, 11]) phRow(reset, "fiveHour", m, 50, -5);
  assert.match((await run(["forecast"], { e: reset, now: FC_NOW, fetch: noFetch })).out, /^claude 5-hour {2}window reset at 13:55, waiting for a new reading$/m);
  // an open range end and a hedged no-limit
  const open = env();
  for (const [m, p] of [[50, 40], [30, 40], [1, 41]]) phRow(open, "fiveHour", m, p, 180);
  const openOut = (await run(["forecast"], { e: open, now: FC_NOW, fetch: noFetch })).out;
  assert.match(openOut, /^claude 5-hour {2}(won't reach 100% before the reset at 17:00|probably not before the reset at 17:00 \(could be ~\S+ \S*\d\d:\d\d at the fastest pace\))$/m, openOut);
});

test("forecast names a caps.json problem and lists each recent charged session", async () => {
  _resetLedgerCache();
  const e = env();
  fcSteady(e, 20);
  for (let i = 0; i < 5; i++) fcRow(e, 0.05 + i * 0.01, { sessionId: "s2", provider: "anthropic", billing: "subscription", usd: 0, apiEquivUsd: 0.5 });
  mkdirSync(join(e.dir, "data"), { recursive: true });
  writeFileSync(join(e.dir, "data", "caps.json"), "{garbage");
  const r = await run(["forecast"], { e, now: FC_NOW, fetch: noFetch });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^caps\.json {6}caps\.json: .*defaults used$/m, r.out);
  assert.match(r.out, /^session cap {4}\$15\.00 \(s1\): /m, r.out);
  assert.doesNotMatch(r.out, /\(s2\)/, "the subscription session is not the session cap");
  assert.equal(JSON.parse((await run(["forecast", "--json"], { e, now: FC_NOW, fetch: noFetch })).out).capsProblem.includes("defaults used"), true);
});

const fcReport = (now) => ({
  estimate: true, generatedAt: now, capsProblem: null,
  spend: { estimate: true, generatedAt: now, complete: true, reason: null, minCalls: 3, windowsMin: [15, 60],
    charged: { status: "ok", reason: null, calls15: 15, calls60: 40, ratePerHour: { m15: 1.2, m60: 1.35 }, todayUsd: 4.1, midnightAt: now + 10 * 3600e3, projectedTodayUsd: { mid: 14.2, low: 13.8, high: 15.1 } },
    caps: [{ which: "daily", capUsd: 40, spentUsd: 4.1, calls15: 15, state: "at-pace", reason: null, resetsAt: now + 10 * 3600e3, reachedAt: now + 2 * 3600e3 + 40 * 60e3, range: { earliestAt: now + 3600e3, latestAt: null } }],
    apiValue: null, plans: [] },
  plan: { estimate: true, lastReadingAt: now - 60e3, ageMs: 60e3, windows: {
    fiveHour: { status: "limit", resetsAt: new Date(now + 3 * 3600e3).toISOString(), readings: 6, limitAt: now + 80 * 60e3, earliestAt: now + 70 * 60e3, latestAt: now + 95 * 60e3 },
    sevenDay: { status: "insufficient", readings: 1, needed: 3 } } },
});

test("status shows a forecast summary: from the host's /forecast when it has one, else computed from the data dir; nothing when suppressed", async () => {
  _resetLedgerCache();
  const plan = { mode: "plan", fiveHour: { percent: 40, resetsAt: new Date(FC_NOW + 3 * 3600e3).toISOString() }, extraKnown: true, extraEnabled: false };
  const base = { "/healthz": [200, { ok: true }], "/status": [200, { signedIn: true, plan, imageCap: true, compactionSlim: true, spendGuard: true }] };
  const withFc = hubFetch({ ...base, "/forecast": [200, fcReport(FC_NOW)] });
  const r = await run(["status"], { fetch: withFc, now: FC_NOW });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^forecast {3}\$1\.20\/h now \(15 min\) · today ~\$14\.20 · daily cap ~16:40$/m, r.out);
  assert.match(r.out, new RegExp(`^forecast {3}claude 5h: limit ~${hhmm(FC_NOW + 80 * 60e3)}, 6 readings$`, "m"), r.out);
  assert.doesNotMatch(r.out, /claude weekly|insufficient|not enough/);
  const j = JSON.parse((await run(["status", "--json"], { fetch: withFc, now: FC_NOW })).out);
  assert.equal(j.forecast.estimate, true);
  assert.equal(j.forecast.plan.windows.fiveHour.status, "limit");
  // a suppressed pace and an unfit plan print nothing
  const quiet = fcReport(FC_NOW);
  quiet.spend.charged = { status: "suppressed", reason: "fewer than 3", calls15: 1, calls60: 1, ratePerHour: null, todayUsd: 0, midnightAt: 0, projectedTodayUsd: null };
  quiet.plan.windows.fiveHour = { status: "stale", readings: 0 };
  const q = await run(["status"], { fetch: hubFetch({ ...base, "/forecast": [200, quiet] }), now: FC_NOW });
  assert.equal(q.code, 0);
  assert.doesNotMatch(q.out, /^forecast /m);
  // no /forecast on the host (404, 503, unreachable): computed from the data dir, no error line
  const e = env();
  fcSteady(e, 30);
  phSteep(e);
  for (const routes of [base, { ...base, "/forecast": [404, {}] }, { ...base, "/forecast": [503, { error: "forecast unavailable" }] }]) {
    const l = await run(["status"], { e, fetch: hubFetch(routes), now: FC_NOW });
    assert.equal(l.code, 0, l.err);
    assert.equal(l.err, "");
    assert.match(l.out, /^forecast {3}\$1\.20\/h now \(15 min\) · today ~\$\d+\.\d\d · session cap ~/m, l.out);
    assert.match(l.out, /^forecast {3}claude 5h: limit ~15:0\d, 6 readings$/m, l.out);
  }
  // an empty data dir and no host forecast: status is what it was
  const empty = await run(["status"], { e: env(), fetch: hubFetch(base), now: FC_NOW });
  assert.equal(empty.code, 0);
  assert.doesNotMatch(empty.out, /^forecast /m);
});

test("doctor checks the plan history file: absent ok, mode 600 ok with count and age, other mode warn, a symlink fails", async () => {
  _resetLedgerCache();
  const f = hubFetch({ "/healthz": [200, {}], "/status": [200, { imageCap: true, compactionSlim: true, spendGuard: true }] });
  const lit = async (u) => { if (String(u).includes("hub.test")) return f(u); throw new Error("offline"); };
  const check = async (e) => JSON.parse((await run(["doctor", "--json"], { e, fetch: lit, rocco: gpuOk, now: FC_NOW })).out).checks.find((c) => c.name === "plan history");
  const none = env();
  assert.deepEqual([(await check(none)).level, (await check(none)).detail.startsWith("no readings yet")], ["ok", true]);
  const e = env();
  phSteep(e);
  const ok = await check(e);
  assert.equal(ok.level, "ok"); assert.match(ok.detail, /^6 rows, last reading 1 min ago/);
  chmodSync(join(e.dir, "data", "plan-history.jsonl"), 0o644);
  const warn = await check(e);
  assert.equal(warn.level, "warn"); assert.match(warn.detail, /mode 644/);
  const l = env();
  mkdirSync(join(l.dir, "data"), { recursive: true });
  writeFileSync(join(l.dir, "target"), "x");
  symlinkSync(join(l.dir, "target"), join(l.dir, "data", "plan-history.jsonl"));
  const bad = await check(l);
  assert.equal(bad.level, "fail"); assert.match(bad.detail, /symbolic link/);
});

const FOUR = ["cost", "caps", "route", "receipt"];
const statusWith = (commands) => hubFetch({ "/healthz": [200, { ok: true }], "/status": [200, { signedIn: true, plan: { mode: "plan" }, imageCap: true, compactionSlim: true, spendGuard: true, ...(commands === undefined ? {} : { commands }) }] });
const doctorCheck = async (commands) => {
  const f = statusWith(commands);
  const lit = async (u) => { if (String(u).includes("hub.test")) return f(u); throw new Error("offline"); };
  const r = await run(["doctor", "--json"], { fetch: lit, gpu: gpuOk });
  return JSON.parse(r.out).checks.find((c) => c.name === "slash commands");
};

test("status prints the slash commands line: all four, a collision, none registered, and nothing for an older host", async () => {
  const all = (await run(["status"], { fetch: statusWith({ registered: FOUR, collided: [] }) })).out;
  assert.match(all, /^commands {3}\/cost \/caps \/route \/receipt$/m);
  const col = (await run(["status"], { fetch: statusWith({ registered: ["caps", "route", "receipt"], collided: ["cost"] }) })).out;
  assert.match(col, /^commands {3}\/caps \/route \/receipt · collided: \/cost$/m);
  const none = (await run(["status"], { fetch: statusWith({ registered: [], collided: [] }) })).out;
  assert.match(none, /^commands {3}none registered$/m);
  const old = (await run(["status"], { fetch: statusWith(undefined) })).out;
  assert.doesNotMatch(old, /commands/);
  const j = JSON.parse((await run(["status", "--json"], { fetch: statusWith({ registered: FOUR, collided: [] }) })).out);
  assert.deepEqual(j.commands, { registered: FOUR, collided: [] });
  // names are printed only when they look like command names
  const junk = (await run(["status"], { fetch: statusWith({ registered: ["cost", "x\ny", "/etc/passwd"], collided: [] }) })).out;
  assert.match(junk, /^commands {3}\/cost$/m);
  assert.doesNotMatch(junk, /passwd/);
});

test("doctor: slash commands ok, none registered is a warning, a collision is a warning (never a failure), an older host adds no check", async () => {
  const ok = await doctorCheck({ registered: FOUR, collided: [] });
  assert.equal(ok.level, "ok");
  assert.equal(ok.detail, "registered: /cost /caps /route /receipt");
  const none = await doctorCheck({ registered: [], collided: [] });
  assert.equal(none.level, "warn");
  assert.match(none.detail, /^none registered \(DSH's commands service not available in the process that owns the hub port\)$/);
  const col = await doctorCheck({ registered: ["caps", "route", "receipt"], collided: ["cost"] });
  assert.equal(col.level, "warn");
  assert.equal(col.detail, "registered /caps /route /receipt; collided with another plugin's command: /cost");
  assert.equal(await doctorCheck(undefined), undefined);
  const f = statusWith({ registered: ["caps", "route", "receipt"], collided: ["cost"] });
  const lit = async (u) => { if (String(u).includes("hub.test")) return f(u); throw new Error("offline"); };
  const e = env();
  await seedPrices(e.env.DSH_HUB_DATA_DIR);
  const r = await run(["doctor", "--json"], { fetch: lit, gpu: gpuOk, e });
  const j = JSON.parse(r.out);
  const sc = j.checks.find((c) => c.name === "slash commands");
  assert.equal(sc.level, "warn", "a collision is a warning");
  assert.ok(!j.checks.some((c) => c.name === "slash commands" && c.level === "fail"), "the slash commands check never fails the run");
  // with DSH's packages present every other check passes here, so the whole run is OK (without them the accounts checks fail)
  if (!NEEDS_DSH) assert.equal(r.code, 0, "a collision does not fail the doctor run");
});
