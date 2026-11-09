#!/usr/bin/env node
/**
 * dsh-hub: CLI for dsh-model-hub. Every command accepts --json.
 *   status | accounts | gpus | switch <model> [--gpus 2,3] | unload | spend [--since] [--by]
 *   | prices <provider/model…> | cache [--session <id>] | doctor
 * Offline-capable: accounts, spend, prices (read the data dir). Needs DSH running: status, cache.
 * Talks to the configured GPU server (config.json) directly for gpus/switch/unload. Never prints secrets.
 */
import { dshHome } from "../lib/paths.mjs";
import { redactSecrets } from "../lib/accounts/errors.mjs";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccounts } from "../lib/accounts/index.mjs";
import { createCostEngine, DEFAULT_DATA_DIR } from "../lib/host/engine.mjs";
import { loadConfig } from "../lib/config.mjs";
import { createGpuClient, errMessage, MODEL_RE, parseGpus } from "../lib/host/gpu.mjs";

const HUB_URL = "http://127.0.0.1:8185";
const USAGE = `usage: dsh-hub <command> [--json]
  status                      host API health + plugin features + plan
  accounts                    provider sign-in / expiry / watchdog state
  gpus                        GPU server cards, loaded model, stale reservations
  switch <model> [--gpus 2,3 | --auto] [--force]
                              load a model on the GPU server; --gpus pins it, --auto clears a pin, --force overrides the 300 s lease
  unload                      unload the GPU server's model now
  spend [--since today|7d|30d|all] [--by provider|model|session|day]
  prices <provider/model…>    price rows (litellm / override / unpriced)
  cache [--session <id>]      prompt-cache hit ratios
  doctor                      end-to-end health check (exit 1 on any failure)`;

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const valued = new Set(["since", "by", "gpus", "session"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (valued.has(k)) {
        const v = inline ?? argv[++i];
        if (v === undefined || v.startsWith("--")) throw new CliError(`--${k} needs a value`, 2);
        flags[k] = v;
      } else if (k === "json" || k === "help" || k === "auto" || k === "force") flags[k] = true;
      else throw new CliError(`unknown flag --${k}`, 2);
    } else pos.push(a);
  }
  return { pos, flags };
}

const fmtUsd = (n) => `$${(n || 0).toFixed(n >= 1 ? 2 : 4)}`;
const fmtMs = (ms) => {
  if (ms === null || ms === undefined) return "-";
  const neg = ms < 0;
  const s = Math.abs(Math.round(ms / 1000));
  const t = s >= 86400 ? `${Math.floor(s / 86400)}d` : s >= 3600 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 60)}m`;
  return neg ? `${t} ago` : `in ${t}`;
};

export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const env = io.env ?? process.env;
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const dataDir = env.DSH_HUB_DATA_DIR || DEFAULT_DATA_DIR;
  const hubUrl = env.DSH_HUB_URL || HUB_URL;
  const credentialsPath = env.DSH_HUB_CREDENTIALS || undefined;
  const cfg = loadConfig({ dataDir, env });
  const gpu = io.gpu ?? createGpuClient({ getConfig: () => cfg, fetchImpl });
  const gpuConfigured = Boolean(io.gpu || cfg.gpuServer);
  const gpuName = cfg.gpuServer?.name ?? "GPU server";

  // with --json, every failure is a JSON object on stdout ({error, code}) so scripts can parse it
  const wantsJson = Array.isArray(argv) && argv.includes("--json");
  const fail = (message, code) => {
    if (wantsJson) out(JSON.stringify({ error: String(message), code }));
    else err(message);
    return code;
  };
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { if (!wantsJson) { err(e.message); err(USAGE); return e.code ?? 2; } return fail(e.message, e.code ?? 2); }
  const { pos, flags } = parsed;
  const [cmd, ...rest] = pos;
  if (!cmd || flags.help || cmd === "help") { (cmd || flags.help ? out : err)(USAGE); return cmd || flags.help ? 0 : 2; }
  const json = flags.json === true;
  const emit = (obj, human) => out(json ? JSON.stringify(obj, null, 2) : human(obj));

  async function hubGet(path) {
    try {
      const r = await fetchImpl(`${hubUrl}${path}`, { signal: AbortSignal.timeout(8000) });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    } catch {
      throw new CliError(`DSH host API not reachable at ${hubUrl} (is dsh web running with the model-hub plugin?)`, 3);
    }
  }
  const gpuFail = (r) => { throw new CliError(`${gpuName}: HTTP ${r.status} ${errMessage(r.body)}`.trim(), 1); };
  // a refused switch/unload: same {error, code} shape as every other --json failure, plus the GPU server's status
  const gpuReplyFail = (r) => {
    const message = `${gpuName}: HTTP ${r.status} ${errMessage(r.body)}`.trim();
    if (json) out(JSON.stringify({ error: message, code: 1, httpStatus: r.status }));
    else err(message);
    return 1;
  };
  const needGpu = () => { if (!gpuConfigured) throw new CliError("no GPU server configured (see README: GPU server)", 2); };

  try {
    switch (cmd) {
      case "status": {
        const [h, s] = await Promise.all([hubGet("/healthz"), hubGet("/status")]);
        const body = { hub: { reachable: h.status === 200, url: hubUrl }, ...s.body };
        emit(body, (b) => [
          `hub        ${b.hub.reachable ? "up" : "DOWN"} (${b.hub.url})`,
          `claude     ${b.signedIn ? "signed in" : "signed out"}${b.plan?.mode ? ` (${b.plan.mode})` : ""}`,
          `features   imageCap=${b.imageCap} compactionSlim=${b.compactionSlim} spendGuard=${b.spendGuard}`,
        ].join("\n"));
        return h.status === 200 ? 0 : 1;
      }
      case "accounts": {
        const accounts = readAccounts({ statePath: join(dataDir, "accounts-state.json"), ...(credentialsPath ? { credentialsPath } : {}) });
        emit({ accounts }, ({ accounts: a }) => a.map((x) =>
          `${x.provider.padEnd(15)} ${x.health.padEnd(14)} ${x.signedIn ? `${x.kind} ${x.expiresAt ? fmtMs(x.expiresInMs) : ""}` : "not signed in"}${x.lastError ? `  err: ${x.lastError}` : ""}`).join("\n"));
        return accounts.some((x) => x.health === "refresh-failed") ? 1 : 0;
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
      case "spend": {
        const since = flags.since ?? "today";
        const by = flags.by ?? "provider";
        if (!/^(today|7d|30d|all)$/.test(since) || !["provider", "model", "session", "day"].includes(by)) throw new CliError("bad --since/--by", 2);
        const rep = await createCostEngine({ dataDir, localProviders: cfg.localProviders }).spendReport({ since, by });
        emit(rep, (r) => [
          `${r.since}: ${fmtUsd(r.totals.usd)} charged, ${fmtUsd(r.totals.apiEquivUsd)} API-equivalent, ${r.totals.calls} calls`,
          ...Object.entries(r.groups ?? {}).map(([k, v]) => `  ${k.padEnd(28)} ${fmtUsd(v.usd).padStart(9)}  api-eq ${fmtUsd(v.apiEquivUsd).padStart(9)}  ${v.calls} calls`),
          `caps: daily ${fmtUsd(r.caps.limits.dailyUsd)} session ${fmtUsd(r.caps.limits.sessionUsd)}  status ${r.caps.action} (${r.caps.reason})`,
        ].join("\n"));
        return 0;
      }
      case "prices": {
        if (rest.length < 1) throw new CliError("usage: dsh-hub prices <provider/model>…", 2);
        const rep = await createCostEngine({ dataDir, fetchImpl, localProviders: cfg.localProviders }).prices(rest);
        emit(rep, (r) => [`table: ${r.source} (${r.count} entries)`, ...Object.entries(r.models).map(([k, p]) => p.error ? `${k}  ${p.error}` : `${k}  ${p.billing}/${p.source}  in $${p.inPerM}/M  out $${p.outPerM}/M  cache-read $${p.cacheReadPerM}/M`)].join("\n"));
        return Object.values(rep.models).every((p) => p.priced) ? 0 : 1;
      }
      case "cache": {
        const q = flags.session ? `?session=${encodeURIComponent(flags.session)}` : "";
        const r = await hubGet(`/cache${q}`);
        if (r.status !== 200) throw new CliError(`cache: HTTP ${r.status} ${r.body?.error ?? ""}`.trim(), 1);
        emit(r.body, (b) => b.sessions
          ? (b.sessions.length ? b.sessions.map((s) => `${s.sessionId}  last ${(s.lastHit * 100).toFixed(0)}%  avg ${(s.avgHit * 100).toFixed(0)}%  ${s.steps} steps  ${s.provider}/${s.model}`).join("\n") : "no sessions observed yet")
          : `${b.sessionId}  last ${(b.lastHit * 100).toFixed(0)}%  avg ${(b.avgHit * 100).toFixed(0)}%  ${b.steps} steps`);
        return 0;
      }
      case "doctor":
        return await doctor({ out, emit, json, fetchImpl, hubUrl, dataDir, credentialsPath, gpu, gpuConfigured, gpuName, cfg, env });
      default:
        throw new CliError(`unknown command ${cmd}\n${USAGE}`, 2);
    }
  } catch (e) {
    if (e instanceof CliError) return fail(redactSecrets(e.message), e.code);
    return fail(`dsh-hub: ${redactSecrets(e?.message || e)}`, 1);
  }
}

async function doctor({ emit, fetchImpl, hubUrl, dataDir, credentialsPath, gpu, gpuConfigured, gpuName, cfg, env }) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  const mode = (p) => (statSync(p).mode & 0o777).toString(8);

  try {
    const r = await fetchImpl(`${hubUrl}/healthz`, { signal: AbortSignal.timeout(4000) });
    add("host API", r.status === 200 ? "ok" : "fail", `${hubUrl}/healthz HTTP ${r.status}`);
    const s = await (await fetchImpl(`${hubUrl}/status`, { signal: AbortSignal.timeout(8000) })).json();
    add("guards", s.spendGuard && s.compactionSlim && s.imageCap ? "ok" : "warn", `imageCap=${s.imageCap} compactionSlim=${s.compactionSlim} spendGuard=${s.spendGuard}`);
  } catch { add("host API", "fail", `not reachable at ${hubUrl}`); }

  if (!gpuConfigured) add("GPU server", "ok", "not configured");
  else {
    try {
      const h = await gpu.health();
      add(`${gpuName} server`, h.status === 200 ? "ok" : "fail", `HTTP ${h.status}`);
      const g = await gpu.gpus();
      if (g.status === 200 && g.body?.ok !== false) add(`${gpuName} manager`, g.body.stale ? "warn" : "ok", `state ${g.body.state_age_s}s old${g.body.stale ? " (STALE)" : ""}, loaded ${g.body.loaded_model ?? "none"}`);
      else add(`${gpuName} manager`, "fail", String(g.body?.error ?? `HTTP ${g.status}`).slice(0, 160));
    } catch { add(`${gpuName} server`, "fail", "unreachable"); }
  }
  for (const e of cfg.errors) add("config.json", "warn", e);

  try {
    const accounts = readAccounts({ statePath: join(dataDir, "accounts-state.json"), ...(credentialsPath ? { credentialsPath } : {}) });
    const signed = accounts.filter((a) => a.signedIn);
    const bad = signed.filter((a) => a.health !== "ok");
    add("accounts", bad.length ? "warn" : "ok", signed.length ? signed.map((a) => `${a.provider}:${a.health}`).join(" ") : "no provider signed in");
  } catch (e) { add("accounts", "fail", String(e?.message || e).slice(0, 120)); }

  const credFile = credentialsPath || join(dshHome(env), ".credentials.yaml");
  if (existsSync(credFile)) add("credentials file", mode(credFile) === "600" ? "ok" : "fail", `mode ${mode(credFile)}`);
  if (existsSync(dataDir)) add("data dir", mode(dataDir) === "700" ? "ok" : "warn", `mode ${mode(dataDir)}`);
  else add("data dir", "warn", `${dataDir} does not exist yet (created on first spend)`);

  try {
    const eng = createCostEngine({ dataDir, fetchImpl, localProviders: cfg.localProviders });
    const caps = eng.capsStatus();
    add("caps", caps.warnings.length ? "warn" : "ok", `daily $${caps.limits.dailyUsd}, session $${caps.limits.sessionUsd}, today $${caps.todayUsd.toFixed(2)} (${caps.action})`);
    const p = await eng.prices(["google/gemini-3.8-flash"]);
    add("price table", p.count > 0 ? "ok" : "fail", `${p.source}, ${p.count} entries${p.warnings.length ? `, ${p.warnings.length} warnings` : ""}`);
  } catch (e) { add("cost", "fail", String(e?.message || e).slice(0, 120)); }

  // the ~/.local/bin symlink is optional convenience: report it, never warn about it
  const link = join(homedir(), ".local/bin/dsh-hub");
  add("CLI link", "ok", existsSync(link) ? link : "not installed (optional: ln -s <repo>/bin/dsh-hub.mjs ~/.local/bin/dsh-hub)");
  add("data dir path", "ok", dataDir);

  const res = { ok: checks.every((c) => c.level !== "fail"), checks };
  emit(res, (r) => [...r.checks.map((c) => `${c.level.toUpperCase().padEnd(4)} ${c.name.padEnd(17)} ${c.detail}`), r.ok ? "doctor: OK" : "doctor: FAILED"].join("\n"));
  return res.ok ? 0 : 1;
}

let invoked = false;
try { invoked = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* ignore */ }
if (invoked) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
