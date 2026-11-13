// dsh-hub receipt <session-id|last> [--md|--json]: offline, from the data dir only.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./dsh-hub.mjs";
import { appendSpend, ledgerRows, _resetLedgerCache } from "../lib/cost/ledger.mjs";
import { makeSpendRecord } from "../lib/cost/cost.mjs";
import { buildReceipt, receiptText, receiptMarkdown } from "../lib/cost/receipt.mjs";
import { DEMO_TEXT } from "../lib/demo/constants.mjs";

const MET = { inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, source: "litellm", billing: "metered" };
const SUB = { ...MET, billing: "subscription" };
const T0 = Date.parse("2026-11-12T10:00:00Z");
function env() {
  const dir = mkdtempSync(join(tmpdir(), "hub-cli-receipt-"));
  return { dir, env: { DSH_HUB_DATA_DIR: join(dir, "data"), DSH_HUB_CREDENTIALS: join(dir, "creds.yaml"), DSH_HUB_URL: "http://hub.test" } };
}
let fetched = 0;
const spy = async () => { fetched++; throw new Error("the CLI must not call the host for this"); };
function run(args, e, fetch = spy) {
  const o = [], er = [];
  return main(args, { out: (s) => o.push(s), err: (s) => er.push(s), env: e.env, fetch }).then((code) => ({ code, out: o.join("\n"), err: er.join("\n") }));
}
const row = (sid, turn, step, at, { price = MET, usage = { inputTokens: 12400, outputTokens: 1200, cacheReadTokens: 100000 }, purpose = "chat", parent = null, provider = "google", model = "m" } = {}) =>
  makeSpendRecord({ ts: new Date(T0 + at).toISOString(), sessionId: sid, provider, model, usage, price, meta: { purpose, turn, step, parentSessionId: parent, ttftMs: 800, durationMs: 3000 } });
function seed(e) {
  const d = e.env.DSH_HUB_DATA_DIR;
  appendSpend(d, row("s1", 1, 1, 0)); appendSpend(d, row("s1", 1, 2, 5000));
  appendSpend(d, row("s1", 2, 1, 60000, { price: SUB, provider: "anthropic", model: "c" }));
  appendSpend(d, row("s1", null, null, 59000, { purpose: "compaction" }));
  appendSpend(d, row("s1-sub", 1, 1, 70000, { parent: "s1" }));
  appendSpend(d, row("other", 1, 1, 900000));
}
const rcOf = (e, id) => buildReceipt(ledgerRows(e.env.DSH_HUB_DATA_DIR).rows, id);

test("receipt <id> prints receiptText exactly", async () => {
  const e = env(); seed(e); fetched = 0;
  const r = await run(["receipt", "s1"], e);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, receiptText(rcOf(e, "s1")));
  assert.match(r.out.split("\n")[0], /^Session s1$/);
  assert.match(r.out, /subagents \(one level\): 1 session, 1 call/);
});

test("receipt last resolves to the newest session and names it on the first line; a subagent row resolves to its parent", async () => {
  const e = env(); seed(e);
  let r = await run(["receipt", "last"], e);
  assert.equal(r.code, 0, r.err); assert.equal(r.out.split("\n")[0], "Session other");
  appendSpend(e.env.DSH_HUB_DATA_DIR, row("deep", 1, 1, 2_000_000, { parent: "s1" }));
  r = await run(["receipt", "last"], e);
  assert.equal(r.out.split("\n")[0], "Session s1");
});

test("--md prints exactly receiptMarkdown and nothing else; --json carries the receipt plus markdown, complete and unreadable", async () => {
  const e = env(); seed(e);
  const md = await run(["receipt", "s1", "--md"], e);
  assert.equal(md.code, 0, md.err);
  assert.equal(md.out, receiptMarkdown(rcOf(e, "s1")));
  assert.equal(md.err, "");
  const j = JSON.parse((await run(["receipt", "s1", "--json"], e)).out);
  assert.equal(j.sessionId, "s1"); assert.equal(j.calls, 4); assert.equal(j.subagents.calls, 1);
  assert.equal(j.complete, true); assert.equal(j.unreadable, false);
  assert.equal(j.markdown, md.out);
  assert.ok(Array.isArray(j.byRoute));
});

test("--md with --json, no id, extra args and a bad id exit 2; an unknown id and last on an empty ledger exit 1", async () => {
  const e = env(); seed(e);
  for (const [args, re] of [
    [["receipt", "s1", "--md", "--json"], /--md and --json cannot be combined/],
    [["receipt"], /usage: dsh-hub receipt/],
    [["receipt", "s1", "s2"], /usage: dsh-hub receipt/],
    [["receipt", "../x"], /session must be a session id/],
    [["receipt", "a b"], /session must be a session id/],
    [["receipt", "x".repeat(129)], /session must be a session id/],
  ]) {
    const r = await run(args, e);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err + r.out, re, args.join(" ")); // with --json the error is a JSON object on stdout
  }
  let r = await run(["receipt", "nobody"], e);
  assert.equal(r.code, 1); assert.match(r.err, /no ledger rows for session nobody/);
  r = await run(["receipt", "nobody", "--json"], e);
  assert.equal(r.code, 1); assert.equal(JSON.parse(r.out).code, 1);
  r = await run(["receipt", "last"], env());
  assert.equal(r.code, 1); assert.match(r.err, /no ledger rows/);
});

test("it is offline: the host is never called, and the data dir path is in no output form", async () => {
  const e = env(); seed(e); fetched = 0;
  for (const args of [["receipt", "s1"], ["receipt", "last"], ["receipt", "s1", "--md"], ["receipt", "s1", "--json"]]) {
    const r = await run(args, e);
    assert.ok(!r.out.includes(e.dir), args.join(" "));
    assert.ok(!r.out.includes("spend.jsonl"), args.join(" "));
  }
  assert.equal(fetched, 0);
});

test("an unreadable ledger prints what it has and exits 1 (text, --md and --json)", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root can read a mode 000 file");
  const e = env(); seed(e);
  _resetLedgerCache();
  const f = join(e.env.DSH_HUB_DATA_DIR, "spend.jsonl");
  chmodSync(f, 0);
  try {
    const j = await run(["receipt", "s1", "--json"], e);
    assert.equal(j.code, 1);
    const b = JSON.parse(j.out);
    assert.equal(b.unreadable, true); assert.equal(b.code, 1); assert.match(b.error, /partial totals/);
    const m = await run(["receipt", "s1", "--md"], e);
    assert.equal(m.code, 1); assert.match(m.err, /partial totals/);
  } finally { chmodSync(f, 0o600); }
});

test("an unreadable ledger with no rows never says 'no calls': text and --md print nothing on stdout and the partial message on stderr; --json says unreadable; last does not claim an empty ledger", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root can read a mode 000 file");
  const e = env(); seed(e);
  _resetLedgerCache();
  const f = join(e.env.DSH_HUB_DATA_DIR, "spend.jsonl");
  chmodSync(f, 0);
  try {
    const txt = await run(["receipt", "s1"], e);
    assert.equal(txt.code, 1); assert.equal(txt.out, "");
    assert.match(txt.err, /partial totals: the spend ledger could not be read/);
    const md = await run(["receipt", "s1", "--md"], e);
    assert.equal(md.code, 1); assert.equal(md.out, "");
    assert.match(md.err, /partial totals/);
    const js = await run(["receipt", "s1", "--json"], e);
    assert.equal(js.code, 1);
    const b = JSON.parse(js.out);
    assert.equal(b.unreadable, true); assert.equal(b.calls, 0);
    const last = await run(["receipt", "last"], e);
    assert.equal(last.code, 1); assert.equal(last.out, "");
    assert.match(last.err, /partial totals/); assert.doesNotMatch(last.err, /no ledger rows/);
    const turns = await run(["spend", "--session", "s1", "--by", "turn"], e);
    assert.equal(turns.code, 1); assert.equal(turns.out, ""); assert.match(turns.err, /partial totals/);
    const turnsLast = await run(["spend", "--session", "last", "--by", "turn"], e);
    assert.equal(turnsLast.code, 1); assert.equal(turnsLast.out, ""); assert.doesNotMatch(turnsLast.err, /no ledger rows/);
    const tj = await run(["spend", "--session", "s1", "--by", "turn", "--json"], e);
    assert.equal(tj.code, 1); assert.equal(JSON.parse(tj.out).unreadable, true);
  } finally { chmodSync(f, 0o600); }
});

test("a demo folder prints the DEMO banner first in text and JSON, and the Markdown carries its own DEMO line once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-cli-receipt-demo-"));
  const { writeDemo } = await import("../lib/demo/write.mjs");
  const home = join(dir, "home");
  const w = writeDemo({ out: join(dir, "demo"), at: "2026-11-12T15:00:00Z", seed: 3, tzOffsetMin: 0, env: { DSH_HUB_DATA_DIR: join(dir, "d"), DSH_HOME: join(dir, "h"), HOME: home }, home });
  const e = { env: { DSH_HUB_DATA_DIR: w.out, DSH_HUB_URL: "http://hub.test" } };
  const t = await run(["receipt", "demo-s-conv"], e);
  assert.equal(t.code, 0, t.err);
  assert.equal(t.out.split("\n")[0], DEMO_TEXT);
  const j = JSON.parse((await run(["receipt", "demo-s-conv", "--json"], e)).out);
  assert.equal(j.demo, true); assert.equal(j.demoNote, DEMO_TEXT); assert.equal(j.markdown.split("\n")[0], DEMO_TEXT);
  const md = await run(["receipt", "demo-s-conv", "--md"], e);
  assert.equal(md.out.split("\n")[0], DEMO_TEXT);
  assert.equal(md.out.split(DEMO_TEXT).length - 1, 1);
});

test("help lists the receipt command", async () => {
  const r = await run(["--help"], env());
  assert.match(r.out, /receipt <session-id\|last> \[--md\|--json\]/);
});
