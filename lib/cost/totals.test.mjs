import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSpend, summarize, sessionKey, _ledgerParsedBytes, _resetLedgerCache } from './ledger.mjs';
import { createLedgerTotals } from './totals.mjs';

const mk = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cost-totals-')), 'hub');
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const PROVIDERS = ['google', 'anthropic', 'openai'];
const SESSIONS = ['s1', 's2', 's3', ''];
const rec = (o = {}) => ({ ts: new Date().toISOString(), sessionId: 's1', provider: 'google', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.25, apiEquivUsd: 0.25, priceSource: 'litellm', billing: 'metered', ...o });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

/** Every number the guard reads, from a full recompute (two summaries, however many providers and sessions are checked). */
function assertEqual(totals, d, now, label) {
  const today = summarize(d, { since: 'today', now });
  const all = summarize(d, { since: 'all', now });
  const providers = [...PROVIDERS, ''];
  for (let i = 0; i < providers.length; i++) { // each provider and each session is checked, paired along the diagonal
    const provider = providers[i], sessionId = SESSIONS[i];
    const got = totals.read({ now, provider, sessionId });
    near(got.todayUsd, today.totals.usd, `${label} todayUsd`);
    near(got.providerUsd, today.byProvider[provider]?.usd || 0, `${label} providerUsd(${provider})`);
    near(got.sessionUsd, all.bySession[sessionKey(sessionId)]?.usd || 0, `${label} sessionUsd(${sessionId})`);
    assert.equal(got.complete, today.complete && all.complete, `${label} complete`);
  }
}

test('property: running totals equal summarize today/provider/session after every step (appends, duplicates, rotations, midnight crossings)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = mulberry32(seed);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    _resetLedgerCache();
    const d = mk();
    const totals = createLedgerTotals(d);
    let now = new Date(2026, 10, 8, 20, 0).getTime();
    const written = [];
    for (let step = 0; step < 150; step++) {
      const r = rnd();
      if (r < 0.45) {
        const ts = new Date(now + (rnd() * 6 - 3) * 86_400_000).toISOString();
        const stored = appendSpend(d, rec({ ts, provider: pick(PROVIDERS), sessionId: pick(SESSIONS), usd: Math.round(rnd() * 500) / 100 }));
        written.push(stored);
      } else if (r < 0.60 && written.length) {
        appendSpend(d, { ...pick(written) }); // same id again: a retried row
      } else if (r < 0.72) {
        appendSpend(d, rec({ ts: new Date(now).toISOString(), provider: pick(PROVIDERS), sessionId: pick(SESSIONS), usd: Math.round(rnd() * 300) / 100 }), { rotateBytes: 1 });
      } else if (r < 0.85) {
        now += Math.floor(rnd() * 30 * 3_600_000);
      }
      assertEqual(totals, d, now, `seed ${seed} step ${step}`);
    }
  }
});

test('unchanged files parse 0 bytes on re-read; one appended row parses only its bytes', () => {
  _resetLedgerCache();
  const d = mk();
  const totals = createLedgerTotals(d);
  for (let i = 0; i < 40; i++) appendSpend(d, rec({ usd: 1 }));
  const first = totals.read({ provider: 'google', sessionId: 's1' });
  assert.equal(first.todayUsd, 40);
  const b0 = _ledgerParsedBytes();
  assert.ok(b0 > 0);
  totals.read({ provider: 'google', sessionId: 's1' });
  totals.read({ provider: 'google', sessionId: 's1' });
  assert.equal(_ledgerParsedBytes(), b0, 'nothing re-parsed');
  const stored = appendSpend(d, rec({ usd: 2 }));
  const lineBytes = Buffer.byteLength(JSON.stringify(stored)) + 2; // leading and trailing newline
  const after = totals.read({ provider: 'google', sessionId: 's1' });
  assert.equal(after.todayUsd, 42);
  assert.equal(_ledgerParsedBytes() - b0, lineBytes, 'only the new row was parsed (its two newlines included)');
});

test('a rotated file (same inode, new name) is not double counted', () => {
  _resetLedgerCache();
  const d = mk();
  const totals = createLedgerTotals(d);
  for (let i = 0; i < 5; i++) appendSpend(d, rec({ usd: 1 }));
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).todayUsd, 5);
  appendSpend(d, rec({ usd: 10 }), { rotateBytes: 1 }); // spend.jsonl -> spend.<n>.jsonl, then a new spend.jsonl
  assert.ok(fs.readdirSync(d).some((f) => /^spend\.\d+\.jsonl$/.test(f)));
  const t = totals.read({ provider: 'google', sessionId: 's1' });
  assert.equal(t.todayUsd, 15);
  assert.equal(t.sessionUsd, 15);
  appendSpend(d, rec({ usd: 100 }));
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).todayUsd, 115);
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).todayUsd, 115);
});

test('a duplicate id counts once, also across a rotated file', () => {
  _resetLedgerCache();
  const d = mk();
  const totals = createLedgerTotals(d);
  const first = appendSpend(d, rec({ usd: 3 }));
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).todayUsd, 3);
  appendSpend(d, { ...first }, { rotateBytes: 1 });
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).todayUsd, 3);
});

test('a folded file that shrinks, is replaced or disappears makes the totals rebuild and still equal summarize', () => {
  _resetLedgerCache();
  const d = mk();
  const totals = createLedgerTotals(d);
  const now = Date.now();
  const check = (label) => assertEqual(totals, d, now, label);
  for (let i = 0; i < 6; i++) appendSpend(d, rec({ usd: 1, sessionId: i % 2 ? 's1' : 's2' }));
  appendSpend(d, rec({ usd: 4, sessionId: 's3' }), { rotateBytes: 1 });
  appendSpend(d, rec({ usd: 8, sessionId: 's3' }));
  check('initial');
  // truncate the live file to its first row
  const live = path.join(d, 'spend.jsonl');
  const text = fs.readFileSync(live, 'utf8');
  fs.truncateSync(live, text.indexOf('\n', 1) + 1 || 1);
  check('truncated');
  // replaced by shorter, different content
  fs.writeFileSync(live, `${JSON.stringify(rec({ usd: 2, sessionId: 's1' }))}\n`);
  check('replaced');
  // replaced by a different file with the same number of rows (same length of history, other values)
  fs.unlinkSync(live);
  fs.writeFileSync(live, `${JSON.stringify(rec({ usd: 7, sessionId: 's2', id: 'other' }))}\n`);
  check('replaced, new inode');
  // the rotated file disappears
  const rotated = fs.readdirSync(d).find((f) => /^spend\.\d+\.jsonl$/.test(f));
  fs.unlinkSync(path.join(d, rotated));
  check('rotated file unlinked');
  // everything gone
  fs.unlinkSync(live);
  check('all gone');
  assert.equal(totals.read({ now, provider: 'google', sessionId: 's1' }).todayUsd, 0);
});

test('a file replaced by a shorter one with the same row count but other values is noticed', () => {
  _resetLedgerCache();
  const d = mk();
  const totals = createLedgerTotals(d);
  const live = path.join(d, 'spend.jsonl');
  const long = 'm'.repeat(300);
  appendSpend(d, rec({ usd: 1, id: 'a', model: long }));
  appendSpend(d, rec({ usd: 2, id: 'b', model: long }));
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).todayUsd, 3);
  // the reader starts this file over (it is shorter than what it consumed); the folded prefix no longer matches
  fs.truncateSync(live, 0);
  fs.appendFileSync(live, `${JSON.stringify(rec({ usd: 10, id: 'c' }))}\n${JSON.stringify(rec({ usd: 20, id: 'd' }))}\n`);
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).todayUsd, 30);
  assert.equal(summarize(d, { since: 'today' }).totals.usd, 30);
});

test('an unreadable data dir never reads as no spend, and recovers', { skip: process.getuid?.() === 0 }, () => {
  _resetLedgerCache();
  const d = mk();
  const totals = createLedgerTotals(d);
  appendSpend(d, rec({ usd: 5 }));
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).todayUsd, 5);
  fs.chmodSync(d, 0o000);
  try {
    const t = totals.read({ provider: 'google', sessionId: 's1' });
    assert.equal(t.unreadable, true);
    assert.equal(t.complete, false);
  } finally { fs.chmodSync(d, 0o700); }
  const back = totals.read({ provider: 'google', sessionId: 's1' });
  assert.equal(back.unreadable, false);
  assert.equal(back.complete, true);
  assert.equal(back.todayUsd, 5);
  appendSpend(d, rec({ usd: 1 }));
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).todayUsd, 6);
});

test('an empty provider gives providerUsd 0 (checkCaps looks up byProvider[""])', () => {
  _resetLedgerCache();
  const d = mk();
  const totals = createLedgerTotals(d);
  appendSpend(d, rec({ usd: 5, provider: '' }));
  appendSpend(d, rec({ usd: 2, provider: 'google' }));
  const t = totals.read({ provider: '', sessionId: 's1' });
  assert.equal(t.providerUsd, 0);
  assert.equal(t.todayUsd, 7);
  assert.equal(totals.read({ provider: 'google', sessionId: 's1' }).providerUsd, 2);
});

test('rows without a parsable timestamp or before 1970 are left out like summarize leaves them out; a missing data dir is complete with no spend', () => {
  _resetLedgerCache();
  const d = mk();
  const totals = createLedgerTotals(d);
  const none = totals.read({ provider: 'google', sessionId: 's1' });
  assert.deepEqual([none.todayUsd, none.providerUsd, none.sessionUsd, none.complete, none.unreadable], [0, 0, 0, true, false]);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'spend.jsonl'), [
    JSON.stringify(rec({ usd: 1 })),
    JSON.stringify({ ...rec({ usd: 50 }), ts: '1960-01-01T00:00:00.000Z' }),
    '{"torn": ',
    '',
  ].join('\n'));
  const now = Date.now();
  const t = totals.read({ now, provider: 'google', sessionId: 's1' });
  near(t.todayUsd, summarize(d, { since: 'today', now }).totals.usd, 'today');
  near(t.sessionUsd, summarize(d, { since: 'all', now }).bySession.s1.usd, 'session');
  assert.equal(t.sessionUsd, 1);
});
