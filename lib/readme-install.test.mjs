// The README Install and Upgrade sections are a contract: these tests run the upgrade block's patch-file edit for real
// (bash + awk on throwaway files, HOME and DSH_HOME pointed at temp dirs) and pin the install claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');

function upgradeBlock() {
  const after = readme.split(/^### Upgrading from `@local\/dsh-model-hub` \(v2\)$/m)[1];
  assert.ok(after, 'the Upgrading heading exists');
  const section = after.split(/^## /m)[0];
  const blocks = [...section.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1].split('\n').filter((l) => l !== ''));
  assert.equal(blocks.length, 2, 'the Upgrading section has two sh blocks: edit the patch file, then swap the package');
  return blocks;
}
const editLines = () => upgradeBlock()[0];

const ENTRY = "- insert:\n    - id: model-hub\n      name: '@local/dsh-model-hub'\n";
const OTHER = '- insert:\n    - id: other\n      name: other\n';

/** Runs the README's patch-file edit on `content`; returns the file afterwards, the .bak copy and stderr. */
function runEdit(content) {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-readme-'));
  const dir = path.join(home, 'profiles', 'web');
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'cordis.patch.yml');
  writeFileSync(f, content);
  const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: home };
  const r = spawnSync('bash', ['-c', editLines().join('\n')], { encoding: 'utf8', env, cwd: home });
  assert.equal(r.error, undefined);
  return { file: readFileSync(f, 'utf8'), bak: readFileSync(`${f}.bak`, 'utf8'), stderr: r.stderr, stdout: r.stdout };
}

test('upgrade block: the plain v2 entry is removed and nothing else changes', () => {
  assert.equal(runEdit(ENTRY).file, '[]\n', 'an emptied file must hold []');
  const both = runEdit(OTHER + ENTRY + OTHER.replace('other', 'zzz'));
  assert.equal(both.file, OTHER + OTHER.replace('other', 'zzz'));
  assert.ok(!both.stderr.includes('still'), both.stderr);
  assert.equal(both.bak, OTHER + ENTRY + OTHER.replace('other', 'zzz'), 'the .bak copy is the original');
  const commented = runEdit(`# mine\n${ENTRY}`);
  assert.equal(commented.file, '# mine\n[]\n', 'comments only: a patch file with no entry holds []');
});

test('upgrade block: an entry v2 never wrote is left alone and reported, never half-deleted', () => {
  const shapes = {
    'several rows under one insert': "- insert:\n    - id: model-hub\n      name: '@local/dsh-model-hub'\n    - id: other\n      name: other\n",
    'an extra key under the row': "- insert:\n    - id: model-hub\n      name: '@local/dsh-model-hub'\n      config:\n        x: 1\n",
    'a row before it under the same insert': "- insert:\n    - id: a\n    - id: model-hub\n      name: '@local/dsh-model-hub'\n",
  };
  for (const [what, content] of Object.entries(shapes)) {
    const r = runEdit(content);
    assert.equal(r.file, content, `${what}: the file is byte-for-byte what it was`);
    assert.match(r.stdout, /@local\/dsh-model-hub/, `${what}: the leftover line is shown`);
    assert.match(r.stderr, /by hand/, `${what}: the user is told to edit by hand`);
  }
});

test('upgrade block: a one-line insert before the entry no longer swallows the entry header', () => {
  const r = runEdit(`- insert:\n    - id: a\n${ENTRY}`);
  assert.equal(r.file, '- insert:\n    - id: a\n');
  assert.ok(!r.stderr.includes('by hand'), r.stderr);
});

test('upgrade block: a patch file that was already migrated is untouched and quiet', () => {
  const done = runEdit(OTHER);
  assert.equal(done.file, OTHER);
  assert.equal(done.stderr, '');
  const empty = runEdit('[]\n');
  assert.equal(empty.file, '[]\n');
  assert.equal(empty.stderr, '');
});

test('upgrade block: the patch file must still compose before the old package is removed', () => {
  const b = upgradeBlock()[1];
  const compose = b.findIndex((l) => l.startsWith('dsh --profile web --dump-config'));
  const remove = b.findIndex((l) => l.startsWith('dsh plugin --profile web remove -w @local/dsh-model-hub'));
  const add = b.findIndex((l) => l.startsWith('dsh plugin --profile web add -w dsh-model-hub'));
  assert.ok(compose === 0 && remove > compose && add > remove, `order: compose ${compose}, remove ${remove}, add ${add}`);
});

test('install section says what CI installs: the packed tarball, never the registry name', () => {
  const install = readme.split(/^## Install$/m)[1].split(/^### Upgrading/m)[0];
  assert.match(install, /packed tarball/);
  assert.ok(!/CI installs the plugin exactly as below/.test(install));
});
