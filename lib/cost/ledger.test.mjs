import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSpend, summarize, resolveSince, dayKey } from './ledger.mjs';

const mk = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cost-ledger-')), 'hub');
const rec = (o = {}) => ({ ts: new Date().toISOString(), sessionId: 's1', provider: 'google', model: 'gemini-3.8-flash', input: 100, output: 50, cacheRead: 10, cacheWrite: 0, usd: 0.25, apiEquivUsd: 0.25, priceSource: 'litellm', billing: 'metered', ...o });

test('append creates 0700 dir and 0600 file; whitelists fields (no content)', () => {
  const d = mk();
  const stored = appendSpend(d, { ...rec(), prompt: 'SECRET PROMPT', content: 'x', apiKey: 'k' });
  assert.equal(fs.statSync(d).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(d, 'spend.jsonl')).mode & 0o777, 0o600);
  const text = fs.readFileSync(path.join(d, 'spend.jsonl'), 'utf8');
  assert.ok(!/SECRET|apiKey|content/.test(text)); assert.equal(JSON.parse(text).model, 'gemini-3.8-flash'); assert.ok(!('prompt' in stored));
});
test('summarize totals and groups', () => {
  const d = mk();
  appendSpend(d, rec({ usd: 1 })); appendSpend(d, rec({ usd: 2, sessionId: 's2' })); appendSpend(d, rec({ provider: 'anthropic', model: 'claude-opus-4-8', usd: 0, apiEquivUsd: 4, billing: 'subscription' }));
  const s = summarize(d, { since: 'today' });
  assert.equal(s.totals.calls, 3); assert.equal(s.totals.usd, 3); assert.equal(s.totals.apiEquivUsd, 4.5);
  assert.equal(s.byProvider.google.usd, 3); assert.equal(s.byProvider.anthropic.usd, 0); assert.equal(s.byProvider.anthropic.apiEquivUsd, 4);
  assert.equal(s.bySession.s2.usd, 2); assert.equal(s.byModel['google/gemini-3.8-flash'].calls, 2);
  assert.equal(Object.keys(s.byDay).length, 1);
  assert.equal(summarize(d, { by: 'session' }).groups.s1.calls, 2);
  assert.throws(() => summarize(d, { by: 'nope' }), /bad by/);
});
test('since windows use local-day boundaries and exclude old rows', () => {
  const d = mk(); const now = new Date(2026, 10, 8, 15, 0, 0).getTime();
  appendSpend(d, rec({ ts: new Date(2026, 10, 8, 1, 0).toISOString(), usd: 1 }));
  appendSpend(d, rec({ ts: new Date(2026, 10, 7, 23, 59).toISOString(), usd: 10 }));
  appendSpend(d, rec({ ts: new Date(2026, 10, 2, 12, 0).toISOString(), usd: 100 }));
  appendSpend(d, rec({ ts: new Date(2026, 9, 1, 12, 0).toISOString(), usd: 1000 }));
  assert.equal(summarize(d, { since: 'today', now }).totals.usd, 1);
  assert.equal(summarize(d, { since: '2d', now }).totals.usd, 11);
  assert.equal(summarize(d, { since: '7d', now }).totals.usd, 111);
  assert.equal(summarize(d, { since: '30d', now }).totals.usd, 111);
  assert.equal(summarize(d, { since: 'all', now }).totals.usd, 1111);
  assert.equal(summarize(d, { by: 'day', since: '7d', now }).groups[dayKey(new Date(2026, 10, 8).getTime())].usd, 1);
  assert.throws(() => resolveSince('garbage'), /bad since/);
});
test('rotates at the threshold and summaries still read rotated files', () => {
  const d = mk();
  appendSpend(d, rec({ usd: 1 })); appendSpend(d, rec({ usd: 1 }), { rotateBytes: 10 }); appendSpend(d, rec({ usd: 1 }), { rotateBytes: 10 });
  const files = fs.readdirSync(d).sort();
  assert.ok(files.some((f) => /^spend\.\d+\.jsonl$/.test(f))); assert.ok(files.includes('spend.jsonl'));
  assert.equal(summarize(d).totals.usd, 3);
});
test('torn / garbage lines are skipped; missing dir is empty', () => {
  const d = mk(); appendSpend(d, rec());
  fs.appendFileSync(path.join(d, 'spend.jsonl'), '{"ts":"2026\nnot json\n[1]\n');
  assert.equal(summarize(d).totals.calls, 1);
  assert.equal(summarize(path.join(d, 'nope')).totals.calls, 0);
});
test('negative / non-numeric fields are clamped to 0', () => {
  const d = mk(); const r = appendSpend(d, rec({ input: -5, usd: 'x', output: NaN }));
  assert.equal(r.input, 0); assert.equal(r.usd, 0); assert.equal(r.output, 0);
});

// ---- adversarial-review regressions (2026-11-08) ----
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sessionKey, _ledgerParsedBytes, _resetLedgerCache } from './ledger.mjs';
import { checkCaps } from './caps.mjs';
const run = promisify(execFile);

test('concurrent writers rotating at the same time lose no rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-race-'));
  const mod = fileURLToPath(new URL('./ledger.mjs', import.meta.url));
  const N = 4, PER = 1500;
  const code = (w) => `import { appendSpend } from ${JSON.stringify(mod)};
    for (let i = 0; i < ${PER}; i++) appendSpend(${JSON.stringify(dir)}, { ts: new Date().toISOString(), sessionId: 'w${w}', provider: 'p', model: 'm', input: 1, usd: 0.001 }, { rotateBytes: 4000 });`;
  await Promise.all(Array.from({ length: N }, (_, w) => run(process.execPath, ['--input-type=module', '-e', code(w)])));
  _resetLedgerCache();
  const s = summarize(dir, { since: 'all' });
  assert.equal(s.totals.calls, N * PER, `rows kept: ${s.totals.calls}/${N * PER}`);
  assert.ok(fs.readdirSync(dir).filter((f) => /^spend\.\d+\.jsonl$/.test(f)).length > 10, 'rotation actually happened');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('.spend.rotating')).length, 0, 'no temp leftovers');
});

test('a "__proto__" id in the ledger cannot pollute Object.prototype', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-proto-'));
  fs.writeFileSync(path.join(dir, 'spend.jsonl'), JSON.stringify({ ts: new Date().toISOString(), sessionId: '__proto__', provider: 'constructor', model: 'x', usd: 1 }) + '\n');
  _resetLedgerCache();
  const s = summarize(dir, { since: 'all', by: 'session' });
  assert.equal(({}).calls, undefined);
  assert.equal(({}).usd, undefined);
  assert.equal(s.totals.calls, 1);
  assert.equal(Object.getPrototypeOf(s.bySession), null);
});

test('empty session ids share one bucket and the session cap sees it', () => {
  assert.equal(sessionKey(''), '?');
  assert.equal(sessionKey(undefined), '?');
  const summary = { totals: { usd: 0 }, byProvider: {}, bySession: { '?': { usd: 999 } } };
  const r = checkCaps({ summary, provider: 'google', sessionId: '', billing: 'metered', caps: { dailyUsd: 1000, sessionUsd: 15, perProviderDailyUsd: {}, warnPct: 50 }, priced: true });
  assert.equal(r.action, 'block', 'a request without a session id must not bypass the session cap');
});

test('unchanged ledger files are not re-parsed; appended bytes only are read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cache-'));
  for (let i = 0; i < 200; i++) appendSpend(dir, { provider: 'p', model: 'm', usd: 0.01 });
  _resetLedgerCache();
  summarize(dir, { since: 'all' });
  const first = _ledgerParsedBytes();
  assert.ok(first > 0);
  summarize(dir, { since: 'all' });
  assert.equal(_ledgerParsedBytes(), first, 'second summary parsed nothing new');
  appendSpend(dir, { provider: 'p', model: 'm', usd: 0.01 });
  const s = summarize(dir, { since: 'all' });
  assert.equal(s.totals.calls, 201);
  assert.ok(_ledgerParsedBytes() - first < 400, 'only the appended line was read');
});

test('unpriced metered calls are counted (caps do not see their spend)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-unpriced-'));
  appendSpend(dir, { provider: 'google', model: 'new-model', usd: 0, priceSource: 'unpriced', billing: 'metered' });
  appendSpend(dir, { provider: 'rocco', model: 'm', usd: 0, priceSource: 'local', billing: 'local' });
  _resetLedgerCache();
  const s = summarize(dir, { since: 'all' });
  assert.equal(s.totals.unpricedCalls, 1);
  assert.equal(s.byProvider.google.unpricedCalls, 1);
});

test('a rotation whose hard link fails never throws, loses no rows and leaves no double count', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-linkfail-'));
  const realLink = fs.linkSync;
  try {
    appendSpend(d, rec({ usd: 1 }));
    // archive name refused (EPERM) but restore allowed: the file goes back to spend.jsonl
    fs.linkSync = (src, dst) => { if (/spend\.\d+\.jsonl$/.test(dst)) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return realLink(src, dst); };
    assert.doesNotThrow(() => appendSpend(d, rec({ usd: 1 }), { rotateBytes: 10 }));
    assert.equal(summarize(d).totals.calls, 2);
    assert.ok(fs.existsSync(path.join(d, 'spend.jsonl')));
    // every link refused: the renamed file stays as an orphan and readers still count it
    fs.linkSync = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
    assert.doesNotThrow(() => appendSpend(d, rec({ usd: 1 }), { rotateBytes: 10 }));
    assert.equal(fs.readdirSync(d).filter((f) => f.startsWith('.spend.rotating.')).length, 1, 'orphan kept');
    assert.equal(summarize(d).totals.calls, 3);
    assert.equal(summarize(d).totals.usd, 3);
  } finally {
    fs.linkSync = realLink;
  }
});

test('the temp name and its archived link are one file: read once', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-ino-'));
  appendSpend(d, rec({ usd: 2 }));
  fs.linkSync(path.join(d, 'spend.jsonl'), path.join(d, '.spend.rotating.1.abc123'));
  assert.equal(summarize(d).totals.calls, 1);
});

test('a rotation by another process between listing and reading never hides archived spend', async () => {
  const { _setLedgerAfterListHook } = await import('./ledger.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-snap-'));
  for (let i = 0; i < 50; i++) appendSpend(d, rec({ usd: 1 }));
  _resetLedgerCache();
  let rotated = false;
  _setLedgerAfterListHook((attempt) => {
    // the race astra found: after the reader listed only spend.jsonl, another process rotates it and appends
    if (attempt === 0 && !rotated) { rotated = true; appendSpend(d, rec({ usd: 1 }), { rotateBytes: 10 }); }
  });
  try {
    const s = summarize(d);
    assert.ok(rotated, 'the rotation happened mid-read');
    assert.ok(fs.readdirSync(d).some((f) => /^spend\.\d+\.jsonl$/.test(f)), 'an archive exists');
    assert.equal(s.totals.calls, 51);
    assert.equal(s.totals.usd, 51);
  } finally {
    _setLedgerAfterListHook(null);
  }
});

test('rotations racing every read attempt still lose no spend (union by inode)', async () => {
  const { _setLedgerAfterListHook } = await import('./ledger.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-storm-'));
  for (let i = 0; i < 50; i++) appendSpend(d, rec({ usd: 1 }));
  _resetLedgerCache();
  let n = 0;
  _setLedgerAfterListHook(() => { n++; appendSpend(d, rec({ usd: 1 }), { rotateBytes: 10 }); });
  try {
    const s = summarize(d);
    assert.ok(n >= 5, `rotated during all ${n} attempts`);
    assert.equal(s.totals.calls, 50 + n);
    assert.equal(s.totals.usd, 50 + n);
  } finally {
    _setLedgerAfterListHook(null);
  }
  assert.equal(summarize(d).totals.calls, 50 + n, 'a quiet re-read agrees');
});

test('appends just before each of many racing rotations: the read is marked incomplete, never silently short', async () => {
  const { _setLedgerAfterListHook } = await import('./ledger.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-busy-'));
  for (let i = 0; i < 50; i++) appendSpend(d, rec({ usd: 1 }));
  _resetLedgerCache();
  let n = 0;
  _setLedgerAfterListHook(() => {
    n++;
    appendSpend(d, rec({ usd: 1 }));                      // a row lands in the file about to be rotated...
    appendSpend(d, rec({ usd: 1 }), { rotateBytes: 10 }); // ...which is then rotated, plus one more row
  });
  let s;
  try { s = summarize(d); } finally { _setLedgerAfterListHook(null); }
  assert.equal(s.complete, false, 'still churning after every pass');
  const quiet = summarize(d);
  assert.equal(quiet.complete, true);
  assert.equal(quiet.totals.calls, 50 + 2 * n, 'a quiet read sees everything');
});

test('a torn last line (a write that failed partway) never swallows the next row', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-torn-'));
  appendSpend(d, rec({ usd: 2 }));
  fs.appendFileSync(path.join(d, 'spend.jsonl'), '{"ts":"2026-11-09T05:00:00.000Z","sessio'); // disk full after 40 bytes
  appendSpend(d, rec({ usd: 1 }));
  const s = summarize(d);
  assert.equal(s.totals.calls, 2, 'both complete rows count; the fragment is dropped');
  assert.equal(s.totals.usd, 3);
});

test('a row retried after a failed write that had in fact landed whole is counted once', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-dup-'));
  const r = rec({ usd: 1, id: 'row-1' });
  fs.writeFileSync(path.join(d, 'spend.jsonl'), JSON.stringify(r)); // the JSON landed, the newline did not
  appendSpend(d, r); // the engine retries the same row
  const s = summarize(d);
  assert.equal(s.totals.calls, 1);
  assert.equal(s.totals.usd, 1);
  const ids = new Set();
  appendSpend(d, rec({ usd: 1 })); appendSpend(d, rec({ usd: 1 }));
  for (const l of fs.readFileSync(path.join(d, 'spend.jsonl'), 'utf8').split('\n').filter(Boolean)) ids.add(JSON.parse(l).id);
  assert.equal(ids.size, 3, 'every new row gets its own id');
});

test('a short write interleaved with another process\'s append loses neither row (the cut-short row is retried whole)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-race-'));
  const a = rec({ usd: 1, id: 'row-a' });
  const b = rec({ usd: 2, id: 'row-b' });
  const real = fs.writeSync;
  let cut = 0;
  fs.writeSync = function (fd, buf, off = 0, len = buf.length, ...rest) {
    if (cut++ === 0) {
      const n = real.call(fs, fd, buf, off, 30, ...rest); // disk full after 30 bytes...
      fs.writeSync = real;
      appendSpend(d, b); // ...and another DSH process appends before A goes on
      return n;
    }
    return real.call(fs, fd, buf, off, len, ...rest);
  };
  let threw = false;
  try { appendSpend(d, a); } catch (e) { threw = true; assert.equal(e.code, 'ESHORTWRITE'); } finally { fs.writeSync = real; }
  assert.ok(threw, 'a cut-short write is reported, never finished later after another row');
  appendSpend(d, a); // the engine retries the kept row whole
  const s = summarize(d);
  assert.equal(s.totals.calls, 2);
  assert.equal(s.totals.usd, 3, 'A ($1) and B ($2) both count');
});

test('a write cut short after the whole JSON (only the newline lost) is retried and still counted once', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-race2-'));
  const a = rec({ usd: 1, id: 'row-a2' });
  const real = fs.writeSync;
  fs.writeSync = function (fd, buf, off = 0, len = buf.length, ...rest) { fs.writeSync = real; return real.call(fs, fd, buf, off, len - 1, ...rest); };
  try { assert.throws(() => appendSpend(d, a), (e) => e.code === 'ESHORTWRITE'); } finally { fs.writeSync = real; }
  appendSpend(d, rec({ usd: 2 }));
  appendSpend(d, a);
  const s = summarize(d);
  assert.equal(s.totals.calls, 2);
  assert.equal(s.totals.usd, 3);
});

test('a write torn inside a multi-byte character never makes the incremental reader skip a later row', async () => {
  const { _resetLedgerCache } = await import('./ledger.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-utf8-'));
  _resetLedgerCache();
  const a = rec({ usd: 1, id: 'row-a', model: 'modèle-è' });
  const line = Buffer.from(`\n${JSON.stringify(a)}\n`, 'utf8');
  const cut = line.indexOf(Buffer.from('è', 'utf8')) + 1; // inside the 2-byte character
  fs.writeFileSync(path.join(d, 'spend.jsonl'), line.subarray(0, cut)); // writer A torn mid-character
  appendSpend(d, rec({ usd: 2, id: 'row-b' })); // writer B
  appendSpend(d, a); // A retried whole
  assert.equal(summarize(d).totals.usd, 3, 'first read');
  appendSpend(d, rec({ usd: 4, id: 'row-c' })); // a later row, read incrementally from the cached offset
  const s = summarize(d);
  assert.equal(s.totals.usd, 7, 'the later $4 row is counted');
  assert.equal(s.complete, true);
});

test('each summary bucket carries the billing kind of its rows ("mixed" when they differ)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-billing-'));
  appendSpend(d, rec({ provider: 'anthropic', billing: 'subscription', usd: 0 }));
  appendSpend(d, rec({ provider: 'anthropic', billing: 'subscription', usd: 0 }));
  appendSpend(d, rec({ provider: 'google', billing: 'metered' }));
  appendSpend(d, rec({ provider: 'rocco', billing: 'local', usd: 0 }));
  const s = summarize(d);
  assert.equal(s.byProvider.anthropic.billing, 'subscription');
  assert.equal(s.byProvider.google.billing, 'metered');
  assert.equal(s.byProvider.rocco.billing, 'local');
  assert.equal(s.totals.billing, 'mixed');
});
