import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./dsh-hub.mjs";
import { appendSpend, ledgerRows, _resetLedgerCache } from "../lib/cost/ledger.mjs";
import { exportRows, exportTargetIsLedger, EXPORT_COLUMNS, VERIFY_NOTE } from "../lib/cost/verify.mjs";
import { makeSpendRecord } from "../lib/cost/cost.mjs";

const P = { inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, source: 'litellm', billing: 'metered' };
function env() {
  const dir = mkdtempSync(join(tmpdir(), "hub-cli-ledger-"));
  return { dir, env: { DSH_HUB_DATA_DIR: join(dir, "data"), DSH_HUB_CREDENTIALS: join(dir, "creds.yaml"), DSH_HUB_URL: "http://hub.test" } };
}
// a host that is not there: no test here touches a real network or a real DSH
const refused = async () => { throw new Error("ECONNREFUSED"); };
function run(args, e, fetch = refused) {
  const o = [], er = [];
  return main(args, { out: (s) => o.push(s), err: (s) => er.push(s), env: e.env, fetch }).then((code) => ({ code, out: o.join("\n"), err: er.join("\n") }));
}
function seed(e) {
  const dir = e.env.DSH_HUB_DATA_DIR;
  const row = (purpose, usd) => ({ ...makeSpendRecord({ sessionId: "s", provider: "google", model: "m", usage: { inputTokens: 10, outputTokens: 1 }, price: P, meta: { purpose } }), usd, apiEquivUsd: usd });
  appendSpend(dir, row("chat", 1)); appendSpend(dir, row("compaction", 0.5));
  appendSpend(dir, { ts: new Date().toISOString(), sessionId: "s", provider: "google", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.25, apiEquivUsd: 0.25, priceSource: "litellm", billing: "metered" });
}

test("spend --by purpose --json groups v2 rows by purpose and v1 rows as unknown, with byPurpose", async () => {
  const e = env(); seed(e);
  const r = await run(["spend", "--since", "all", "--by", "purpose", "--json"], e);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j.groups).sort(), ["chat", "compaction", "unknown"]);
  assert.deepEqual(Object.keys(j.byPurpose).sort(), ["chat", "compaction", "unknown"]);
  assert.equal(j.groups.chat.usd, 1); assert.equal(j.groups.unknown.usd, 0.25);
});

test("spend --by purpose prints one line per purpose", async () => {
  const e = env(); seed(e);
  const r = await run(["spend", "--since", "all", "--by", "purpose"], e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ {2}chat\s+\$1\.00/m);
  assert.match(r.out, /^ {2}compaction\s+\$0\.5000/m);
  assert.match(r.out, /^ {2}unknown\s+\$0\.2500/m);
});

test("spend --by nope exits 2 with the valid values named; --help lists purpose", async () => {
  const e = env();
  const bad = await run(["spend", "--by", "nope"], e);
  assert.equal(bad.code, 2); assert.match(bad.err, /bad --since\/--by/);
  const help = await run(["--help"], e);
  assert.match(help.out + help.err, /--by provider\|model\|session\|day\|purpose/);
});

// ---- ledger verify / ledger export ----
const ledgerFile = (e) => join(e.env.DSH_HUB_DATA_DIR, "spend.jsonl");
function seedV2(e, n = 2) {
  const dir = e.env.DSH_HUB_DATA_DIR;
  for (let i = 0; i < n; i++) appendSpend(dir, makeSpendRecord({ sessionId: "s", provider: "google", model: "m" + i, usage: { inputTokens: 1000, outputTokens: 100 }, price: P }));
  appendSpend(dir, { ts: new Date().toISOString(), sessionId: "s", provider: "google", model: "old", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.25, apiEquivUsd: 0.25, priceSource: "litellm", billing: "metered", id: "oldrow" });
}
function tamperUsd(e) {
  const f = ledgerFile(e);
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  lines[0].usd = 5;
  writeFileSync(f, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  _resetLedgerCache();
}

test("ledger verify on a clean ledger: exit 0, counts, VERIFIED and the honesty note; --json is the report", async () => {
  const e = env(); seedV2(e);
  const r = await run(["ledger", "verify"], e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ledger \(since all\): 3 rows · 2 v2 re-derived · 1 v1 \(not re-derivable\)$/m);
  assert.match(r.out, /^mismatches 0 · torn lines 0 · duplicate ids 0 · unknown fields none$/m);
  assert.match(r.out, /^VERIFIED$/m); assert.ok(r.out.includes(VERIFY_NOTE)); assert.equal(r.err, "");
  const j = await run(["ledger", "verify", "--json"], e);
  assert.equal(j.code, 0);
  const rep = JSON.parse(j.out);
  assert.deepEqual([rep.ok, rep.rows, rep.checked, rep.v1, rep.mismatchCount, rep.since], [true, 3, 2, 1, 0, "all"]);
  assert.equal(rep.error, undefined);
});

test("ledger verify on a tampered ledger: exit 1; the data on stdout and the message on stderr, or {error, code, ...report} with --json", async () => {
  const e = env(); seedV2(e); tamperUsd(e);
  const r = await run(["ledger", "verify"], e);
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAILED$/m); assert.match(r.out, /usd\b.*expected.*stored 5/);
  assert.equal(r.err, "ledger verification failed: 1 mismatching field(s), 0 torn line(s)");
  const j = await run(["ledger", "verify", "--json"], e);
  assert.equal(j.code, 1);
  const rep = JSON.parse(j.out);
  assert.equal(rep.code, 1); assert.match(rep.error, /^ledger verification failed: 1 mismatching field/); assert.equal(rep.ok, false);
  assert.equal(rep.mismatches[0].field, "usd"); assert.equal(rep.mismatches[0].stored, 5); assert.equal(j.err, "");
});

test("ledger verify: a torn line fails, a duplicate id does not, --since limits rows", async () => {
  const e = env(); seedV2(e);
  writeFileSync(ledgerFile(e), readFileSync(ledgerFile(e), "utf8") + "{not json\n");
  const torn = await run(["ledger", "verify", "--json"], e);
  assert.equal(torn.code, 1); assert.equal(JSON.parse(torn.out).tornLines, 1);
  assert.match(JSON.parse(torn.out).error, /1 torn line\(s\)/);
  const e2 = env(); seedV2(e2);
  const first = readFileSync(ledgerFile(e2), "utf8").split("\n").filter(Boolean)[0];
  writeFileSync(ledgerFile(e2), readFileSync(ledgerFile(e2), "utf8") + first + "\n");
  const dup = await run(["ledger", "verify"], e2);
  assert.equal(dup.code, 0); assert.match(dup.out, /duplicate ids 1/);
  const none = await run(["ledger", "verify", "--since", "today", "--json"], e2);
  assert.equal(JSON.parse(none.out).since, "today");
});

test("ledger verify on an unreadable ledger: exit 1 with the could-not-be-read message", async () => {
  const e = env(); seedV2(e);
  chmodSync(e.env.DSH_HUB_DATA_DIR, 0o000);
  let r;
  try { r = await run(["ledger", "verify", "--json"], e); } finally { chmodSync(e.env.DSH_HUB_DATA_DIR, 0o700); }
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.out).error, /ledger could not be read in full/);
});

test("ledger: missing or unknown subcommand and bad flags exit 2", async () => {
  const e = env();
  for (const args of [["ledger"], ["ledger", "nope"], ["ledger", "verify", "extra"], ["ledger", "verify", "--since", "yesterday"], ["ledger", "verify", "--csv"], ["ledger", "export"], ["ledger", "export", "--csv", "--jsonl"], ["ledger", "export", "--csv", "--since", "x"]]) {
    const r = await run(args, e);
    assert.equal(r.code, 2, args.join(" ") + " :: " + r.err);
  }
  const j = await run(["ledger", "nope", "--json"], e);
  assert.equal(j.code, 2); assert.equal(JSON.parse(j.out).code, 2);
  const help = await run(["--help"], e);
  assert.match(help.out, /ledger verify \[--since/); assert.match(help.out, /ledger export \(--csv\|--jsonl\)/);
});

test("ledger export to stdout is exactly exportRows; --json without --out is a usage error", async () => {
  const e = env(); seedV2(e);
  const rows = ledgerRows(e.env.DSH_HUB_DATA_DIR).rows.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const csv = await run(["ledger", "export", "--csv"], e);
  assert.equal(csv.code, 0, csv.err);
  assert.equal(csv.out + "\n", exportRows(rows, "csv"));
  assert.equal(csv.out.split("\n")[0], EXPORT_COLUMNS.join(","));
  const jl = await run(["ledger", "export", "--jsonl"], e);
  assert.equal(jl.code, 0); assert.equal(jl.out + "\n", exportRows(rows, "jsonl"));
  const bad = await run(["ledger", "export", "--csv", "--json"], e);
  assert.equal(bad.code, 2); assert.equal(JSON.parse(bad.out).code, 2);
});

test("ledger export --out writes a 0600 file, refuses to overwrite, and --force replaces it", async () => {
  const e = env(); seedV2(e);
  const f = join(e.dir, "ledger.csv");
  const first = await run(["ledger", "export", "--csv", "--out", f], e);
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out, `wrote 3 rows (csv) to ${f}`);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const body = readFileSync(f, "utf8");
  assert.equal(body.split("\n")[0], EXPORT_COLUMNS.join(","));
  const again = await run(["ledger", "export", "--csv", "--out", f], e);
  assert.equal(again.code, 1); assert.match(again.err, /^refusing to overwrite \S+ \(use --force\)$/);
  assert.equal(readFileSync(f, "utf8"), body);
  appendSpend(e.env.DSH_HUB_DATA_DIR, makeSpendRecord({ sessionId: "s", provider: "google", model: "extra", usage: { inputTokens: 5, outputTokens: 5 }, price: P }));
  const forced = await run(["ledger", "export", "--jsonl", "--out", f, "--force", "--json"], e);
  assert.equal(forced.code, 0, forced.err);
  const o = JSON.parse(forced.out);
  assert.deepEqual([o.out, o.format, o.rows], [f, "jsonl", 4]); assert.equal(o.bytes, statSync(f).size);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(readFileSync(f, "utf8").split("\n").filter(Boolean).length, 4);
});

test("ledger export --out into a missing directory fails with exit 1 and a short message (no OS detail)", async () => {
  const e = env(); seedV2(e);
  const f = join(e.dir, "missing", "x.csv");
  const r = await run(["ledger", "export", "--csv", "--out", f], e);
  assert.equal(r.code, 1);
  assert.match(r.err, /^cannot write \S+: ENOENT$/); assert.ok(!/open '/.test(r.err));
  assert.ok(!existsSync(f));
});

test("ledger export from an unreadable ledger writes nothing and exits 1", async () => {
  const e = env(); seedV2(e);
  const f = join(e.dir, "partial.csv");
  chmodSync(e.env.DSH_HUB_DATA_DIR, 0o000);
  let r;
  try { r = await run(["ledger", "export", "--csv", "--out", f], e); } finally { chmodSync(e.env.DSH_HUB_DATA_DIR, 0o700); }
  assert.equal(r.code, 1); assert.match(r.err, /ledger could not be read in full/);
  assert.ok(!existsSync(f));
});

test("ledger export --since limits the rows and holds only ledger fields", async () => {
  const e = env(); seedV2(e);
  appendSpend(e.env.DSH_HUB_DATA_DIR, { ts: new Date(Date.now() - 40 * 86400e3).toISOString(), sessionId: "s", provider: "google", model: "ancient", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0, apiEquivUsd: 0, priceSource: "litellm", billing: "metered", prompt: "SECRET PROMPT TEXT" });
  const all = await run(["ledger", "export", "--jsonl", "--since", "all"], e);
  const wk = await run(["ledger", "export", "--jsonl", "--since", "7d"], e);
  assert.equal(all.out.split("\n").length, 4); assert.equal(wk.out.split("\n").length, 3);
  assert.ok(!all.out.includes("SECRET"));
  for (const l of all.out.split("\n")) assert.deepEqual(Object.keys(JSON.parse(l)), ["ts", "id", "sessionId", "provider", "model", "input", "output", "cacheRead", "cacheWrite", "usd", "apiEquivUsd", "priceSource", "billing", "v", "purpose", "turn", "step", "parentSessionId", "rates", "derived", "tier", "offPeak", "planCoveredUsd", "reasoning", "finish", "ttftMs", "durationMs"]);
});

test("ledger export --out never targets a ledger file name in the data dir, with or without --force (exit 2, nothing written)", async () => {
  const e = env(); seedV2(e);
  const before = readFileSync(ledgerFile(e), "utf8");
  for (const target of [ledgerFile(e), join(e.env.DSH_HUB_DATA_DIR, "..", "data", "spend.jsonl"), join(e.env.DSH_HUB_DATA_DIR, "spend.1700000000000.jsonl")]) {
    for (const extra of [[], ["--force"]]) {
      const r = await run(["ledger", "export", "--csv", "--out", target, ...extra], e);
      assert.equal(r.code, 2, target + " " + extra + " :: " + r.err);
    }
  }
  const forced = await run(["ledger", "export", "--csv", "--out", ledgerFile(e), "--force"], e);
  assert.match(forced.err, /--out would overwrite the spend ledger/);
  assert.ok(!existsSync(join(e.env.DSH_HUB_DATA_DIR, "spend.1700000000000.jsonl")));
  assert.equal(readFileSync(ledgerFile(e), "utf8"), before);
});

test("ledger export --out --force with a miscased ledger name (SPEND.JSONL, a case-insensitive filesystem's spend.jsonl) is refused and the ledger bytes are untouched", async () => {
  const e = env(); seedV2(e);
  const before = readFileSync(ledgerFile(e));
  const dir = e.env.DSH_HUB_DATA_DIR;
  for (const name of ["SPEND.JSONL", "Spend.Jsonl", ".SPEND.rotating.1.abcdef", "SPEND.1700000000000.JSONL"]) {
    for (const extra of [[], ["--force"]]) {
      const r = await run(["ledger", "export", "--csv", "--out", join(dir, name), ...extra], e);
      assert.equal(r.code, 2, name + " " + extra + " :: " + r.err);
      assert.match(r.err, /--out would overwrite the spend ledger/);
    }
  }
  assert.deepEqual(readFileSync(ledgerFile(e)), before);
});

test("ledger export --force inside the data dir is refused whatever the name (exit 2); without --force a non-ledger name there still works", async () => {
  const e = env(); seedV2(e);
  const dir = e.env.DSH_HUB_DATA_DIR;
  const target = join(dir, "export.csv");
  const forced = await run(["ledger", "export", "--csv", "--out", target, "--force"], e);
  assert.equal(forced.code, 2); assert.match(forced.err, /--force cannot be used with --out inside the data dir/);
  assert.ok(!existsSync(target));
  const plain = await run(["ledger", "export", "--csv", "--out", target], e);
  assert.equal(plain.code, 0, plain.err); assert.ok(existsSync(target));
});

test("exportTargetIsLedger decides by file identity: a second name (hard link) of a ledger file is refused, an unrelated file is not", () => {
  const e = env(); seedV2(e);
  const dir = e.env.DSH_HUB_DATA_DIR;
  const elsewhere = join(e.dir, "elsewhere"); mkdirSync(elsewhere);
  const alias = join(elsewhere, "report.csv");
  linkSync(ledgerFile(e), alias);
  assert.equal(exportTargetIsLedger(dir, alias, { force: true }), "ledger");
  assert.equal(exportTargetIsLedger(dir, alias, { force: false }), "ledger");
  const other = join(elsewhere, "other.csv"); writeFileSync(other, "x");
  assert.equal(exportTargetIsLedger(dir, other, { force: true }), null);
  assert.equal(exportTargetIsLedger(dir, join(elsewhere, "missing.csv"), { force: true }), null);
  assert.equal(exportTargetIsLedger(dir, join(dir, "export.csv"), { force: true }), "force-in-data-dir");
  assert.equal(exportTargetIsLedger(dir, join(dir, "export.csv"), { force: false }), null);
});

test("README: rotation and doctor text belong to the Ledger bullet, not to Ledger v2 or Spend by purpose", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const bullet = (title) => { const i = readme.indexOf(`- **${title}`); assert.ok(i >= 0, title); const j = readme.indexOf("\n- **", i + 1); return readme.slice(i, j < 0 ? undefined : j); };
  const ledger = bullet("Ledger**"), v2 = bullet("Ledger v2 rows"), purpose = bullet("Spend by purpose");
  for (const t of ["Rotated at 20 MB", "`dsh-hub doctor` checks that the data dir and the ledger", "`\"complete\": false`"]) {
    assert.ok(ledger.includes(t), "Ledger bullet lacks: " + t);
    assert.ok(!v2.includes(t) && !purpose.includes(t), "misplaced: " + t);
  }
});

// ---- guard status: dsh-hub status and dsh-hub doctor ----
const hubFetch = (routes) => async (url) => {
  const u = new URL(url);
  const r = routes[u.pathname + u.search] ?? routes[u.pathname];
  if (!r) throw new Error("ECONNREFUSED");
  return { status: r[0], json: async () => r[1] };
};
function runF(args, e, fetch) {
  const o = [], er = [];
  return main(args, { out: (s) => o.push(s), err: (s) => er.push(s), env: e.env, fetch }).then((code) => ({ code, out: o.join("\n"), err: er.join("\n") }));
}
const STATUS = { signedIn: true, plan: { mode: "plan" }, imageCap: true, compactionSlim: true, spendGuard: true };
const withGuard = (guard) => hubFetch({ "/healthz": [200, { ok: true }], "/status": [200, guard === undefined ? STATUS : { ...STATUS, guard }] });
const GUARD_ERR = { onError: "block", errors: { count: 2, last: { at: 1700000000000, message: "boom key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123" } } };
const GUARD_OK = { onError: "allow", errors: { count: 0, last: null } };

test("status prints a guard line (policy and error count) and, when there are errors, the last one redacted", async () => {
  const e = env();
  const clean = await runF(["status"], e, withGuard(GUARD_OK));
  assert.equal(clean.code, 0, clean.err);
  assert.match(clean.out, /^guard {6}onError=allow · errors 0$/m);
  assert.doesNotMatch(clean.out, /last:/);
  const bad = await runF(["status"], e, withGuard(GUARD_ERR));
  assert.equal(bad.code, 0, bad.err);
  assert.match(bad.out, /^guard {6}onError=block · errors 2$/m);
  assert.match(bad.out, /^ {2}last: boom key=/m);
  assert.doesNotMatch(bad.out, /AIza/);
});

test("status --json carries guard; an older host without it prints no guard line", async () => {
  const e = env();
  const j = JSON.parse((await runF(["status", "--json"], e, withGuard(GUARD_ERR))).out);
  assert.equal(j.guard.onError, "block");
  assert.equal(j.guard.errors.count, 2);
  const old = await runF(["status"], e, withGuard(undefined));
  assert.equal(old.code, 0);
  assert.doesNotMatch(old.out, /^guard /m);
  const nul = await runF(["status"], e, withGuard(null));
  assert.doesNotMatch(nul.out, /^guard /m);
});

const doctorChecks = async (e, f) => {
  const lit = async (u) => { if (String(u).includes("hub.test")) return f(u); throw new Error("offline"); };
  const r = await runF(["doctor", "--json"], e, lit);
  return { r, checks: JSON.parse(r.out).checks };
};

test("doctor warns on guard errors > 0 (with count, policy and last error) and still exits 0; zero errors is ok", async () => {
  const e = env();
  const warn = await doctorChecks(e, withGuard(GUARD_ERR));
  const c = warn.checks.find((x) => x.name === "guard errors");
  assert.equal(c.level, "warn");
  assert.match(c.detail, /onError=block/);
  assert.match(c.detail, /2 error\(s\) since this DSH process started/);
  assert.match(c.detail, /last: boom/);
  assert.doesNotMatch(c.detail, /AIza/);
  assert.equal(warn.r.code, 0, "a warn is not a failure");
  const ok = (await doctorChecks(e, withGuard(GUARD_OK))).checks.find((x) => x.name === "guard errors");
  assert.equal(ok.level, "ok");
  assert.match(ok.detail, /onError=allow/);
  assert.match(ok.detail, /0 error\(s\)/);
});

test("doctor skips the guard check on an older host that reports no guard", async () => {
  const e = env();
  const { checks } = await doctorChecks(e, withGuard(undefined));
  assert.equal(checks.find((x) => x.name === "guard errors"), undefined);
});

test("a bad guard.onError in config.json shows through the doctor's config.json warn", async () => {
  const e = env();
  mkdirSync(e.env.DSH_HUB_DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(e.env.DSH_HUB_DATA_DIR, "config.json"), JSON.stringify({ guard: { onError: "BLOCK" } }));
  const { r, checks } = await doctorChecks(e, withGuard(GUARD_OK));
  assert.ok(checks.some((x) => x.name === "config.json" && x.level === "warn" && x.detail === 'guard.onError must be "allow" or "block"'), r.out);
});

// ---- spend: dollars reserved by requests in flight (Task 5) ----
const hostWith = (reserved, seen = []) => async (url, init) => {
  seen.push({ url: String(url), headers: init?.headers });
  if (new URL(url).pathname !== "/spend") throw new Error("ECONNREFUSED");
  return { status: 200, json: async () => ({ caps: { reserved } }) };
};

test("spend shows the running host's in-flight dollars; --json carries caps.reserved with source host; the host call is header-gated and read-only", async () => {
  const e = env(); seed(e);
  const seen = [];
  const r = await run(["spend", "--since", "all"], e, hostWith({ usd: 0.825, count: 2 }, seen));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^in flight: \$0\.8250 reserved across 2 request\(s\) \(running DSH process\)$/m);
  assert.ok(r.out.indexOf("in flight:") < r.out.indexOf("caps:"), "the line sits before the caps line");
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /^http:\/\/hub\.test\/spend\?since=today&by=provider$/);
  assert.equal(seen[0].headers["x-dsh-model-hub"], "1");
  const j = JSON.parse((await run(["spend", "--json"], e, hostWith({ usd: 0.825, count: 2 }))).out);
  assert.deepEqual(j.caps.reserved, { usd: 0.825, count: 2, source: "host" });
});

test("spend with nothing in flight says none; host down says unknown and the exit code is unchanged", async () => {
  const e = env(); seed(e);
  const none = await run(["spend"], e, hostWith({ usd: 0, count: 0 }));
  assert.equal(none.code, 0);
  assert.match(none.out, /^in flight: none \(running DSH process\)$/m);
  const down = await run(["spend"], e);
  assert.equal(down.code, 0, down.err);
  assert.match(down.out, /^in flight: unknown \(the running DSH process holds reservations; host API not reachable\)$/m);
  const j = JSON.parse((await run(["spend", "--json"], e)).out);
  assert.deepEqual(j.caps.reserved, { usd: 0, count: 0, source: "unavailable" });
  assert.equal(j.totals.calls, 3, "the local ledger report is untouched");
});

test("spend ignores a host answer that is not a well-formed reserved block", async () => {
  const e = env(); seed(e);
  for (const bad of [null, "x", { usd: "5", count: 1 }, { usd: -1, count: 1 }, { usd: 1, count: 1.5 }, { usd: Infinity, count: 1 }, { count: 2 }]) {
    const j = JSON.parse((await run(["spend", "--json"], e, hostWith(bad))).out);
    assert.deepEqual(j.caps.reserved, { usd: 0, count: 0, source: "unavailable" }, JSON.stringify(bad));
  }
  const non200 = async () => ({ status: 403, json: async () => ({ caps: { reserved: { usd: 9, count: 9 } } }) });
  assert.equal(JSON.parse((await run(["spend", "--json"], e, non200)).out).caps.reserved.source, "unavailable");
});

test("spend with the ledger unreadable still prints the in-flight line", async () => {
  const e = env(); seed(e);
  chmodSync(ledgerFile(e), 0o000);
  try {
    const r = await run(["spend"], e, hostWith({ usd: 1, count: 1 }));
    assert.notEqual(r.code, 0);
    assert.match(r.out, /in flight: \$1\.00 reserved across 1 request/);
  } finally { chmodSync(ledgerFile(e), 0o600); }
});
