import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./dsh-hub.mjs";
import { appendSpend, _resetLedgerCache } from "../lib/cost/ledger.mjs";
import { makeSpendRecord } from "../lib/cost/cost.mjs";

const MET = { inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, source: "litellm", billing: "metered" };
const SUB = { ...MET, billing: "subscription" };
const T0 = Date.parse("2026-11-12T10:00:00Z");
function env() {
  const dir = mkdtempSync(join(tmpdir(), "hub-cli-turns-"));
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
  appendSpend(d, row("s1", null, null, 500000, { purpose: "session-title" }));
  appendSpend(d, row("other", 1, 1, 900000));
}

test("spend --session <id> --by turn --json prints the turn index with complete and unreadable", async () => {
  const e = env(); seed(e); fetched = 0;
  const r = await run(["spend", "--session", "s1", "--by", "turn", "--json"], e);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.sessionId, "s1");
  assert.deepEqual(j.turns.map((t) => [t.turn, t.calls]), [[1, 2], [2, 1]]);
  assert.equal(j.complete, true); assert.equal(j.unreadable, false); assert.equal(j.v1Calls, 0); assert.equal(j.truncated, false);
  assert.equal(j.turns[1].during[0].purpose, "compaction");
  assert.equal(j.outside.calls, 1);
});

test("spend --session <id> --by turn prints one line per turn: charged or kind, API value, tokens, cache, first token, calls, route", async () => {
  const e = env(); seed(e);
  const r = await run(["spend", "--session", "s1", "--by", "turn"], e);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  assert.match(lines[0], /^session s1: 2 turns, 3 calls/);
  const t1 = lines.find((l) => /^ {2}turn 1 /.test(l));
  assert.match(t1, /\$0\.\d+ charged/);
  assert.match(t1, /24\.8k in \/ 2\.4k out/);
  assert.match(t1, /cache 8\d%/);
  assert.match(t1, /first token 0\.8 s/);
  assert.match(t1, /2 calls/);
  assert.match(t1, /google\/m/);
  const t2 = lines.find((l) => /^ {2}turn 2 /.test(l));
  assert.match(t2, /subscription/);
  assert.match(t2, /API value \$0\.\d+ not charged/);
  assert.match(t2, /anthropic\/c/);
  assert.ok(lines.some((l) => /^ {2}during turn 2: compaction x1 /.test(l)), r.out);
  assert.ok(lines.some((l) => /^ {2}outside turns: session-title x1 /.test(l)), r.out);
});

test("--session last resolves to the newest session, a subagent row to its parent, and prints the resolved id", async () => {
  const e = env(); seed(e);
  let r = await run(["spend", "--session", "last", "--by", "turn", "--json"], e);
  assert.equal(JSON.parse(r.out).sessionId, "other");
  appendSpend(e.env.DSH_HUB_DATA_DIR, row("sub", 1, 1, 2_000_000, { parent: "s1" }));
  r = await run(["spend", "--session", "last", "--by", "turn"], e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.split("\n")[0], /^session s1:/);
});

test("it is offline: the host is never called", async () => {
  const e = env(); seed(e); fetched = 0;
  await run(["spend", "--session", "s1", "--by", "turn"], e);
  await run(["spend", "--session", "last", "--by", "turn", "--json"], e);
  assert.equal(fetched, 0);
});

test("a session with no rows and an empty ledger with last exit 1 (and emit {error, code} with --json)", async () => {
  const e = env(); seed(e);
  let r = await run(["spend", "--session", "nobody", "--by", "turn"], e);
  assert.equal(r.code, 1); assert.match(r.err, /no ledger rows for session nobody/);
  r = await run(["spend", "--session", "nobody", "--by", "turn", "--json"], e);
  assert.equal(r.code, 1); assert.equal(JSON.parse(r.out).code, 1); assert.match(JSON.parse(r.out).error, /no ledger rows/);
  const e2 = env();
  r = await run(["spend", "--session", "last", "--by", "turn"], e2);
  assert.equal(r.code, 1); assert.match(r.err, /no ledger rows/);
});

test("flag misuse and a bad id exit 2 and name the fix", async () => {
  const e = env(); seed(e);
  for (const [args, re] of [
    [["spend", "--by", "turn"], /--by turn needs --session/],
    [["spend", "--session", "s1"], /--session needs --by turn/],
    [["spend", "--session", "s1", "--by", "turn", "--since", "7d"], /--since does not apply/],
    [["spend", "--session", "../x", "--by", "turn"], /--session must be a session id/],
    [["spend", "--session", "x".repeat(129), "--by", "turn"], /--session must be a session id/],
    [["spend", "--session", "a b", "--by", "turn"], /--session must be a session id/],
  ]) {
    const r = await run(args, e);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, re, args.join(" "));
  }
  const old = await run(["spend", "--by", "nope"], e);
  assert.equal(old.code, 2); assert.match(old.err, /bad --since\/--by/);
});

test("an unreadable ledger prints what it has and exits 1", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root can read a mode 000 file");
  const e = env(); seed(e);
  _resetLedgerCache();
  const f = join(e.env.DSH_HUB_DATA_DIR, "spend.jsonl");
  chmodSync(f, 0);
  try {
    const r = await run(["spend", "--session", "s1", "--by", "turn", "--json"], e);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.out);
    assert.equal(j.unreadable, true); assert.equal(j.code, 1); assert.match(j.error, /partial totals/);
  } finally { chmodSync(f, 0o600); }
});

test("a v1-only session says how many calls predate ledger v2 and exits 0 with turns []", async () => {
  const e = env();
  const v1 = { ts: new Date(T0).toISOString(), sessionId: "old", provider: "google", model: "m", input: 5, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.5, apiEquivUsd: 0.5, priceSource: "litellm", billing: "metered", id: "v1a" };
  appendSpend(e.env.DSH_HUB_DATA_DIR, v1); appendSpend(e.env.DSH_HUB_DATA_DIR, { ...v1, id: "v1b" });
  const r = await run(["spend", "--session", "old", "--by", "turn"], e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /no turn data \(2 calls before ledger v2\)/);
  const j = JSON.parse((await run(["spend", "--session", "old", "--by", "turn", "--json"], e)).out);
  assert.deepEqual(j.turns, []); assert.equal(j.v1Calls, 2);
});

test("help lists the new form", async () => {
  const e = env();
  const r = await run(["--help"], e);
  assert.match(r.out, /spend --session <id\|last> --by turn/);
});

test("spend --by turn text never prints control characters from ledger fields (provider, model)", async () => {
  const e = env(); const d = e.env.DSH_HUB_DATA_DIR;
  const hostile = { provider: "g\u001b]0;pwned\u0007", model: "m\u001b[31mRED\u009b" };
  appendSpend(d, row("s9", 1, 1, 0, hostile));
  appendSpend(d, row("s9", 1, 2, 1000, hostile));
  const r = await run(["spend", "--session", "s9", "--by", "turn"], e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /turn 1/);
  assert.match(r.out, /RED/, "the route is printed, sanitized");
  assert.doesNotMatch(r.out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});
