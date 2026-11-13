// The Settings -> Models "Model hub" section (boards S1-S4): pure models and the elements they feed. No DOM; the picture is checked by
// docs/specs/e2e/harness/render.py against the boards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');
const src = fs.readFileSync(file, 'utf8');

function load(react, globals = {}) {
  let mod;
  const sandbox = { URL, ...globals, window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  const jsx = (type, props) => ({ type, props });
  return mod.factory((n) => (n === 'react' ? react : n === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : { FishLogo: () => ({}) }))._test;
}
const fakeReact = { useState: (i) => [i, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useCallback: (f) => f };
const t = load(fakeReact);
const J = (v) => JSON.parse(JSON.stringify(v));
const texts = (n, out = []) => {
  if (n === null || n === undefined || typeof n === 'boolean') return out;
  if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => texts(x, out)); return out; }
  if (n.props) texts(n.props.children, out);
  return out;
};
const expand = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(expand); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return expand(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: expand(n.props.children) } } : n; };
const find = (n, pred, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((x) => find(x, pred, out)); return out; } if (n.props) { if (pred(n)) out.push(n); find(n.props.children, pred, out); } return out; };

// ---- the runway: ghost estimate, ticks, tones ----
test('capRunway: the dot, the ticks still ahead of it, and the dashed ghost from the dot to the estimate', () => {
  const g = t.capRunway(0.23, 0.38);
  assert.equal(g.x, 63.54);
  assert.deepEqual(J(g.ticks), [130, 192], 'a tick under the filled part is left out');
  assert.deepEqual(J(g.ghost), { x1: 72.54, x2: 100.24 });
  assert.equal(g.tone, 'accent');
  assert.equal(t.capRunway(0.1).ghost, null, 'no estimate, no ghost');
  assert.equal(t.capRunway(0.4, 0.4).ghost, null, 'an estimate that is not ahead of the spend draws nothing');
  assert.equal(t.capRunway(0.4, 0.41).ghost, null, 'less than a dot of distance draws nothing');
  // an estimate at or past the cap ends just short of the cap line
  assert.equal(t.capRunway(0.78, 1.3).ghost.x2, 252);
  // hollow dot at nothing spent keeps every tick
  const z = t.capRunway(0);
  assert.equal(z.hollow, true); assert.deepEqual(J(z.ticks), [68, 130, 192]);
});

test('capRunway tones: the alert percentage of caps.json turns it amber, the cap turns it red', () => {
  assert.equal(t.capRunway(0.6, null, 50).tone, 'warn');
  assert.equal(t.capRunway(0.4, null, 50).tone, 'accent');
  assert.equal(t.capRunway(0.6).tone, 'accent', 'without an alert percentage the old 80% applies');
  assert.equal(t.capRunway(0.85).tone, 'warn');
  assert.equal(t.capRunway(1, null, 50).tone, 'danger');
  assert.equal(t.capRunway(1.4).tone, 'danger');
});

test('CapRunway draws the ghost behind the dot, and leaves the hatched end out for plan credits', () => {
  const walk = (n) => find(expand(n), () => true);
  const withGhost = walk(t.CapRunway({ frac: 0.23, est: 0.38, pid: 'a', label: 'x' }));
  assert.equal(withGhost.filter((n) => n.type === 'line' && n.props.className === 'dshMh-rw-ghost').length, 1);
  assert.equal(withGhost.filter((n) => n.type === 'pattern').length, 1);
  const plan = walk(t.CapRunway({ frac: 0.3, pid: 'b', label: 'x', hatch: false }));
  assert.equal(plan.filter((n) => n.type === 'pattern' || (n.type === 'rect' && n.props.fill)).length, 0, 'plan credits have no hatched cap end');
  assert.equal(plan.filter((n) => n.props && n.props.className === 'dshMh-rw-cap').length, 1, 'but still a cap line');
  const svg = t.CapRunway({ frac: 0.3, pid: 'b', label: 'Daily cap: x' });
  assert.equal(svg.props.role, 'img'); assert.equal(svg.props['aria-label'], 'Daily cap: x');
});

// ---- the headline ----
const SPEND = {
  totals: { usd: 9.31, calls: 577, apiEquivUsd: 37.49 },
  byProvider: { deepseek: { usd: 9.31, calls: 292, apiEquivUsd: 9.31, billing: 'metered' }, anthropic: { usd: 0, calls: 212, apiEquivUsd: 26.84, billing: 'subscription' }, ollama: { usd: 0, calls: 47, apiEquivUsd: 1.34, billing: 'credits' }, rocco: { usd: 0, calls: 26, apiEquivUsd: 0, billing: 'local' } },
  complete: true,
};
test('spendHeroModel: charged, API value that was not charged (the difference), calls, and one bar segment per route that has some', () => {
  const m = t.spendHeroModel(SPEND, 'today');
  assert.equal(m.charged, '$9.31'); assert.equal(m.notCharged, '$28.18'); assert.equal(m.total, '$37.49'); assert.equal(m.callsText, '577 calls');
  assert.equal(m.chargedLabel, 'Charged today, in DSH');
  assert.deepEqual(J(m.segments.map((s) => [s.key, s.look])), [['charged', 'solid'], ['anthropic', 'tint'], ['ollama', 'hatch']], 'solid charged, then tinted / hatched not-charged by size; local has nothing to show');
  assert.equal(t.spendHeroModel(SPEND, '7d').chargedLabel, 'Charged in the last 7 days, in DSH');
  assert.equal(t.spendHeroModel({ ...SPEND, complete: false }, 'today').charged, '≥$9.31');
  assert.equal(t.spendHeroModel({ totals: { usd: 0, calls: 0, apiEquivUsd: 0 }, byProvider: {} }, 'today').empty, true);
  assert.equal(t.spendHeroModel({ totals: { usd: 0, calls: 0, apiEquivUsd: 0 }, byProvider: {} }, 'today').emptyText, 'No model calls today');
  assert.equal(t.spendHeroModel({ totals: { usd: 0, calls: 0 }, byProvider: {}, complete: false }, '7d').emptyText, 'Calls not known');
  assert.equal(t.spendHeroModel({ totals: { usd: 2, calls: 1, apiEquivUsd: 2 }, byProvider: { x: { usd: 2, apiEquivUsd: 2, calls: 1, billing: 'metered' } } }, 'today').total, null, 'the total says something only when part was not charged');
  assert.equal(t.spendHeroModel(null, 'today'), null);
  assert.equal(t.spendHeroModel({}, 'today'), null);
  assert.equal(t.spendHeroModel({ totals: { usd: 1, calls: 1, apiEquivUsd: 1 } }, 'today').segments.length, 1, 'no provider split: only the charged part');
});

test('provLook: solid when charged, hatched for plan credits, tinted for other API value, outline for nothing', () => {
  assert.equal(t.provLook({ usd: 1, api: 1, billing: 'metered' }), 'solid');
  assert.equal(t.provLook({ usd: 0, api: 2, billing: 'credits' }), 'hatch');
  assert.equal(t.provLook({ usd: 0, api: 2, billing: 'subscription' }), 'tint');
  assert.equal(t.provLook({ usd: 0, api: 0, billing: 'local' }), 'outline');
});

// ---- the cap rows ----
const CAPD = { caps: { action: 'ok', todayUsd: 9.31, sessionSpentUsd: 0.29, limits: { dailyUsd: 40, sessionUsd: 15, warnPct: 50, perProviderDailyUsd: { deepseek: 12 } } }, byProvider: { deepseek: { usd: 3 } } };
const PLANS = [{ key: 'ollama', label: 'Ollama Pro credits', reset: 'Dec 9', spent: 18.42, cap: 60, frac: 0.307, over: 0, partial: false }];
test('capRowsModel: Today, Latest session, a provider cap, then each plan; the forecast is the Today row\'s ghost only', () => {
  const rows = t.capRowsModel(CAPD, PLANS, { projectedUsd: 15.2, dailyReached: false });
  assert.deepEqual(J(rows.map((r) => [r.key, r.label, r.sub])), [['daily', 'Today', ''], ['session', 'Latest session', ''], ['p:deepseek', 'deepseek', 'daily cap'], ['plan:ollama', 'Ollama Pro credits', 'resets Dec 9']]);
  assert.equal(rows[0].est, 15.2 / 40); assert.equal(rows[1].est, null); assert.equal(rows[3].est, null);
  assert.equal(rows[0].aria, 'Daily cap: $9.31 spent today of $40.00, 23%. Estimate: about $15.20 by midnight.');
  assert.equal(rows[1].aria, 'Session cap: $0.29 spent of $15.00, 2%');
  assert.equal(rows[2].spent, 3); assert.equal(rows[2].cap, 12);
  assert.equal(rows[3].hatch, false); assert.equal(rows[0].hatch, true);
  // the alert percentage decides the tone; a reached cap is red
  assert.deepEqual(J(t.capRowsModel({ ...CAPD, caps: { ...CAPD.caps, todayUsd: 31.2 } }, [], null).map((r) => r.tone)), ['warn', 'accent', 'accent']);
  const hit = t.capRowsModel({ ...CAPD, caps: { ...CAPD.caps, todayUsd: 40 } }, [], { projectedUsd: 52, dailyReached: true })[0];
  assert.equal(hit.tone, 'danger'); assert.equal(hit.est, 1.3);
  // a reached daily cap closes the runway: the estimate is at least the cap
  assert.equal(t.capRowsModel({ ...CAPD, caps: { ...CAPD.caps, todayUsd: 31.2 } }, [], { projectedUsd: 36, dailyReached: true })[0].est, 1);
  // no estimate when it is not ahead of the spend; no row for a cap that is off
  assert.equal(t.capRowsModel(CAPD, [], { projectedUsd: 5, dailyReached: false })[0].est, null);
  assert.deepEqual(J(t.capRowsModel({ caps: { limits: { dailyUsd: 0, sessionUsd: 0 } } }, [], null)), []);
  assert.equal(t.capRowsModel({ caps: { ...CAPD.caps, sessionSpentUsd: undefined } }, [], null)[1].spent, null, 'an unknown session spend is not drawn as 0');
  assert.deepEqual(J(t.capRowsModel(null, [], null)), []);
});

test('the Costs card says "No caps are set" when none is, and notes a plan over its credits', () => {
  const none = expand(t.CostsPanel({ today: { data: { totals: { usd: 0, calls: 0 }, byProvider: {}, caps: { action: 'ok', todayUsd: 0, limits: { dailyUsd: 0, sessionUsd: 0 } } }, error: null }, gcfg: null }));
  assert.ok(texts(none).join('|').includes('No caps are set. Edit caps to add one.'));
  const over = expand(t.CostsPanel({ today: { data: { ...SPEND, caps: CAPD.caps, plans: [{ provider: 'ollama', name: 'Pro', includedUsd: 10, usedUsd: 10, overageUsd: 2.5, complete: false }] }, error: null }, gcfg: null }));
  const out = texts(over).join('|');
  assert.ok(out.includes('Ollama Pro credits: over the included credits by $2.50, billed as metered and counted toward caps.'), out);
  assert.ok(out.includes('Ollama Pro credits: partial, the spend ledger could not be read in full.'), out);
});

test('By provider: Not charged is API value minus charged; an unpriced or zero value is dim; the table has the five columns', () => {
  const tree = expand(t.CostsPanel({ today: { data: { ...SPEND, caps: CAPD.caps }, error: null }, gcfg: null, declared: [] }));
  const tables = find(tree, (n) => n.type === 'table');
  const prov = tables.find((x) => x.props['aria-label'].startsWith('Spend by provider'));
  const heads = find(prov, (n) => n.type === 'th').map((n) => texts(n).join(''));
  assert.deepEqual(heads, ['By provider', 'Billing', 'Calls', 'Charged', 'Not charged']);
  const rows = find(prov, (n) => n.type === 'tr' && n.props['data-provider-row']);
  const cells = (r) => find(r, (n) => n.type === 'td').map((n) => texts(n).join(''));
  assert.deepEqual(cells(rows[0]), ['deepseek', 'Metered', '292', '$9.31', '$0.00']);
  assert.deepEqual(cells(rows[1]), ['anthropic', 'Subscription', '212', '$0.00', '$26.84']);
  assert.deepEqual(cells(rows[2]), ['ollama', 'Credits', '47', '$0.00', '$1.34']);
  assert.deepEqual(cells(rows[3]), ['rocco', 'Local', '26', '$0.00', '$0.00']);
  const dimCells = (r) => find(r, (n) => n.type === 'td').map((n) => /is-zero/.test(n.props.className || ''));
  assert.deepEqual(dimCells(rows[0]), [false, false, false, false, true]);
  assert.deepEqual(dimCells(rows[1]), [false, false, false, true, false]);
  assert.ok(!find(tree, (n) => n.props && /dshMh-pill/.test(n.props.className || '')).some((n) => /Metered|Subscription|Credits|Local/.test(texts(n).join(''))), 'billing is a word, a pill only for an exception');
});

test('the 7-day period uses the 7-day payload and keeps the same card', () => {
  const react = { ...fakeReact, useState: (i) => (i === 'today' ? ['7d', () => {}] : [i, () => {}]) };
  const t7 = load(react);
  const week = { data: { ...SPEND, totals: { usd: 41.8, calls: 3190, apiEquivUsd: 188.4 } }, error: null };
  const out = texts(expand(t7.CostsPanel({ today: { data: { ...SPEND, caps: CAPD.caps }, error: null }, week, gcfg: null }))).join('|');
  assert.ok(out.includes('Charged in the last 7 days, in DSH|$41.80'), out);
  assert.ok(out.includes('3,190 calls'));
  const empty = texts(expand(t7.CostsPanel({ today: { data: { ...SPEND, caps: CAPD.caps }, error: null }, gcfg: null }))).join('|');
  assert.ok(!empty.includes('Charged in the last 7 days'), 'no 7-day data yet: no headline');
});

test('the 7-day tab: a failed 7-day read says so, a partial 7-day ledger gets its warning, and the bar is labelled "Last 7 days\' API value"', () => {
  const react7 = { ...fakeReact, useState: (i) => (i === 'today' ? ['7d', () => {}] : [i, () => {}]) };
  const t7 = load(react7);
  const todayP = { data: { ...SPEND, caps: CAPD.caps }, error: null };
  const wk = { ...SPEND, totals: { usd: 41.8, calls: 3190, apiEquivUsd: 188.4 } };
  const out = (tt, props) => texts(expand(tt.CostsPanel({ today: todayP, gcfg: null, ...props }))).join('|');
  // a failed 7-day read: a message on the 7-day tab only
  const failed = out(t7, { week: { data: null, error: 'HTTP 500' } });
  assert.ok(failed.includes('Spend for the last 7 days is unavailable: HTTP 500'), failed);
  assert.ok(!out(t, { week: { data: null, error: 'HTTP 500' } }).includes('last 7 days is unavailable'), 'not on the Today tab');
  // the partial-ledger warning follows the payload on show
  const warnBox = (tt, props) => find(expand(tt.CostsPanel({ today: todayP, gcfg: null, ...props })), (n) => /dshMh-warns/.test(n.props.className || '')).map((n) => texts(n));
  assert.deepEqual(warnBox(t7, { week: { data: { ...wk, complete: false }, error: null } }).map((l) => l.map((x) => x.slice(0, 8))), [['partial:']], 'a partial 7-day read explains the ≥');
  assert.deepEqual(warnBox(t7, { week: { data: wk, error: null } }), [], 'complete 7 days: no warning, even if today were partial');
  const partialToday = { data: { ...SPEND, caps: CAPD.caps, complete: false }, error: null };
  assert.deepEqual(find(expand(t7.CostsPanel({ today: partialToday, week: { data: wk, error: null }, gcfg: null })), (n) => /dshMh-warns/.test(n.props.className || '')).length, 0, 'today partial, 7 days complete: the 7-day tab shows no warning');
  assert.equal(find(expand(t.CostsPanel({ today: partialToday, gcfg: null })), (n) => /dshMh-warns/.test(n.props.className || '')).length, 1, 'the Today tab still warns about today');
  // the bar's accessible label
  assert.equal(t.spendHeroModel(wk, '7d').barLabel, "Last 7 days' API value in DSH by billing: ");
  assert.equal(t.spendHeroModel(wk, 'today').barLabel, "Today's API value in DSH by billing: ");
});

test('warnings: one box under the card header, a line per problem (invalid caps file, partial ledger, unpriced calls)', () => {
  const data = { ...SPEND, complete: false, unreadable: true, totals: { ...SPEND.totals, unpricedCalls: 2 }, caps: CAPD.caps };
  const tree = expand(t.CostsPanel({ today: { data, error: null }, gcfg: null }));
  const boxes = find(tree, (n) => /dshMh-warns/.test(n.props.className || ''));
  assert.equal(boxes.length, 1);
  const lines = texts(boxes[0]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^partial: the spend ledger could not be read/);
  assert.match(lines[1], /^2 unpriced calls today/);
  assert.equal(find(expand(t.CostsPanel({ today: { data: { ...SPEND, caps: CAPD.caps }, error: null }, gcfg: null })), (n) => /dshMh-warns/.test(n.props.className || '')).length, 0);
});

test('the Costs header shows a pill only for an exception: Near a cap, Cap reached', () => {
  const pill = (action) => find(expand(t.CostsPanel({ today: { data: { ...SPEND, caps: { ...CAPD.caps, action, reason: 'r' } }, error: null }, gcfg: null })), (n) => /dshMh-pill/.test(n.props.className || '')).map((n) => texts(n).join(''));
  assert.deepEqual(pill('ok'), []);
  assert.deepEqual(pill('warn'), ['Near a cap']);
  assert.deepEqual(pill('block'), ['Cap reached']);
});

// ---- caps editor: Save sends what the user changed in the editor, not what the 15-second poll says now ----
test('CapsEditor: a plan-stop toggled on the plan card while the editor is open is not written back; only the edited field is sent', async () => {
  const slots = []; let at = 0;
  const react = {
    useState: (init) => { const k = at++; if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init }; const c = slots[k]; return [c.v, (n) => { c.v = typeof n === 'function' ? n(c.v) : n; }]; },
    useRef: (v) => { const k = at++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useEffect: () => {}, useCallback: (f) => f,
  };
  const posts = [];
  const tt = load(react, { fetch: (u, o) => {
    if (o && o.method === 'POST') { posts.push({ path: String(u).replace(/^https?:\/\/[^/]+/, ''), body: JSON.parse(o.body) }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ webOrigin: 'http://localhost' }) });
  } });
  const opened = { caps: { dailyUsd: 40, sessionUsd: 15, warnPct: 50, perProviderDailyUsd: {} }, stopAtPlanLimit: false };
  let saved = 0;
  const render = (view) => { at = 0; return tt.CapsEditor({ view, plan: null, onSaved: () => { saved++; }, onCancel: () => {} }); };
  let form = render(opened);
  form.props.onChange({ ...form.props.draft, dailyUsd: '25' });          // the user edits only the daily cap
  form = render({ ...opened, stopAtPlanLimit: true, caps: { ...opened.caps, sessionUsd: 30 } }); // the poll: stop turned on, session cap changed elsewhere
  assert.equal(form.props.draft.dailyUsd, '25', 'the draft keeps the user\'s edit');
  form.props.onSubmit();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(J(posts), [{ path: '/caps', body: { set: { dailyUsd: 25 } } }]);
  assert.equal(saved, 1);
});

// ---- accounts ----
test('AccountRow: fixed columns, the identity line only when reported, the button says what it does', () => {
  const si = (o = {}) => ({ flowing: false, failed: false, fresh: false, msg: null, start() { calls.push('start'); }, cancel() { calls.push('cancel'); }, done() {}, ...o });
  const calls = [];
  const row = (a, s) => expand(t.AccountRow({ account: a, si: s || si() }));
  const claude = row({ provider: 'anthropic', signedIn: true, health: 'ok', expiresInMs: 2.3 * 3600e3, identity: { email: 'name@example.com', plan: 'Team', org: 'AuraLAB' } });
  assert.equal(claude.props.role, 'listitem');
  const out = texts(claude);
  for (const want of ['Anthropic', ' · Claude Pro/Max', 'name@example.com · Team · AuraLAB', 'Signed in', 'renews in 2.3 h', 'Reconnect']) assert.ok(out.includes(want), want + ' in ' + out.join('|'));
  const codex = texts(row({ provider: 'openai-codex', signedIn: true, health: 'ok', expiresInMs: 6.1 * 86400e3, identity: null }));
  assert.ok(!codex.includes('account not reported'), 'no identity line without an identity');
  // revoked: the pill with its own word, the primary button, the human error line
  const rev = row({ provider: 'anthropic', signedIn: true, health: 'expired', errorKind: 'revoked', lastError: 'x', terminal: true, expiresInMs: -3.2 * 3600e3 });
  const rt = texts(rev);
  for (const want of ['Revoked', 'expired 3.2 h ago', 'Sign in again', 'The sign-in was revoked or replaced. Automatic retries are paused.']) assert.ok(rt.includes(want), want + ' in ' + rt.join('|'));
  assert.ok(find(rev, (n) => n.type === 'button' && /is-primary/.test(n.props.className))[0]);
  assert.ok(find(rev, (n) => n.props && /dshMh-pill is-bad/.test(n.props.className || '')).length === 1);
  const warn = row({ provider: 'github-copilot', signedIn: true, health: 'expiring', expiresInMs: 8 * 60e3 });
  assert.deepEqual(texts(warn).filter((x) => /Expiring|expires/.test(x)), ['Expiring soon', 'expires in 8 min']);
  assert.ok(find(warn, (n) => n.props && /dshMh-pill is-warn/.test(n.props.className || '')).length === 1);
  // expired / refresh failed keep their own word
  assert.ok(texts(row({ provider: 'openai-codex', signedIn: true, health: 'expired', expiresInMs: -53 * 86400e3 })).includes('Expired'));
  assert.ok(texts(row({ provider: 'openai-codex', signedIn: true, health: 'refresh-failed', expiresInMs: -60e3 })).includes('Refresh failed'));
  // while the sign-in flows the button is Cancel and the panel opens under the row
  const flowing = row({ provider: 'anthropic', signedIn: false, health: 'missing' }, si({ flowing: true }));
  const cancel = find(flowing, (n) => n.type === 'button' && texts(n).join('') === 'Cancel')[0];
  assert.ok(cancel); cancel.props.onClick(); assert.deepEqual(calls, ['cancel']);
  assert.ok(texts(flowing).includes('Not signed in'));
  const raw = t.AccountRow({ account: { provider: 'anthropic', signedIn: false, health: 'missing' }, si: si({ flowing: true }) });
  assert.equal(find(raw, (n) => typeof n.type === 'function' && n.type.name === 'SignInFlow' && n.props.active === true).length, 1, 'the SignInFlow is under the row');
  assert.equal(find(t.AccountRow({ account: { provider: 'anthropic', signedIn: false, health: 'missing' }, si: si() }), (n) => typeof n.type === 'function' && n.type.name === 'SignInFlow').length, 0, 'and only while it flows');
  // a failed sign-in keeps the reason and a way back in
  const failed = row({ provider: 'anthropic', signedIn: false, health: 'missing' }, si({ failed: true, msg: 'A sign-in is already in progress in DSH.' }));
  const ft = texts(failed);
  assert.ok(ft.includes('Sign-in failed.') && ft.some((x) => x.includes('A sign-in is already in progress in DSH.')) && ft.some((x) => x.includes('Nothing was saved.')), ft.join('|'));
  const again = find(failed, (n) => n.type === 'button' && texts(n).join('') === 'Try again')[0];
  assert.ok(again && /is-primary/.test(again.props.className)); again.props.onClick(); assert.equal(calls[1], 'start');
  assert.equal(find(failed, (n) => n.props && n.props.role === 'alert').length, 1);
  // just signed in: the row turns live with a check
  const fresh = row({ provider: 'anthropic', signedIn: true, health: 'ok', expiresInMs: 8 * 3600e3 }, si({ fresh: true }));
  assert.ok(find(fresh, (n) => n.props && /is-fresh/.test(n.props.className || '')).length === 1);
});

test('the sign-in panel: a choice of methods, then waiting with a link and a paste box, or a device code with a copy button; source checks', () => {
  assert.match(src, /Choose how to sign in/);
  assert.match(src, /Waiting for you to finish in the browser/);
  assert.match(src, /Tab did not open\? Use this link\./);
  assert.match(src, /and enter this code there/);
  assert.match(src, /"aria-label": "Copy the code"/);
  assert.match(src, /Paste the code shown after sign-in/);
  assert.match(src, /Array\.isArray\(s\.prompt\.options\)/);
  assert.match(src, /answer\(String\(o\.id/);
  assert.match(src, /signInUrl\(\(s\.notices/, 'only an https URL is opened or linked');
  assert.ok(!/dshMh-addchip|dshMh-acctbox/.test(src));
});

test('AccountsPanel: the list, the "Add a sign-in" chips, Auto-refresh and Check now; the sign-in state is held by the card', () => {
  const tree = expand(t.AccountsPanel({}));
  assert.deepEqual(find(tree, (n) => n.props && n.props['aria-label'] === 'Accounts').length, 1);
  assert.ok(!texts(tree).includes('Check now'), 'no Check now before the accounts load');
  assert.match(src, /acc\.data\.reportOnly \? "Auto-refresh: report only" : "Auto-refresh on"/);
  assert.match(src, /h\("span", \{ className: "dshMh-soft dshMh-addlabel", children: "Add a sign-in" \}\)/);
  assert.match(src, /const sign = useSignIns\(flows, acc\.reload\)/);
  assert.match(src, /isAvailable\(a\) && !sign\(a\)\.active/, 'a chip whose sign-in is running becomes a row');
  assert.match(src, /accounts unavailable|Accounts unavailable: /i);
  // a chip starts the sign-in; the post goes through the ownership check (postJson)
  const chip = t.AvailableChip({ account: { provider: 'openrouter' }, si: { start() {} } });
  assert.equal(chip.type, 'button'); assert.match(chip.props.title, /Sign in to OpenRouter/);
  assert.ok(texts(chip).includes('OpenRouter'));
  assert.match(src, /postJson\("\/accounts\/signin", \{ provider: a\.provider, method \}\)/);
});

// ---- GPU server ----
test('gpuRingModel: memory percent, the one-line size, idle is "Free", the tooltip carries what runs and is reserved', () => {
  const idle = t.gpuRingModel({ index: 0, total_mib: 46080, used_mib: 600, processes: [] });
  assert.equal(idle.pct, 0); assert.equal(idle.sub, 'Free · 45 GiB'); assert.equal(idle.idle, true);
  const busy = t.gpuRingModel({ index: 1, total_mib: 46080, used_mib: 12902, util_pct: 41, processes: [{ user: 'vllm', cmd: 'python', used_mib: 12300 }], reserved_by: ['session-a'] });
  assert.equal(busy.pct, 28); assert.equal(busy.sub, '12.6 / 45 GiB'); assert.equal(busy.tone, 'ok'); assert.equal(busy.dash, '21.11 75.40');
  assert.ok(busy.tip.includes('41% util') && busy.tip.includes('vllm · python 12 GiB') && busy.tip.includes('reserved · session-a'));
  assert.equal(t.gpuRingModel({ index: 2, total_mib: 1000, used_mib: 950, processes: [{ user: 'u', cmd: 'c', used_mib: 900 }] }).tone, 'warn', 'above 85% the ring is amber');
  assert.equal(t.gpuRingModel({ index: 3, used_mib: 5, processes: [] }).sub, 'Free · ? GiB');
  const stale = t.gpuRingModel({ index: 0, total_mib: 46080, used_mib: 12000, processes: [{ user: 'u', cmd: 'c', used_mib: 1 }], reserved_by: ['x'], reservation_stale: true });
  assert.ok(!stale.tip.includes('reserved'), 'a stale reservation is not shown as a reservation');
});

const MODELS = [{ id: 'qwen3.8-q4' }, { id: 'glm-5.3-flash' }, { id: 'deepseek-v4.1-flash' }];
test('gpuModelRows: Load when nothing is loaded, Unload + Loaded for the loaded one, Switch for the others, Loading while one switches', () => {
  const cfg = { defaultModel: 'qwen3.8-q4' };
  assert.deepEqual(J(t.gpuModelRows(MODELS, cfg, null, null).map((r) => [r.id, r.action, r.isDefault, r.loaded, r.loading])), [['qwen3.8-q4', 'load', true, false, false], ['glm-5.3-flash', 'load', false, false, false], ['deepseek-v4.1-flash', 'load', false, false, false]]);
  assert.deepEqual(J(t.gpuModelRows(MODELS, cfg, 'glm-5.3-flash', null).map((r) => [r.action, r.loaded])), [['switch', false], ['unload', true], ['switch', false]]);
  const busy = t.gpuModelRows(MODELS, cfg, null, { target: 'qwen3.8-q4', started: 1 });
  assert.deepEqual(J(busy.map((r) => [r.action, r.loading])), [[null, true], ['load', false], ['load', false]], 'the loading row has no button; the others stay (and the panel disables them)');
  const unl = t.gpuModelRows(MODELS, cfg, 'glm-5.3-flash', { target: 'unload', started: 1 });
  assert.deepEqual(J(unl.map((r) => [r.action, r.loading])), [['switch', false], [null, true], ['switch', false]]);
  assert.equal(t.gpuModelRows(MODELS, {}, null, null).some((r) => r.isDefault), false, 'no Default tag without a configured default model');
  assert.equal(t.gpuModelRows(MODELS, { defaultModel: 'nope' }, null, null).some((r) => r.isDefault), false);
  assert.deepEqual(J(t.gpuModelRows([], cfg, null, null)), []);
});

test('the GPU server panel: a button per model row, the Load-on-GPU control, Return to auto, Force switch; Load posts the row\'s model', () => {
  assert.match(src, /const load = \(id\) => send\(pins\.length \? \{ model: id, gpus: pins \} : \{ model: id \}, true\)/);
  assert.match(src, /postJson\("\/gpu\/switch", body\)/);
  assert.match(src, /postJson\("\/gpu\/unload", \{\}\)/);
  assert.match(src, /send\(\{ model: loadedModel \|\| \(models\[0\] && models\[0\]\.id\) \|\| "", auto: true \}, false\)/);
  assert.match(src, /send\(\{ \.\.\.lastReq\.current, force: true \}, true\)/);
  assert.match(src, /"aria-label": "GPUs for the next load"/);
  assert.match(src, /"Load and Unload are paused until this finishes\."/);
  assert.match(src, /"Nothing is loaded\. A model loads by itself when a session asks for it\."/);
  assert.match(src, /children: "Return to auto"/);
  assert.match(src, /children: "Force switch"/);
  assert.match(src, /"Manager stopped"/);
  assert.match(src, /"Stale reservation"/);
  const cfg = { configured: true, id: 'lab', name: 'Lab box', icon: 'nvidia' };
  const out = texts(expand(t.GpuServerPanel({ cfg })));
  assert.ok(out.includes('Lab box GPUs') && out.includes('Models') && out.includes('Load on GPU') && out.includes('Auto'));
});

// ---- prices ----
test('PricesPanel is its own card: a header with the unit, and a note when there is nothing to price', () => {
  const tree = expand(t.PricesPanel({ gcfg: null }));
  assert.equal(find(tree, (n) => n.props && n.props['aria-label'] === 'Prices' && n.type === 'section').length, 1);
  const out = texts(tree);
  assert.ok(out.includes('Prices') && out.includes('$ per million tokens'));
  assert.ok(out.some((x) => x.startsWith('No models to price yet.')));
  assert.match(src, /th\("dshMh-c-plain", "Model"\), th\("dshMh-c-bill", "Billing"\), th\("dshMh-c-n dshMh-c-px", "In"\), th\("dshMh-c-n dshMh-c-px", "Out"\), th\("dshMh-c-n dshMh-c-px", "Cache"\)/);
  assert.match(src, /"No credit \(" \+/);
  assert.match(src, /children: "Add price"/);
});

// ---- the hub ----
test('the hub header: "Model hub" on the left, the connection and spend guard on the right; no tiles, no per-card demo banner', () => {
  assert.match(src, /h\("h2", \{ className: "dshMh-hubtitle", children: "Model hub" \}\)/);
  assert.ok(!/dshMh-tiles|dshMh-tile2|overviewTiles/.test(src));
  // the cards keep their aria-labels and .dshMh-hub, which docs/specs/e2e/capture_screens.py finds them by
  for (const label of ['"Costs"', '"Accounts"', 'gpuTitle(cfg)', '"Prices"']) assert.ok(src.includes('"aria-label": ' + label), label);
  assert.ok(src.includes('className: "dshMh-hub"'));
  assert.equal((src.match(/className: "dshMh-card"/g) || []).length, 4);
});

test('the sign-in state moves from a chip to a row without losing its panel: useSignIns keeps one entry per provider', () => {
  let state = {};
  const react = { ...fakeReact, useState: (i) => [state, (f) => { state = typeof f === 'function' ? f(state) : f; }] };
  const tt = load(react, { fetch: (u, o) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(u.endsWith('/healthz') ? { webOrigin: 'http://localhost' } : {}) }) });
  let changed = 0;
  const sign = tt.useSignIns([{ provider: 'anthropic', methods: ['oauth'] }], () => { changed++; });
  const a = { provider: 'anthropic' };
  assert.equal(sign(a).active, false);
  state = { anthropic: { flowing: true } };
  assert.equal(tt.useSignIns([], null)(a).active, true);
  // done: authorized -> a fresh row; cancelled -> back to a chip; failed -> a row with the reason
  sign(a).done('authorized');
  assert.deepEqual(J(state.anthropic), { flowing: false, failed: false, msg: null, fresh: true });
  assert.equal(tt.useSignIns([], null)(a).active, false); assert.equal(tt.useSignIns([], null)(a).fresh, true);
  sign(a).done('cancelled');
  assert.equal(state.anthropic, undefined);
  sign(a).done('failed', 'nope');
  assert.deepEqual(J(state.anthropic), { flowing: false, failed: true, msg: 'nope' });
  assert.equal(tt.useSignIns([], null)(a).active, true, 'a failed row stays until it is retried');
  assert.equal(changed, 3, 'every end of a sign-in reloads the accounts');
});

test('GPU model list: a long server list shows 8 rows until "Show all"; loaded, loading and default rows always stay in view', () => {
  const row = (id, o = {}) => ({ id, isDefault: false, loaded: false, loading: false, action: 'load', ...o });
  const many = Array.from({ length: 24 }, (_, i) => row('m' + i));
  many[14] = row('m14', { isDefault: true }); many[20] = row('m20', { loaded: true, action: 'unload' });
  const v = t.visibleModelRows(many, false);
  assert.equal(v.shown.length, t.MODEL_ROWS_MAX);
  assert.equal(v.hidden, 24 - t.MODEL_ROWS_MAX);
  assert.ok(v.shown.some((r) => r.id === 'm14') && v.shown.some((r) => r.id === 'm20'), 'default and loaded rows are never hidden');
  assert.deepEqual(v.shown.map((r) => r.id).slice(0, 6), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'], 'the rest keep the server order');
  assert.equal(t.visibleModelRows(many, true).shown.length, 24, 'Show all shows every row');
  assert.equal(t.visibleModelRows(many.slice(0, 9), false).hidden, 0, 'one hidden row is never worth a button');
});
