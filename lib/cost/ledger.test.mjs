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
