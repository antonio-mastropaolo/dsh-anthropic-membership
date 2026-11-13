#!/usr/bin/env node
/**
 * dsh-hub: CLI for dsh-model-hub. Every command accepts --json.
 *   status | accounts | gpus | switch <model> [--gpus 2,3] | unload | spend [--since] [--by] | spend --session <id|last> --by turn
 *   | ledger verify [--since] | ledger export (--csv|--jsonl) [--since] [--out <file>] [--force]
 *   | receipt <session-id|last> [--md] | prices <provider/model…> | plans | forecast | caps [--check] | caps set key=value… | cache [--session <id>] | doctor
 *   | demo --out <dir> [--at <ISO time|now>] [--seed <n>] [--force]
 * Offline-capable: accounts, spend (also spend --session --by turn), receipt, ledger, prices, plans, forecast, caps (read/write the data dir). Needs DSH running: status, cache.
 * Demo mode: when DSH_HUB_DATA_DIR holds a sealed DEMO folder every command answers in-process from it (no host call,
 * no credential file, no fetch) and prints the DEMO DATA banner first.
 * Talks to the configured GPU server (config.json) directly for gpus/switch/unload. Never prints secrets.
 */
import { dshHome } from "../lib/paths.mjs";
import { redactSecrets } from "../lib/accounts/errors.mjs";
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccounts } from "../lib/accounts/index.mjs";
import { createCostEngine, DEFAULT_DATA_DIR } from "../lib/host/engine.mjs";
import { exportRows, exportTargetIsLedger, readExportRows, verifyLedger, writeExport } from "../lib/cost/verify.mjs";
import { loadConfig } from "../lib/config.mjs";
import { capsView, loadCaps, parseCapsAssignments, setCaps } from "../lib/cost/caps.mjs";
import { buildForecast } from "../lib/cost/forecast.mjs";
import { ledgerRows } from "../lib/cost/ledger.mjs";
import { buildTurns, latestSessionId, SESSION_ID_RE } from "../lib/cost/turns.mjs";
import { buildReceipt, receiptMarkdown, receiptText, safe } from "../lib/cost/receipt.mjs";
import { fmtUsdSmall } from "../lib/cost/money.mjs";
import { readPlanHistory } from "../lib/plan-history.mjs";
import { createGpuClient, errMessage, MODEL_RE, parseGpus } from "../lib/host/gpu.mjs";
import { DemoError, writeDemo } from "../lib/demo/write.mjs";
import { demoMarked, verifyDemoDir } from "../lib/demo/gate.mjs";
import { DEMO_IDENTITY, DEMO_TEXT } from "../lib/demo/constants.mjs";
import { readDemoAccounts } from "../lib/demo/accounts.mjs";
import { createDemoEngine, replayDemoCache } from "../lib/demo/engine.mjs";
import { createDemoGpuClient } from "../lib/demo/gpu.mjs";
import { createDemoLegacy } from "../lib/demo/legacy.mjs";

// the host API answers GETs (other than /healthz) only with this header, as the web UI sends it
const HUB_HEADERS = Object.freeze({ "x-dsh-model-hub": "1" });

const HUB_URL = "http://127.0.0.1:8185";
const USAGE = `usage: dsh-hub <command> [--json]
  status                      host API health + plugin features + slash commands + plan
  accounts                    provider sign-in / expiry / watchdog state
  gpus                        GPU server cards, loaded model, stale reservations
  switch <model> [--gpus 2,3 | --auto] [--force]
                              load a model on the GPU server; --gpus pins it, --auto clears a pin, --force overrides the 300 s lease
  unload                      unload the GPU server's model now
  spend [--since today|7d|30d|all] [--by provider|model|session|day|purpose]
  spend --session <id|last> --by turn [--json]
                              per-turn cost of one session (offline; last = the newest session in the ledger)
  receipt <session-id|last> [--md|--json]
                              one session's money: charged, API value (not charged), by route / purpose, subagents, billing kinds (offline; --md = Markdown to paste into a PR)
  ledger verify [--since today|7d|30d|all]
                              re-derive every v2 row's usd / apiEquivUsd from its own tokens and rates; torn lines, duplicate ids (exit 1 on a mismatch or torn line)
  ledger export (--csv|--jsonl) [--since today|7d|30d|all] [--out <file>] [--force]
                              the ledger rows (ledger fields only) as CSV or JSON Lines; stdout, or --out (mode 0600, never overwrites without --force)
  prices <provider/model…>    price rows (litellm / ollama / override / unpriced); ollama/<model> shows its rate, off-peak rate, source and date
  plans                       prepaid plan credits (config.json plans): used this cycle, remaining, resets
  forecast                    estimates: burn rate, when each cap and plan credit is reached at this pace (estimates, not limits; works with DSH stopped)
  caps [--check]              spend caps, their source file and today's status; with --check the exit code is 0 ok, 10 at/over warnPct, 11 a cap reached, 1 ledger unreadable/partial or caps.json invalid
  caps set key=value ...      dailyUsd= sessionUsd= warnPct= (1-99) provider.<id>= (number or off); 0/off = off; stopAtPlanLimit=on|off (refuse Claude subscription requests at 100% of a plan window); works with DSH stopped
  cache [--session <id>]      prompt-cache hit ratios
  doctor                      end-to-end health check (exit 1 on any failure; a demo folder: warning)
  demo --out <dir> [--at <ISO time|now>] [--seed <n>] [--force]
                              write a synthetic DEMO data folder (nothing real is read or written outside it)`;

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const valued = new Set(["since", "by", "gpus", "session", "out", "at", "seed"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (valued.has(k)) {
        const v = inline ?? argv[++i];
        if (v === undefined || v.startsWith("--")) throw new CliError(`--${k} needs a value`, 2);
        flags[k] = v;
      } else if (k === "json" || k === "help" || k === "auto" || k === "force" || k === "check" || k === "csv" || k === "jsonl" || k === "md") flags[k] = true;
      else throw new CliError(`unknown flag --${k}`, 2);
    } else pos.push(a);
  }
  return { pos, flags };
}

const SINCE_VALUES = /^(today|7d|30d|all)$/;
const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
const fmtUsd = fmtUsdSmall;
/** `status` lines for the Claude plan: one per window the endpoint reported, then the extra-usage state (only while the plan is readable). */
function planWindowLines(plan) {
  if (!plan || (plan.mode !== "plan" && plan.mode !== "unavailable")) return [];
  const win = (label, w) => (w && typeof w.percent === "number" ? [`window ${label.padEnd(13)} ${w.percent}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ""}`] : []);
  const out = [
    ...win("5h", plan.fiveHour),
    ...win("weekly", plan.sevenDay),
    ...win("weekly opus", plan.sevenDayOpus),
    ...win("weekly sonnet", plan.sevenDaySonnet),
    ...(plan.scopedWeekly?.label ? win(String(plan.scopedWeekly.label), plan.scopedWeekly) : []),
  ];
  if (plan.mode === "plan") out.push(`extra usage ${plan.extraKnown ? (plan.extraEnabled ? "on" : "off") : "not reported"}`);
  return out;
}
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** Human output of `spend --session <id> --by turn`. */
function turnsHuman(b) {
  const calls = b.turns.reduce((s, t) => s + t.calls, 0);
  const money = (x) => (x.usd > 0 ? fmtUsd(x.usd) : `${fmtUsd(x.apiEquivUsd)} API value`);
  const purposes = (list) => list.map((p) => `${safe(p.purpose)} x${p.calls} ${money(p)}`).join(", ");
  if (!b.turns.length) {
    const head = b.v1Calls ? `session ${b.sessionId}: no turn data (${plural(b.v1Calls, "call")} before ledger v2)` : `session ${b.sessionId}: no turns`;
    return [head, ...(b.outside.calls ? [`  outside turns: ${purposes(b.outside.byPurpose)}`] : [])].join("\n");
  }
  const lines = [`session ${b.sessionId}: ${plural(b.turns.length, "turn")}, ${plural(calls, "call")}${b.v1Calls ? `, ${plural(b.v1Calls, "call")} before ledger v2` : ""}${b.truncated ? " (newest turns only)" : ""}`];
  for (const t of b.turns) {
    const kinds = Object.keys(t.billings).filter((k) => k !== "metered");
    const pricedMetered = (t.billings.metered || 0) - t.unpricedCalls;
    const charged = [t.usd > 0 || pricedMetered > 0 ? `${fmtUsd(t.usd)} charged` : null, ...kinds, t.unpricedCalls ? "price unknown" : null].filter((x) => x !== null).join(" + ");
    lines.push([
      `  turn ${t.turn}`.padEnd(9) + ` ${charged}`,
      t.notChargedUsd > 0 ? `API value ${fmtUsd(t.notChargedUsd)} not charged` : null,
      `${fmtK(t.input + t.cacheRead + t.cacheWrite)} in / ${fmtK(t.output)} out`,
      t.cacheReadShare === null ? null : `cache ${Math.round(t.cacheReadShare * 100)}%`,
      `first token ${t.ttftMs === null ? "-" : `${(t.ttftMs / 1000).toFixed(1)} s`}`,
      plural(t.calls, "call"),
      t.routes.length === 1 ? `${safe(t.routes[0].provider)}/${safe(t.routes[0].model)}` : `${t.routes.length} routes`,
    ].filter((x) => x !== null).join("  "));
    if (t.during.length) lines.push(`  during turn ${t.turn}: ${purposes(t.during)}`);
  }
  if (b.outside.calls) lines.push(`  outside turns: ${purposes(b.outside.byPurpose)}`);
  return lines.join("\n");
}
const fmtMs = (ms) => {
  if (ms === null || ms === undefined) return "-";
  const neg = ms < 0;
  const s = Math.abs(Math.round(ms / 1000));
  const t = s >= 86400 ? `${Math.floor(s / 86400)}d` : s >= 3600 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 60)}m`;
  return neg ? `${t} ago` : `in ${t}`;
};

// ---- `forecast` formatting: 24 h local clock, with a short weekday when the day is not today ----
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n) => String(n).padStart(2, "0");
const usdH = (n) => `$${n >= 0.1 ? n.toFixed(2) : n.toFixed(3)}`;
const usd2 = (n) => `$${n.toFixed(2)}`;
function clock(ms, now) {
  const d = new Date(ms);
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? hhmm : `${WEEKDAYS[d.getDay()]} ${hhmm}`;
}
// a range end of null means "not within the horizon at that pace"
const clockRange = (r, now) => (r ? `${r.earliestAt === null ? "later" : clock(r.earliestAt, now)}-${r.latestAt === null ? "later" : clock(r.latestAt, now)}` : "later");
const fmtAge = (ms) => {
  const age = Math.max(0, ms);
  if (age < 60e3) return "under a minute";
  if (age < 120 * 60e3) return `${Math.round(age / 60e3)} min`;
  return age < 48 * 3600e3 ? `${Math.round(age / 3600e3)} h` : `${Math.round(age / 86400e3)} d`;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** The text for one Claude plan window of the report's `plan.windows`, or null when there is nothing to say. now = the report's clock. */
function planWindowText(w, now, short = false) {
  if (!w) return null;
  const reset = Date.parse(w.resetsAt);
  if (w.status === "limit") {
    const range = typeof w.latestAt === "number" ? `range ${clock(w.earliestAt, now)}-${clock(w.latestAt, now)}` : `range from ${clock(w.earliestAt, now)}`;
    return short ? `limit ~${clock(w.limitAt, now)}, ${plural(w.readings, "reading")}` : `limit ~${clock(w.limitAt, now)} (${range}), ${plural(w.readings, "reading")}, before the reset at ${clock(reset, now)}`;
  }
  if (w.status === "no-limit") {
    const hedged = w.mayReach === true && typeof w.earliestAt === "number";
    if (short) return hedged ? "probably not before the reset" : "won't reach 100% before the reset";
    return hedged ? `probably not before the reset at ${clock(reset, now)} (could be ~${clock(w.earliestAt, now)} at the fastest pace)` : `won't reach 100% before the reset at ${clock(reset, now)}`;
  }
  if (short) return null;
  if (w.status === "insufficient") return `not enough readings (${w.readings})`;
  if (w.status === "stale") return `no forecast: last reading ${fmtAge(w.ageMs)} ago`;
  if (w.status === "reset") return `window reset at ${clock(reset, now)}, waiting for a new reading`;
  if (w.status === "at-limit") return "at 100% now";
  return null;
}
const PLAN_WINDOWS = [["fiveHour", "claude 5-hour", "claude 5h"], ["sevenDay", "claude weekly", "claude weekly"]];
/** Rows [label, text] for the Claude plan part of the report. */
function planForecastRows(plan, now) {
  if (!plan) return [];
  if (plan.lastReadingAt === null || plan.lastReadingAt === undefined) return [["claude plan", "no plan readings yet (written while the Claude plan card is read)"]];
  const rows = [];
  for (const [key, label] of PLAN_WINDOWS) { const t = planWindowText(plan.windows?.[key], now); if (t) rows.push([label, t]); }
  rows.push(["claude plan", `last reading ${fmtAge(plan.ageMs)} ago (${clock(plan.lastReadingAt, now)})`]);
  return rows;
}
/** The one-line spend summary (same wording as the Costs card), or null while the pace is suppressed. */
function spendSummaryLine(sp, now) {
  const c = sp && sp.complete !== false ? sp.charged : null;
  if (!c || c.status !== "ok" || !c.ratePerHour || !c.projectedTodayUsd) return null;
  const caps = Array.isArray(sp.caps) ? sp.caps : [];
  const name = (e) => (e.which === "provider-daily" ? String(e.provider) : e.which === "session" ? "session" : "daily");
  const first = caps.filter((e) => e.state === "at-pace" && typeof e.reachedAt === "number").reduce((a, e) => (!a || e.reachedAt < a.reachedAt ? e : a), null);
  const daily = caps.find((e) => e.which === "daily");
  const capParts = caps.filter((e) => e.state === "reached").map((e) => `${name(e)} cap reached`);
  if (first) capParts.push(`${name(first)} cap ~${clock(first.reachedAt, now)}`);
  else if (daily && daily.state === "not-at-this-pace") capParts.push("daily cap: not at this pace");
  return [`${usdH(c.ratePerHour.m15)}/h now (15 min)`, `today ~${usd2(c.projectedTodayUsd.mid)}`, ...capParts].join(" · ");
}
/** `status` lines: the spend summary and one per Claude window with a forecast. */
function forecastSummaryLines(rep) {
  if (!rep) return [];
  const now = rep.spend?.generatedAt ?? rep.generatedAt ?? Date.now();
  const lines = [];
  const sp = spendSummaryLine(rep.spend, now);
  if (sp) lines.push(`forecast   ${sp}`);
  for (const [key, , label] of PLAN_WINDOWS) { const t = planWindowText(rep.plan?.windows?.[key], now, true); if (t) lines.push(`forecast   ${label}: ${t}`); }
  return lines;
}
function forecastHuman(rep) {
  const sp = rep.spend, now = sp.generatedAt;
  const row = (label, text) => `${label.padEnd(14)} ${text}`;
  const out = ["forecast (estimates, not limits; nothing here blocks a request)"];
  const tail = () => [...(rep.capsProblem ? [row("caps.json", rep.capsProblem)] : []), ...planForecastRows(rep.plan, now).map(([l, t]) => row(l, t))];
  if (sp.complete === false) return [...out, row("charged now", `no forecast: ${sp.reason}`), ...tail()].join("\n");
  const c = sp.charged;
  if (c.status === "ok") {
    out.push(row("charged now", `${usdH(c.ratePerHour.m15)}/h (15 min) · ${usdH(c.ratePerHour.m60)}/h (60 min) · ${c.calls15} metered call${c.calls15 === 1 ? "" : "s"} in 15 min`));
    const p = c.projectedTodayUsd;
    out.push(row("today", `${usd2(c.todayUsd)} so far · ~${usd2(p.mid)} by midnight (range ${usd2(p.low)}-${usd2(p.high)})`));
  } else {
    out.push(row("charged now", `no forecast: ${c.reason}`));
    out.push(row("today", `${usd2(c.todayUsd)} so far`));
  }
  const state = (e) => {
    if (e.state === "reached") return "reached";
    if (e.state === "suppressed") return `suppressed, ${e.reason}`;
    if (e.state === "not-at-this-pace") return "not at this pace";
    return `~${clock(e.reachedAt, now)} (range ${clockRange(e.range, now)})`;
  };
  for (const e of sp.caps) {
    const label = e.which === "daily" ? "daily cap" : e.which === "provider-daily" ? `provider ${e.provider} cap` : "session cap";
    const who = e.which === "session" ? ` (${String(e.sessionId).slice(0, 16)})` : "";
    out.push(row(label, `${usd2(e.capUsd)}${who}: ${state(e)}`));
  }
  const a = sp.apiValue;
  if (a && a.status === "ok") out.push(row("API value", `${usdH(a.ratePerHour.m15)}/h (15 min) · ${usdH(a.ratePerHour.m60)}/h (60 min), not charged (subscription and credits)`));
  for (const p of sp.plans) {
    const reset = p.resetsAt.slice(0, 10);
    const text = p.state === "exhausted" ? `exhausted (resets ${reset})`
      : p.state === "suppressed" ? `suppressed, ${p.reason}`
        : p.state === "not-before-reset" ? `credits not used up before the reset on ${reset} at this pace`
          : `credits run out ~${clock(p.runsOutAt, now)} (range ${clockRange(p.range, now)})`;
    out.push(row(`plan ${p.provider}`, `${p.name}: ${text}`));
  }
  return [...out, ...tail()].join("\n");
}

export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const env = io.env ?? process.env;
  const home = io.home ?? homedir();
  const nowFn = io.now ?? Date.now;
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const dataDir = env.DSH_HUB_DATA_DIR || DEFAULT_DATA_DIR;
  const hubUrl = env.DSH_HUB_URL || HUB_URL;
  const credentialsPath = env.DSH_HUB_CREDENTIALS || undefined;
  // Demo mode: only a DEMO marker in the data dir; the folder must then verify (sealed), else every command stops.
  const probe = demoMarked(dataDir) ? verifyDemoDir(dataDir) : null;
  const demo = probe?.ok ? { dir: dataDir, manifest: probe.manifest } : null;
  const cfg = loadConfig({ dataDir, env: probe ? {} : env });
  const gpu = io.gpu ?? (demo ? createDemoGpuClient() : createGpuClient({ getConfig: () => cfg, fetchImpl }));
  const gpuConfigured = Boolean(io.gpu || cfg.gpuServer);
  const gpuName = cfg.gpuServer?.name ?? "GPU server";

  // with --json, every failure is a JSON object on stdout ({error, code}) so scripts can parse it
  const wantsJson = Array.isArray(argv) && argv.includes("--json");
  // every failure leaves through here: redacted, and with --json a {error, code} object on stdout
  const fail = (message, code) => {
    const m = redactSecrets(String(message));
    if (wantsJson) out(JSON.stringify({ error: m, code }));
    else err(m);
    return code;
  };
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { if (!wantsJson) { err(redactSecrets(e.message)); err(USAGE); return e.code ?? 2; } return fail(e.message, e.code ?? 2); }
  const { pos, flags } = parsed;
  const [cmd, ...rest] = pos;
  if (!cmd && !flags.help && wantsJson) return fail("missing command (see dsh-hub help)", 2);
  if (!cmd || flags.help || cmd === "help") { (cmd || flags.help ? out : err)(USAGE); return cmd || flags.help ? 0 : 2; }
  if (probe && !probe.ok && cmd !== "demo") {
    return fail(`DEMO marker found in ${dataDir} but the folder is not a valid demo folder (${probe.reason}); regenerate it with dsh-hub demo --force`, 2);
  }
  const json = flags.json === true;
  // every table goes through emit/emitFailed, so the DEMO banner cannot be forgotten by a command
  const isDemo = (obj) => (demo !== null && cmd !== "demo") || obj?.demo === true;
  const withBanner = (obj) => (isDemo(obj) ? { demo: true, demoNote: DEMO_TEXT, ...obj } : obj);
  const emit = (obj, human) => out(json ? JSON.stringify(withBanner(obj), null, 2) : `${isDemo(obj) ? `${DEMO_TEXT}\n` : ""}${human(obj)}`);
  // a command that printed its data but did not succeed: the data plus the same {error, code} as any failure
  const emitFailed = (obj, human, message, code = 1) => {
    const m = redactSecrets(message);
    if (json) out(JSON.stringify({ ...withBanner(obj), error: m, code }, null, 2));
    else { out(`${isDemo(obj) ? `${DEMO_TEXT}\n` : ""}${human(obj)}`); err(m); }
    return code;
  };
  // demo engines are built once per command and never touch the network or write
  const mkEngine = (extra = {}) => (demo ? createDemoEngine(demo) : createCostEngine({ dataDir, localProviders: cfg.localProviders, ...extra }));

  async function hubGet(path) {
    try {
      const r = await fetchImpl(`${hubUrl}${path}`, { headers: HUB_HEADERS, signal: AbortSignal.timeout(8000) });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    } catch {
      throw new CliError(`DSH host API not reachable at ${hubUrl} (is dsh web running with the model-hub plugin?)`, 3);
    }
  }
  const gpuFail = (r) => { throw new CliError(`${gpuName}: HTTP ${r.status} ${errMessage(r.body)}`.trim(), 1); };
  // a refused switch/unload: same {error, code} shape as every other --json failure, plus the GPU server's status
  const gpuReplyFail = (r) => {
    const message = redactSecrets(`${gpuName}: HTTP ${r.status} ${errMessage(r.body)}`.trim());
    if (json) out(JSON.stringify({ ...(demo ? { demo: true, demoNote: DEMO_TEXT } : {}), error: message, code: 1, httpStatus: r.status }));
    else err(message);
    return 1;
  };
  const needGpu = () => { if (!gpuConfigured) throw new CliError("no GPU server configured (see README: GPU server)", 2); };

  try {
    switch (cmd) {
      case "status": {
        if (demo) {
          const body = { hub: { reachable: false, demo: true, url: "demo fixtures (no host contacted)" }, ...(await createDemoLegacy({ manifest: demo.manifest }).status()) };
          emit(body, (b) => [
            `hub        ${b.hub.url}`,
            `claude     ${b.signedIn ? "signed in" : "signed out"} (${b.plan.mode})  ${[b.identity?.email, b.identity?.plan, b.identity?.org].filter(Boolean).join(" · ")}`,
            `features   imageCap=${b.imageCap} compactionSlim=${b.compactionSlim} spendGuard=${b.spendGuard}`,
            `gauges     5h ${b.plan.fiveHour.percent}% · weekly ${b.plan.sevenDay.percent}%`,
            `window     ${b.plan.messages} messages · ${b.plan.modelCalls} model calls sent from DSH`,
          ].join("\n"));
          return 0;
        }
        const [h, s] = await Promise.all([hubGet("/healthz"), hubGet("/status")]);
        // the forecast summary: the host's report when it serves one, else computed here from the data dir (estimates only)
        let fc = null;
        try { const f = await hubGet("/forecast"); if (f.status === 200 && f.body?.spend) fc = f.body; } catch { /* no host forecast */ }
        if (!fc) { try { fc = buildForecast({ dataDir, caps: loadCaps(dataDir), plans: cfg.plans, now: nowFn() }); } catch { fc = null; } }
        const fcLines = forecastSummaryLines(fc);
        const body = { hub: { reachable: h.status === 200, url: redactSecrets(hubUrl) }, ...s.body, ...(fcLines.length ? { forecast: fc } : {}) };
        const human = (b) => [
          `hub        ${b.hub.reachable ? "up" : "DOWN"} (${b.hub.url})`,
          `claude     ${b.signedIn ? "signed in" : "signed out"}${b.plan?.mode ? ` (${b.plan.mode})` : ""}`,
          `features   imageCap=${b.imageCap} compactionSlim=${b.compactionSlim} spendGuard=${b.spendGuard}`,
          ...(b.caps ? [`caps       ${b.caps.problem ?? "ok"}`] : []),
          ...(b.caps && typeof b.caps.stopAtPlanLimit === "boolean" ? [`plan stop  ${b.caps.stopAtPlanLimit ? "on" : "off"}`] : []),
          ...planWindowLines(b.plan),
          ...guardLines(b.guard),
          ...commandsLines(b.commands),
          ...(typeof b.plan?.messages === "number" && typeof b.plan?.modelCalls === "number" ? [`window     ${b.plan.messages} messages · ${b.plan.modelCalls} model calls sent from DSH`] : []),
          ...fcLines,
        ].join("\n");
        if (h.status !== 200) return emitFailed(body, human, `host API unhealthy: /healthz HTTP ${h.status}`);
        if (s.status !== 200) return emitFailed(body, human, `host API /status failed: HTTP ${s.status}`);
        emit(body, human);
        return 0;
      }
      case "accounts": {
        const accounts = demo ? readDemoAccounts(demo) : readAccounts({ statePath: join(dataDir, "accounts-state.json"), ...(credentialsPath ? { credentialsPath } : {}) });
        if (demo) { for (const x of accounts) if (x.provider === "anthropic" && x.signedIn) x.identity = { ...DEMO_IDENTITY }; }
        // identity (email, plan) comes from the running host (it holds the token); without it: "account not reported"
        else {
          try {
            const h = await hubGet("/accounts");
            // a host in demo mode holds synthetic identities: never attach them to the rows of a real data dir
            const ids = h.body?.demo === true ? new Map() : new Map((Array.isArray(h.body?.accounts) ? h.body.accounts : []).filter((x) => x?.identity).map((x) => [x.provider, x.identity]));
            for (const x of accounts) if (ids.has(x.provider)) x.identity = ids.get(x.provider);
          } catch { /* host not reachable */ }
        }
        const idText = (x) => { const i = x.identity; const parts = [i?.email ?? i?.name, i?.plan, i?.org].filter(Boolean); return parts.length ? parts.join(" · ") : "account not reported"; };
        const human = ({ accounts: a }) => a.map((x) =>
          `${x.provider.padEnd(15)} ${x.health.padEnd(14)} ${x.signedIn ? `${x.kind} ${x.expiresAt ? fmtMs(x.expiresInMs) : ""}  ${idText(x)}` : "not signed in"}${x.lastError ? `  err: ${x.lastError}` : ""}`).join("\n");
        const broken = accounts.filter((x) => x.health === "refresh-failed").map((x) => x.provider);
        if (broken.length) return emitFailed({ accounts }, human, `refresh failed for ${broken.join(", ")}: sign in again`);
        emit({ accounts }, human);
        return 0;
      }
      case "gpus": {
        needGpu();
        const r = await gpu.gpus();
        if (r.status !== 200 || r.body?.ok === false) gpuFail(r);
        emit(r.body, (b) => [
          `manager ${b.manager?.active ? "active" : "inactive"}  tier ${b.tier}  loaded ${b.loaded_model ?? "none"}  state ${b.state_age_s}s old${b.stale ? " STALE" : ""}`,
          ...b.gpus.map((g) => `GPU${g.index}  ${g.used_mib}/${g.total_mib} MiB  util ${g.util_pct}%  ${g.processes.map((p) => `${p.user}:${p.cmd}`).join(",") || "idle"}${g.reserved_by?.length ? `  reserved:${g.reserved_by.join(",")}` : ""}`),
          ...(b.failover ? [`failover ${b.failover.model} -> ${b.failover.to} (${b.failover.reason}) at ${new Date(b.failover.at * 1000).toISOString()}`] : []),
          ...(b.reservations ?? []).map((x) => `reservation ${x.owner} gpus=${x.gpus}${x.stale ? " (stale)" : ""}`),
        ].join("\n"));
        return 0;
      }
      case "switch": {
        needGpu();
        if (rest.length !== 1 || !MODEL_RE.test(rest[0])) throw new CliError("usage: dsh-hub switch <model> [--gpus 2,3 | --auto] [--force]", 2);
        if (flags.auto && flags.gpus !== undefined) throw new CliError("--auto and --gpus are mutually exclusive", 2);
        let gpus;
        if (flags.gpus !== undefined) {
          const list = flags.gpus.split(",").map((s) => (/^\d+$/.test(s.trim()) ? Number(s) : NaN));
          try { gpus = parseGpus(list); } catch (e) { throw new CliError(e.message, 2); }
        }
        const r = await gpu.switch(rest[0], gpus, { force: Boolean(flags.force), auto: Boolean(flags.auto) });
        if (r.status !== 200 && r.status !== 202) return gpuReplyFail(r);
        emit({ httpStatus: r.status, ...r.body }, (b) => `HTTP ${b.httpStatus} ${b.status ?? ""}${b.gpus ? ` gpus=${b.gpus}` : ""}${b.was_pinned ? ` (was pinned to ${b.was_pinned})` : ""}`);
        return 0;
      }
      case "unload": {
        needGpu();
        const r = await gpu.unload();
        if (r.status !== 200) return gpuReplyFail(r);
        emit({ httpStatus: r.status, ...r.body }, (b) => `HTTP ${b.httpStatus} ${b.status ?? "ok"}`);
        return 0;
      }
      case "receipt": {
        const [target, ...extra] = rest;
        if (!target || extra.length) throw new CliError("usage: dsh-hub receipt <session-id|last> [--md|--json]", 2);
        if (flags.md && json) throw new CliError("--md and --json cannot be combined", 2);
        if (target !== "last" && !SESSION_ID_RE.test(target)) throw new CliError("session must be a session id (1-128 characters of A-Za-z0-9_.:-) or last", 2);
        const led = ledgerRows(dataDir); // offline: the data dir only, through the reader the host uses
        const complete = led.complete !== false && !led.unreadable;
        const partial = led.unreadable ? "partial totals: the spend ledger could not be read (see dsh-hub doctor)"
          : !complete ? "partial totals: another DSH process kept rotating the ledger while it was read; run it again" : null;
        const id = target === "last" ? latestSessionId(led.rows) : target;
        if (id === null) throw new CliError(partial ?? "no ledger rows for any session yet", 1);
        const rc = buildReceipt(led.rows, id);
        const none = !rc.calls && !rc.subagents.calls;
        if (none && !partial) throw new CliError(`no ledger rows for session ${id}`, 1);
        const body = { ...rc, markdown: receiptMarkdown(rc, { demo: Boolean(demo) }), complete, unreadable: Boolean(led.unreadable) };
        // a ledger that could not be read says nothing about this session: no empty receipt on stdout, only the reason
        if (none && !json) throw new CliError(partial, 1);
        if (flags.md) {
          out(body.markdown);
          if (partial) { err(partial); return 1; }
          return 0;
        }
        const human = (b) => receiptText(b, { demo: false }); // emit() adds the DEMO banner itself
        if (partial) return emitFailed(body, human, partial);
        emit(body, human);
        return 0;
      }
      case "spend": {
        if (flags.by === "turn" || flags.session !== undefined) {
          if (flags.by !== "turn") throw new CliError("--session needs --by turn (dsh-hub spend --session <id|last> --by turn)", 2);
          if (flags.session === undefined) throw new CliError("--by turn needs --session <id|last>", 2);
          if (flags.since !== undefined) throw new CliError("--since does not apply to --by turn (it reads the whole session)", 2);
          if (flags.session !== "last" && !SESSION_ID_RE.test(flags.session)) throw new CliError("--session must be a session id (1-128 characters of A-Za-z0-9_.:-) or last", 2);
          const led = ledgerRows(dataDir); // offline: the data dir only, through the reader the host uses
          const partial = led.unreadable ? "partial totals: the spend ledger could not be read (see dsh-hub doctor)"
            : led.complete === false ? "partial totals: another DSH process kept rotating the ledger while it was read; run it again" : null;
          const id = flags.session === "last" ? latestSessionId(led.rows) : flags.session;
          if (id === null) throw new CliError(partial ?? "no ledger rows for any session yet", 1);
          const body = { ...buildTurns(led.rows, id), complete: !partial, unreadable: Boolean(led.unreadable) };
          const none = !body.turns.length && !body.v1Calls && !body.outside.calls;
          if (none && !partial) throw new CliError(`no ledger rows for session ${id}`, 1);
          // a ledger that could not be read says nothing about this session: no "no turns" line on stdout, only the reason
          if (none && !json) throw new CliError(partial, 1);
          if (partial) return emitFailed(body, turnsHuman, partial);
          emit(body, turnsHuman);
          return 0;
        }
        const since = flags.since ?? "today";
        const by = flags.by ?? "provider";
        if (!/^(today|7d|30d|all)$/.test(since) || !["provider", "model", "session", "day", "purpose"].includes(by)) throw new CliError("bad --since/--by", 2);
        const rep = await mkEngine().spendReport({ since, by });
        // Dollars reserved by requests in flight live in the running DSH process, not in the ledger: ask its host API.
        // Best effort: no host, a refusal or an odd answer is "unavailable" and never changes the exit code. A demo
        // folder never calls the host (demo mode records and reserves nothing).
        let reserved = { usd: 0, count: 0, source: demo ? "demo" : "unavailable" };
        if (!demo) {
          try {
            const h = await hubGet("/spend?since=today&by=provider");
            const r = h.body?.caps?.reserved;
            if (h.status === 200 && r && Number.isFinite(r.usd) && r.usd >= 0 && Number.isInteger(r.count) && r.count >= 0) reserved = { usd: r.usd, count: r.count, source: "host" };
          } catch { /* host not reachable */ }
        }
        rep.caps = { ...rep.caps, reserved };
        const inFlight = (rv) => rv.source === "demo" ? "in flight: none (demo mode reserves nothing)"
          : rv.source !== "host"
          ? "in flight: unknown (the running DSH process holds reservations; host API not reachable)"
          : rv.count === 0 ? "in flight: none (running DSH process)" : `in flight: ${fmtUsd(rv.usd)} reserved across ${rv.count} request(s) (running DSH process)`;
        const human = (r) => [
          `${r.since}: ${fmtUsd(r.totals.usd)} charged, ${fmtUsd(r.totals.apiEquivUsd)} API-equivalent, ${r.totals.calls} calls`,
          ...Object.entries(r.groups ?? {}).map(([k, v]) => `  ${k.padEnd(28)} ${fmtUsd(v.usd).padStart(9)}  api-eq ${fmtUsd(v.apiEquivUsd).padStart(9)}  ${v.calls} calls`),
          ...(r.plans ?? []).map((p) => `plan ${p.provider}: ${p.name} ${fmtUsd(p.usedUsd)} of ${fmtUsd(p.includedUsd)} used, ${fmtUsd(p.remainingUsd)} left, resets ${p.resetsAt.slice(0, 10)}`),
          inFlight(r.caps.reserved),
          `caps: daily ${fmtUsd(r.caps.limits.dailyUsd)} session ${fmtUsd(r.caps.limits.sessionUsd)}  status ${r.caps.action} (${r.caps.reason})`,
        ].join("\n");
        if (rep.unreadable) return emitFailed(rep, human, "partial totals: the spend ledger could not be read (see dsh-hub doctor)");
        if (rep.complete === false) return emitFailed(rep, human, "partial totals: another DSH process kept rotating the ledger while it was read; run it again");
        emit(rep, human);
        return 0;
      }
      case "ledger": {
        const [sub, ...extra] = rest;
        if (sub !== "verify" && sub !== "export") throw new CliError("usage: dsh-hub ledger verify | ledger export (--csv|--jsonl) [--since …] [--out <file>] [--force]", 2);
        if (extra.length) throw new CliError(`ledger ${sub}: unexpected argument ${extra[0]}`, 2);
        const since = flags.since ?? "all";
        if (!SINCE_VALUES.test(since)) throw new CliError("bad --since (today|7d|30d|all)", 2);
        const notRead = "ledger could not be read in full (another DSH process kept rotating it, or a file is unreadable); run it again";
        if (sub === "verify") {
          if (flags.csv || flags.jsonl || flags.out !== undefined || flags.force) throw new CliError("ledger verify takes only --since and --json", 2);
          const rep = verifyLedger(dataDir, { since, full: true });
          const human = (r) => [
            `ledger (since ${r.since}): ${fmtInt(r.rows)} rows · ${fmtInt(r.checked)} v2 re-derived · ${fmtInt(r.v1)} v1 (not re-derivable)`,
            `mismatches ${r.mismatchCount} · torn lines ${r.tornLines} · duplicate ids ${r.duplicateCount} · unknown fields ${r.unknownFields.length ? r.unknownFields.join(", ") : "none"}`,
            ...r.mismatches.slice(0, 10).map((m) => `  ${m.id ?? "(no id)"}  ${m.field}  expected ${JSON.stringify(m.expected)}  stored ${JSON.stringify(m.stored)}`),
            ...(r.mismatches.length > 10 ? [`  … and ${r.mismatchCount - 10} more (--json lists up to ${r.mismatches.length})`] : []),
            r.ok ? "VERIFIED" : r.complete && !r.unreadable ? "FAILED" : "INCOMPLETE",
            r.note,
          ].join("\n");
          if (rep.ok) { emit(rep, human); return 0; }
          if (!rep.complete || rep.unreadable) return emitFailed(rep, human, notRead);
          return emitFailed(rep, human, `ledger verification failed: ${rep.mismatchCount} mismatching field(s), ${rep.tornLines} torn line(s)`);
        }
        if (flags.csv === flags.jsonl) throw new CliError("usage: dsh-hub ledger export (--csv|--jsonl) [--since today|7d|30d|all] [--out <file>] [--force]", 2);
        if (flags.out === undefined && json) throw new CliError("ledger export --json needs --out (the export itself is the output otherwise)", 2);
        if (flags.force && flags.out === undefined) throw new CliError("--force needs --out", 2);
        // an export must never replace the ledger it was made from, nor add a file the ledger reader would take for one
        // (decided by name in any case and by file identity, see exportTargetIsLedger)
        if (flags.out !== undefined) {
          const verdict = exportTargetIsLedger(dataDir, flags.out, { force: Boolean(flags.force) });
          if (verdict === "ledger") throw new CliError("--out would overwrite the spend ledger; choose another file", 2);
          if (verdict === "force-in-data-dir") throw new CliError("--force cannot be used with --out inside the data dir; choose another directory", 2);
        }
        const format = flags.csv ? "csv" : "jsonl";
        const exp = readExportRows(dataDir, { since });
        if (!exp.complete || exp.unreadable) throw new CliError(notRead, 1);
        const text = exportRows(exp.rows, format);
        if (flags.out === undefined) { out(text.replace(/\n$/, "")); return 0; }
        try { writeExport(flags.out, text, { force: Boolean(flags.force) }); }
        catch (e) {
          if (e?.code === "EEXIST") throw new CliError(`refusing to overwrite ${flags.out} (use --force)`, 1);
          throw new CliError(`cannot write ${flags.out}: ${e?.code || "error"}`, 1);
        }
        emit({ out: flags.out, format, rows: exp.rows.length, bytes: Buffer.byteLength(text) }, (b) => `wrote ${b.rows} rows (${b.format}) to ${b.out}`);
        return 0;
      }
      case "prices": {
        if (rest.length < 1) throw new CliError("usage: dsh-hub prices <provider/model>…", 2);
        // Billing as the host decides it: subscription only for a provider DSH holds an OAuth grant for AND whose route
        // sends no API key. Which routes send a key only the running host can tell (GET /status routeAuth); without
        // it nothing is assumed to be subscription.
        let routeAuth = null;
        if (!demo) { try { const s = await hubGet("/status"); if (s.status === 200 && s.body?.routeAuth?.known === true) routeAuth = s.body.routeAuth; } catch { /* host not reachable */ } }
        let oauthProviders = [];
        if (routeAuth) {
          const keyed = Array.isArray(routeAuth.apiKeyRoutes) ? routeAuth.apiKeyRoutes : [];
          try { oauthProviders = readAccounts({ statePath: join(dataDir, "accounts-state.json"), ...(credentialsPath ? { credentialsPath } : {}) }).filter((a) => a.signedIn && a.kind === "oauth" && !keyed.includes(a.provider)).map((a) => a.provider); } catch { /* none known: metered */ }
        }
        const rep = { ...(await mkEngine({ fetchImpl, oauthProviders }).prices(rest)), routeAuth: demo ? "demo" : routeAuth ? "host" : "unknown" };
        const declared = new Set(cfg.subscriptions ?? []);
        const human = (r) => [`table: ${r.source} (${r.count} entries)${r.routeAuth === "unknown" ? "; host not reachable, so subscription billing is not assumed" : ""}`,
          ...(r.ollama ? [`ollama table: ${r.ollama.source}, dated ${r.ollama.date ?? "?"}, ${r.ollama.count} models (${r.ollama.url})`] : []),
          ...Object.entries(r.models).flatMap(([k, p]) => p.error ? [`${k}  ${p.error}`] : [
            `${k}  ${p.billing}/${p.source}${declared.has(k.split("/")[0]) ? " (declared in config.json)" : ""}  in $${p.inPerM}/M  out $${p.outPerM}/M  cache-read $${p.cacheReadPerM}/M${p.offPeak ? "  [off-peak rate now]" : ""}`,
            ...(p.ollama ? [`    ollama: ${p.ollama.peak ? `peak in $${p.ollama.peak.inPerM}/M out $${p.ollama.peak.outPerM}/M cache $${p.ollama.peak.cachedPerM}/M` : "no off-peak row"}${p.ollama.offPeakRate ? `; off-peak in $${p.ollama.offPeakRate.inPerM}/M out $${p.ollama.offPeakRate.outPerM}/M cache $${p.ollama.offPeakRate.cachedPerM}/M` : ""} (12:00-18:00 UTC weekdays is peak)`] : [])])].join("\n");
        const unpriced = Object.entries(rep.models).filter(([, p]) => !p.priced).map(([k]) => k);
        if (unpriced.length) return emitFailed(rep, human, `no known price for ${unpriced.join(", ")}`);
        emit(rep, human);
        return 0;
      }
      case "plans": {
        const plans = mkEngine().plansReport();
        const human = ({ plans: ps }) => (ps.length ? ps.map((p) => `${p.provider.padEnd(12)} ${p.name}  ${fmtUsd(p.usedUsd)} of ${fmtUsd(p.includedUsd)} used  remaining ${fmtUsd(p.remainingUsd)}${p.overageUsd > 0 ? `  overage ${fmtUsd(p.overageUsd)} (metered)` : ""}  cycle ${p.cycleStart.slice(0, 10)} -> resets ${p.resetsAt.slice(0, 10)}${p.complete ? "" : "  (partial: ledger unreadable)"}`).join("\n")
          : "no plans configured (config.json plans: { \"ollama\": { \"name\": \"Pro\", \"includedUsd\": 60, \"resetsOnDay\": 9 } })");
        emit({ plans }, human);
        return 0;
      }
      case "forecast": {
        if (rest.length) throw new CliError("usage: dsh-hub forecast [--json]", 2);
        // estimates from the ledger, caps.json and the config.json plans; no host call, so DSH may be stopped
        const report = buildForecast({ dataDir, caps: loadCaps(dataDir), plans: cfg.plans, now: nowFn() });
        if (report.spend.complete === false) return emitFailed(report, forecastHuman, "partial forecast: the spend ledger could not be read in full (see dsh-hub doctor)", 1);
        emit(report, forecastHuman);
        return 0;
      }
      case "caps": {
        if (rest[0] === "set") {
          if (flags.check) throw new CliError("--check cannot be combined with set", 2);
          // a demo folder is sealed (manifest hashes) and demo mode never writes: changing caps.json would break it
          if (demo) throw new CliError("the demo folder is read-only: caps set changes nothing in demo mode (point DSH_HUB_DATA_DIR at your real data dir to change caps)", 2);
          const p = parseCapsAssignments(rest.slice(1));
          const r = p.ok ? setCaps(dataDir, p.input) : p;
          if (!r.ok) throw new CliError(r.errors.join("\n"), 2);
          emit({ ok: true, replaced: r.replaced, ...r.view }, capsHuman);
          return 0;
        }
        if (rest.length) throw new CliError("usage: dsh-hub caps [--check] | dsh-hub caps set key=value ...", 2);
        const view = capsView(dataDir);
        const st = createCostEngine({ dataDir, localProviders: cfg.localProviders }).capsStatus();
        const perCap = [
          { which: "daily", capUsd: st.limits.dailyUsd, spentUsd: st.todayUsd },
          { which: "session", capUsd: st.limits.sessionUsd, spentUsd: st.sessionSpentUsd },
          ...Object.entries(st.perProvider).map(([p, v]) => ({ which: `provider ${p}`, capUsd: v.capUsd, spentUsd: v.spentUsd })),
        ].map((c) => ({ ...c, pct: c.capUsd > 0 && c.spentUsd != null ? Math.floor((c.spentUsd * 100) / c.capUsd) : null }));
        const body = { ...view, status: { action: st.action, reason: st.reason, pct: st.pct, which: st.which, todayUsd: st.todayUsd, sessionSpentUsd: st.sessionSpentUsd, complete: st.complete, unreadable: st.unreadable, perCap } };
        if (!flags.check) { emit(body, capsHuman); return 0; }
        if (st.unreadable) return emitFailed(body, capsHuman, "the spend ledger could not be read: caps cannot be checked", 1);
        const code = st.action === "block" ? 11 : st.action === "warn" ? 10 : st.complete === false ? 1 : 0;
        // a corrupt caps.json means the user's real limits are not in force: a script must not read that as "ok"
        if (code === 0 && view.fatal) return emitFailed(body, capsHuman, view.problem || "caps.json invalid", 1);
        if (code === 0) { emit(body, capsHuman); return 0; }
        return emitFailed(body, capsHuman, code === 11 ? `a cap is reached: ${st.reason}` : code === 10 ? `at or over warnPct: ${st.reason}` : "partial totals: another DSH process kept rotating the ledger; run it again", code);
      }
      case "cache": {
        let r;
        if (demo) {
          // the demo fixtures replayed through the same tracker the host uses
          const eng = mkEngine();
          await replayDemoCache(eng, dataDir);
          const body = eng.cacheReport(flags.session || undefined);
          r = body === null ? { status: 404, body: { error: "unknown session" } } : { status: 200, body };
        } else {
          const q = flags.session ? `?session=${encodeURIComponent(flags.session)}` : "";
          r = await hubGet(`/cache${q}`);
        }
        if (r.status !== 200) throw new CliError(`cache: HTTP ${r.status} ${r.body?.error ?? ""}`.trim(), 1);
        emit(r.body, (b) => b.sessions
          ? (b.sessions.length ? b.sessions.map((s) => `${s.sessionId}  last ${(s.lastHit * 100).toFixed(0)}%  avg ${(s.avgHit * 100).toFixed(0)}%  ${s.steps} steps  ${s.provider}/${s.model}`).join("\n") : "no sessions observed yet")
          : `${b.sessionId}  last ${(b.lastHit * 100).toFixed(0)}%  avg ${(b.avgHit * 100).toFixed(0)}%  ${b.steps} steps`);
        return 0;
      }
      case "demo": {
        if (!flags.out) throw new CliError("usage: dsh-hub demo --out <dir> [--at <ISO time|now>] [--seed <n>] [--force]", 2);
        if (flags.seed !== undefined && !/^\d{1,10}$/.test(flags.seed)) throw new CliError("--seed must be a non-negative integer", 2);
        let r;
        try { r = writeDemo({ out: resolve(flags.out), at: flags.at, seed: flags.seed === undefined ? undefined : Number(flags.seed), force: Boolean(flags.force), env, home }); }
        catch (e) { if (e instanceof DemoError) throw new CliError(e.message, e.code); throw e; }
        emit(r, (s) => [`wrote ${s.files.length} files to ${s.out} (${s.rows} ledger rows, ${s.days} days, anchored at ${s.anchor}${s.anchorAdjusted ? ", moved to 02:00 local because --at was earlier" : ""})`,
          `to see it in DSH:  DSH_HUB_DEMO=${s.out} dsh web     (a throwaway DSH_HOME is recommended; see README "Demo mode")`,
          `to see it here:    DSH_HUB_DATA_DIR=${s.out} dsh-hub spend`,
          "WARNING: demo mode switches spend capture and caps OFF; use it only with a throwaway DSH_HOME."].join("\n"));
        return 0;
      }
      case "doctor":
        return demo
          ? await doctorDemo({ emit, demo, cfg, engine: mkEngine() })
          : await doctor({ out, emit, json, fetchImpl, hubUrl, dataDir, credentialsPath, gpu, gpuConfigured, gpuName, cfg, env, now: nowFn });
      default:
        throw new CliError(`unknown command ${cmd}\n${USAGE}`, 2);
    }
  } catch (e) {
    const msg = e instanceof CliError ? redactSecrets(e.message) : `dsh-hub: ${redactSecrets(e?.message || e)}`;
    const code = e instanceof CliError ? e.code : 1;
    // in demo mode a failure says so too (the same demo / demoNote fields as every other demo answer)
    if (demo && cmd !== "demo" && wantsJson) { out(JSON.stringify({ demo: true, demoNote: DEMO_TEXT, error: redactSecrets(msg), code })); return code; }
    return fail(msg, code);
  }
}

// `dsh-hub caps` / `caps set`: one line per cap (with today's spend when the status is known), warnPct, the file, any problem
function capsHuman(b) {
  const cap = (n) => (n > 0 ? fmtUsd(n) : "off");
  const per = new Map((b.status?.perCap ?? []).map((c) => [c.which, c]));
  const line = (label, capUsd, which) => {
    const c = per.get(which);
    const spent = c && c.spentUsd != null ? `  spent ${fmtUsd(c.spentUsd)}${c.pct != null ? ` (${c.pct}%)` : ""}` : "";
    return `${label.padEnd(18)} ${cap(capUsd).padStart(9)}${spent}`;
  };
  return [
    line("daily", b.caps.dailyUsd, "daily"),
    line("session", b.caps.sessionUsd, "session"),
    ...Object.entries(b.caps.perProviderDailyUsd).map(([p, v]) => line(`provider ${p}`, v, `provider ${p}`)),
    `${"warnPct".padEnd(18)} ${String(b.caps.warnPct).padStart(9)}`,
    `${"plan stop".padEnd(18)} ${b.stopAtPlanLimit ? "on" : "off"} (Claude subscription requests are ${b.stopAtPlanLimit ? "refused" : "not refused"} at 100% of a plan window)`,
    ...(b.status ? [`status             ${b.status.action} (${b.status.reason})`] : []),
    `file               ${b.file} (${b.exists ? "exists" : "not created yet: defaults in effect"})`,
    ...(b.problem ? [`!! ${b.problem}`] : []),
    ...(b.replaced ? ["replaced an invalid caps.json (kept as caps.json.broken)"] : []),
  ].join("\n");
}

/** doctor on a demo folder: the demo itself is a WARNING; no host API, credential file, Ollama refresh or ~/.local/bin check. */
async function doctorDemo({ emit, demo, cfg, engine }) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail: redactSecrets(String(detail ?? "")) });
  add("demo mode", "warn", `${DEMO_TEXT}. Spend capture and caps are OFF; nothing is written.`);
  add("demo folder", "ok", `sealed, ${Object.keys(demo.manifest.files).length} data files, anchored at ${demo.manifest.anchor}`);
  if (cfg.errors.length) for (const e of cfg.errors) add("config.json", "warn", e);
  else add("config.json", "ok", "valid");
  try {
    const accounts = readDemoAccounts(demo);
    const bad = accounts.filter((a) => a.signedIn && a.health !== "ok");
    add("accounts", bad.length ? "warn" : "ok", accounts.filter((a) => a.signedIn).map((a) => `${a.provider}:${a.health}`).join(" ") || "no provider signed in");
  } catch (e) { add("accounts", "fail", String(e?.message || e).slice(0, 120)); }
  try {
    const caps = engine.capsStatus();
    if (caps.unreadable) add("caps", "fail", "the demo ledger could not be read");
    else add("caps", caps.warnings.length || caps.action !== "ok" ? "warn" : "ok", `daily $${caps.limits.dailyUsd}, today $${caps.todayUsd.toFixed(2)} (${caps.action}, ${Math.round(caps.pct)}%)`);
    for (const pl of engine.plansReport()) add(`plan ${pl.provider}`, pl.complete ? "ok" : "warn", `${pl.name}: ${fmtUsd(pl.usedUsd)} of ${fmtUsd(pl.includedUsd)}, resets ${pl.resetsAt.slice(0, 10)}${pl.overageUsd > 0 ? `, overage ${fmtUsd(pl.overageUsd)}` : ""}`);
    const p = await engine.prices(["google/gemini-3.8-flash"]);
    add("price table", p.count > 0 ? "ok" : "fail", `${p.source}, ${p.count} entries`);
  } catch (e) { add("cost", "fail", String(e?.message || e).slice(0, 120)); }
  add("data dir path", "ok", demo.dir);
  const failed = checks.filter((c) => c.level === "fail");
  const res = failed.length
    ? { ok: false, error: `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}`, code: 1, checks }
    : { ok: true, checks };
  emit(res, (r) => [...r.checks.map((c) => `${c.level.toUpperCase().padEnd(4)} ${c.name.padEnd(17)} ${c.detail}`), r.ok ? "doctor: OK" : "doctor: FAILED"].join("\n"));
  return res.ok ? 0 : 1;
}

/** The `guard` lines of `dsh-hub status`: policy and error count, plus the newest error when there is one. Nothing for an older host. */
function guardLines(g) {
  const n = g?.errors?.count;
  if (!g || typeof g !== "object" || !Number.isFinite(n)) return [];
  const last = g.errors.last?.message;
  return [
    `guard      onError=${redactSecrets(String(g.onError))} · errors ${n}`,
    ...(n > 0 && last ? [`  last: ${redactSecrets(String(last))}`] : []),
  ];
}

/** The slash commands a host reports ({registered, collided}); only plausible command names are ever printed. */
const cmdNames = (l) => (Array.isArray(l) ? l.filter((n) => typeof n === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(n)) : []);
function commandsLines(c) {
  if (!c || typeof c !== "object") return [];
  const reg = cmdNames(c.registered);
  const col = cmdNames(c.collided);
  const slash = (l) => l.map((n) => `/${n}`).join(" ");
  if (!reg.length && !col.length) return ["commands   none registered"];
  return [`commands   ${[reg.length ? slash(reg) : "none registered", ...(col.length ? [`collided: ${slash(col)}`] : [])].join(" · ")}`];
}
/** doctor's slash commands check: [level, detail], or null for an older host that does not report them. */
function commandsCheck(c) {
  if (!c || typeof c !== "object") return null;
  const reg = cmdNames(c.registered);
  const col = cmdNames(c.collided);
  const slash = (l) => l.map((n) => `/${n}`).join(" ");
  if (col.length) return ["warn", `registered ${reg.length ? slash(reg) : "none"}; collided with another plugin's command: ${slash(col)}`];
  if (!reg.length) return ["warn", "none registered (DSH's commands service not available in the process that owns the hub port)"];
  return ["ok", `registered: ${slash(reg)}`];
}

/** doctor's plan-history check: [level, detail]. The file holds percent/resetsAt/fetchedAt only; a link at its path is never followed. */
function planHistoryCheck(dataDir, now) {
  const file = join(dataDir, "plan-history.jsonl");
  let st;
  try { st = lstatSync(file); } catch { return ["ok", "no readings yet (written while the Claude plan card is read)"]; }
  if (st.isSymbolicLink() || !st.isFile()) return ["fail", "plan-history.jsonl is a symbolic link or not a regular file: it is neither read nor written"];
  const mode = (st.mode & 0o777).toString(8);
  const { rows } = readPlanHistory(dataDir, { now });
  const last = rows.reduce((m, r) => Math.max(m, r.fetchedAt), 0);
  return [mode === "600" ? "ok" : "warn", `${rows.length} rows, ${last ? `last reading ${fmtAge(now - last)} ago` : "no valid reading"}${mode === "600" ? "" : `, mode ${mode} (expected 600)`}`];
}

async function doctor({ emit, fetchImpl, hubUrl, dataDir, credentialsPath, gpu, gpuConfigured, gpuName, cfg, env, now }) {
  const checks = [];
  // every check detail passes through the redactor (it can quote DSH_HUB_URL, a GPU server URL or an error message)
  const add = (name, level, detail) => checks.push({ name, level, detail: redactSecrets(String(detail ?? "")) });
  const mode = (p) => (statSync(p).mode & 0o777).toString(8);

  try {
    const r = await fetchImpl(`${hubUrl}/healthz`, { signal: AbortSignal.timeout(4000) });
    add("host API", r.status === 200 ? "ok" : "fail", `${hubUrl}/healthz HTTP ${r.status}`);
    // where refreshed grants are written: DSH's credential store as the running host sees it now
    try {
      const a = await (await fetchImpl(`${hubUrl}/accounts`, { headers: HUB_HEADERS, signal: AbortSignal.timeout(8000) })).json();
      const cs = a?.credentialStore;
      if (cs && cs.state) add("credential store", cs.state === "live" ? "ok" : cs.state === "none" && a.reportOnly ? "warn" : "fail",
        cs.state === "live" ? "live (grant refresh can write)" : cs.state === "none" ? "not available (watchdog is report-only)" : "disposed: grant refresh would fail");
    } catch { /* older host: no such field */ }
    const s = await (await fetchImpl(`${hubUrl}/status`, { headers: HUB_HEADERS, signal: AbortSignal.timeout(8000) })).json();
    add("guards", s.spendGuard && s.compactionSlim && s.imageCap ? "ok" : "warn", `imageCap=${s.imageCap} compactionSlim=${s.compactionSlim} spendGuard=${s.spendGuard}`);
    if (s.demo === true) add("host mode", "warn", `${DEMO_TEXT}: the running host is in demo mode (DSH_HUB_DEMO), spend capture and caps are OFF`);
    // errors of the spend guard itself, counted by the DSH process that owns the host port; skipped for an older host
    const ge = s.guard?.errors;
    if (ge && Number.isFinite(ge.count)) {
      add("guard errors", ge.count > 0 ? "warn" : "ok",
        `onError=${s.guard.onError}, ${ge.count} error(s) since this DSH process started${ge.count > 0 && ge.last?.message ? `, last: ${ge.last.message}` : ""}`);
    }
    // the slash commands (/cost /caps /route /receipt) this DSH process registered; skipped for an older host. A name another
    // plugin already holds is a warning, never a failure.
    const cc = commandsCheck(s.commands);
    if (cc) add("slash commands", cc[0], cc[1]);
  } catch { add("host API", "fail", `not reachable at ${hubUrl}`); }

  if (!gpuConfigured) add("GPU server", "ok", "not configured");
  else {
    try {
      const h = await gpu.health();
      add(`${gpuName} server`, h.status === 200 ? "ok" : "fail", `HTTP ${h.status}`);
      const g = await gpu.gpus();
      if (g.status === 200 && g.body?.ok !== false) add(`${gpuName} manager`, g.body.stale ? "warn" : "ok", `state ${g.body.state_age_s}s old${g.body.stale ? " (STALE)" : ""}, loaded ${g.body.loaded_model ?? "none"}`);
      else add(`${gpuName} manager`, "fail", `HTTP ${g.status} ${errMessage(g.body)}`.slice(0, 160));
    } catch { add(`${gpuName} server`, "fail", "unreachable"); }
  }
  for (const e of cfg.errors) add("config.json", "warn", e);

  try {
    const accounts = readAccounts({ statePath: join(dataDir, "accounts-state.json"), ...(credentialsPath ? { credentialsPath } : {}) });
    const signed = accounts.filter((a) => a.signedIn);
    const bad = signed.filter((a) => a.health !== "ok");
    add("accounts", bad.length ? "warn" : "ok", signed.length ? signed.map((a) => `${a.provider}:${a.health}`).join(" ") : "no provider signed in");
  } catch (e) { add("accounts", "fail", redactSecrets(String(e?.message || e).slice(0, 120))); }

  const credFile = credentialsPath || join(dshHome(env), ".credentials.yaml");
  if (existsSync(credFile)) add("credentials file", mode(credFile) === "600" ? "ok" : "fail", `mode ${mode(credFile)}`);
  if (existsSync(dataDir)) add("data dir", mode(dataDir) === "700" ? "ok" : "warn", `mode ${mode(dataDir)}`);
  else add("data dir", "warn", `${dataDir} does not exist yet (created on first spend)`);
  // effective access, not just the mode bits: the spend guard refuses metered requests it cannot record or check
  if (existsSync(dataDir)) {
    const ledger = join(dataDir, "spend.jsonl");
    const problems = [];
    try { accessSync(dataDir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK); } catch (e) { problems.push(`data dir ${e.code || "not accessible"}`); }
    if (existsSync(ledger)) { try { accessSync(ledger, fsConstants.R_OK | fsConstants.W_OK); } catch (e) { problems.push(`spend.jsonl ${e.code || "not accessible"}`); } }
    add("spend ledger", problems.length ? "fail" : "ok", problems.length ? `${problems.join(", ")}: metered requests are held back` : "readable and writable");
  }

  try {
    const eng = createCostEngine({ dataDir, fetchImpl, localProviders: cfg.localProviders });
    const caps = eng.capsStatus();
    const cv = capsView(dataDir);
    if (caps.unreadable) add("caps", "fail", "the spend ledger could not be read: caps cannot be checked and metered requests are held back");
    else add("caps", cv.fatal ? "fail" : caps.warnings.length || caps.complete === false ? "warn" : "ok", `daily $${caps.limits.dailyUsd}, session $${caps.limits.sessionUsd}, today $${caps.todayUsd.toFixed(2)}${caps.complete === false ? " (partial: ledger rotating)" : ""} (${caps.action})${cv.problem ? ` | ${cv.problem}` : ""}`);
    add("plan stop", "ok", `${cv.stopAtPlanLimit ? "on" : "off"} (stopAtPlanLimit in caps.json; Claude subscription requests are ${cv.stopAtPlanLimit ? "refused" : "not refused"} at 100% of a plan window)`);
    add("plan history", ...planHistoryCheck(dataDir, now()));
    const p = await eng.prices(["google/gemini-3.8-flash"]);
    const o = (await eng.prices(["ollama/glm-5.3-flash"])).ollama;
    if (o) {
      const ageD = o.fetchedAt ? Math.floor((Date.now() - o.fetchedAt) / 86400e3) : null;
      add("ollama prices", o.source === "network" || o.source === "cache" ? "ok" : "warn", `${o.source}, dated ${o.date ?? "?"}${ageD !== null ? `, fetched ${ageD}d ago` : ", bundled snapshot (never refreshed)"}, ${o.count} models`);
    }
    if (cfg.subscriptions?.length) add("declared subscriptions", "ok", `${cfg.subscriptions.join(", ")} (declared in config.json)`);
    for (const pl of eng.plansReport()) add(`plan ${pl.provider}`, pl.complete ? "ok" : "warn", `${pl.name}: ${fmtUsd(pl.usedUsd)} of ${fmtUsd(pl.includedUsd)}, resets ${pl.resetsAt.slice(0, 10)}`);
    add("price table", p.count > 0 ? "ok" : "fail", `${p.source}, ${p.count} entries${p.warnings.length ? `, ${p.warnings.length} warnings` : ""}`);
  } catch (e) { add("cost", "fail", redactSecrets(String(e?.message || e).slice(0, 120))); }

  // the ~/.local/bin symlink is optional convenience: report it, never warn about it
  const link = join(homedir(), ".local/bin/dsh-hub");
  add("CLI link", "ok", existsSync(link) ? link : "not installed (optional: ln -s <repo>/bin/dsh-hub.mjs ~/.local/bin/dsh-hub)");
  add("data dir path", "ok", dataDir);

  const failed = checks.filter((c) => c.level === "fail");
  // a failing doctor follows the --json error convention too: {error, code} beside the checks
  const res = failed.length
    ? { ok: false, error: `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}`, code: 1, checks }
    : { ok: true, checks };
  emit(res, (r) => [...r.checks.map((c) => `${c.level.toUpperCase().padEnd(4)} ${c.name.padEnd(17)} ${c.detail}`), r.ok ? "doctor: OK" : "doctor: FAILED"].join("\n"));
  return res.ok ? 0 : 1;
}

let invoked = false;
try { invoked = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* ignore */ }
if (invoked) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
