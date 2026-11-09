import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalLedgerPath, externalLedgerPaths, summarizeExternal } from "./external.mjs";

const NOW = Date.parse("2026-11-08T20:00:00.000Z");
const row = (o) => JSON.stringify({ model: "m", input_tokens: 1, session_id: "cc_SECRET", ...o });

test("sums usd/calls by provider for the since window; missing provider = meter; tolerates junk", () => {
  const d = mkdtempSync(join(tmpdir(), "ext-"));
  const f = join(d, "spend.jsonl");
  writeFileSync(f, [
    row({ ts: "2026-09-02T07:28:09.111Z", usd: 5 }),
    row({ ts: new Date(NOW - 3600e3).toISOString(), usd: 0.25 }),
    row({ ts: new Date(NOW - 1800e3).toISOString(), usd: 0.5, provider: "nearai" }),
    row({ ts: new Date(NOW - 900e3).toISOString(), usd: 0.125, provider: "nearai" }),
    "{not json",
    "",
    row({ ts: new Date(NOW - 600e3).toISOString(), usd: "x" }),
    row({ ts: "garbage", usd: 9 }),
    "[1,2]",
  ].join("\n"));
  const all = summarizeExternal(f, { since: "all", now: NOW });
  assert.equal(all.source, "meter");
  assert.deepEqual(all.totals, { usd: 5.875, calls: 5 });
  const today = summarizeExternal(f, { since: "today", now: NOW });
  assert.deepEqual(today.totals, { usd: 0.875, calls: 4 });
  assert.deepEqual(JSON.parse(JSON.stringify(today.byProvider)), { meter: { usd: 0.25, calls: 2 }, nearai: { usd: 0.625, calls: 2 } });
  assert.doesNotMatch(JSON.stringify(today), /SECRET|session/);
});

test("missing or unreadable file -> null; empty file -> zeros; env override", () => {
  const d = mkdtempSync(join(tmpdir(), "ext-"));
  assert.equal(summarizeExternal(join(d, "nope.jsonl"), { since: "all" }), null);
  assert.equal(summarizeExternal(d, { since: "all" }), null, "a directory is unreadable");
  const f = join(d, "e.jsonl");
  writeFileSync(f, "");
  assert.deepEqual(summarizeExternal(f, { since: "all" }).totals, { usd: 0, calls: 0 });
  assert.equal(externalLedgerPath({ DSH_HUB_EXTRA_LEDGERS: f }), f);
  // opt-in only: nothing configured -> no extra ledger is read
  assert.equal(externalLedgerPath({}), null);
  assert.deepEqual(externalLedgerPaths({}, { extraLedgers: [f] }), [f]);
  assert.deepEqual(externalLedgerPaths({ DSH_HUB_EXTRA_LEDGERS: `${f}, relative.jsonl` }, { extraLedgers: ["/x"] }), [f], "env wins; relative paths dropped");
});

test("a __proto__ provider in an external ledger cannot pollute Object.prototype", () => {
  const d = mkdtempSync(join(tmpdir(), "ext-"));
  const f = join(d, "e.jsonl");
  writeFileSync(f, JSON.stringify({ ts: new Date(NOW).toISOString(), usd: 1, provider: "__proto__" }) + "\n");
  const r = summarizeExternal(f, { since: "all", now: NOW });
  assert.equal(({}).calls, undefined);
  assert.equal(({}).usd, undefined);
  assert.equal(r.totals.calls, 1);
});

test("extra ledgers are re-read incrementally: appended rows count, a replaced file is read afresh", async () => {
  const { appendFileSync, writeFileSync: wf, mkdtempSync: md, renameSync } = await import("node:fs");
  const dir = md(join(tmpdir(), "ext-inc-"));
  const f = join(dir, "meter.jsonl");
  const ts = new Date().toISOString();
  wf(f, JSON.stringify({ ts, usd: 1, provider: "a" }) + "\n");
  assert.equal(summarizeExternal([f], { since: "today" }).totals.usd, 1);
  appendFileSync(f, JSON.stringify({ ts, usd: 2, provider: "a" }) + "\n" + '{"ts":"' + ts + '","usd":4');
  assert.equal(summarizeExternal([f], { since: "today" }).totals.usd, 3, "a half-written last line waits");
  appendFileSync(f, "}\n");
  assert.equal(summarizeExternal([f], { since: "today" }).totals.usd, 7);
  const g = join(dir, "new.jsonl");
  wf(g, JSON.stringify({ ts, usd: 0.5 }) + "\n");
  renameSync(g, f);
  assert.equal(summarizeExternal([f], { since: "today" }).totals.usd, 0.5, "a replaced file is not mixed with the old one");
});

test("extra ledgers: a torn multi-byte character never shifts the read offset past a later row", async () => {
  const { appendFileSync, writeFileSync: wf, mkdtempSync: md } = await import("node:fs");
  const f = join(md(join(tmpdir(), "ext-utf8-")), "meter.jsonl");
  const ts = new Date().toISOString();
  const row = Buffer.from(JSON.stringify({ ts, usd: 1, provider: "fournisseur-è" }) + "\n", "utf8");
  wf(f, Buffer.concat([Buffer.from("\n"), row.subarray(0, row.indexOf(Buffer.from("è", "utf8")) + 1), Buffer.from("\n")])); // a torn line
  appendFileSync(f, JSON.stringify({ ts, usd: 2, provider: "a" }) + "\n");
  assert.equal(summarizeExternal([f], { since: "today" }).totals.usd, 2);
  appendFileSync(f, JSON.stringify({ ts, usd: 4, provider: "a" }) + "\n");
  assert.equal(summarizeExternal([f], { since: "today" }).totals.usd, 6, "the later row is counted");
});
