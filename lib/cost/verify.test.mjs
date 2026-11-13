import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSpend, _resetLedgerCache, _ledgerParsedBytes, _auditCachedItems, _setLedgerAfterListHook, ledgerRows, KNOWN_FIELDS } from './ledger.mjs';
import { makeSpendRecord } from './cost.mjs';
import { verifyLedger, examineRow, exportRows, readExportRows, writeExport, EXPORT_COLUMNS, VERIFY_NOTE } from './verify.mjs';

const mk = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cost-verify-')), 'hub');
const METERED = { inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, source: 'litellm', billing: 'metered', derived: ['cacheWrite'] };
const SUB = { ...METERED, source: 'subscription', billing: 'subscription' };
const UNPRICED = { inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, source: 'unpriced', billing: 'metered' };
const U = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000 };
const row = (o = {}) => makeSpendRecord({ sessionId: 's1', provider: 'google', model: 'gemini-3.8-flash', usage: U, price: METERED, ...o });
const v1 = (o = {}) => ({ ts: new Date().toISOString(), sessionId: 's0', provider: 'google', model: 'old', input: 5, output: 5, cacheRead: 0, cacheWrite: 0, usd: 0.5, apiEquivUsd: 0.5, priceSource: 'litellm', billing: 'metered', ...o });
const fileOf = (d) => path.join(d, 'spend.jsonl');
/** rewrite every stored line through fn(obj) -> obj (the ledger the way a hand edit would leave it), cache reset */
function tamper(d, fn) {
  const lines = fs.readFileSync(fileOf(d), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  fs.writeFileSync(fileOf(d), lines.map((o) => JSON.stringify(fn(o) ?? o)).join('\n') + '\n');
  _resetLedgerCache();
}
const only = (rep, field) => rep.mismatches.filter((m) => m.field === field);

test('a clean mixed ledger verifies: v2 rows re-derived, v1 counted apart, honesty note present', () => {
  const d = mk();
  appendSpend(d, row()); appendSpend(d, row({ price: SUB })); appendSpend(d, v1());
  const r = verifyLedger(d);
  assert.equal(r.ok, true);
  assert.deepEqual([r.rows, r.checked, r.v1, r.mismatchCount, r.tornLines, r.duplicateCount], [3, 2, 1, 0, 0, 0]);
  assert.deepEqual(r.unknownFields, []); assert.equal(r.complete, true); assert.equal(r.unreadable, false);
  assert.ok(r.note.includes('not that a published price was right')); assert.equal(r.note, VERIFY_NOTE);
});

test('a tampered usd, token count or rate is a mismatch with id, field, expected and stored', () => {
  const d = mk(); const a = appendSpend(d, row()); const b = appendSpend(d, row()); const c = appendSpend(d, row());
  tamper(d, (o) => {
    if (o.id === a.id) return { ...o, usd: 0.0001 };
    if (o.id === b.id) return { ...o, output: o.output + 1000 };
    if (o.id === c.id) return { ...o, rates: { ...o.rates, outPerM: 11 } };
    return o;
  });
  const r = verifyLedger(d);
  assert.equal(r.ok, false);
  const u = only(r, 'usd')[0];
  assert.deepEqual([u.id, u.stored], [a.id, 0.0001]); assert.equal(u.expected, a.usd);
  const api = r.mismatches.filter((m) => m.field === 'apiEquivUsd');
  assert.deepEqual(api.map((m) => m.id).sort(), [b.id, c.id].sort());
  assert.ok(api.every((m) => typeof m.expected === 'number' && m.stored === a.apiEquivUsd));
});

test('a raw out-of-domain field is a mismatch (clean() would have hidden it)', () => {
  const d = mk(); const a = appendSpend(d, row()); const b = appendSpend(d, row());
  tamper(d, (o) => (o.id === a.id ? { ...o, usd: 'abc' } : { ...o, input: -1 }));
  const r = verifyLedger(d);
  assert.equal(r.ok, false);
  assert.deepEqual(only(r, 'usd').map((m) => [m.id, m.stored]), [[a.id, 'abc']]);
  assert.deepEqual(only(r, 'input').map((m) => [m.id, m.stored]), [[b.id, -1]]);
  // the reader's normalised view of the same rows is clean: that is exactly why verify reads the raw values
  assert.ok(ledgerRows(d).rows.every((x) => x.usd >= 0 && x.input >= 0));
});

test('v1 rows are never a mismatch, whatever their numbers', () => {
  const d = mk();
  appendSpend(d, v1({ usd: 99, apiEquivUsd: 0.1 }));
  const r = verifyLedger(d);
  assert.equal(r.ok, true); assert.deepEqual([r.rows, r.checked, r.v1, r.mismatchCount], [1, 0, 1, 0]);
});

test('plan rows: credits and a crossing metered row verify; a credits row that charged money does not', () => {
  const d = mk();
  const credits = row({ price: METERED }); credits.billing = 'credits'; credits.usd = 0; credits.planCoveredUsd = credits.apiEquivUsd;
  const crossing = row(); crossing.planCoveredUsd = Number((crossing.apiEquivUsd * 0.25).toFixed(6)); crossing.usd = Number((crossing.apiEquivUsd - crossing.planCoveredUsd).toFixed(6));
  appendSpend(d, credits); appendSpend(d, crossing);
  const ok = verifyLedger(d);
  assert.equal(ok.ok, true, JSON.stringify(ok.mismatches)); assert.equal(ok.checked, 2);
  const e = mk();
  const bad = row(); bad.billing = 'credits'; bad.planCoveredUsd = bad.apiEquivUsd; // usd stays > 0
  appendSpend(e, bad);
  const r = verifyLedger(e);
  assert.equal(r.ok, false); assert.deepEqual(only(r, 'usd').map((m) => m.expected), [0]);
});

test('a credits row not fully covered, and plan cover on a non-plan row, are mismatches', () => {
  const d = mk();
  const a = row(); a.billing = 'credits'; a.usd = 0; a.planCoveredUsd = 0;
  const b = row({ price: SUB }); b.planCoveredUsd = b.apiEquivUsd;
  appendSpend(d, a); appendSpend(d, b);
  const r = verifyLedger(d);
  assert.deepEqual(only(r, 'planCoveredUsd').map((m) => m.id).sort(), [a.id, b.id].sort());
});

test('tier above200k needs a prompt over 200000 tokens; an unpriced row has apiEquivUsd 0', () => {
  const d = mk(); const a = appendSpend(d, row());
  tamper(d, (o) => ({ ...o, tier: 'above200k' }));
  const r = verifyLedger(d);
  assert.deepEqual(only(r, 'tier').map((m) => m.id), [a.id]);
  const big = mk();
  const hi = row({ usage: { inputTokens: 150000, outputTokens: 10, cacheReadTokens: 100000 }, price: { ...METERED, above200k: { inPerM: 4, outPerM: 18, cacheReadPerM: 0.4, cacheWritePerM: 5 } } });
  appendSpend(big, hi);
  assert.equal(hi.tier, 'above200k'); assert.equal(verifyLedger(big).ok, true);
  const e = mk(); appendSpend(e, row({ price: UNPRICED }));
  assert.equal(verifyLedger(e).ok, true);
  tamper(e, (o) => ({ ...o, apiEquivUsd: 1 }));
  const bad = verifyLedger(e);
  assert.equal(bad.ok, false); assert.deepEqual(only(bad, 'apiEquivUsd').map((m) => [m.expected, m.stored]), [[0, 1]]);
});

test('a torn line fails; a duplicate id and an unknown field are reported but do not fail', () => {
  const d = mk(); const a = appendSpend(d, row());
  fs.appendFileSync(fileOf(d), '{"ts": "oops\n');
  const torn = verifyLedger(d);
  assert.equal(torn.ok, false); assert.equal(torn.tornLines, 1); assert.equal(torn.mismatchCount, 0);
  const e = mk(); const b = appendSpend(e, row()); appendSpend(e, b);
  const dup = verifyLedger(e);
  assert.equal(dup.ok, true); assert.equal(dup.duplicateCount, 1); assert.deepEqual(dup.duplicateIds, [b.id]); assert.equal(dup.rows, 1);
  const f = mk(); appendSpend(f, row());
  tamper(f, (o) => ({ ...o, extra: 1, prompt: 'x' }));
  const unk = verifyLedger(f);
  assert.equal(unk.ok, true); assert.deepEqual(unk.unknownFields.sort(), ['extra', 'prompt']);
  assert.ok(![...KNOWN_FIELDS].includes('extra'));
  assert.ok(a.id);
});

test('rotation: every row in every ledger file is checked once (inode union)', () => {
  const d = mk();
  for (let i = 0; i < 5; i++) appendSpend(d, row(), { rotateBytes: 10 });
  assert.ok(fs.readdirSync(d).filter((f) => /^spend\.\d+\.jsonl$/.test(f)).length >= 2);
  const r = verifyLedger(d);
  assert.equal(r.ok, true); assert.deepEqual([r.rows, r.checked], [5, 5]);
});

test('--since filters rows but not torn lines', () => {
  const d = mk();
  const now = new Date(2026, 10, 8, 15, 0, 0).getTime();
  appendSpend(d, row({ ts: new Date(now - 3 * 86400e3).toISOString() }));
  appendSpend(d, row({ ts: new Date(now).toISOString() }));
  fs.appendFileSync(fileOf(d), '{broken\n');
  const r = verifyLedger(d, { since: 'today', now });
  assert.deepEqual([r.rows, r.checked], [1, 1]); assert.equal(r.tornLines, 1); assert.equal(r.ok, false);
  assert.equal(verifyLedger(d, { since: 'all', now }).rows, 2);
});

test('the second run parses no new bytes (shared incremental reader); an append parses only its own', () => {
  const d = mk(); appendSpend(d, row()); appendSpend(d, row());
  _resetLedgerCache();
  verifyLedger(d);
  const first = _ledgerParsedBytes();
  assert.ok(first > 0);
  verifyLedger(d);
  assert.equal(_ledgerParsedBytes(), first, 'nothing re-read');
  const before = fs.statSync(fileOf(d)).size;
  appendSpend(d, row());
  const r = verifyLedger(d);
  assert.equal(r.rows, 3);
  assert.equal(_ledgerParsedBytes() - first, fs.statSync(fileOf(d)).size - before);
});

test('full:true re-reads every byte, so an in-place edit made after a cached run is still caught', () => {
  const d = mk(); const a = appendSpend(d, row());
  assert.equal(verifyLedger(d).ok, true);
  const text = fs.readFileSync(fileOf(d), 'utf8');
  const bumped = text.replace(`"usd":${a.usd}`, `"usd":${String(a.usd + 1).slice(0, String(a.usd).length)}`);
  assert.equal(bumped.length, text.length, 'same size: the offset cache cannot see it');
  fs.writeFileSync(fileOf(d), bumped);
  assert.equal(verifyLedger(d).ok, true, 'the incremental run trusts bytes it already parsed');
  const full = verifyLedger(d, { full: true });
  assert.equal(full.ok, false); assert.equal(only(full, 'usd').length, 1);
});

test('a read that keeps racing rotations is incomplete: ok false, complete false', () => {
  const d = mk(); for (let i = 0; i < 5; i++) appendSpend(d, row());
  _resetLedgerCache();
  _setLedgerAfterListHook(() => { appendSpend(d, row(), { rotateBytes: 10 }); });
  let r;
  try { r = verifyLedger(d); } finally { _setLedgerAfterListHook(null); }
  assert.equal(r.complete, false); assert.equal(r.ok, false);
});

test('an unreadable data dir is not ok', () => {
  const d = mk(); appendSpend(d, row());
  _resetLedgerCache();
  fs.chmodSync(d, 0o000);
  let r;
  try { r = verifyLedger(d); } finally { fs.chmodSync(d, 0o700); }
  assert.equal(r.ok, false); assert.equal(r.unreadable, true); assert.equal(r.complete, false);
});

test('the report lists at most 100 mismatches and counts every one', () => {
  const d = mk();
  for (let i = 0; i < 130; i++) appendSpend(d, row());
  tamper(d, (o) => ({ ...o, usd: 7 }));
  const r = verifyLedger(d);
  assert.equal(r.mismatches.length, 100); assert.equal(r.mismatchCount, 130); assert.equal(r.ok, false);
});

test('examineRow: shapes it must not trust', () => {
  const g = row();
  assert.deepEqual(examineRow({ ...g }).problems, []);
  assert.equal(examineRow({ ...g, ts: 'yesterday' }).problems[0].field, 'ts');
  assert.equal(examineRow({ ...g, v: 3 }).problems[0].field, 'v');
  assert.ok(examineRow({ ...g, rates: { inPerM: 1 } }).problems.some((p) => p.field === 'rates'));
  assert.ok(examineRow({ ...g, rates: null }).problems.some((p) => p.field === 'rates'), 'a priced row cannot drop its rates');
  assert.ok(examineRow({ ...g, billing: 'barter' }).problems.some((p) => p.field === 'billing'));
  assert.ok(examineRow({ ...g, tier: 'huge' }).problems.some((p) => p.field === 'tier'));
  assert.ok(examineRow({ ...g, planCoveredUsd: g.apiEquivUsd + 1 }).problems.some((p) => p.field === 'planCoveredUsd'));
  const noApi = makeSpendRecord({ sessionId: 's', provider: 'p', model: 'm', usage: U, price: { ...UNPRICED, source: 'subscription', billing: 'subscription', apiEquivKnown: false } });
  assert.equal(noApi.rates, null); assert.deepEqual(examineRow({ ...noApi }).problems, [], 'a subscription model with no known API price has no rates, honestly');
  assert.equal(examineRow({ ...g, id: undefined }).id, null);
  assert.equal(examineRow({ ...g, usd: g.usd + 5e-10 }).problems.length, 0, 'inside the 1e-9 tolerance');
  assert.equal(examineRow({ ...g, usd: g.usd + 1e-6 }).problems.length, 1);
});

const csvLines = (text) => text.split('\n');

test('export csv: header is EXPORT_COLUMNS, v1 rows have empty v2 cells, sorted by ts', () => {
  const d = mk();
  const t0 = Date.parse('2026-11-08T10:00:00Z');
  appendSpend(d, row({ ts: new Date(t0 + 1000).toISOString() }));
  appendSpend(d, v1({ ts: new Date(t0).toISOString(), id: 'v1row' }));
  const { rows } = readExportRows(d);
  const text = exportRows(rows, 'csv');
  const lines = csvLines(text);
  assert.equal(lines[0], EXPORT_COLUMNS.join(','));
  assert.ok(text.endsWith('\n'));
  const idx = (n) => EXPORT_COLUMNS.indexOf(n);
  const first = lines[1].split(',');
  assert.equal(first[idx('id')], 'v1row'); assert.equal(first.length, EXPORT_COLUMNS.length);
  for (const c of ['v', 'purpose', 'turn', 'step', 'parentSessionId', 'rate_inPerM', 'rate_cacheWritePerM', 'derived', 'tier', 'offPeak', 'planCoveredUsd', 'reasoning', 'finish', 'ttftMs', 'durationMs']) assert.equal(first[idx(c)], '', c);
  const second = lines[2].split(',');
  assert.deepEqual([second[idx('v')], second[idx('purpose')], second[idx('rate_inPerM')], second[idx('derived')], second[idx('tier')], second[idx('offPeak')]], ['2', 'chat', '2', 'cacheWritePerM', 'base', 'false']);
});

test('export csv: formula prefixes are defanged and quoting follows RFC 4180; derived joined with |', () => {
  const d = mk();
  appendSpend(d, row({ model: "=cmd|' /C calc", sessionId: '@SUM(1)' }));
  appendSpend(d, row({ model: 'a,b', sessionId: 'say "hi"', provider: 'line\nbreak' }));
  appendSpend(d, row({ model: '-1+1', sessionId: '+x' }));
  const text = exportRows(readExportRows(d).rows, 'csv');
  assert.ok(text.includes(`"'=cmd|' /C calc"`), text);
  assert.ok(text.includes(`"'@SUM(1)"`));
  assert.ok(text.includes('"a,b"')); assert.ok(text.includes('"say ""hi"""')); assert.ok(text.includes('"line\nbreak"'));
  assert.ok(text.includes(`"'-1+1"`)); assert.ok(text.includes(`"'+x"`));
  const m = row({ price: { ...METERED, derived: ['cacheRead', 'cacheWrite'] } });
  assert.ok(exportRows([{ ...m }], 'csv').includes('cacheReadPerM|cacheWritePerM'));
});

test('export jsonl: one object per line, columns in order, nulls for a v1 row, rates nested', () => {
  const d = mk();
  appendSpend(d, row({ price: UNPRICED }));
  appendSpend(d, v1({ id: 'old' }));
  appendSpend(d, row());
  const lines = exportRows(readExportRows(d).rows, 'jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  const keys = ['ts', 'id', 'sessionId', 'provider', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'usd', 'apiEquivUsd', 'priceSource', 'billing', 'v', 'purpose', 'turn', 'step', 'parentSessionId', 'rates', 'derived', 'tier', 'offPeak', 'planCoveredUsd', 'reasoning', 'finish', 'ttftMs', 'durationMs'];
  for (const l of lines) assert.deepEqual(Object.keys(l), keys);
  const old = lines.find((l) => l.id === 'old');
  for (const k of keys.slice(13)) assert.equal(old[k], null, k);
  const priced = lines.find((l) => l.rates && l.rates.inPerM === 2);
  assert.deepEqual(priced.rates, { inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 }); assert.deepEqual(priced.derived, ['cacheWritePerM']);
  assert.equal(lines.find((l) => l.priceSource === 'unpriced').rates, null);
  assert.deepEqual(EXPORT_COLUMNS.filter((c) => !c.startsWith('rate_')).length, keys.length - 1);
});

test('export: nothing beyond the ledger fields is ever written (no content columns)', () => {
  assert.ok(EXPORT_COLUMNS.every((c) => KNOWN_FIELDS.has(c) || c.startsWith('rate_')));
  assert.ok(!EXPORT_COLUMNS.some((c) => /prompt|content|text|message|key|secret|token$/i.test(c)));
});

test('export rows are filtered by since and sorted by ts; an unreadable or incomplete read is reported', () => {
  const d = mk(); const now = new Date(2026, 10, 8, 15, 0, 0).getTime();
  appendSpend(d, row({ ts: new Date(now).toISOString(), model: 'late' }));
  appendSpend(d, row({ ts: new Date(now - 5 * 86400e3).toISOString(), model: 'old' }));
  appendSpend(d, row({ ts: new Date(now - 60e3).toISOString(), model: 'mid' }));
  assert.deepEqual(readExportRows(d, { since: 'all', now }).rows.map((r) => r.model), ['old', 'mid', 'late']);
  assert.deepEqual(readExportRows(d, { since: 'today', now }).rows.map((r) => r.model), ['mid', 'late']);
  assert.equal(readExportRows(d).complete, true);
  _resetLedgerCache();
  fs.chmodSync(d, 0o000);
  let bad;
  try { bad = readExportRows(d); } finally { fs.chmodSync(d, 0o700); }
  assert.deepEqual([bad.complete, bad.unreadable, bad.rows.length], [false, true, 0]);
});

test('writeExport: new file is 0600; an existing file is refused untouched; --force replaces it, still 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-write-'));
  const f = path.join(dir, 'out.csv');
  writeExport(f, 'one\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600); assert.equal(fs.readFileSync(f, 'utf8'), 'one\n');
  assert.throws(() => writeExport(f, 'two\n'), (e) => e.code === 'EEXIST');
  assert.equal(fs.readFileSync(f, 'utf8'), 'one\n');
  fs.chmodSync(f, 0o644);
  writeExport(f, 'three\n', { force: true });
  assert.equal(fs.readFileSync(f, 'utf8'), 'three\n'); assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['out.csv'], 'no temp file left behind');
});

test('writeExport: a symlink at the target is replaced, never written through; without --force it is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-link-'));
  const victim = path.join(dir, 'victim.txt'); fs.writeFileSync(victim, 'precious');
  const link = path.join(dir, 'out.csv'); fs.symlinkSync(victim, link);
  assert.throws(() => writeExport(link, 'x'), (e) => e.code === 'EEXIST');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious');
  writeExport(link, 'exported', { force: true });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious', 'the link target is untouched');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false); assert.equal(fs.readFileSync(link, 'utf8'), 'exported');
  const dangling = path.join(dir, 'dangling.csv'); fs.symlinkSync(path.join(dir, 'nowhere'), dangling);
  assert.throws(() => writeExport(dangling, 'x'), (e) => e.code === 'EEXIST');
  assert.ok(!fs.existsSync(path.join(dir, 'nowhere')));
});

test('writeExport: the path is used as given (cwd-relative, no ~ expansion, no shell); a missing directory throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-rel-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    writeExport('~', 'tilde'); writeExport('rel $(touch pwned).csv', 'x');
  } finally { process.chdir(cwd); }
  assert.equal(fs.readFileSync(path.join(dir, '~'), 'utf8'), 'tilde');
  assert.ok(fs.existsSync(path.join(dir, 'rel $(touch pwned).csv'))); assert.ok(!fs.existsSync(path.join(dir, 'pwned')));
  assert.throws(() => writeExport(path.join(dir, 'missing', 'out.csv'), 'x'), (e) => e.code === 'ENOENT');
  assert.throws(() => writeExport(path.join(dir, 'missing', 'out.csv'), 'x', { force: true }), (e) => e.code === 'ENOENT');
});

test('a tampered row cannot bloat the report: quoted values, ids and unknown field names are bounded', () => {
  const d = mk(); appendSpend(d, row());
  const big = 'x'.repeat(50000);
  tamper(d, (o) => {
    const extra = {}; for (let i = 0; i < 500; i++) extra['k' + i + big.slice(0, 100)] = 1;
    return { ...o, id: big, rates: { inPerM: big, nested: { deep: [big] } }, usd: { a: big }, ...extra };
  });
  const r = verifyLedger(d);
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.every((m) => m.id.length <= 200 && (typeof m.stored !== 'string' || m.stored.length <= 200) && (typeof m.expected !== 'string' || m.expected.length <= 200)));
  assert.ok(r.unknownFields.length <= 50 && r.unknownFields.every((k) => k.length <= 64));
  assert.ok(JSON.stringify(r).length < 20000);
});

test('a full verify does not keep one examined item per row in memory afterwards; the incremental one does', () => {
  const dir = mk(); _resetLedgerCache();
  for (let i = 0; i < 5; i++) appendSpend(dir, makeSpendRecord({ sessionId: 's', provider: 'google', model: 'm', usage: { inputTokens: 10, outputTokens: 1 }, price: METERED }));
  assert.equal(verifyLedger(dir, { full: true }).rows, 5);
  assert.equal(_auditCachedItems(), 0);
  assert.equal(verifyLedger(dir).rows, 5);
  assert.equal(_auditCachedItems(), 5);
  assert.equal(verifyLedger(dir, { full: true }).rows, 5);
  assert.equal(_auditCachedItems(), 0);
});
