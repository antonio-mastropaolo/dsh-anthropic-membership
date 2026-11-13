import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDemo } from "./write.mjs";
import { verifyDemoDir } from "./gate.mjs";
import { createDemoGpuClient, createDemoGpuFetch } from "./gpu.mjs";
import { createDemoLegacy } from "./legacy.mjs";
import { createDemoEngine, replayDemoCache } from "./engine.mjs";
import { DEMO_IDENTITY } from "./constants.mjs";

const AT = "2026-11-12T15:00:00Z";
const AT_MS = Date.parse(AT);
const tmp = () => mkdtempSync(join(tmpdir(), "demo-fx-"));
function folder() {
  const base = tmp();
  const w = writeDemo({ out: join(base, "demo"), at: AT, seed: 3, env: { DSH_HUB_DATA_DIR: join(base, "real") }, home: join(base, "home") });
  const v = verifyDemoDir(w.out);
  assert.equal(v.ok, true);
  return { dir: w.out, manifest: v.manifest };
}
function treeHash(dir) {
  const h = createHash("sha256");
  for (const n of readdirSync(dir).sort()) {
    const st = statSync(join(dir, n));
    h.update(`${n}|${st.size}|${st.mtimeMs}|${createHash("sha256").update(readFileSync(join(dir, n))).digest("hex")}\n`);
  }
  return h.digest("hex");
}
const throwingFetch = async () => { throw new Error("network must not be used"); };
async function withNoFetch(fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = throwingFetch;
  try { return await fn(); } finally { globalThis.fetch = saved; }
}

test("the fake GPU server answers the documented contract through the real client", async () => {
  let t = 1_000_000;
  const gpu = createDemoGpuClient({ now: () => t });
  const g = await gpu.gpus();
  assert.equal(g.status, 200);
  assert.equal(g.body.gpus.length, 4);
  assert.equal(g.body.loaded_model, "demo-qwen-32b");
  assert.equal(g.body.manager.active, true);
  assert.equal(g.body.gpus[0].processes[0].user, "demo");
  assert.match(g.body.gpus[0].processes[0].cmd, /vllm serve demo-qwen-32b/);
  assert.deepEqual(g.body.gpus[3].reserved_by, ["demo-batch-run"]);
  assert.ok(g.body.reservations.some((r) => r.owner === "demo-old-run" && r.gpus === "all" && r.stale === true));
  assert.equal(g.body.gpus[2].processes.length, 0);
  const m = await gpu.models();
  assert.deepEqual(m.body.models.map((x) => [x.id, x.owner]), [["demo-qwen-32b", "demo-gpu"], ["demo-llama-70b", "demo-gpu"], ["demo-small-8b", "demo-gpu"], ["mac-demo-8b", "mac"]]);
  assert.equal((await gpu.health()).status, 200);

  assert.equal((await gpu.switch("no-such-model")).status, 400);
  assert.equal((await gpu.switch("demo-llama-70b", [9])).status, 400);
  assert.equal((await gpu.switch("demo-llama-70b", [1, 1])).status, 400);
  const ok = await gpu.switch("demo-llama-70b", [0, 1]);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { status: "loaded", gpus: [0, 1] });
  assert.deepEqual((await gpu.gpus()).body.pin, { gpus: [0, 1], error: null });
  const lease = await gpu.switch("demo-small-8b");
  assert.equal(lease.status, 409);
  assert.match(lease.body.error, /lease held \(demo\): retry or force/);
  assert.equal((await gpu.switch("demo-small-8b", undefined, { force: true })).status, 200);
  assert.ok((await gpu.gpus()).body.pin, "a forced switch without --auto keeps the pin");
  t += 301_000;
  assert.equal((await gpu.switch("demo-qwen-32b", undefined, { auto: true })).status, 200);
  assert.equal((await gpu.gpus()).body.pin, undefined);
  const un = await gpu.unload();
  assert.deepEqual(un, { status: 200, body: { status: "unloaded" } });
  assert.equal((await gpu.gpus()).body.loaded_model, null);
  assert.equal((await gpu.gpus()).body.gpus.every((x) => x.processes.length === 0), true);
});

test("the fake GPU server keeps its state per instance and redacts error text through the real client", async () => {
  const a = createDemoGpuClient();
  const b = createDemoGpuClient();
  await a.unload();
  assert.equal((await b.gpus()).body.loaded_model, "demo-qwen-32b");
  const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV";
  const r = await a.switch(secret);
  assert.equal(r.status, 400);
  assert.ok(!JSON.stringify(r.body).includes(secret), "the error text went through the redactor");
});

test("the fake GPU server uses no network", async () => {
  await withNoFetch(async () => {
    const gpu = createDemoGpuClient();
    for (const r of [await gpu.gpus(), await gpu.models(), await gpu.health(), await gpu.switch("demo-small-8b"), await gpu.unload()]) assert.notEqual(r.status, 502);
  });
  const src = readFileSync(fileURLToPath(new URL("./gpu.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /node:http|node:net|node:dgram|\.listen\(|createServer|globalThis\.fetch/);
  assert.equal(typeof createDemoGpuFetch(), "function");
});

test("demo legacy: Claude gauges and identity are the fixed demo values", async () => {
  const { manifest } = folder();
  const s = await createDemoLegacy({ manifest }).status();
  assert.equal(s.plan.fiveHour.percent, 62);
  assert.equal(s.plan.sevenDay.percent, 41);
  assert.equal(s.plan.messages, 37);
  assert.equal(s.plan.modelCalls, 214);
  assert.equal(s.plan.fetchedAt, AT_MS);
  assert.equal(Date.parse(s.plan.fiveHour.resetsAt), AT_MS + 2.5 * 3600e3);
  assert.equal(Date.parse(s.plan.sevenDay.resetsAt), AT_MS + 3 * 86400e3);
  assert.equal(s.spendGuard, false);
  assert.equal(s.signedIn, true);
  assert.equal(s.demo, true);
  assert.deepEqual(s.identity, DEMO_IDENTITY);
  assert.equal(s.identity.email, "demo@example.com");
  assert.equal(s.identity.plan, "Max");
  assert.equal(s.identity.org, "Demo Org");
  assert.deepEqual(await createDemoLegacy({ manifest }).identities(), { anthropic: DEMO_IDENTITY });
});

test("demo engine on a generated folder: caps warn, plan overage, offline prices, external ledger", async () => {
  const { dir, manifest } = folder();
  await withNoFetch(async () => {
    const eng = createDemoEngine({ dir, manifest });
    const rep = await eng.spendReport({ since: "today" });
    assert.equal(rep.caps.action, "warn");
    const pct = rep.caps.pct;
    assert.ok(pct >= 79 && pct <= 81, `pct ${pct}`);
    assert.notEqual(rep.external, null);
    const plans = eng.plansReport();
    assert.equal(plans.length, 1);
    assert.ok(plans[0].overageUsd > 0);
    const p = await eng.prices(["google/gemini-3.8-flash", "ollama/glm-5.3-flash", "openrouter/acme/mystery-1"]);
    assert.equal(p.source, "demo");
    assert.equal(p.models["google/gemini-3.8-flash"].priced, true);
    assert.equal(p.models["ollama/glm-5.3-flash"].priced, true);
    assert.equal(p.models["openrouter/acme/mystery-1"].priced, false);
    assert.equal(p.ollama.source, "snapshot");
    assert.equal(eng.capsStatus().action, "warn");
    assert.equal((await eng.guard({ provider: "anthropic", model: "x" })).action, "ok");
  });
});

test("replay: the collapse is the latest session with one alert, after a healthy session", async () => {
  const { dir, manifest } = folder();
  const eng = createDemoEngine({ dir, manifest });
  await replayDemoCache(eng, dir);
  const rep = eng.cacheReport();
  assert.deepEqual(rep.sessions.map((s) => s.sessionId), ["demo-s-warm", "demo-s-cache"]);
  assert.equal(rep.latest.sessionId, "demo-s-cache");
  const warm = rep.sessions[0];
  const bad = rep.sessions[1];
  assert.ok(warm.lastHit > 0.85);
  assert.ok(bad.lastHit < 0.05);
  assert.equal(warm.alerts, 0);
  assert.equal(bad.alerts, 1);
  assert.ok(bad.lastAlert.prevHit >= 0.85);
});

test("the demo engine never writes and never goes online", async () => {
  const { dir, manifest } = folder();
  const before = treeHash(dir);
  await withNoFetch(async () => {
    const eng = createDemoEngine({ dir, manifest });
    await eng.spendReport({ since: "7d", by: "model" });
    await eng.prices(["anthropic/claude-sonnet-5-5"]);
    eng.plansReport();
    eng.capsStatus();
    await replayDemoCache(eng, dir);
    await eng.warm();
    assert.equal((await eng.guard({ provider: "google", model: "gemini-3.8-flash", sessionId: "s" })).action, "ok");
    assert.equal(await eng.recordUsage({ provider: "google", model: "gemini-3.8-flash", sessionId: "s" }, { input: 1000, output: 1000 }), null);
    assert.equal(eng.recordProviderFailure("google", { status: 402, message: "insufficient_quota" }), false);
    eng.clearProviderHealth("google");
  });
  assert.equal(treeHash(dir), before);
  assert.deepEqual(readdirSync(dir).sort(), [...readdirSync(dir)].sort());
  assert.ok(!readdirSync(dir).includes("provider-health.json"));
});

test("the demo engine's inert facade cannot write", async () => {
  const { dir, manifest } = folder();
  const before = treeHash(dir);
  const eng = createDemoEngine({ dir, manifest });
  const r = await eng.recordUsage({ provider: "anthropic", model: "claude-sonnet-5-5", sessionId: "x" }, { inputTokens: 5000, outputTokens: 5000 });
  assert.equal(r, null);
  assert.equal(treeHash(dir), before);
  assert.equal(verifyDemoDir(dir).ok, true);
});
