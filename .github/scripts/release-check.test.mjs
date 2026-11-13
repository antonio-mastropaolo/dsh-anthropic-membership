import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection, checkTag, versionFromTag } from './release-check.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-check.mjs');
const CL = `# Changelog\n\n## [3.1.0] - Unreleased\n\n### Added\n- later\n\n## [3.0.0] - 2026-11-20\n\n### Added\n- first\n\n### Fixed\n- second\n\n## [2.0.0] - 2026-11-08\n\n### Added\n- old\n`;

test('versionFromTag accepts vMAJOR.MINOR.PATCH only', () => {
  assert.equal(versionFromTag('v3.0.0'), '3.0.0');
  assert.equal(versionFromTag('v10.20.30'), '10.20.30');
  for (const bad of ['3.0.0', 'v3.0', 'v3.0.0-rc.1', 'v03.0.0', 'v3.0.0 ', 'refs/tags/v3.0.0', '', undefined, 'v3.0.0\nx']) assert.throws(() => versionFromTag(bad), /not a release tag/);
});

test('checkTag requires the tag to equal package.json version and a public package', () => {
  assert.equal(checkTag('v3.0.0', { version: '3.0.0' }), '3.0.0');
  assert.throws(() => checkTag('v3.0.1', { version: '3.0.0' }), /tag v3\.0\.1 does not match package\.json version 3\.0\.0/);
  assert.throws(() => checkTag('v3.0.0', { version: '3.0.0', private: true }), /private/);
});

test('changelogSection returns exactly that version\'s body', () => {
  assert.equal(changelogSection(CL, '3.0.0'), '### Added\n- first\n\n### Fixed\n- second\n');
  assert.equal(changelogSection(CL, '2.0.0'), '### Added\n- old\n');
});

test('changelogSection refuses a missing, undated or empty section', () => {
  assert.throws(() => changelogSection(CL, '9.9.9'), /no "## \[9\.9\.9\]" section/);
  assert.throws(() => changelogSection(CL, '3.1.0'), /no release date/);
  assert.throws(() => changelogSection('## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-01-01\n- x\n', '1.0.0'), /is empty/);
});

test('CLI: tag and notes print on success and exit 1 with a message on failure', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'rc-'));
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '3.0.0' }));
  writeFileSync(path.join(d, 'CHANGELOG.md'), CL);
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8' });
  const ok = run('tag', 'v3.0.0', '--package', path.join(d, 'package.json'));
  assert.equal(ok.status, 0); assert.equal(ok.stdout.trim(), '3.0.0');
  const notes = run('notes', 'v3.0.0', '--package', path.join(d, 'package.json'), '--changelog', path.join(d, 'CHANGELOG.md'));
  assert.equal(notes.status, 0); assert.ok(notes.stdout.startsWith('### Added\n- first'));
  const bad = run('tag', 'v3.0.1', '--package', path.join(d, 'package.json'));
  assert.equal(bad.status, 1); assert.match(bad.stderr, /does not match/); assert.equal(bad.stdout, '');
  assert.equal(run('nonsense').status, 2);
});

test('changelogSection refuses a section that still carries a work-in-progress note (the body is published verbatim)', () => {
  for (const note of ['Forecast is still being merged; it is added to this section when it lands.', 'Integrator: add the forecast bullets.', 'More bullets are added when they land.', 'TODO: forecast', 'TBD']) {
    const cl = `# Changelog\n\n## [3.0.0] - 2026-11-20\n\n${note}\n\n### Added\n- first\n`;
    assert.throws(() => changelogSection(cl, '3.0.0'), /work-in-progress note/, note);
  }
  const cl = `# Changelog\n\n## [3.0.0] - 2026-11-20\n\n### Added\n- first\n\n## [3.1.0] - Unreleased\n\nstill being merged\n`;
  assert.equal(changelogSection(cl, '3.0.0'), '### Added\n- first\n', 'only the released version\'s own body is checked');
});
