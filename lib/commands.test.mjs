import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_NAMES, capsText, costText, createCommandDefs, registerCommands, routeText } from "./commands.mjs";
import { buildReceipt, receiptText, receiptReplyText } from "./cost/receipt.mjs";
import { writeDemo } from "./demo/write.mjs";
import { createCostEngine } from "./host/engine.mjs";
import { appendSpend, ledgerRows } from "./cost/ledger.mjs";
import { setCaps } from "./cost/caps.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEMO_LINE = "DEMO DATA: synthetic, nothing is recorded or capped";
const tmp = () => mkdtempSync(join(tmpdir(), "cmds-"));
const SID = "agent-session-0b8f3c2e-1111-4222-8333-444455556666";

function fakeService(throwFor = () => false) {
  const defs = [];
  return { defs, register(def) { if (throwFor(def.name)) throw new Error(`command "${def.name}" is already registered`); defs.push(def); return { dispose() {} }; } };
}

const CS = (over = {}) => ({
  limits: { dailyUsd: 25, sessionUsd: 15, perProviderDailyUsd: { google: 5 }, warnPct: 50 },
  todayUsd: 1.23, session: SID, complete: true, unreadable: false,
  guard: { onError: "allow", errors: { count: 0, last: null } }, reserved: { usd: 0, count: 0 },
  action: "ok", reason: "within caps", pct: 5, perProvider: { google: { capUsd: 5, spentUsd: 1.2 } }, ...over,
});
const row = (o = {}) => ({ v: 2, ts: "2026-11-12T10:00:00.000Z", sessionId: SID, provider: "google", model: "gemini-3.8-flash", billing: "metered", usd: 0.1, apiEquivUsd: 0.1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, purpose: "chat", turn: 1, ...o });

function deps(over = {}) {
  const dataDir = tmp();
  const rows = over.rows ?? [row(), row({ usd: 0.31, apiEquivUsd: 3.0, billing: "subscription", provider: "anthropic", model: "opus-x", turn: 2 })];
  const calls = { setCaps: 0, receiptIds: [], priceIds: [] };
  const d = {
    dataDir,
    engine: {
      capsStatus: () => CS(over.caps),
      prices: async (ids) => { calls.priceIds.push(...ids); return { models: Object.fromEntries(ids.map((i) => [i, over.price ?? { inPerM: 0.75, outPerM: 3.75, cacheReadPerM: 0.075, source: "litellm", billing: "metered", priced: true }])) }; },
      setCaps: () => { calls.setCaps++; },
    },
    sessions: { receipt: (id) => { calls.receiptIds.push(id); return { ...buildReceipt(rows, id), complete: true, unreadable: false }; } },
    routeAuth: () => over.routeAuth ?? { known: true, apiKeyRoutes: ["google"] },
    oauthProviders: () => over.oauth ?? ["anthropic"],
    demo: false,
    ...over.deps,
  };
  return { d, calls, defs: Object.fromEntries(createCommandDefs(d).map((x) => [x.name, x])) };
}
const agent = (provider = "google", model = "gemini-3.8-flash") => ({ id: SID, model: { current: () => ({ provider, model }) } });
const inv = (a = agent(), extra = {}) => ({ commandId: "c1", agent: a, rawInput: "", attachments: [], ...extra });
const text = async (defs, name, i = inv()) => { const r = await defs[name].handler(i); assert.equal(r.kind, "success", JSON.stringify(r)); return r.text; };
const noLongLines = (t) => { for (const l of t.split("\n")) assert.ok(l.length <= 100, `long line (${l.length}): ${l}`); assert.ok(!/^\s*\|/m.test(t) && !t.includes("|---"), "no table"); };

test("registerCommands registers all four names; definitions are argument-free, unrecorded and DSH-valid", () => {
  const { d } = deps();
  const svc = fakeService();
  const defs = createCommandDefs(d);
  const r = registerCommands(svc, defs, { warn: () => {} });
  assert.deepEqual(r, { registered: ["cost", "caps", "route", "receipt"], collided: [] });
  assert.deepEqual([...COMMAND_NAMES], ["cost", "caps", "route", "receipt"]);
  for (const def of svc.defs) {
    assert.equal(def.recordInput, false, def.name);
    assert.ok(def.description.length > 10, def.name);
    assert.equal("input" in def, false, def.name);
    assert.match(def.name, /^[a-z][a-z0-9_-]*$/);
    assert.equal(typeof def.handler, "function");
  }
});

test("a name collision logs exactly one warning naming the command, never throws, keeps the others, and is listed in collided", () => {
  const { d } = deps();
  const warns = [];
  const svc = fakeService((n) => n === "cost");
  const r = registerCommands(svc, createCommandDefs(d), { warn: (m) => warns.push(m) });
  assert.deepEqual(r, { registered: ["caps", "route", "receipt"], collided: ["cost"] });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /\/cost/);
  assert.doesNotMatch(warns[0], /\/caps|\/route|\/receipt/);
});

test("a service that throws for every name leaves registered empty and never throws", () => {
  const { d } = deps();
  const warns = [];
  let r;
  assert.doesNotThrow(() => { r = registerCommands(fakeService(() => true), createCommandDefs(d), { warn: (m) => warns.push(m) }); });
  assert.deepEqual(r, { registered: [], collided: ["cost", "caps", "route", "receipt"] });
  assert.equal(warns.length, 4);
  assert.doesNotThrow(() => registerCommands(null, createCommandDefs(d), { warn: () => {} }));
  assert.doesNotThrow(() => registerCommands({ register() { throw "boom"; } }, createCommandDefs(d), { warn: () => { throw new Error("warn itself fails"); } }));
});

const EXAMPLE_SID = "session-a8ca3061-8f13-4c1d-b4e2-33884a832efc";
// the designed replies of the redesign (T4): the example session of the mockups, exact strings
const exRow = (o) => ({ v: 2, sessionId: EXAMPLE_SID, input: 200, output: 50, cacheRead: 0, cacheWrite: 0, priceSource: "table", turn: null, ...o });
const at = (min, sec) => new Date(Date.UTC(2026, 10, 13, 0, 26 + min, sec)).toISOString();
const EXAMPLE_ROWS = [
  exRow({ ts: at(0, 10), provider: "anthropic", model: "claude-opus-4-7", billing: "subscription", usd: 0, apiEquivUsd: 0.1248, purpose: "chat", turn: 1, input: 1000 }),
  exRow({ ts: at(0, 40), provider: "anthropic", model: "claude-opus-4-7", billing: "subscription", usd: 0, apiEquivUsd: 0.0017, purpose: "session-title" }),
  exRow({ ts: at(2, 0), provider: "deepseek", model: "deepseek-v4.1-flash", billing: "metered", usd: 0.0022, apiEquivUsd: 0.0022, purpose: "chat", turn: 2, cacheRead: 1226 }),
  exRow({ ts: at(3, 0), provider: "deepseek", model: "deepseek-v4.1-flash", billing: "metered", usd: 0.0022, apiEquivUsd: 0.0022, purpose: "chat", turn: 2 }),
  exRow({ ts: at(4, 0), provider: "deepseek", model: "deepseek-v4.1-flash", billing: "metered", usd: 0.0022, apiEquivUsd: 0.0022, purpose: "chat", turn: 2 }),
  exRow({ ts: at(5, 0), provider: "deepseek", model: "deepseek-v4.1-flash", billing: "metered", usd: 0.0075, apiEquivUsd: 0.0075, purpose: "compaction" }),
];
const EX_COST = [
  "This session    $0.0141 charged of $15.00 · $14.99 left · $0.1265 not charged · 6 calls.",
  "Today             $9.31 charged of $40.00 · $30.69 left · within caps.",
  "",
  "Held for requests in flight: $0.00. If the cap check itself fails, requests go through.",
  "Not charged is the API value: the list price of calls on plan, credit, free and local routes.",
].join("\n");
const EX_CAPS = [
  "Caps: $40.00 a day · $15.00 a session · warning at 50% · no provider caps · today within caps.",
  "Claude plan stop is off: DSH keeps sending Claude requests when a plan window is full.",
  "Read-only here. Change caps in Settings > Models > Model hub, or run: dsh-hub caps set dailyUsd=10",
].join("\n");
const EX_ROUTE = [
  "deepseek/deepseek-v4.1-flash · Metered: charged per use · Signed in with an API key.",
  "Price per 1M tokens: $0.30 in · $1.20 out · $0.03 cache read · source: litellm.",
].join("\n");
const EX_RECEIPT = [
  "$0.0141 charged · $0.1265 API value not charged · 6 calls · 2 turns · cache read 38%.",
  "Nov 12, 7:26 PM to 7:31 PM · session-a8ca3061-8f13-4c1d-b4e2-33884a832efc",
  "",
  "By route                        Billing        Calls    Charged   Not charged",
  "anthropic/claude-opus-4-7       Subscription       2      $0.00       $0.1265",
  "deepseek/deepseek-v4.1-flash    Metered            4    $0.0141         $0.00",
  "",
  "By purpose                                     Calls    Charged     API value",
  "Chat                                               4    $0.0066       $0.1314",
  "Compaction                                         1    $0.0075       $0.0075",
  "Title                                              1      $0.00       $0.0017",
].join("\n");
const exCostData = (over = {}) => ({ demo: false, todayUsd: 9.31, limits: { dailyUsd: 40, sessionUsd: 15 }, session: { calls: 6, usd: 0.0141, apiEquivUsd: 0.1406, notChargedUsd: 0.1265 }, action: "ok", which: null, reason: "within caps", guard: { onError: "allow" }, reservedUsd: 0, complete: true, ...over });

test("the four replies for the example session are exactly the designed text (T4)", () => {
  assert.equal(costText(exCostData()), EX_COST);
  assert.equal(capsText({ demo: false, limits: { dailyUsd: 40, sessionUsd: 15, warnPct: 50 }, perProvider: {}, stopAtPlanLimit: false, action: "ok", which: null, reason: "within caps", problem: null }), EX_CAPS);
  assert.equal(routeText({ demo: false, route: { provider: "deepseek", model: "deepseek-v4.1-flash" }, price: { billing: "metered", inPerM: 0.3, outPerM: 1.2, cacheReadPerM: 0.03, source: "litellm", priced: true }, auth: "api-key" }), EX_ROUTE);
  const rc = buildReceipt(EXAMPLE_ROWS, EXAMPLE_SID);
  assert.equal(receiptReplyText(rc, { tz: "America/New_York" }), EX_RECEIPT);
  for (const t of [EX_COST, EX_CAPS, EX_ROUTE, EX_RECEIPT]) noLongLines(t);
  // DSH collapses newlines in the collapsed row: line 1 of every reply reads as a phrase on its own
  for (const t of [EX_COST, EX_CAPS, EX_ROUTE, EX_RECEIPT]) assert.match(t.split("\n")[0], /^[A-Z$a-z].*[.]$/);
});

test("/cost /caps /route /receipt through the handlers print the example text (real receipt builder, real handlers)", async () => {
  const dataDir = tmp();
  const d = {
    dataDir,
    engine: {
      capsStatus: () => CS({ limits: { dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: {}, warnPct: 50 }, todayUsd: 9.31, perProvider: {} }),
      prices: async (ids) => ({ models: { [ids[0]]: { inPerM: 0.3, outPerM: 1.2, cacheReadPerM: 0.03, source: "litellm", billing: "metered", priced: true } } }),
    },
    sessions: { receipt: (id) => ({ ...buildReceipt(EXAMPLE_ROWS, id), complete: true, unreadable: false }) },
    routeAuth: () => ({ known: true, apiKeyRoutes: ["deepseek"] }), oauthProviders: () => [], demo: false,
  };
  const defs = Object.fromEntries(createCommandDefs(d).map((x) => [x.name, x]));
  const a = { id: EXAMPLE_SID, model: { current: () => ({ provider: "deepseek", model: "deepseek-v4.1-flash" }) } };
  assert.equal(await text(defs, "cost", inv(a)), EX_COST);
  assert.equal(await text(defs, "caps", inv(a)), EX_CAPS);
  assert.equal(await text(defs, "route", inv(a)), EX_ROUTE);
  // the time of the span is local time: the same instant, in the zone this process runs in
  const local = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/[  ]/g, " ");
  const rec = (await text(defs, "receipt", inv(a))).split("\n");
  assert.equal(rec[1], `${local(at(0, 10))} to ${local(at(5, 0)).split(", ")[1]} · ${EXAMPLE_SID}`);
  assert.equal(rec.slice(2).join("\n"), EX_RECEIPT.split("\n").slice(2).join("\n"));
});

test("costText: every branch", () => {
  const base = exCostData();
  // no caps: the words say so
  const nocap = costText({ ...base, limits: { dailyUsd: 0, sessionUsd: 0 }, session: { calls: 1, usd: 0, apiEquivUsd: 0, notChargedUsd: 0 } });
  assert.match(nocap, /^This session    \$0\.00 charged · no session cap · 1 call\.$/m);
  assert.match(nocap, /^Today           \$9\.31 charged · no daily cap\.$/m);
  assert.ok(!/not charged|left/.test(nocap.split("\n").slice(0, 2).join(" ")), nocap);
  const none = costText({ ...base, session: { calls: 0, usd: 0, apiEquivUsd: 0, notChargedUsd: 0 } });
  assert.match(none, /^This session    no model calls recorded yet\.$/m);
  assert.match(costText({ ...base, session: null }), /^This session    not known\.$/m);
  assert.match(costText({ ...base, session: { calls: 0 }, complete: false }), /^This session    not known \(the ledger could not be read in full\)\.$/m);
  // warn / block: the verdict first, then the existing Why, then the numbers
  const warn = costText({ ...base, todayUsd: 31.2, action: "warn", which: "daily", reason: "daily $31.20 is 78% of $40" });
  assert.equal(warn.split("\n")[0], "Near the daily cap: requests still go through.");
  assert.equal(warn.split("\n")[1], "Why: daily $31.20 is 78% of $40");
  assert.match(warn, /^Today            \$31\.20 charged of \$40\.00 · \$8\.80 left · near the cap\.$/m);
  const block = costText({ ...base, todayUsd: 41, action: "block", which: "daily", reason: "daily cap $40 reached (spent $41.00 today)", guard: { onError: "block" }, reservedUsd: 0.5, complete: false });
  assert.equal(block.split("\n")[0], "Daily cap reached: metered requests are stopped.");
  assert.equal(block.split("\n")[1], "Why: daily cap $40 reached (spent $41.00 today)");
  assert.match(block, /^Today            \$41\.00 charged of \$40\.00 · \$0\.00 left · cap reached\.$/m);
  assert.match(block, /^Held for requests in flight: \$0\.50\. If the cap check itself fails, requests are refused\.$/m);
  assert.match(block, /^Ledger read was partial: totals may be low\.$/m);
  // a session cap in trouble says session, and does not claim the daily cap
  assert.equal(costText({ ...base, action: "warn", which: "session", reason: "session x" }).split("\n")[0], "Near the session cap: requests still go through.");
  assert.match(costText({ ...base, action: "warn", which: "session", reason: "x" }), /within caps\.$/m);
  const demo = costText({ ...base, demo: true });
  assert.equal(demo.split("\n")[0], DEMO_LINE);
  noLongLines(warn); noLongLines(block); noLongLines(demo); noLongLines(costText({ ...base, action: "warn", which: "daily", reason: "x".repeat(300) }));
});

test("capsText: every branch", () => {
  const base = { demo: false, limits: { dailyUsd: 25, sessionUsd: 15, perProviderDailyUsd: { google: 5, openai: 10 }, warnPct: 50 }, perProvider: { google: { capUsd: 5, spentUsd: 1.2 }, openai: { capUsd: 10, spentUsd: 0 } }, stopAtPlanLimit: false, action: "ok", which: null, reason: "within caps", problem: null };
  assert.equal(capsText(base), [
    "Caps: $25.00 a day · $15.00 a session · warning at 50% · provider caps below · today within caps.",
    "google   $5.00 a day · $1.20 spent today",
    "openai  $10.00 a day · $0.00 spent today",
    "Claude plan stop is off: DSH keeps sending Claude requests when a plan window is full.",
    "Read-only here. Change caps in Settings > Models > Model hub, or run: dsh-hub caps set dailyUsd=10",
  ].join("\n"));
  const off = capsText({ ...base, limits: { dailyUsd: 0, sessionUsd: 0, perProviderDailyUsd: {}, warnPct: 0 }, perProvider: {}, stopAtPlanLimit: true, action: "warn", which: "daily", reason: "daily 85% used", problem: "caps.json invalid: x; using defaults" });
  assert.equal(off.split("\n")[0], "Near the daily cap: requests still go through.");
  assert.equal(off.split("\n")[1], "Why: daily 85% used");
  assert.match(off, /^Caps: no daily cap · no session cap · no warning level · no provider caps · today near a cap\.$/m);
  assert.match(off, /^Claude plan stop is on: DSH refuses Claude requests when a plan window is full\.$/m);
  assert.match(off, /^A problem with caps\.json: caps\.json invalid: x; using defaults$/m);
  const blocked = capsText({ ...base, action: "block", which: "daily", reason: "daily cap $25 reached (spent $26.00 today)" });
  assert.equal(blocked.split("\n")[0], "Daily cap reached: metered requests are stopped.");
  assert.match(blocked, /^Why: daily cap \$25 reached/m);
  assert.equal(capsText({ ...base, demo: true }).split("\n")[0], DEMO_LINE);
  noLongLines(capsText(base)); noLongLines(off); noLongLines(blocked);
  assert.doesNotMatch(capsText(base), /=\d+\.\d|dailyUsd=\$/);
});

test("routeText: every branch", () => {
  const metered = { inPerM: 0.75, outPerM: 3.75, cacheReadPerM: 0.075, source: "litellm", billing: "metered", priced: true };
  assert.equal(routeText({ demo: false, route: { provider: "google", model: "gemini-3.8-flash" }, price: metered, auth: "api-key" }), [
    "google/gemini-3.8-flash · Metered: charged per use · Signed in with an API key.",
    "Price per 1M tokens: $0.75 in · $3.75 out · $0.075 cache read · source: litellm.",
  ].join("\n"));
  const unpriced = routeText({ demo: false, route: { provider: "x", model: "y" }, price: { source: "unpriced", billing: "metered", priced: false }, auth: "none" });
  assert.match(unpriced, /^x\/y · Metered: charged per use · No sign-in needed or found\.$/m);
  assert.match(unpriced, /^Price: not known \(unpriced\)\.$/m);
  // a subscription route is one line
  const sub = routeText({ demo: false, route: { provider: "anthropic", model: "claude-opus-4-7" }, price: { source: "subscription", billing: "subscription", priced: true, inPerM: 0, outPerM: 0 }, auth: "stored-sign-in" });
  assert.equal(sub, "anthropic/claude-opus-4-7 · Subscription: covered by your plan · Signed in with a stored sign-in.");
  assert.doesNotMatch(sub, /Price per 1M/);
  assert.match(routeText({ demo: false, route: { provider: "o", model: "m" }, price: { source: "local", billing: "local", priced: true }, auth: "none" }), /^o\/m · Local: runs on your machine, no charge · /m);
  assert.match(routeText({ demo: false, route: { provider: "o", model: "m" }, price: { source: "free", billing: "free", priced: true }, auth: "none" }), /^o\/m · Free: no charge · /m);
  assert.match(routeText({ demo: false, route: { provider: "o", model: "m" }, price: { source: "x", billing: "credits", priced: true }, auth: "none" }), /^o\/m · Credits: covered by prepaid credits · /m);
  assert.match(routeText({ demo: false, route: { provider: "g", model: "m" }, price: metered, auth: "unknown" }), /Sign-in not known \(route config unreadable\)\.$/m);
  assert.equal(routeText({ demo: false, route: null, price: null, auth: "unknown" }), "Route: not known (DSH has not reported this session's model yet).");
  assert.match(routeText({ demo: false, route: { provider: "g", model: "m" }, price: null, auth: "none" }), /^Price: not known\.$/m);
  assert.equal(routeText({ demo: true, route: null, price: null, auth: "unknown" }).split("\n")[0], DEMO_LINE);
  noLongLines(routeText({ demo: false, route: { provider: "google", model: "m".repeat(200) }, price: metered, auth: "api-key" }));
});

test("/cost reads the receipt of agent.id; without agent.id the session is 'not known'", async () => {
  const { defs, calls } = deps();
  const t = await text(defs, "cost");
  assert.deepEqual(calls.receiptIds, [SID]);
  assert.match(t, /^Today             \$1\.23 charged of \$25\.00 · \$23\.77 left · within caps\.$/m);
  assert.match(t, /^This session    \$0\.4100 charged of \$15\.00 · \$14\.59 left · \$2\.69 not charged · 2 calls\.$/m);
  const none = await text(defs, "cost", inv({ model: agent().model }));
  assert.match(none, /^This session    not known\.$/m);
  const bad = await text(defs, "cost", inv({ id: "../../etc/passwd", model: agent().model }));
  assert.match(bad, /^This session    not known\.$/m);
  assert.deepEqual(calls.receiptIds, [SID], "no receipt lookup for a missing or malformed id");
  noLongLines(t);
});

test("/cost says so when the ledger read is partial", async () => {
  const { defs } = deps({ caps: { complete: false } });
  assert.match(await text(defs, "cost"), /^Ledger read was partial: totals may be low\.$/m);
});

test("/cost and /caps judge the guard for the session that received the command, not the one the host saw last", async () => {
  // the host's capsStatus() describes session B (its last session): over its per-session cap. The command comes from session A.
  const other = { session: "other-session-B", sessionSpentUsd: 13, action: "warn", pct: 87, which: "session", reason: "session $13.00 is 87% of $15 (this session spent $13)" };
  const { defs } = deps({ caps: other });
  const cost = await text(defs, "cost");
  assert.match(cost, /^This session    \$0\.4100 charged/m, "A's own spend");
  assert.match(cost, /within caps\.$/m, cost);
  assert.doesNotMatch(cost, /^Why:/m, cost);
  assert.doesNotMatch(cost, /\$13/, "nothing of session B");
  const caps = await text(defs, "caps");
  assert.match(caps, /today within caps\./m, caps);
  assert.doesNotMatch(caps, /^Why:|\$13/m, caps);
  // and A's own spend over its cap is what A sees
  const nearCap = deps({ caps: other, rows: [row({ usd: 13, apiEquivUsd: 13 })] });
  const mine = await text(nearCap.defs, "cost");
  assert.equal(mine.split("\n")[0], "Near the session cap: requests still go through.", mine);
  assert.match(mine, /^Why: session \$13\.00 is 86% of \$15$/m, mine);
  const blocked = deps({ rows: [row({ usd: 15.5, apiEquivUsd: 15.5 })] });
  const b = await text(blocked.defs, "cost");
  assert.equal(b.split("\n")[0], "Session cap reached: metered requests are stopped.", b);
  assert.match(b, /^Why: per-session cap \$15 reached \(this session spent \$15\.50\)$/m, b);
  // a daily cap reached is the same whichever session asks, and /caps (no session) still reports it
  const day = deps({ caps: { todayUsd: 26 } });
  assert.equal((await text(day.defs, "caps")).split("\n")[0], "Daily cap reached: metered requests are stopped.");
  assert.equal((await text(day.defs, "cost")).split("\n")[0], "Daily cap reached: metered requests are stopped.");
  // without a session id the session cap is not applied (the reply says the session is not known)
  const none = await text(nearCap.defs, "cost", inv({ model: agent().model }));
  assert.match(none, /^This session    not known\./m);
  assert.doesNotMatch(none, /^Why:/m, none);
});

test("for the session the host itself judges, /cost's guard line equals engine.capsStatus() (real engine, real ledger)", async () => {
  for (const [spent, want] of [[0.5, "ok"], [9, "warn"], [16, "block"]]) {
    const dataDir = tmp();
    assert.equal(setCaps(dataDir, { dailyUsd: 100, sessionUsd: 15, warnPct: 50 }).ok, true);
    appendSpend(dataDir, { ts: new Date().toISOString(), sessionId: SID, provider: "google", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: spent, apiEquivUsd: spent, billing: "metered" });
    const engine = createCostEngine({ dataDir, loadTable: async () => ({ entries: {}, overrides: {}, source: "network", fetchedAt: 1, count: 0, warnings: [] }) });
    const cs = engine.capsStatus();
    assert.equal(cs.session, SID);
    assert.equal(cs.action, want);
    const d = { dataDir, engine, sessions: { receipt: (id) => ({ ...buildReceipt(ledgerRows(dataDir).rows, id), complete: true, unreadable: false }) }, routeAuth: () => ({ known: true, apiKeyRoutes: [] }), oauthProviders: () => [], demo: false };
    const defs = Object.fromEntries(createCommandDefs(d).map((x) => [x.name, x]));
    const t = await text(defs, "cost");
    assert.match(t.split("\n")[0], { ok: /^This session/, warn: /^Near the session cap: requests still go through\.$/, block: /^Session cap reached: metered requests are stopped\.$/ }[want], t);
    if (want === "ok") assert.doesNotMatch(t, /^Why:/m);
    else assert.ok(t.includes(`Why: ${cs.reason}`), `${t}\n--- engine: ${cs.reason}`);
  }
});

test("/caps is read-only: arguments are ignored, no write function exists in the module, setCaps is never called", async () => {
  const { defs, calls } = deps();
  const plain = await text(defs, "caps");
  for (const raw of ["dailyUsd=9999", "set dailyUsd=0", " sessionUsd=1e9 stopAtPlanLimit=off"]) {
    assert.equal(await text(defs, "caps", inv(agent(), { rawInput: raw })), plain, raw);
  }
  assert.equal(calls.setCaps, 0);
  const src = readFileSync(join(HERE, "commands.mjs"), "utf8");
  for (const w of ["setCaps", "saveCaps", "applyCapsChange", "writeFile", "appendFile", "rename(", "unlink", "mkdir", "node:fs"]) assert.ok(!src.includes(w), `commands.mjs must not mention ${w}`);
  assert.match(plain, /^Read-only here\./m);
});

test("/caps shows stopAtPlanLimit and a caps.json problem from the caps file in the data dir", async () => {
  const { d } = deps();
  writeFileSync(join(d.dataDir, "caps.json"), JSON.stringify({ dailyUsd: 25, sessionUsd: 15, warnPct: 50, stopAtPlanLimit: true }));
  const t = await text(Object.fromEntries(createCommandDefs(d).map((x) => [x.name, x])), "caps");
  assert.match(t, /^Claude plan stop is on: /m);
  const { d: d2 } = deps();
  writeFileSync(join(d2.dataDir, "caps.json"), "{not json");
  const t2 = await text(Object.fromEntries(createCommandDefs(d2).map((x) => [x.name, x])), "caps");
  assert.match(t2, /^A problem with caps\.json: /m);
  assert.ok(!t2.includes(d2.dataDir), "no path");
});

test("/route uses agent.model.current(), the price layer and routeAuth; it never prints a key, token, URL or env name", async () => {
  const { defs, calls } = deps();
  const t = await text(defs, "route", inv(agent(), { rawInput: " sk-ant-abc123 apiKeyEnv=GOOGLE_API_KEY https://x.example/v1" }));
  assert.deepEqual(calls.priceIds, ["google/gemini-3.8-flash"]);
  assert.match(t, /^google\/gemini-3\.8-flash · Metered: charged per use · Signed in with an API key\.$/m);
  assert.match(t, /^Price per 1M tokens: \$0\.75 in · \$3\.75 out · \$0\.075 cache read · source: litellm\.$/m);
  for (const bad of ["sk-", "apiKeyEnv", "API_KEY", "http", "abc123", "x.example"]) assert.ok(!t.includes(bad), bad);
  const oauth = await text(defs, "route", inv(agent("anthropic", "opus-x")));
  assert.match(oauth, /^google\/gemini-3\.8-flash|^anthropic\/opus-x · .* · Signed in with a stored sign-in\.$/m);
  const none = await text(defs, "route", inv(agent("ollama", "glm")));
  assert.match(none, / · No sign-in needed or found\.$/m);
  const unk = await createCommandDefs(deps({ routeAuth: { known: false, apiKeyRoutes: [] }, oauth: [] }).d).find((x) => x.name === "route").handler(inv(agent("ollama", "glm")));
  assert.match(unk.text, / · Sign-in not known \(route config unreadable\)\.$/m);
});

test("/route sanitises route names that carry odd characters", async () => {
  const { defs } = deps();
  const t = await text(defs, "route", inv(agent("goo\ngle", "m<script>")));
  assert.ok(!t.includes("<") && !t.includes("script>"));
  assert.equal(t.split("\n")[0].startsWith("goo_gle/m_script_"), true);
});

test("/route says 'not known' when agent.model is missing, throws, or names no model", async () => {
  const { defs } = deps();
  for (const a of [{ id: SID }, { id: SID, model: { current: () => { throw new Error("boom sk-ant-secret1234567890"); } } }, { id: SID, model: { current: () => undefined } }, { id: SID, model: {} }, undefined]) {
    const r = await defs.route.handler({ commandId: "c", agent: a, rawInput: "", attachments: [] });
    assert.equal(r.kind, "success");
    assert.equal(r.text, "Route: not known (DSH has not reported this session's model yet).");
  }
});

test("/receipt prints the session receipt text; unknown session and empty session are plain sentences", async () => {
  const { defs, d } = deps();
  const t = await text(defs, "receipt");
  assert.equal(t, receiptReplyText(buildReceipt([row(), row({ usd: 0.31, apiEquivUsd: 3.0, billing: "subscription", provider: "anthropic", model: "opus-x", turn: 2 })], SID)));
  assert.match(t, /^By route {2,}Billing {2,}Calls {2,}Charged {2,}Not charged$/m);
  assert.match(t, /^By purpose {2,}Calls {2,}Charged {2,}API value$/m);
  noLongLines(t);
  assert.match(await text(defs, "receipt", inv({ model: agent().model })), /^This session: not known\.$/m);
  const empty = await text(Object.fromEntries(createCommandDefs({ ...d, sessions: { receipt: (id) => ({ ...buildReceipt([], id), complete: true, unreadable: false }) } }).map((x) => [x.name, x])), "receipt");
  assert.match(empty, /No model calls recorded for this session yet\./);
  const partial = await text(Object.fromEntries(createCommandDefs({ ...d, sessions: { receipt: (id) => ({ ...buildReceipt([row()], id), complete: false, unreadable: false }) } }).map((x) => [x.name, x])), "receipt");
  assert.match(partial, /^Ledger read was partial: totals may be low\.$/m);
  const emptyPartial = await text(Object.fromEntries(createCommandDefs({ ...d, sessions: { receipt: (id) => ({ ...buildReceipt([], id), complete: false, unreadable: true }) } }).map((x) => [x.name, x])), "receipt");
  assert.doesNotMatch(emptyPartial, /No model calls recorded/);
  assert.match(emptyPartial, /could not be read in full/);
  const emptyCost = await text(Object.fromEntries(createCommandDefs({ ...d, sessions: { receipt: (id) => ({ ...buildReceipt([], id), complete: false, unreadable: true }) } }).map((x) => [x.name, x])), "cost");
  assert.doesNotMatch(emptyCost, /no model calls recorded/);
  assert.match(emptyCost, /^This session    not known \(the ledger could not be read in full\)\.$/m);
});

test("the handler refuses a non-user source (defence in depth: CommandInvocation has no source field today) and accepts user or none", async () => {
  const { defs } = deps();
  for (const name of COMMAND_NAMES) {
    for (const source of [{ kind: "model" }, null, "user", {}, 0]) {
      const r = await defs[name].handler(inv(agent(), { source }));
      assert.equal(r.kind, "error", `${name} ${JSON.stringify(source)}`);
      assert.match(r.text, /^refused: slash commands are for the person typing them\.$/);
    }
    assert.equal((await defs[name].handler(inv(agent(), { source: { kind: "user" } }))).kind, "success", name);
    assert.equal((await defs[name].handler(inv())).kind, "success", name);
  }
  assert.equal((await defs.cost.handler(undefined)).kind, "success");
});

test("a handler that throws returns a redacted error result and never rejects", async () => {
  const { d } = deps();
  const boom = { ...d, engine: { ...d.engine, capsStatus: () => { throw new Error("read failed token=abcdef1234567890SECRET at " + d.dataDir); } }, sessions: { receipt: () => { throw new Error("sk-ant-api03-ZZZZZZZZZZZZZZZZZZ " + d.dataDir); } } };
  const defs = Object.fromEntries(createCommandDefs(boom).map((x) => [x.name, x]));
  for (const name of ["cost", "caps", "receipt"]) {
    let r;
    await assert.doesNotReject(async () => { r = await defs[name].handler(inv()); });
    assert.equal(r.kind, "error", name);
    assert.match(r.text, /could not read the ledger \(see dsh-hub doctor\)/);
    assert.ok(!/SECRET|sk-ant|abcdef1234/.test(r.text) && !r.text.includes(d.dataDir), name);
  }
});

test("replies never contain the data dir path", async () => {
  const { d, defs } = deps({ caps: { reason: `limit hit under ${"/x"}` } });
  d.engine.capsStatus = () => CS({ action: "warn", reason: `see ${d.dataDir}/caps.json for details` });
  const defs2 = Object.fromEntries(createCommandDefs(d).map((x) => [x.name, x]));
  for (const name of COMMAND_NAMES) {
    const t = await text(defs2, name);
    assert.ok(!t.includes(d.dataDir), `${name} leaked the data dir`);
  }
  assert.ok(defs);
});

test("demo: every reply starts with the DEMO line", async () => {
  const { defs } = deps({ deps: { demo: true } });
  for (const name of COMMAND_NAMES) assert.equal((await text(defs, name)).split("\n")[0], DEMO_LINE, name);
  const off = deps();
  for (const name of COMMAND_NAMES) assert.ok(!(await text(off.defs, name)).includes("DEMO DATA"), name);
});

test("demo commands over the demo engine read only the demo folder (fs spy in a child process)", () => {
  const base = tmp();
  const home = join(base, "home");
  mkdirSync(home);
  const w = writeDemo({ out: join(base, "demo"), at: "2026-11-12T15:00:00Z", seed: 3, tzOffsetMin: 0, env: { DSH_HUB_DATA_DIR: join(base, "data"), DSH_HOME: join(base, "dsh"), HOME: home }, home });
  const code = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const demoDir = fs.realpathSync(${JSON.stringify(w.out)}); const lib = ${JSON.stringify(HERE)};
    const outside = [];
    const note = (p) => { const s = String(p); if (typeof p !== "string" && !(p instanceof URL)) return; if (!(s === demoDir || s.startsWith(demoDir + "/") || s.startsWith(lib) || s.startsWith("/dev/") || s.startsWith("file://"))) outside.push(s); };
    let armed = false;
    for (const k of ["readFileSync", "openSync", "readdirSync", "statSync", "lstatSync", "existsSync", "accessSync", "mkdirSync", "writeFileSync", "renameSync", "appendFileSync"]) {
      const o = fs[k]; fs[k] = (p, ...a) => { if (armed) note(p); return o(p, ...a); };
    }
    syncBuiltinESMExports();
    globalThis.fetch = async () => { throw new Error("network forbidden"); };
    const { resolveDemo } = await import(${JSON.stringify(join(HERE, "demo", "gate.mjs"))});
    const { createDemoHub } = await import(${JSON.stringify(join(HERE, "demo", "host.mjs"))});
    const { createCommandDefs } = await import(${JSON.stringify(join(HERE, "commands.mjs"))});
    const demo = resolveDemo({ DSH_HUB_DEMO: demoDir, DSH_HUB_DATA_DIR: ${JSON.stringify(join(base, "data"))}, DSH_HOME: ${JSON.stringify(join(base, "dsh"))}, HOME: ${JSON.stringify(home)} }, { home: ${JSON.stringify(home)} });
    const hub = createDemoHub({ demo, allowedOrigins: [] });
    await hub.replayed;
    armed = true;
    const defs = createCommandDefs({ engine: hub.engine, dataDir: demo.dir, sessions: hub.sessions, routeAuth: hub.routeAuth, oauthProviders: hub.oauthProviders, demo: true });
    const agent = { id: "demo-s-conv", model: { current: () => ({ provider: "google", model: "gemini-3.8-flash" }) } };
    const replies = {};
    for (const d of defs) replies[d.name] = await d.handler({ commandId: "c", agent, rawInput: "", attachments: [] });
    armed = false; hub.stop();
    console.log("RESULT " + JSON.stringify({ outside, replies }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { PATH: process.env.PATH, HOME: home, DSH_HUB_DATA_DIR: join(base, "data"), DSH_HOME: join(base, "dsh"), DSH_NODE_MODULES: join(base, "nm") }, encoding: "utf8", timeout: 60_000 });
  const r = JSON.parse(out.split("\n").reverse().find((l) => l.startsWith("RESULT ")).slice(7));
  assert.deepEqual(r.outside, [], "no path outside the demo folder was touched");
  for (const name of COMMAND_NAMES) {
    assert.equal(r.replies[name].kind, "success", name);
    assert.equal(r.replies[name].text.split("\n")[0], DEMO_LINE, name);
  }
  assert.match(r.replies.receipt.text, /demo-s-conv/);
  assert.ok(!JSON.stringify(r.replies).includes(base), "no path in a reply");
});
