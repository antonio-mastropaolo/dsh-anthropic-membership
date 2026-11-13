// Costs card: the "Spend by purpose" split (Ledger v2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

function loadWithReact(reactStub) {
  let mod;
  const sandbox = { window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const jsx = (type, props) => ({ type, props });
  return mod.factory((n) => (n === 'react' ? reactStub : n === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : { FishLogo: () => ({}) }))._test;
}
const texts = (n, out = []) => {
  if (n === null || n === undefined || typeof n === 'boolean') return out;
  if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => texts(x, out)); return out; }
  if (n.props) { texts(n.props.children, out); if (n.type && n.type.name === 'ProviderIcon') out.push('icon:' + n.props.provider); }
  return out;
};
const fakeReact = { useState: (i) => [i, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useCallback: (f) => f };
const expand = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(expand); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return expand(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: expand(n.props.children) } } : n; };
const J = (v) => JSON.parse(JSON.stringify(v));

test('purposeRows: API-value order, friendly labels, share of the API value, unknown = "Before ledger v2"', () => {
  const t = loadWithReact(fakeReact);
  const rows = t.purposeRows({ byPurpose: { chat: { calls: 4, usd: 0, apiEquivUsd: 3 }, 'session-title': { calls: 1, usd: 0, apiEquivUsd: 0.01 }, compaction: { calls: 2, usd: 0, apiEquivUsd: 1 }, unknown: { calls: 9, usd: 0, apiEquivUsd: 0 } } });
  assert.deepEqual(J(rows.map((r) => r.label)), ['Chat', 'Compaction', 'Title', 'Before ledger v2']);
  assert.deepEqual(J(rows.map((r) => r.key)), ['chat', 'compaction', 'session-title', 'unknown']);
  assert.ok(Math.abs(rows[0].pct - (3 / 4.01) * 100) < 1e-9);
  assert.ok(Math.abs(rows[1].pct - (1 / 4.01) * 100) < 1e-9);
  assert.equal(rows[3].pct, 0); assert.equal(rows[3].calls, 9); assert.equal(rows[0].api, 3);
  assert.equal(t.purposeRows({ byPurpose: { 'auto-review': { calls: 1, apiEquivUsd: 1 }, 'my-thing': { calls: 1, apiEquivUsd: 0.5 } } })[0].label, 'Review');
  assert.equal(t.purposeRows({ byPurpose: { 'my-thing': { calls: 1, apiEquivUsd: 0.5 } } })[0].label, 'My-thing');
});

test('purposeRows: nothing for a missing or empty split, and an all-zero split has 0% shares (no NaN)', () => {
  const t = loadWithReact(fakeReact);
  for (const d of [null, undefined, {}, { byPurpose: null }, { byPurpose: {} }]) assert.deepEqual(J(t.purposeRows(d)), []);
  const z = t.purposeRows({ byPurpose: { chat: { calls: 1, usd: 0, apiEquivUsd: 0 } } });
  assert.equal(z[0].pct, 0);
});

test('the Costs card renders "Spend by purpose" from the selected period, as text, and nothing when the payload has no split', () => {
  const t = loadWithReact(fakeReact);
  const base = {
    totals: { usd: 0, apiEquivUsd: 4, calls: 6 }, complete: true,
    byProvider: { anthropic: { usd: 0, apiEquivUsd: 4, calls: 6, billing: 'subscription' } },
    caps: { action: 'ok', reason: 'within caps', todayUsd: 0, sessionSpentUsd: 0, limits: { dailyUsd: 40, sessionUsd: 15 } },
  };
  const withSplit = { data: { ...base, byPurpose: { chat: { calls: 4, usd: 0, apiEquivUsd: 3 }, compaction: { calls: 2, usd: 0, apiEquivUsd: 1 }, 'session-title': { calls: 1, usd: 0, apiEquivUsd: 0.01 } } }, error: null };
  const out = texts(expand(t.CostsPanel({ today: withSplit, gcfg: null }))).join('|');
  for (const want of ['By purpose', 'Chat', 'Compaction', 'Title', '$3.00', '$1.00', '$0.0100']) assert.ok(out.includes(want), want + ' in ' + out);
  assert.ok(out.includes('Chat|4|$0.00|$3.00'), 'a purpose row is its name, calls, charged and API value: ' + out);
  const without = texts(expand(t.CostsPanel({ today: { data: base, error: null }, gcfg: null }))).join('|');
  assert.ok(!without.includes('By purpose'));
});

test('the purpose split never uses innerHTML and adds no hardcoded colour', () => {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(!/innerHTML|dangerouslySetInnerHTML/.test(src));
  const i = src.indexOf('function purposeRows');
  assert.ok(i > 0);
  assert.deepEqual(src.slice(i, i + 1500).match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
});

// ---- Costs card: the Ledger line and Verify button ----
const find = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { n.forEach((x) => find(x, pred, out)); return out; }
  if (pred(n)) out.push(n);
  if (n.props) find(n.props.children, pred, out);
  return out;
};
const OKREP = { ok: true, rows: 1204, checked: 1120, v1: 84, mismatchCount: 0, mismatches: [], tornLines: 0, complete: true, unreadable: false };

test('ledgerLine: one branch per state, with its tone and plain text', () => {
  const t = loadWithReact(fakeReact);
  assert.deepEqual(J(t.ledgerLine(null, null, true)), { tone: 'neutral', text: 'Verifying…' });
  assert.deepEqual(J(t.ledgerLine(null, null, false)), { tone: 'neutral', text: 'Not checked yet. Every amount on this card comes from it.' });
  assert.deepEqual(J(t.ledgerLine(null, 'HTTP 403', false)), { tone: 'bad', text: 'Verify failed: HTTP 403' });
  const ok = t.ledgerLine(OKREP, null, false);
  assert.equal(ok.tone, 'ok'); assert.equal(ok.text, (1204).toLocaleString() + ' rows verified · 0 mismatches');
  assert.ok(ok.title.includes((84).toLocaleString() + ' older rows') && ok.title.includes('not that a published price was right'));
  assert.deepEqual(J(t.ledgerLine({ ...OKREP, ok: false, complete: false }, null, false)), { tone: 'warn', text: 'Could not be read in full. Run Verify again.' });
  assert.equal(t.ledgerLine({ ...OKREP, ok: false, unreadable: true }, null, false).tone, 'warn');
  const bad = t.ledgerLine({ ...OKREP, ok: false, mismatchCount: 1, tornLines: 0 }, null, false);
  assert.deepEqual(J(bad), { tone: 'bad', text: '1 mismatch · run dsh-hub ledger verify' });
  assert.equal(t.ledgerLine({ ...OKREP, ok: false, mismatchCount: 3, tornLines: 2 }, null, false).text, '3 mismatches, 2 torn lines · run dsh-hub ledger verify');
  assert.equal(t.ledgerLine({ ...OKREP, ok: false, mismatchCount: 0, tornLines: 1 }, null, false).text, '0 mismatches, 1 torn line · run dsh-hub ledger verify');
  assert.equal(t.ledgerLine(OKREP, 'x', true).text, 'Verifying…', 'running wins over an old result');
});

test('ledgerDetail: the first mismatches as text lines, capped, nothing when clean', () => {
  const t = loadWithReact(fakeReact);
  assert.deepEqual(J(t.ledgerDetail(null)), []); assert.deepEqual(J(t.ledgerDetail(OKREP)), []);
  const m = (i) => ({ id: 'id' + i, field: 'usd', expected: 0.5, stored: i === 2 ? 'abc' : 7 });
  const lines = t.ledgerDetail({ ok: false, mismatchCount: 5, mismatches: [m(1), m(2), m(3), m(4), m(5)] });
  assert.deepEqual(J(lines), ['id1 · usd: stored 7, expected 0.5', 'id2 · usd: stored abc, expected 0.5', 'id3 · usd: stored 7, expected 0.5', '… and 2 more (dsh-hub ledger verify lists them)']);
  assert.equal(t.ledgerDetail({ ok: false, mismatchCount: 1, mismatches: [{ id: null, field: 'rates', expected: 'x', stored: null }] })[0], '(no id) · rates: stored null, expected x');
});

test('the Costs card shows the Ledger line and an enabled Verify button before any check', () => {
  const t = loadWithReact(fakeReact);
  const tree = expand(t.CostsPanel({ today: { data: null, error: null }, gcfg: null }));
  assert.ok(texts(tree).join('|').includes('Spend ledger|'), 'the footer row names the ledger');
  assert.ok(texts(tree).join('|').includes('Not checked yet. Every amount on this card comes from it.'));
  const btn = find(tree, (n) => n.type === 'button' && n.props.children === 'Verify');
  assert.equal(btn.length, 1);
  assert.equal(btn[0].props.disabled, false); assert.equal(typeof btn[0].props.onClick, 'function'); assert.equal(btn[0].props.type, 'button');
  const group = find(tree, (n) => n.props && n.props['aria-label'] === 'Ledger');
  assert.equal(group.length, 1); assert.equal(group[0].props.role, 'group');
  assert.equal(find(tree, (n) => n.props && n.props.role === 'status' && JSON.stringify(n.props.children).includes('Not checked yet')).length >= 1, true);
});

test('while verifying the Verify button is disabled and says so; a finished report renders as text', () => {
  const running = { ...fakeReact, useState: (i) => (i && typeof i === 'object' && 'running' in i ? [{ running: true, report: null, error: null }, () => {}] : [i, () => {}]) };
  const t = loadWithReact(running);
  const tree = expand(t.CostsPanel({ today: { data: null, error: null }, gcfg: null }));
  const btn = find(tree, (n) => n.type === 'button' && n.props.children === 'Verifying…');
  assert.equal(btn.length, 1); assert.equal(btn[0].props.disabled, true);
  assert.ok(texts(tree).join('|').includes('Verifying…'));
  const done = { ...fakeReact, useState: (i) => (i && typeof i === 'object' && 'running' in i ? [{ running: false, report: { ...OKREP, ok: false, mismatchCount: 1, mismatches: [{ id: '<img src=x onerror=alert(1)>', field: 'usd', expected: 1, stored: 2 }] }, error: null }, () => {}] : [i, () => {}]) };
  const out = texts(expand(loadWithReact(done).CostsPanel({ today: { data: null, error: null }, gcfg: null }))).join('|');
  assert.ok(out.includes('1 mismatch · run dsh-hub ledger verify'));
  assert.ok(out.includes('<img src=x onerror=alert(1)> · usd: stored 2, expected 1'), 'data stays text');
});

test('the Verify click calls GET /ledger/verify?since=all with the hub header and stores the report', async () => {
  const calls = []; const states = [];
  const sandboxFetch = (url, opts) => { calls.push([url, opts && opts.headers]); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(OKREP) }); };
  let mod;
  const sandbox = { URL, fetch: sandboxFetch, window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const react = { ...fakeReact, useState: (i) => (i && typeof i === 'object' && 'running' in i ? [i, (v) => states.push(typeof v === 'function' ? v(i) : v)] : [i, () => {}]) };
  const jsx = (type, props) => ({ type, props });
  const t = mod.factory((n) => (n === 'react' ? react : n === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : { FishLogo: () => ({}) }))._test;
  const btn = find(expand(t.CostsPanel({ today: { data: null, error: null }, gcfg: null })), (n) => n.type === 'button' && n.props.children === 'Verify')[0];
  btn.props.onClick();
  assert.deepEqual(J(states[0]), { running: true, report: null, error: null });
  await new Promise((r) => setTimeout(r, 0));
  const hit = calls.find((c) => String(c[0]).endsWith('/ledger/verify?since=all'));
  assert.ok(hit, JSON.stringify(calls));
  assert.equal(hit[1]['x-dsh-model-hub'], '1');
  assert.deepEqual(J(states[states.length - 1]), { running: false, report: OKREP, error: null });
});

test('the Ledger line adds no hardcoded colour and no innerHTML', () => {
  const src = fs.readFileSync(file, 'utf8');
  const i = src.indexOf('function ledgerLine');
  assert.ok(i > 0);
  assert.deepEqual(src.slice(i, i + 2500).match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
});

// ---- Costs card: guard errors ----
const GBASE = {
  totals: { usd: 0, apiEquivUsd: 0, calls: 0 }, complete: true, byProvider: {},
  caps: { action: 'ok', reason: 'within caps', todayUsd: 0, sessionSpentUsd: 0, limits: { dailyUsd: 40, sessionUsd: 15 } },
};
const gcaps = (guard) => ({ data: { ...GBASE, caps: { ...GBASE.caps, ...(guard === undefined ? {} : { guard }) } }, error: null });

test('guardLine: null without errors or without a guard status; text and title otherwise', () => {
  const t = loadWithReact(fakeReact);
  for (const c of [null, undefined, {}, { guard: null }, { guard: {} }, { guard: { onError: 'allow', errors: { count: 0, last: null } } }, { guard: { onError: 'allow', errors: null } }]) assert.equal(t.guardLine(c), null);
  const allow = t.guardLine({ guard: { onError: 'allow', errors: { count: 3, last: { at: 1, message: 'boom' } } } });
  assert.equal(allow.text, 'guard errors: 3, last boom');
  assert.equal(allow.title, 'config.json guard.onError is "allow" (requests go through when the guard fails)');
  const block = t.guardLine({ guard: { onError: 'block', errors: { count: 1, last: { at: 1, message: 'x' } } } });
  assert.equal(block.text, 'guard errors: 1, last x');
  assert.equal(block.title, 'config.json guard.onError is "block" (requests are held back when the guard fails)');
  assert.equal(t.guardLine({ guard: { onError: 'allow', errors: { count: 2, last: null } } }).text, 'guard errors: 2');
  assert.equal(t.guardLine({ guard: { onError: 'allow', errors: { count: 1, last: { message: 'y'.repeat(500) } } } }).text.length <= 'guard errors: 1, last '.length + 160, true);
});

test('the Costs card renders "guard errors: N, last ..." as text when the guard has failed, and nothing when it has not', () => {
  const t = loadWithReact(fakeReact);
  const out = texts(expand(t.CostsPanel({ today: gcaps({ onError: 'block', errors: { count: 4, last: { at: 1, message: '<img src=x onerror=alert(1)>' } } }), gcfg: null }))).join('|');
  assert.ok(out.includes('guard errors: 4, last <img src=x onerror=alert(1)>'), out);
  for (const g of [undefined, null, { onError: 'allow', errors: { count: 0, last: null } }]) {
    const none = texts(expand(t.CostsPanel({ today: gcaps(g), gcfg: null }))).join('|');
    assert.ok(!none.includes('guard errors'), JSON.stringify(g));
  }
});

test('the guard errors line is a Guard tag row with the policy as its title, and the guard code adds no hardcoded colour', () => {
  const t = loadWithReact(fakeReact);
  const tree = expand(t.CostsPanel({ today: gcaps({ onError: 'allow', errors: { count: 1, last: { at: 1, message: 'm' } } }), gcfg: null }));
  const rows = find(tree, (n) => n.props && n.props.className === 'dshMh-fact' && texts(n).join('').includes('guard errors:'));
  assert.equal(rows.length, 1);
  assert.deepEqual(texts(rows[0]).slice(0, 1), ['Guard'], 'a "Guard" tag leads the row, like est. and Held');
  assert.match(rows[0].props.title, /guard\.onError is "allow"/);
  assert.equal(rows[0].props.role, 'status');
  const src = fs.readFileSync(file, 'utf8');
  const i = src.indexOf('function guardLine');
  assert.ok(i > 0);
  assert.deepEqual(src.slice(i, i + 900).match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
});

// ---- Costs card: dollars reserved by requests in flight ----
const rcaps = (reserved, extra = {}) => ({ data: { ...GBASE, caps: { ...GBASE.caps, todayUsd: 3, ...(reserved === undefined ? {} : { reserved }), ...extra } }, error: null });

test('reservedLine: null without in-flight requests; "$X for N request(s) in flight, counted at their worst case." otherwise', () => {
  const t = loadWithReact(fakeReact);
  for (const c of [null, undefined, {}, { reserved: null }, { reserved: { usd: 0, count: 0 } }, { reserved: { usd: 5, count: 0 } }, { reserved: { usd: 'x', count: 2 } }, { reserved: { usd: 1, count: -1 } }, { reserved: { usd: 1, count: 1.5 } }]) assert.equal(t.reservedLine(c), null, JSON.stringify(c));
  assert.equal(t.reservedLine({ reserved: { usd: 0.834, count: 1 } }), '$0.83 for 1 request in flight, counted at their worst case.');
  assert.equal(t.reservedLine({ reserved: { usd: 2, count: 3 } }), '$2.00 for 3 requests in flight, counted at their worst case.');
  assert.deepEqual(J(t.reservedSegs({ reserved: { usd: 2, count: 3 } })), [{ b: '$2.00' }, ' for 3 requests in flight, counted at their worst case.'], 'the amount is the bold part of the line');
});

test('the Held row says what is reserved only while something is in flight; it sits under the cap rows', () => {
  const t = loadWithReact(fakeReact);
  const tree = expand(t.CostsPanel({ today: rcaps({ usd: 0.834, count: 2 }), gcfg: null }));
  const out = texts(tree).join('|');
  assert.ok(out.includes('$3.00| of $40.00'), out);
  assert.ok(out.includes('Held|$0.83| for 2 requests in flight, counted at their worst case.'), out);
  assert.ok(!out.includes('+$0.83'), 'the amount is said once');
  const row = find(tree, (n) => n.props && n.props.className === 'dshMh-fact' && texts(n).join('').includes('in flight'))[0];
  assert.ok(row, 'a Held row');
  assert.equal(row.props.role, 'status');
  for (const r of [undefined, null, { usd: 0, count: 0 }]) {
    const none = texts(expand(t.CostsPanel({ today: rcaps(r), gcfg: null }))).join('|');
    assert.ok(none.includes('$3.00| of $40.00'), none);
    assert.ok(!none.includes('in flight'), JSON.stringify(r));
  }
});

test('in-flight text is rendered as text, and the reserved code adds no hardcoded colour and no innerHTML', () => {
  const t = loadWithReact(fakeReact);
  const out = texts(expand(t.CostsPanel({ today: rcaps({ usd: 1, count: 1 }, { limits: { dailyUsd: 0, sessionUsd: 15 } }), gcfg: null }))).join('|');
  assert.ok(out.includes('$1.00| for 1 request in flight'), 'shown even with the daily cap off');
  const src = fs.readFileSync(file, 'utf8');
  const i = src.indexOf('function reservedLine');
  assert.ok(i > 0);
  assert.deepEqual(src.slice(i, i + 700).match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
  assert.ok(!/innerHTML/.test(src.slice(i, i + 700)));
});
