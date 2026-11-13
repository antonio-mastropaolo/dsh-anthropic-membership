import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('CHANGELOG follows Keep a Changelog and its newest section is the package version', () => {
  assert.match(text, /^# Changelog\n/);
  assert.ok(text.includes('https://keepachangelog.com/en/1.1.0/'));
  const heads = [...text.matchAll(/^## \[([^\]]+)\] - (Unreleased|\d{4}-\d{2}-\d{2})$/gm)];
  assert.ok(heads.length >= 2);
  assert.equal(heads[0][1], pkg.version);
  assert.deepEqual(heads.map((h) => h[1]).slice(0, 2), ['3.0.0', '2.0.0']);
  assert.equal(text.match(/^## /gm).length, heads.length, 'every ## heading is a version heading');
});

test('sections use only the Keep a Changelog groups and every group has bullets', () => {
  const groups = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.ok(groups.length >= 4);
  for (const g of groups) assert.ok(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'].includes(g), g);
  for (const part of text.split(/^### /m).slice(1)) assert.match(part, /^\w+\n+- /, `empty group: ${part.slice(0, 20)}`);
});

test('credits the outside contributor and keeps internal vocabulary out', () => {
  assert.ok(text.includes('Mihail Turusov') && text.includes('sneakyjoeru'));
  for (const n of ['#1', '#3', '#4']) assert.ok(text.includes(n), n);
  assert.ok(!/ledger-guard|caps-prs|demo-hygiene|dsh-mh\/|\bwave \d|\btrack\b|astra|rocco|kimi-coding|TODO|TBD|\/Users\//i.test(text));
  assert.ok(!/^\[[^\]]+\]: /m.test(text), 'no link-reference lines: the release notes are cut from the section body');
});

test('the release section for 3.0.0 names the install change and the data guarantee', () => {
  const v3 = text.split(/^## \[2\.0\.0\]/m)[0];
  assert.match(v3, /dsh plugin --profile web add -w dsh-model-hub/);
  assert.match(v3, /@local\/dsh-model-hub/);
  assert.match(v3, /model-hub/);
  assert.match(v3, /ledger verify/);
  assert.match(v3, /dsh-hub caps/);
  assert.match(v3, /stopAtPlanLimit|100% of a plan window/);
  assert.match(v3, /dsh-hub demo|demo mode/i);
});

const v3Body = () => text.split(/^## \[2\.0\.0\]/m)[0];

test('the 3.0.0 body is publishable as the release notes: no work-in-progress note', () => {
  assert.ok(!/still being merged|integrator|when they land|will be added|coming soon/i.test(v3Body()));
});

test('the ledger export bullet says what the code does with --force', () => {
  const exportBullet = v3Body().split('\n').find((l) => l.includes('ledger export'));
  assert.ok(exportBullet);
  // bin/dsh-hub.mjs refuses the ledger as --out even with --force, and --force inside the data folder
  assert.match(exportBullet, /never overwrites the ledger,? with or without `--force`/);
  assert.match(exportBullet, /`--force` is refused inside the data folder/);
  assert.ok(!/and never the ledger itself, without `--force`/.test(exportBullet));
});

test('the Fixed list holds only bugs that a 2.0.0 user could have had', () => {
  // each of these belongs to a feature that is new in 3.0.0 (no 2.0.0 release contained it), so it is not a fix
  for (const unreleased of ['caps toggle', 'DS_Store', '/accounts/flows', 'React key', 'turn, step and parent', 'usage chunk with no finish']) assert.ok(!v3Body().includes(unreleased), unreleased);
  assert.ok(!/^- `GET \/caps` and `POST \/caps` no longer return the path/m.test(v3Body()));
  const fixed = v3Body().split(/^### Fixed$/m)[1].split(/^### /m)[0];
  // the one real 2.0.0 bug: lib/plan-usage.mjs at a5b00d2 returned null for a window above 100%
  assert.match(fixed, /^- A plan window reported above 100% was ignored\./m);
  assert.ok(!/^- A plan window reported above 100% is kept/m.test(v3Body()), 'not also listed under Changed');
});

test('the install bullet claims only what the manifest does', () => {
  const bullet = v3Body().split('\n').find((l) => l.startsWith('- Install with'));
  assert.ok(bullet);
  assert.ok(!/Discover page lists/i.test(bullet), 'the manifest does not get the package onto Discover; the catalogue entry does');
  assert.match(bullet, /separate catalogue submission/);
});
