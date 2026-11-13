import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDemo, parseAt } from "./build.mjs";
import { writeDemo } from "./write.mjs";
import { readDemoAccounts } from "./accounts.mjs";
import { demoPriceTable, DEMO_OAUTH_PROVIDERS } from "./prices.mjs";
import { DEMO_CONV_SESSION, DEMO_CONV_SUB, DEMO_FILES } from "./constants.mjs";
import { summarize, checkCaps, loadCaps, planStatus, createCacheTracker, summarizeExternal, priceFor, costOf } from "../cost/index.mjs";
import { loadConfig } from "../config.mjs";

const AT = "2026-11-12T15:00:00Z";
const AT_MS = Date.parse(AT);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const tmp = () => mkdtempSync(join(tmpdir(), "demo-build-"));
function dump(files) {
  const dir = tmp();
  for (const [k, v] of files) writeFileSync(join(dir, k), v);
  return dir;
}
const rowsOf = (files) => files.get("spend.jsonl").trim().split("\n").map((l) => JSON.parse(l));
const V2 = ["v", "purpose", "turn", "step", "parentSessionId", "rates", "derived", "tier", "offPeak", "planCoveredUsd", "reasoning", "finish", "ttftMs", "durationMs"];
const V1 = ["ts", "sessionId", "provider", "model", "input", "output", "cacheRead", "cacheWrite", "usd", "apiEquivUsd", "priceSource", "billing", "id"];

test("same inputs give byte-identical files, whatever the out dir", () => {
  const a = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const b = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  assert.deepEqual([...a.files.keys()], [...b.files.keys()]);
  for (const [k, v] of a.files) assert.equal(sha(v), sha(b.files.get(k)), k);
  const env = (d) => ({ DSH_HUB_DATA_DIR: join(d, "real") });
  const r1 = tmp(), r2 = tmp();
  const w1 = writeDemo({ out: join(r1, "x", "demo"), at: AT, seed: 7, tzOffsetMin: 0, env: env(r1), home: r1 });
  const w2 = writeDemo({ out: join(r2, "other"), at: AT, seed: 7, tzOffsetMin: 0, env: env(r2), home: r2 });
  assert.deepEqual(w1.files, w2.files);
  for (const f of w1.files) assert.equal(sha(readFileSync(join(w1.out, f))), sha(readFileSync(join(w2.out, f))), f);
  assert.equal(readFileSync(join(w1.out, "demo-manifest.json"), "utf8"), a.files.get("demo-manifest.json"));
});

test("a different seed or anchor changes the ledger", () => {
  const base = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 }).files.get("spend.jsonl");
  assert.notEqual(base, buildDemo({ at: AT, seed: 8, tzOffsetMin: 0 }).files.get("spend.jsonl"));
  assert.notEqual(base, buildDemo({ at: "2026-11-12T16:00:00Z", seed: 7, tzOffsetMin: 0 }).files.get("spend.jsonl"));
});

test("parseAt floors to the UTC hour and rejects garbage", () => {
  assert.equal(parseAt("2026-11-12T15:42:10Z"), AT_MS);
  assert.equal(parseAt("now", AT_MS + 59 * 60e3), AT_MS);
  assert.throws(() => parseAt("yesterday"), /bad --at/);
  assert.throws(() => parseAt(""), /bad --at/);
});

test("every billing kind, provider and panel input is present", () => {
  const { files, summary } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const rows = rowsOf(files);
  const kinds = new Set(rows.map((r) => r.billing));
  for (const k of ["metered", "credits", "subscription", "free", "local"]) assert.ok(kinds.has(k), k);
  assert.ok(new Set(rows.map((r) => r.provider)).size >= 3);
  assert.ok(new Set(rows.map((r) => `${r.provider}/${r.model}`)).size >= 6);
  const unpriced = rows.filter((r) => r.priceSource === "unpriced");
  assert.ok(unpriced.length >= 2 && unpriced.length <= 4);
  for (const r of unpriced) { assert.equal(r.billing, "metered"); assert.equal(r.usd, 0); }
  assert.ok(new Set(rows.map((r) => r.ts.slice(0, 10))).size >= 7);
  for (const r of rows) assert.ok(Date.parse(r.ts) <= summary.anchorMs, r.ts);
  assert.equal(summary.rows, rows.length);
});

test("rows are v1-shaped and clean (only the demo conversation's rows are v2)", () => {
  const { files } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const rows = rowsOf(files);
  const ids = new Set();
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), r.sessionId === DEMO_CONV_SESSION || r.sessionId === DEMO_CONV_SUB ? V1.concat(V2) : V1);
    assert.match(r.id, /^demo-[0-9a-f]{20}$/);
    assert.ok(!ids.has(r.id)); ids.add(r.id);
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "usd", "apiEquivUsd"]) assert.ok(Number.isFinite(r[k]) && r[k] >= 0, k);
    assert.ok(r.usd <= r.apiEquivUsd + 1e-9);
    if (r.billing !== "metered") assert.equal(r.usd, 0);
    for (const k of ["ts", "sessionId", "provider", "model", "priceSource", "billing", "id"]) assert.ok(typeof r[k] === "string" && r[k].length <= 200);
  }
  const sorted = [...rows].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  assert.deepEqual(rows.map((r) => r.id), sorted.map((r) => r.id));
  const dir = dump(files);
  assert.equal(summarize(dir, { since: "all" }).totals.calls, rows.length);
});

test("rows re-price exactly with the demo price table", () => {
  const { files } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const table = demoPriceTable({ overrides: JSON.parse(files.get("prices.json")) });
  for (const r of rowsOf(files)) {
    if (r.billing === "credits") continue;
    const p = priceFor(table, r.provider, r.model, { at: Date.parse(r.ts), oauthProviders: DEMO_OAUTH_PROVIDERS, localProviders: ["demo-gpu"], subscriptions: [] });
    const c = costOf({ input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }, p);
    assert.ok(Math.abs(c.usd - r.apiEquivUsd) < 1e-6, `${r.provider}/${r.model} ${c.usd} vs ${r.apiEquivUsd}`);
    assert.equal(p.source, r.priceSource);
  }
});

test("the Ollama plan crosses into overage", () => {
  const { files, summary } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const o = rowsOf(files).filter((r) => r.provider === "ollama");
  assert.ok(o.some((r) => r.billing === "credits"));
  const crossing = o.filter((r) => r.billing === "metered" && r.usd > 0 && r.usd < r.apiEquivUsd);
  assert.equal(crossing.length, 1);
  const at = o.indexOf(crossing[0]);
  assert.ok(o.slice(0, at).every((r) => r.billing === "credits"));
  for (const r of o.slice(at + 1)) { assert.equal(r.billing, "metered"); assert.equal(r.usd, r.apiEquivUsd); }
  const dir = dump(files);
  const cfg = JSON.parse(files.get("config.json"));
  const [p] = planStatus(dir, cfg.plans, summary.anchorMs);
  assert.ok(p.overageUsd > 0 && p.complete);
  assert.equal(p.remainingUsd, 0);
});

for (const tz of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
  test(`today's metered spend is 80% of the daily cap and the cap check says warn (TZ ${tz})`, () => {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try {
      const { files, summary } = buildDemo({ at: AT, seed: 7 });
      const dir = dump(files);
      const caps = loadCaps(dir);
      assert.equal(caps.dailyUsd, 25);
      const s = summarize(dir, { since: "today", now: summary.anchorMs });
      const ratio = s.totals.usd / caps.dailyUsd;
      assert.ok(ratio > 0.795 && ratio < 0.805, `ratio ${ratio}`);
      assert.ok(Math.abs(s.totals.usd - 20) < 0.001, `the last Google call fits the cap exactly: ${s.totals.usd}`);
      const c = checkCaps({ summary: s, provider: "google", sessionId: "x", billing: "metered", caps });
      assert.equal(c.action, "warn");
      assert.ok(c.pct >= 79 && c.pct <= 81, `pct ${c.pct}`);
      assert.ok(Math.abs(summary.todayUsd - s.totals.usd) < 1e-4);
    } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
  });
}

test("every anchor hour lands on 80% (fuzz over hours and seeds)", () => {
  const before = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    for (let h = 0; h < 24; h += 3) for (const seed of [1, 99, 20261112]) {
      const { files, summary } = buildDemo({ at: Date.UTC(2026, 10, 12, h), seed, tzOffsetMin: 0 });
      const s = summarize(dump(files), { since: "today", now: summary.anchorMs });
      assert.ok(Math.abs(s.totals.usd / 25 - 0.8) < 0.005, `h${h} seed${seed}: ${s.totals.usd}`);
    }
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
});

test("a very early anchor is moved to local 02:00 and says so", () => {
  const before = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const { files, summary } = buildDemo({ at: "2026-11-12T00:20:00Z", seed: 7, tzOffsetMin: 0 });
    assert.equal(summary.anchorAdjusted, true);
    assert.equal(summary.anchorMs, Date.UTC(2026, 10, 12, 2));
    assert.equal(summary.anchor, "2026-11-12T02:00:00.000Z");
    const s = summarize(dump(files), { since: "today", now: summary.anchorMs });
    assert.ok(s.totals.calls > 0);
    for (const r of rowsOf(files)) assert.ok(Date.parse(r.ts) <= summary.anchorMs);
    assert.equal(buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 }).summary.anchorAdjusted, false);
    const ny = buildDemo({ at: "2026-11-12T05:20:00Z", seed: 7, tzOffsetMin: -300 });
    assert.equal(ny.summary.anchorAdjusted, true);
    assert.equal(ny.summary.anchorMs, Date.UTC(2026, 10, 12, 7));
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
});

test("the cache fixture collapses in its last session", () => {
  const { files } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const fx = JSON.parse(files.get("demo-cache.json"));
  assert.equal(fx.version, 1);
  assert.ok(fx.sessions.length >= 2);
  const t = createCacheTracker();
  const alerts = {};
  for (const s of fx.sessions) for (const st of s.steps) {
    const r = t.observe({ sessionId: s.sessionId, step: st.step, provider: s.provider, model: s.model, usage: st.usage });
    if (r.alert) (alerts[s.sessionId] ||= []).push(r.alert);
  }
  const last = fx.sessions[fx.sessions.length - 1];
  assert.equal(last.sessionId, "demo-s-cache");
  assert.equal(alerts[last.sessionId].length, 1);
  assert.ok(alerts[last.sessionId][0].prevHit >= 0.85 && alerts[last.sessionId][0].hit < 0.05);
  for (const s of fx.sessions.slice(0, -1)) assert.equal(alerts[s.sessionId], undefined);
  const lr = rowsOf(files).filter((r) => r.sessionId === "demo-s-cache");
  assert.equal(lr.length, last.steps.length);
  for (const r of lr) assert.equal(r.billing, "subscription");
  lr.forEach((r, i) => {
    const u = last.steps[i].usage;
    assert.equal(r.input, u.inputTokens); assert.equal(r.cacheRead, u.cacheReadTokens); assert.equal(r.output, u.outputTokens); assert.equal(r.cacheWrite, u.cacheWriteTokens);
  });
  assert.ok(lr[lr.length - 2].cacheRead > 40000 && lr[lr.length - 1].cacheRead === 0);
});

test("config.json is valid and names a plan and a GPU server; the extra ledger is readable", () => {
  const { files, summary } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const dir = dump(files);
  const cfg = loadConfig({ dataDir: dir, env: {} });
  assert.deepEqual([...cfg.errors], []);
  assert.equal(cfg.gpuServer.id, "demo-gpu");
  assert.equal(cfg.gpuServer.defaultModel, "demo-qwen-32b");
  assert.ok(cfg.plans.ollama.includedUsd > 0);
  assert.ok(cfg.localProviders.includes("demo-gpu"));
  assert.equal(cfg.extraLedgers.length, 0);
  assert.ok(cfg.priceModels.length >= 4);
  const ext = summarizeExternal([join(dir, "extra-ledger.jsonl")], { since: "7d", now: summary.anchorMs });
  assert.ok(ext && ext.totals.calls >= 8);
  assert.deepEqual(JSON.parse(files.get("prices.json")), { "dashscope/qwen-flash": { inPerM: 0, outPerM: 0, billing: "free" } });
});

test("demo accounts: healthy, expiring and revoked, no secret values", () => {
  const { files, summary } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  const dir = dump(files);
  const manifest = JSON.parse(files.get("demo-manifest.json"));
  const a = readDemoAccounts({ dir, manifest });
  const by = Object.fromEntries(a.map((x) => [x.provider, x]));
  assert.equal(by.anthropic.health, "ok");
  assert.equal(by["openai-codex"].health, "expiring");
  assert.equal(by["github-copilot"].health, "refresh-failed");
  assert.equal(by["github-copilot"].terminal, true);
  assert.equal(by["github-copilot"].errorKind, "revoked");
  assert.equal(by.openrouter.health, "missing");
  assert.equal(by.xai.health, "missing");
  assert.equal(manifest.anchorMs, summary.anchorMs);
  assert.doesNotMatch(JSON.stringify(a), /demo/);
  const st = JSON.parse(files.get("accounts-state.json"));
  assert.deepEqual(Object.keys(st.providers), ["github-copilot"]);
  const acc = JSON.parse(files.get("demo-accounts.json"));
  assert.equal(acc.version, 1);
  assert.equal(acc.providers["openai-codex"].expires, summary.anchorMs + 8 * 60e3);
  assert.doesNotMatch(files.get("demo-accounts.json"), /"access"|"refresh"|token|secret/i);
});

test("the demo dir holds no network address except the unused GPU url", () => {
  const { files } = buildDemo({ at: AT, seed: 7, tzOffsetMin: 0 });
  let n = 0;
  for (const [, text] of files) for (const m of text.matchAll(/https?:\/\/[^\s"']*/g)) { n++; assert.equal(m[0], "http://127.0.0.1:9"); }
  assert.equal(n, 1);
  assert.deepEqual(DEMO_FILES.filter((f) => !files.has(f)), []);
  assert.ok(files.has("DEMO") && files.has("demo-manifest.json"));
  mkdirSync(join(tmp(), "x"));
  assert.ok(readdirSync(tmp()) !== null);
});
