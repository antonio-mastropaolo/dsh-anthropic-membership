import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readdirSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./dsh-hub.mjs";
import { writeDemo } from "../lib/demo/write.mjs";
import { DEMO_TEXT } from "../lib/demo/constants.mjs";

const AT = "2026-11-12T15:00:00Z";
const tmp = () => mkdtempSync(join(tmpdir(), "demo-cli-"));
let cached = null;
function demoDir() {
  // a fresh copy per call is not needed: demo mode never writes; one folder serves the whole file
  if (cached) return cached;
  const base = tmp();
  cached = writeDemo({ out: join(base, "demo"), at: AT, seed: 3, env: { DSH_HUB_DATA_DIR: join(base, "real") }, home: join(base, "home") }).out;
  return cached;
}
const noFetch = async () => { throw new Error("fetch must not be called in demo mode"); };
async function run(args, { dir = demoDir(), env = {}, fetch = noFetch } = {}) {
  const o = [], er = [];
  const code = await main(args, { out: (s) => o.push(s), err: (s) => er.push(s), env: { DSH_HUB_DATA_DIR: dir, DSH_HUB_URL: "http://127.0.0.1:9", ...env }, fetch, home: tmp() });
  return { code, out: o.join("\n"), err: er.join("\n") };
}
const COMMANDS = [["status"], ["accounts"], ["gpus"], ["spend"], ["prices", "google/gemini-3.8-flash"], ["plans"], ["cache"], ["doctor"], ["switch", "demo-llama-70b"], ["unload"]];

test("every command prints the DEMO banner as line 1 in demo mode", async () => {
  for (const c of COMMANDS) {
    const r = await run(c);
    assert.equal(r.out.split("\n")[0], DEMO_TEXT, c.join(" "));
  }
});

test("spend --session demo-s-conv --by turn prints the DEMO banner first and the four demo turns; last resolves", async () => {
  const r = await run(["spend", "--session", "demo-s-conv", "--by", "turn"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split("\n")[0], DEMO_TEXT);
  assert.match(r.out, /^session demo-s-conv: 4 turns, 10 calls/m);
  const j = JSON.parse((await run(["spend", "--session", "demo-s-conv", "--by", "turn", "--json"])).out);
  assert.equal(j.demo, true); assert.deepEqual(j.turns.map((t) => t.turn), [1, 2, 3, 4]);
  assert.equal(JSON.parse((await run(["spend", "--session", "last", "--by", "turn", "--json"])).out).demo, true);
});

test("receipt demo-s-conv prints the DEMO banner first (text and JSON) and its Markdown starts with the DEMO line; last resolves", async () => {
  const t = await run(["receipt", "demo-s-conv"]);
  assert.equal(t.code, 0, t.err);
  assert.equal(t.out.split("\n")[0], DEMO_TEXT);
  assert.match(t.out, /^Session demo-s-conv$/m);
  const j = JSON.parse((await run(["receipt", "demo-s-conv", "--json"])).out);
  assert.equal(j.demo, true); assert.equal(j.subagents.sessionCount, 1); assert.equal(j.markdown.split("\n")[0], DEMO_TEXT);
  const md = await run(["receipt", "demo-s-conv", "--md"]);
  assert.equal(md.out.split("\n")[0], DEMO_TEXT);
  assert.equal(JSON.parse((await run(["receipt", "last", "--json"])).out).demo, true);
});

test("--json carries demo:true and demoNote, also on commands that fail", async () => {
  for (const c of COMMANDS) {
    const r = await run([...c, "--json"]);
    const j = JSON.parse(r.out);
    assert.equal(j.demo, true, c.join(" "));
    assert.equal(j.demoNote, DEMO_TEXT, c.join(" "));
  }
  const r = await run(["accounts", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).code, 1);
});

test("demo mode never calls fetch, never opens a credential file, leaves DSH_HOME empty", async () => {
  const canary = join(tmp(), "creds.yaml");
  writeFileSync(canary, "canary");
  const home = tmp();
  const opened = [];
  const real = { open: fs.openSync, read: fs.readFileSync };
  fs.openSync = (p, ...a) => { opened.push(String(p)); return real.open(p, ...a); };
  fs.readFileSync = (p, ...a) => { opened.push(String(p)); return real.read(p, ...a); };
  try {
    for (const c of COMMANDS) await run(c, { env: { DSH_HUB_CREDENTIALS: canary, DSH_HOME: home } });
  } finally { fs.openSync = real.open; fs.readFileSync = real.read; }
  assert.ok(!opened.some((p) => p.includes(canary)), "the credential canary was opened");
  assert.ok(!opened.some((p) => /\.credentials\.yaml|\.dsh\b|\.codex|\.claude/.test(p)), "a DSH/credential path was opened");
  assert.deepEqual(readdirSync(home), []);
});

test("the numbers match the data", async () => {
  const spend = await run(["spend"]);
  assert.equal(spend.code, 0);
  assert.match(spend.out, /caps: .*status warn/);
  const plans = await run(["plans"]);
  assert.match(plans.out, /ollama .*overage \$/);
  const acc = await run(["accounts"]);
  assert.equal(acc.code, 1);
  assert.match(acc.err, /refresh failed for github-copilot: sign in again/);
  assert.match(acc.out, /anthropic\s+ok/);
  assert.match(acc.out, /demo@example\.com · Max · Demo Org/);
  assert.match(acc.out, /openai-codex\s+expiring/);
  assert.match(acc.out, /github-copilot\s+refresh-failed/);
  const cache = await run(["cache"]);
  assert.match(cache.out, /demo-s-warm/);
  assert.match(cache.out, /demo-s-cache\s+last 0%/);
  const gpus = await run(["gpus"]);
  assert.equal(gpus.out.split("\n").filter((l) => /^GPU\d/.test(l)).length, 4);
  assert.match(gpus.out, /reservation demo-old-run gpus=all \(stale\)/);
  const st = await run(["status"]);
  assert.match(st.out, /gauges\s+5h 62% · weekly 41%/);
  assert.match(st.out, /spendGuard=false/);
  const sw = await run(["switch", "demo-llama-70b", "--gpus", "0,1"]);
  assert.equal(sw.code, 0);
  assert.match(sw.out, /HTTP 200 loaded gpus=0,1/);
  const ul = await run(["unload"]);
  assert.match(ul.out, /HTTP 200 unloaded/);
  const bad = await run(["switch", "demo-llama-70b", "--gpus", "9"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /HTTP 400/);
  const pr = await run(["prices", "google/gemini-3.8-flash", "openrouter/acme/mystery-1"]);
  assert.equal(pr.code, 1);
  assert.match(pr.out, /table: demo/);
  assert.match(pr.err, /no known price for openrouter\/acme\/mystery-1/);
  const one = await run(["cache", "--session", "demo-s-cache"]);
  assert.match(one.out, /demo-s-cache/);
  assert.equal((await run(["cache", "--session", "nope"])).code, 1);
});

test("doctor reports demo mode as a WARN, exits 0, makes no host call", async () => {
  const r = await run(["doctor"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /WARN demo mode\s+DEMO DATA: synthetic, nothing is recorded or capped\. Spend capture and caps are OFF; nothing is written\./);
  assert.match(r.out, /OK\s+demo folder\s+sealed/);
  assert.match(r.out, /WARN caps/);
  assert.doesNotMatch(r.out, /host API|credentials file|CLI link/);
  assert.match(r.out, /doctor: OK/);
  const j = JSON.parse((await run(["doctor", "--json"])).out);
  assert.equal(j.checks.find((c) => c.name === "demo mode").level, "warn");
});

test("a DEMO marker on a folder that fails verification stops every command with exit 2 (help still works)", async () => {
  const base = tmp();
  const w = writeDemo({ out: join(base, "t"), at: AT, seed: 3, env: { DSH_HUB_DATA_DIR: join(base, "real") }, home: join(base, "home") });
  appendFileSync(join(w.out, "spend.jsonl"), "{}\n");
  for (const c of COMMANDS) {
    const r = await run(c, { dir: w.out });
    assert.equal(r.code, 2, c.join(" "));
    assert.match(r.err, /DEMO marker found in .* but the folder is not a valid demo folder \(spend\.jsonl does not match the manifest\); regenerate it with dsh-hub demo --force/);
    assert.equal(r.out, "");
  }
  const j = await run(["spend", "--json"], { dir: w.out });
  assert.equal(JSON.parse(j.out).code, 2);
  const h = await run(["help"], { dir: w.out });
  assert.equal(h.code, 0);
  assert.match(h.out, /usage: dsh-hub/);
});

test("a normal data dir shows no banner", async () => {
  const dir = join(tmp(), "data");
  mkdirSync(dir);
  const fetch = async () => { throw new Error("ECONNREFUSED"); };
  for (const c of [["spend"], ["plans"], ["accounts"], ["status"], ["doctor"]]) {
    const r = await run(c, { dir, fetch });
    assert.doesNotMatch(r.out + r.err, /DEMO/, c.join(" "));
  }
  const j = await run(["spend", "--json"], { dir, fetch });
  assert.equal(JSON.parse(j.out).demo, undefined);
});

test("help lists demo and says demo mode", async () => {
  const h = await run(["help"]);
  assert.match(h.out, /demo --out <dir>/);
  assert.match(h.out, /doctor .*a demo folder: warning/);
});

test("doctor warns when the running host reports demo:true, and stays quiet when it reports demo:false", async () => {
  const dir = join(tmp(), "data");
  mkdirSync(dir);
  const host = (demo) => async (url) => {
    const p = new URL(url).pathname;
    const body = p === "/healthz" ? { ok: true, demo }
      : p === "/accounts" ? { running: false, reportOnly: true, accounts: [], credentialStore: { state: "none" } }
      : p === "/status" ? { signedIn: false, imageCap: !demo, compactionSlim: !demo, spendGuard: !demo, demo }
      : null;
    if (!body) throw new Error("ECONNREFUSED");
    return { status: 200, json: async () => body };
  };
  const on = await run(["doctor", "--json"], { dir, fetch: host(true) });
  assert.equal(on.code, 0, on.out);
  const check = JSON.parse(on.out).checks.find((c) => c.name === "host mode");
  assert.equal(check.level, "warn");
  assert.ok(check.detail.startsWith(DEMO_TEXT + ": the running host is in demo mode (DSH_HUB_DEMO)"), check.detail);
  assert.match(check.detail, /spend capture and caps are OFF/);
  const human = await run(["doctor"], { dir, fetch: host(true) });
  assert.match(human.out, /WARN host mode\s+DEMO DATA: synthetic/);
  const st = await run(["status"], { dir, fetch: host(true) });
  assert.equal(st.out.split("\n")[0], DEMO_TEXT, "status against a demo host carries the banner");
  const off = await run(["doctor", "--json"], { dir, fetch: host(false) });
  assert.ok(!JSON.parse(off.out).checks.some((c) => c.name === "host mode"));
});

test("caps reads a demo folder with the banner; caps set refuses (exit 2) and leaves the sealed folder untouched", async () => {
  const base = tmp();
  const dir = writeDemo({ out: join(base, "demo"), at: AT, seed: 3, env: { DSH_HUB_DATA_DIR: join(base, "real") }, home: join(base, "home") }).out;
  const before = fs.readFileSync(join(dir, "caps.json"), "utf8");
  const r = await run(["caps"], { dir });
  assert.equal(r.code, 0);
  assert.equal(r.out.split("\n")[0], DEMO_TEXT);
  const s = await run(["caps", "set", "warnPct=60"], { dir });
  assert.equal(s.code, 2);
  assert.match(s.err, /demo folder is read-only/);
  assert.equal(fs.readFileSync(join(dir, "caps.json"), "utf8"), before);
  assert.deepEqual(readdirSync(dir).sort(), readdirSync(dir).filter((f) => !f.includes(".tmp")).sort());
  // the folder still verifies: a later command is not refused as an invalid demo folder
  const after = await run(["caps"], { dir });
  assert.equal(after.code, 0);
  assert.doesNotMatch(after.out + after.err, /not a valid demo folder/);
  const j = JSON.parse((await run(["caps", "set", "warnPct=60", "--json"], { dir })).out);
  assert.equal(j.code, 2); assert.equal(j.demo, true);
});
