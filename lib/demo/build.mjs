// lib/demo/build.mjs: the synthetic demo data set. Pure: no file, no clock when `at` is given, no network.
// Same inputs (at, seed, tzOffsetMin) give byte-identical files.
import { createHash } from "node:crypto";
import { applyCredits, chargedUsd, costOf, priceFor } from "../cost/index.mjs";
import {
  DEMO_CONV_SESSION, DEMO_CONV_SUB, DEMO_DAILY_CAP_USD, DEMO_DEFAULT_SEED, DEMO_FILES, DEMO_GPU_ID, DEMO_GPU_URL, DEMO_MANIFEST, DEMO_MARKER, DEMO_VERSION, MARKER_LINE,
} from "./constants.mjs";
import { DEMO_LOCAL_PROVIDERS, DEMO_OAUTH_PROVIDERS, DEMO_OVERRIDES, demoPriceTable } from "./prices.mjs";

const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const DAYS = 7;
const PLAN_INCLUDED_USD = 12;
const PLAN_TARGET_TOTAL_USD = 16.2;     // API value of the Ollama calls in the window: crosses the included credits
const TODAY_TARGET_USD = DEMO_DAILY_CAP_USD * 0.8;
const r6 = (x) => Number(x.toFixed(6));

/** "now" | ISO string | ms | Date -> ms floored to the UTC hour. Throws Error("bad --at"). */
export function parseAt(at, nowMs = Date.now()) {
  let ms;
  if (at === undefined || at === null || at === "now") ms = nowMs;
  else if (typeof at === "number") ms = at;
  else if (at instanceof Date) ms = at.getTime();
  else if (typeof at === "string" && /^\d{4}-\d{2}-\d{2}/.test(at)) ms = Date.parse(at);
  else ms = NaN;
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > Date.UTC(2100, 0, 1)) throw new Error("bad --at");
  return Math.floor(ms / HOUR) * HOUR;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

const ANTHROPIC = ["anthropic", "claude-sonnet-5-5"];
const CODEX = ["openai-codex", "gpt-5.5-codex"];
const GOOGLE = ["google", "gemini-3.8-flash"];
const OPENROUTER = ["openrouter", "deepseek/deepseek-v4-pro"];
const MYSTERY = ["openrouter", "acme/mystery-1"];
const OLLAMA_MODELS = ["glm-5.3-flash", "deepseek-v4.1-flash"];
const FREE = ["dashscope", "qwen-flash"];
const LOCAL = [DEMO_GPU_ID, "demo-qwen-32b"];

export function buildDemo({ at = "now", seed = DEMO_DEFAULT_SEED, tzOffsetMin } = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error("bad --seed");
  let anchorMs = parseAt(at);
  let off = tzOffsetMin === undefined ? -new Date(anchorMs).getTimezoneOffset() : tzOffsetMin;
  if (!Number.isInteger(off) || Math.abs(off) > 14 * 60) throw new Error("bad tzOffsetMin");
  off += 0; // no negative zero
  const midOf = (ms) => Math.floor((ms + off * MIN) / DAY) * DAY - off * MIN;
  let anchorAdjusted = false;
  if (anchorMs - midOf(anchorMs) < 120 * MIN) { anchorMs = midOf(anchorMs) + 120 * MIN; anchorAdjusted = true; }
  const mid = midOf(anchorMs);

  const rng = mulberry32(seed);
  const rnd = (lo, hi) => lo + rng() * (hi - lo);
  const int = (lo, hi) => Math.round(rnd(lo, hi));

  // Day windows. Rows stay 70 min away from local midnight so a DST shift cannot move a row to the wrong day.
  const winOf = (d) => (d < DAYS - 1
    ? [mid - (DAYS - 1 - d) * DAY + 70 * MIN, mid - (DAYS - 1 - d) * DAY + 22 * HOUR]
    : [mid + 70 * MIN, anchorMs - 1]);
  const todayFrac = Math.max(0.05, Math.min(1, (anchorMs - 1 - (mid + 70 * MIN)) / (22 * HOUR - 70 * MIN)));
  const fracOf = (d) => (d < DAYS - 1 ? 1 : todayFrac);
  const times = (d, n) => { const [a, b] = winOf(d); return Array.from({ length: n }, () => Math.floor(rnd(a, b))).sort((x, y) => x - y); };

  const events = [];
  let gen = 0;
  const push = (cat, [provider, model], ms, usage, sessionId, v2) => events.push({ cat, provider, model, ms, usage, sessionId, v2, gen: gen++ });

  // chunk the sorted times of one day/category into sessions of 12 calls
  const sessionsOf = (cat, prefix, pm, d, n, usageOf, modelOf) => {
    const ts = times(d, n);
    let model = pm[1];
    ts.forEach((ms, i) => {
      if (i % 12 === 0 && modelOf) model = modelOf();
      push(cat, [pm[0], model], ms, usageOf(), `demo-s-${prefix}${d}${Math.floor(i / 12)}`);
    });
  };

  for (let d = 0; d < DAYS; d++) {
    const f = fracOf(d);
    sessionsOf("anthropic", "a", ANTHROPIC, d, Math.max(4, Math.round(36 * f)), () => ({ input: int(1500, 8000), output: int(400, 4500), cacheRead: int(40000, 150000), cacheWrite: int(0, 6000) }));
    sessionsOf("codex", "c", CODEX, d, Math.max(3, Math.round(20 * f)), () => ({ input: int(3000, 14000), output: int(300, 3000), cacheRead: int(20000, 90000), cacheWrite: 0 }));
    sessionsOf("google", "g", GOOGLE, d, d === DAYS - 1 ? Math.max(24, Math.round(30 * f)) : 30, () => ({ input: int(60000, 300000), output: int(2000, 12000), cacheRead: int(100000, 500000), cacheWrite: 0 }));
    sessionsOf("openrouter", "o", OPENROUTER, d, Math.max(3, Math.round(10 * f)), () => ({ input: int(30000, 150000), output: int(1500, 6000), cacheRead: int(0, 200000), cacheWrite: 0 }));
    sessionsOf("ollama", "l", ["ollama", OLLAMA_MODELS[0]], d, Math.max(6, Math.round(60 * f)), () => ({ input: int(40000, 160000), output: int(2000, 8000), cacheRead: int(100000, 400000), cacheWrite: 0 }), () => OLLAMA_MODELS[rng() < 0.5 ? 0 : 1]);
    sessionsOf("free", "f", FREE, d, Math.max(3, Math.round(12 * f)), () => ({ input: int(20000, 80000), output: int(1000, 6000), cacheRead: 0, cacheWrite: 0 }));
    sessionsOf("local", "x", LOCAL, d, Math.max(2, Math.round(8 * f)), () => ({ input: int(3000, 20000), output: int(300, 2000), cacheRead: 0, cacheWrite: 0 }));
  }
  for (const d of [1, 3, DAYS - 1]) {
    const ms = times(d, 1)[0];
    push("unpriced", MYSTERY, ms, { input: int(20000, 60000), output: int(1000, 3000), cacheRead: 0, cacheWrite: 0 }, "demo-s-u");
  }

  // Two Claude sessions whose cache behaviour is spelled out in demo-cache.json: one healthy, one that collapses at its end.
  const cacheSessions = [];
  const cacheSession = (sessionId, startMs, stepMin, hits) => {
    const steps = hits.map((hit, i) => {
      const prompt = 60000 + 1000 * i;
      const cacheWrite = hit ? 1000 : 0;
      const cacheRead = hit ? Math.round(prompt * hit) : 0;
      const usage = { inputTokens: prompt - cacheRead - cacheWrite, outputTokens: int(600, 2400), cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
      push("anthropic", ANTHROPIC, startMs + i * stepMin * MIN, { input: usage.inputTokens, output: usage.outputTokens, cacheRead, cacheWrite }, sessionId);
      return { step: i + 1, usage };
    });
    cacheSessions.push({ sessionId, provider: ANTHROPIC[0], model: ANTHROPIC[1], steps });
  };
  cacheSession("demo-s-warm", mid - DAY + 10 * HOUR, 5, [0.9, 0.92, 0.93, 0.94, 0.94, 0.95]);
  cacheSession("demo-s-cache", anchorMs - 25 * MIN, 5, [0.93, 0.94, 0.95, 0.95, 0]);

  // extra (display-only) ledger
  const extra = [];
  for (let d = 0; d < DAYS; d++) for (const ms of times(d, d % 2 ? 1 : 2)) extra.push({ ts: new Date(ms).toISOString(), usd: r6(rnd(0.05, 0.6)), provider: "meter" });

  // One conversation with Ledger v2 rows (turn, step, purpose, timings), drawn after every other random number so the rest of
  // the data set keeps its values: four turns (two subscription, one with a compaction call while it ran, one metered), a
  // session-title call between turns, and a subagent. It ends 30 minutes before the anchor, before the newest cache session.
  const convStart = anchorMs - 50 * MIN;
  const convUsage = (lo) => ({ input: int(lo[0], lo[1]), output: int(lo[2], lo[3]), cacheRead: int(lo[4], lo[5]), cacheWrite: int(lo[6], lo[7]) });
  const convCall = (cat, pm, sessionId, ms, purpose, turn, step, lo, parent = null) => push(cat, pm, ms, convUsage(lo), sessionId, {
    purpose, turn, step, parentSessionId: parent, finish: "stop", ttftMs: int(400, 1500), durationMs: int(2000, 9000),
  });
  const SUBSCRIBED = [1500, 8000, 400, 3000, 40000, 120000, 0, 3000];
  for (let i = 0; i < 3; i++) convCall("conv", ANTHROPIC, DEMO_CONV_SESSION, convStart + i * 20e3, "chat", 1, i + 1, SUBSCRIBED);
  convCall("conv", ANTHROPIC, DEMO_CONV_SESSION, convStart + 55e3, "session-title", null, null, [200, 600, 10, 40, 0, 0, 0, 0]);
  for (let i = 0; i < 3; i++) convCall("conv", ANTHROPIC, DEMO_CONV_SESSION, convStart + 3 * MIN + i * 20e3, "chat", 2, i + 1, SUBSCRIBED);
  convCall("conv", ANTHROPIC, DEMO_CONV_SESSION, convStart + 6 * MIN, "chat", 3, 1, SUBSCRIBED);
  convCall("conv", ANTHROPIC, DEMO_CONV_SESSION, convStart + 6 * MIN + 60e3, "compaction", null, null, [30000, 60000, 1000, 3000, 0, 0, 0, 0]);
  convCall("conv", ANTHROPIC, DEMO_CONV_SESSION, convStart + 6 * MIN + 120e3, "chat", 3, 2, SUBSCRIBED);
  for (let i = 0; i < 2; i++) convCall("conv", GOOGLE, DEMO_CONV_SESSION, convStart + 12 * MIN + i * 30e3, "chat", 4, i + 1, [20000, 50000, 500, 2000, 20000, 80000, 0, 0]);
  for (let i = 0; i < 2; i++) convCall("conv-sub", OPENROUTER, DEMO_CONV_SUB, convStart + 7 * MIN + i * 30e3, "chat", 1, i + 1, [10000, 30000, 500, 2000, 0, 20000, 0, 0], DEMO_CONV_SESSION);

  // ---- pricing
  const table = demoPriceTable({ overrides: DEMO_OVERRIDES });
  const popts = (ms) => ({ at: ms, oauthProviders: DEMO_OAUTH_PROVIDERS, localProviders: DEMO_LOCAL_PROVIDERS, subscriptions: [] });
  const priceOf = (ev) => priceFor(table, ev.provider, ev.model, popts(ev.ms));
  const costUsd = (ev) => costOf(ev.usage, priceOf(ev)).usd;

  // Scale the Ollama calls so their API value crosses the plan's included credits partway through the week.
  const ollamaEvents = events.filter((e) => e.cat === "ollama");
  const rawTotal = ollamaEvents.reduce((s, e) => s + costUsd(e), 0);
  const k = PLAN_TARGET_TOTAL_USD / rawTotal;
  for (const e of ollamaEvents) for (const f of ["input", "output", "cacheRead"]) e.usage[f] = Math.max(f === "output" ? 1 : 0, Math.round(e.usage[f] * k));

  const order = [...events].sort((a, b) => a.ms - b.ms || a.gen - b.gen);
  const plan = { name: "Pro", includedUsd: PLAN_INCLUDED_USD };
  function priceAll() {
    let used = 0;
    return order.map((ev) => {
      const price = priceOf(ev);
      const cost = costOf(ev.usage, price);
      let usd, apiEquivUsd = cost.usd, billing = price.billing;
      if (ev.provider === "ollama") {
        const ac = applyCredits(plan, used, cost.usd);
        used += cost.usd;
        usd = ac.usd; apiEquivUsd = ac.apiEquivUsd; billing = ac.billing;
      } else usd = chargedUsd(cost, price);
      return { ev, usd, apiEquivUsd, billing, priceSource: price.source, cost };
    });
  }
  const todayMetered = (priced, skip) => priced.reduce((s, p) => s + (p.ev.ms >= mid && p.billing === "metered" && p.ev !== skip ? p.usd : 0), 0);

  // Today's metered spend lands on 80% of the daily cap: scale today's Google calls, then fit the last one exactly.
  let priced = priceAll();
  const gToday = events.filter((e) => e.cat === "google" && e.ms >= mid);
  const gSum = priced.filter((p) => gToday.includes(p.ev)).reduce((s, p) => s + p.usd, 0);
  const fixed = priced.reduce((s, p) => s + (p.ev.ms >= mid && p.billing === "metered" && p.ev.cat !== "google" ? p.usd : 0), 0);
  const f = (TODAY_TARGET_USD - 0.1 - fixed) / gSum;
  if (!(f > 0.05 && f < 60)) throw new Error("demo build invariant: today's spend cannot be fitted to the cap");
  for (const e of gToday) for (const key of ["input", "output", "cacheRead"]) e.usage[key] = Math.max(key === "output" ? 1 : 0, Math.round(e.usage[key] * f));
  priced = priceAll();
  const last = gToday.reduce((a, b) => (b.ms > a.ms || (b.ms === a.ms && b.gen > a.gen) ? b : a));
  const lastPrice = priceOf(last);
  const rest = todayMetered(priced, last);
  const nonOut = costOf({ ...last.usage, output: 0 }, lastPrice).usd;
  const outTokens = Math.round(((TODAY_TARGET_USD - rest - nonOut) / lastPrice.outPerM) * 1e6);
  if (!(outTokens >= 1)) throw new Error("demo build invariant: the last Google call cannot absorb the remainder");
  last.usage.output = outTokens;
  priced = priceAll();
  const todayUsd = r6(todayMetered(priced, null));
  if (!(todayUsd >= DEMO_DAILY_CAP_USD * 0.795 && todayUsd <= DEMO_DAILY_CAP_USD * 0.805)) throw new Error("demo build invariant: today's spend is not 80% of the cap");

  const ol = priced.filter((p) => p.ev.provider === "ollama");
  const crossings = ol.filter((p) => p.billing === "metered" && p.usd > 0 && p.usd < p.apiEquivUsd);
  const ci = ol.indexOf(crossings[0]);
  if (!ol.some((p) => p.billing === "credits") || crossings.length !== 1 || ol.slice(ci + 1).some((p) => p.billing !== "metered" || p.usd !== p.apiEquivUsd)) {
    throw new Error("demo build invariant: the Ollama plan does not cross into overage exactly once");
  }

  const lines = priced.map((p, i) => JSON.stringify({
    ts: new Date(p.ev.ms).toISOString(), sessionId: p.ev.sessionId, provider: p.ev.provider, model: p.ev.model,
    input: p.ev.usage.input, output: p.ev.usage.output, cacheRead: p.ev.usage.cacheRead, cacheWrite: p.ev.usage.cacheWrite,
    usd: p.usd, apiEquivUsd: p.apiEquivUsd, priceSource: p.priceSource, billing: p.billing,
    id: `demo-${sha256(`${seed}:${i}`).slice(0, 20)}`,
    ...(p.ev.v2 ? {
      v: 2, purpose: p.ev.v2.purpose, turn: p.ev.v2.turn, step: p.ev.v2.step, parentSessionId: p.ev.v2.parentSessionId,
      rates: p.cost.rates, derived: [], tier: p.cost.tier, offPeak: false, planCoveredUsd: 0, reasoning: null,
      finish: p.ev.v2.finish, ttftMs: p.ev.v2.ttftMs, durationMs: p.ev.v2.durationMs,
    } : {}),
  }));

  // ---- the other files
  const resetsOnDay = Math.min(28, new Date(anchorMs - 10 * DAY).getUTCDate());
  const copilotExpires = anchorMs - 3 * HOUR;
  const data = new Map();
  data.set("spend.jsonl", `${lines.join("\n")}\n`);
  data.set("caps.json", json({ dailyUsd: DEMO_DAILY_CAP_USD, sessionUsd: 50, perProviderDailyUsd: {}, warnPct: 50 }));
  data.set("config.json", json({
    gpuServer: { id: DEMO_GPU_ID, name: "Demo GPU box", url: DEMO_GPU_URL, icon: "nvidia", defaultModel: LOCAL[1] },
    priceModels: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-5.5-codex", "google/gemini-3.8-flash", "openrouter/deepseek/deepseek-v4-pro", "ollama/glm-5.3-flash", "ollama/deepseek-v4.1-flash", "dashscope/qwen-flash"],
    plans: { ollama: { name: plan.name, includedUsd: plan.includedUsd, resetsOnDay } },
  }));
  data.set("prices.json", json(DEMO_OVERRIDES));
  data.set("accounts-state.json", json({
    updatedAt: anchorMs,
    providers: { "github-copilot": { lastRefreshAt: null, lastError: "refresh failed: invalid_grant", lastAttemptAt: anchorMs - 5 * MIN, errorKind: "revoked", terminal: true, terminalExpiresAt: copilotExpires, errorExpiresAt: copilotExpires } },
  }));
  data.set("demo-accounts.json", json({
    version: 1,
    providers: {
      anthropic: { expires: anchorMs + 2.5 * DAY, hasRefresh: true },
      "openai-codex": { expires: anchorMs + 8 * MIN, hasRefresh: true },
      "github-copilot": { expires: copilotExpires, hasRefresh: true },
    },
  }));
  data.set("extra-ledger.jsonl", `${extra.map((r) => JSON.stringify(r)).join("\n")}\n`);
  data.set("demo-cache.json", json({ version: 1, sessions: cacheSessions }));

  const manifest = {
    version: DEMO_VERSION, seed, anchor: new Date(anchorMs).toISOString(), anchorMs, tzOffsetMin: off, generator: "dsh-hub demo",
    files: Object.fromEntries(DEMO_FILES.map((n) => [n, sha256(data.get(n))])),
  };
  const files = new Map(DEMO_FILES.map((n) => [n, data.get(n)]));
  files.set(DEMO_MANIFEST, json(manifest));
  files.set(DEMO_MARKER, `${MARKER_LINE}\n`);
  return {
    files,
    summary: { anchor: manifest.anchor, anchorMs, anchorAdjusted, seed, tzOffsetMin: off, rows: lines.length, days: DAYS, todayUsd, dailyCapUsd: DEMO_DAILY_CAP_USD },
  };
}
