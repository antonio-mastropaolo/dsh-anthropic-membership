// The installable-package contract: what `dsh plugin add dsh-model-hub` and `npm publish` will see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('package.json is publishable under the unscoped name', () => {
  assert.equal(pkg.name, 'dsh-model-hub');
  assert.equal(pkg.version, '3.0.0');
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.author, 'Antonio Mastropaolo');
  assert.equal(pkg.repository.url, 'git+https://github.com/antonio-mastropaolo/dsh-model-hub.git');
  assert.equal(pkg.homepage, 'https://github.com/antonio-mastropaolo/dsh-model-hub#readme');
  assert.equal(pkg.bugs.url, 'https://github.com/antonio-mastropaolo/dsh-model-hub/issues');
  assert.ok(pkg.description.length > 40 && !/kimi|rocco/i.test(pkg.description));
  for (const k of ['dsh-plugin', 'deepseek-harness', 'spend-caps', 'cost-tracking']) assert.ok(pkg.keywords.includes(k), k);
  assert.equal(pkg.engines.node, '>=22.12');
  assert.equal(pkg.engines.dsh, '>=0.2.2-rc.1 <0.3.0-0');
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true });
});

test('zero dependencies and no install-time scripts', () => {
  for (const f of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(pkg[f], undefined, f);
  for (const s of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack', 'postpack']) assert.equal(pkg.scripts?.[s], undefined, s);
});

test('dsh.bundle and dsh.client are declared together and the patch enables exactly this package', () => {
  assert.equal(pkg.dsh.manifestVersion, 1);
  assert.deepEqual(pkg.dsh.bundle, { patch: './cordis.patch.yml' });
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-models'));
  // exact text: `dsh plugin add` composes this file as a bundle layer; the row id stays `model-hub` so a leftover v2 entry collides visibly
  assert.equal(read('cordis.patch.yml'), `- insert:\n    - id: model-hub\n      name: ${pkg.name}\n`);
});

test('main, bin, exports, icon and locale all point at files that exist', () => {
  const targets = [pkg.main, pkg.bin['dsh-hub'], pkg.icon, ...Object.values(pkg.exports).filter((t) => !t.includes('*'))];
  for (const t of targets) assert.ok(existsSync(path.join(root, t)), t);
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
  assert.equal(pkg.exports['./package.json'], './package.json');
  const en = JSON.parse(read('locale/en.json'));
  assert.ok(typeof en.meta.title === 'string' && en.meta.title.trim());
  assert.ok(typeof en.meta.description === 'string' && en.meta.description.trim().length > 40);
  assert.ok(statSync(path.join(root, 'bin/dsh-hub.mjs')).mode & 0o111, 'bin is executable');
});

test('icon.svg is a small static SVG (DSH limit 256 KiB; no script, no external reference)', () => {
  const svg = read('icon.svg');
  assert.ok(svg.startsWith('<svg') && svg.includes('viewBox'));
  assert.ok(Buffer.byteLength(svg) < 4096);
  assert.ok(!/<script|href=|xlink:|javascript:|<image|@import|url\(\s*['"]?https?:/i.test(svg));
});

function packList() {
  const t = mkdtempSync(path.join(tmpdir(), 'mh-pack-'));
  writeFileSync(path.join(t, 'user.npmrc'), '');
  writeFileSync(path.join(t, 'global.npmrc'), ''); // never read the developer's ~/.npmrc (tokens)
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: t, npm_config_userconfig: path.join(t, 'user.npmrc'), npm_config_globalconfig: path.join(t, 'global.npmrc'),
      npm_config_cache: path.join(t, 'cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  return JSON.parse(out)[0].files.map((f) => f.path).sort();
}

const REQUIRED = ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'package.json', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'bin/dsh-hub.mjs', 'lib/index.js', 'lib/client.js'];
const ALLOWED = [/^(LICENSE|README\.md|THIRD_PARTY_NOTICES\.md|CHANGELOG\.md|package\.json|cordis\.patch\.yml|icon\.svg)$/, /^locale\/[a-z-]+\.json$/, /^bin\/dsh-hub\.mjs$/, /^lib\/.+\.(mjs|js)$/];
const FORBIDDEN = [/^docs\//, /^macos\//, /^\.github\//, /\.test\.mjs$/, /^SKILL\.md$/, /(^|\/)\.DS_Store$/, /(^|\/)\.env/, /\.bak$/, /\.log$/];

test('npm pack ships exactly the whitelist: no docs, macos, SKILL.md or tests', () => {
  const files = packList();
  for (const r of REQUIRED) assert.ok(files.includes(r), `missing ${r}`);
  for (const f of files) {
    assert.ok(ALLOWED.some((re) => re.test(f)), `unexpected file in the tarball: ${f}`);
    assert.ok(!FORBIDDEN.some((re) => re.test(f)), `forbidden file in the tarball: ${f}`);
  }
});

test('every relative import of a shipped file is shipped, and no shipped file names a developer path', () => {
  const files = new Set(packList());
  const missing = [];
  for (const f of files) {
    if (!/\.(mjs|js)$/.test(f)) continue;
    const text = read(f);
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (!files.has(target)) missing.push(`${f} -> ${target}`);
    }
  }
  assert.deepEqual(missing, []);
  for (const f of files) assert.ok(!/\/Users\/|\/home\/[a-z]|amastro/.test(read(f)), `developer path in ${f}`);
});
