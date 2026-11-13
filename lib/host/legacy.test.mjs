import test from "node:test";
import assert from "node:assert/strict";
import { createLegacy } from "./legacy.mjs";
import fs, { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlanHistory } from "../plan-history.mjs";

const features = { imageCap: () => true, compactionSlim: () => true, spendGuard: () => true };
const NOW = 2e12;

function mkLegacy({ expiresAt, codex, signedIn = true }) {
  let reads = 0;
  const legacy = createLegacy({
    features,
    deps: {
      now: () => NOW,
      status: () => ({ signedIn, expiresAt }),
      readAccounts: () => [codex],
      planStore: { read: async () => { reads++; return { mode: "subscription", httpStatus: 200 }; } },
    },
  });
  return { legacy, reads: () => reads };
}

test("expired Anthropic grant: no usage API call, plan.mode expired with expiresAt", async () => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  const { legacy, reads } = mkLegacy({ expiresAt: NOW - 53 * 864e5, codex: { signedIn: false, expired: false } });
  const s = await legacy.status();
  assert.deepEqual(s.plan, { mode: "expired", expiresAt: NOW - 53 * 864e5 });
  assert.equal(s.signedIn, true);
  assert.equal(reads(), 0);
  assert.ok(!("access" in s), "the Full access switch is gone from /status");
});

test("live grant still reads plan usage; codex.available follows the openai-codex grant", async () => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  let r = mkLegacy({ expiresAt: NOW + 1e6, codex: { signedIn: true, expired: false } });
  let s = await r.legacy.status();
  assert.equal(s.plan.mode, "subscription");
  assert.equal(r.reads(), 1);
  assert.deepEqual(s.codex, { available: true });
  r = mkLegacy({ expiresAt: NOW + 1e6, codex: { signedIn: true, expired: true } });
  assert.deepEqual((await r.legacy.status()).codex, { available: false });
  r = mkLegacy({ expiresAt: null, codex: undefined });
  assert.deepEqual((await r.legacy.status()).codex, { available: false });
});

test("the plan card follows the credential DSH sends: a route API key wins; an env key only when nothing is stored", async () => {
  const mkL = ({ signedIn, routeKey }) => createLegacy({ features, deps: {
    now: () => NOW, status: () => ({ signedIn, expiresAt: NOW + 1e6 }), readAccounts: () => [],
    planStore: { read: async () => ({ mode: "subscription", httpStatus: 200 }) }, routeUsesApiKey: () => routeKey,
  } });
  process.env.ANTHROPIC_API_KEY = "sk-ant-demo-not-real";
  try {
    assert.equal((await mkL({ signedIn: true, routeKey: false }).status()).plan.mode, "subscription", "a stored grant owns the provider");
    assert.equal((await mkL({ signedIn: false, routeKey: false }).status()).plan.mode, "api", "nothing stored: the env key is used");
  } finally { delete process.env.ANTHROPIC_API_KEY; }
  assert.equal((await mkL({ signedIn: true, routeKey: true }).status()).plan.mode, "api", "the route names an API key");
});

test("/status plan carries the model weekly windows, the scoped weekly and whether extra usage is known", async () => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  const opus = { percent: 100, resetsAt: "2026-09-17T14:00:00.000Z" };
  const sonnet = { percent: 7, resetsAt: "2026-09-17T14:00:00.000Z" };
  const scoped = { percent: 26, resetsAt: null, label: "Sonnet" };
  const card = (extra) => ({ mode: "plan", httpStatus: 200, ...extra });
  const mk = (c) => createLegacy({ features, deps: { now: () => NOW, status: () => ({ signedIn: true, expiresAt: NOW + 1e9 }), readAccounts: () => [{ signedIn: false, expired: false }], planStore: { read: async () => c } } });
  const viaParsed = (await mk(card({ parsed: { fiveHour: null, sevenDay: null, scopedWeekly: scoped, sevenDayOpus: opus, sevenDaySonnet: sonnet, extraEnabled: false, extraKnown: true } })).status()).plan;
  assert.deepEqual(viaParsed.sevenDayOpus, opus);
  assert.deepEqual(viaParsed.sevenDaySonnet, sonnet);
  assert.deepEqual(viaParsed.scopedWeekly, scoped);
  assert.equal(viaParsed.extraKnown, true);
  const direct = (await mk(card({ sevenDayOpus: opus, extraKnown: true, extraEnabled: true })).status()).plan;
  assert.deepEqual(direct.sevenDayOpus, opus);
  assert.equal(direct.extraKnown, true);
  const bare = (await mk(card({})).status()).plan;
  assert.equal(bare.sevenDayOpus, null);
  assert.equal(bare.sevenDaySonnet, null);
  assert.equal(bare.scopedWeekly, null);
  assert.equal(bare.extraKnown, false, "unknown stays unknown, never claimed");
});

test("planSnapshot returns the plan object status() serves, and rejects when the store rejects", async () => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  const card = { mode: "plan", fetchedAt: NOW - 5, fiveHour: { percent: 100, resetsAt: "2026-11-12T15:00:00Z" }, sevenDay: { percent: 3, resetsAt: null }, sevenDayOpus: { percent: 40, resetsAt: null }, extraEnabled: true, extraKnown: true, messages: 4, modelCalls: 9 };
  const mk = (read) => createLegacy({ features, deps: { now: () => NOW, status: () => ({ signedIn: true, expiresAt: NOW + 1e6 }), readAccounts: () => [{ signedIn: false }], planStore: { read } } });
  const legacy = mk(async () => card);
  const snap = await legacy.planSnapshot();
  assert.deepEqual(snap, (await legacy.status()).plan);
  assert.equal(snap.mode, "plan"); assert.equal(snap.fetchedAt, NOW - 5); assert.equal(snap.fiveHour.percent, 100); assert.equal(snap.sevenDayOpus.percent, 40);
  await assert.rejects(mk(async () => { throw new Error("store down"); }).planSnapshot(), /store down/);
});

test("status() and identities() never wait on the profile fetch: a hanging fetch still answers at once, the identity appears once it lands", async () => {
  const NOW = Date.UTC(2026, 10, 12, 12);
  let release = null;
  const { createIdentityStore } = await import("../plan-usage.mjs");
  const identityStore = createIdentityStore({ now: () => NOW, getToken: () => "tok-AAAAAAAA", fetchProfile: () => new Promise((res) => { release = () => res({ ok: true, data: { account: { email: "a@x.io" } } }); }) });
  const L = createLegacy({ features, deps: { now: () => NOW, status: () => ({ signedIn: true, expiresAt: NOW + 1e9 }), readAccounts: () => [{ signedIn: false }], planStore: { read: async () => ({ mode: "plan", fiveHour: { percent: 3, resetsAt: null } }) }, identityStore } });
  const t0 = Date.now();
  const first = await L.status();
  assert.ok(Date.now() - t0 < 500, "status() did not wait for the hanging profile fetch");
  assert.equal(first.identity, undefined);
  assert.deepEqual(await L.identities(), {});
  release(); await new Promise((r) => setImmediate(r));
  assert.equal((await L.status()).identity.email, "a@x.io");
  assert.equal((await L.identities()).anthropic.email, "a@x.io");
});

test("with planHistoryDir the real store writes a reading per fetch through planSnapshot; without it nothing is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-plan-history-"));
  let t = NOW, fetches = 0, pct = 30;
  const usage = () => ({ ok: true, status: 200, data: { five_hour: { utilization: pct, resets_at: new Date(NOW + 3 * 3600e3).toISOString() }, seven_day: { utilization: 8.2, resets_at: new Date(NOW + 4 * 864e5).toISOString() }, extra_usage: { is_enabled: false } } });
  const mk = (extra) => createLegacy({ features, deps: { now: () => t, status: () => ({ signedIn: true, expiresAt: NOW + 1e9 }), readAccounts: () => [{ signedIn: false }], identityStore: { read: async () => null }, getToken: () => "tok-not-written", fetchUsage: async () => { fetches++; return usage(); }, countWindow: async () => ({ messages: 1, modelCalls: 1 }), ...extra } });
  const legacy = mk({ planHistoryDir: dir });
  const snap = await legacy.planSnapshot();
  assert.equal(snap.mode, "plan");
  assert.equal(fetches, 1);
  let rows = readPlanHistory(dir, { now: NOW }).rows;
  assert.deepEqual(rows.map((r) => [r.window, r.percent, r.fetchedAt]), [["fiveHour", 30, NOW], ["sevenDay", 8, NOW]]);
  await legacy.planSnapshot();
  assert.equal(fetches, 1, "the 60 s cache: no new reading");
  t += 61e3; pct = 33;
  await legacy.planSnapshot();
  assert.equal(fetches, 2);
  rows = readPlanHistory(dir, { now: t }).rows;
  assert.equal(rows.length, 3, "the five-hour window changed, the unchanged weekly one is not repeated inside 5 minutes");
  assert.equal(rows[2].percent, 33);
  assert.ok(!/tok-not-written/.test(readFileSync(join(dir, "plan-history.jsonl"), "utf8")));
  // without planHistoryDir nothing is written: no process ever opens a plan-history file
  const opened = [];
  const realOpen = fs.openSync;
  fs.openSync = function spy(p, ...rest) { if (String(p).includes("plan-history")) opened.push(String(p)); return realOpen.call(this, p, ...rest); };
  try {
    t += 61e3; pct = 40; fetches = 0;
    const plain = mk({});
    assert.equal((await plain.planSnapshot()).mode, "plan");
    assert.equal(fetches, 1);
    assert.deepEqual(opened, []);
    t += 61e3; pct = 41;
    await legacy.planSnapshot();
    assert.equal(opened.length >= 1, true, "the spy does see the writer when a directory is given");
  } finally { fs.openSync = realOpen; }
});
