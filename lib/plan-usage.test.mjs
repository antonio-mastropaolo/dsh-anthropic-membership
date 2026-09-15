import { strict as assert } from "node:assert";
import {
  parseUsagePayload,
  formatPlanLines,
  createPlanUsageStore,
  FIVE_HOUR_MS,
} from "./plan-usage.mjs";

/** Exact live payload shape from the DSH membership grant (2026-09-15). */
const LIVE = {
  five_hour: { utilization: 85.0, resets_at: "2026-09-15T20:20:00.133840+00:00" },
  seven_day: { utilization: 40.0, resets_at: "2026-09-17T14:00:00.133860+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, utilization: 0.6895 },
  limits: [
    { kind: "session", percent: 85, resets_at: "2026-09-15T20:20:00.133840+00:00" },
    { kind: "weekly_all", percent: 40, resets_at: "2026-09-17T14:00:00.133860+00:00" },
    { kind: "weekly_scoped", percent: 26, resets_at: "2026-09-17T14:00:00.134027+00:00" },
  ],
  spend: { ignore: true },
};

const parsed = parseUsagePayload(LIVE);
assert.equal(parsed.fiveHour.percent, 85);
assert.equal(parsed.sevenDay.percent, 40);
assert.equal(parsed.extraEnabled, false);
assert.equal(parsed.scopedWeekly, null, "unlabeled weekly_scoped is omitted");

const reset = parseUsagePayload({
  ...LIVE,
  five_hour: { utilization: 0, resets_at: LIVE.five_hour.resets_at },
});
assert.equal(reset.fiveHour.percent, 0, "a reset 5h window is 0%, not missing");

const planText = formatPlanLines({
  mode: "plan",
  parsed,
  messages: 12,
  modelCalls: 47,
  now: Date.parse("2026-09-15T16:00:00Z"),
  timeZone: "America/New_York",
}).join("\n");

assert.match(planText, /5-hour window: 85% used/);
assert.match(planText, /Weekly: 40% used/);
assert.match(planText, /Sent from DSH this window: 12 messages · 47 model calls/);
assert.match(planText, /Usage % counts every Claude app/);
assert.match(planText, /Message counts are DSH only/);
assert.match(planText, /does not publish remaining messages/i);
assert.doesNotMatch(planText, /\d+\s+remaining/i);
assert.doesNotMatch(planText, /\bleft\b/i);
assert.doesNotMatch(planText, /\$/);
assert.doesNotMatch(planText, /\btok(?:ens?)?\b/i);
assert.doesNotMatch(planText, /148/);
assert.doesNotMatch(planText, /0\.6895/);
assert.doesNotMatch(planText, /69%/);
assert.doesNotMatch(planText, /Extra usage/i);
assert.doesNotMatch(planText, /expires/i);

const extraOn = parseUsagePayload({
  ...LIVE,
  extra_usage: { is_enabled: true, utilization: 0.6895 },
});
const extraText = formatPlanLines({
  mode: "plan",
  parsed: extraOn,
  messages: 1,
  modelCalls: 1,
  now: Date.parse("2026-09-15T16:00:00Z"),
  timeZone: "UTC",
}).join("\n");
assert.match(extraText, /Extra usage enabled/);
assert.match(extraText, /billed to your Anthropic balance/);
assert.doesNotMatch(extraText, /0\.6895/);
assert.doesNotMatch(extraText, /69%/);

const apiText = formatPlanLines({ mode: "api" }).join("\n");
assert.match(apiText, /Using Anthropic API key \(billed per token\)/);
assert.match(apiText, /Switch to membership/);

const unavail = formatPlanLines({
  mode: "unavailable",
  httpStatus: 429,
  fetchedAt: Date.parse("2026-09-15T16:00:00Z"),
  lastGood: parsed,
  messages: 12,
  modelCalls: 47,
  now: Date.parse("2026-09-15T16:00:00Z"),
  timeZone: "UTC",
}).join("\n");
assert.match(unavail, /Plan usage unavailable \(429\)/);
assert.match(unavail, /85% used/);

assert.equal(FIVE_HOUR_MS, 5 * 60 * 60 * 1000);

let fetches = 0;
const store = createPlanUsageStore({
  now: () => 1_000_000,
  getToken: () => "test-token",
  fetchUsage: async () => {
    fetches += 1;
    return { ok: true, status: 200, data: LIVE };
  },
  countWindow: async () => ({ messages: 12, modelCalls: 47 }),
  cacheMs: 60_000,
  backoffMs: 300_000,
});
const a = await store.read();
const b = await store.read();
assert.equal(fetches, 1, "60s cache: two reads, one upstream");
assert.equal(a.mode, "plan");
assert.equal(a.fiveHour.percent, 85);
assert.equal(b.messages, 12);

const errStore = createPlanUsageStore({
  now: () => 1_000_000,
  getToken: () => "test-token",
  fetchUsage: async () => ({ ok: false, status: 429, data: null }),
  countWindow: async () => ({ messages: 0, modelCalls: 0 }),
  cacheMs: 60_000,
  backoffMs: 300_000,
});
const e1 = await errStore.read();
assert.equal(e1.mode, "unavailable");
assert.equal(e1.httpStatus, 429);

console.log("pass");
