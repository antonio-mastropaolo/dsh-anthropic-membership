import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wf = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
const lines = wf.split('\n');
const jobs = (() => {
  const out = {}; let cur = null; let inJobs = false;
  for (const l of lines) {
    if (/^jobs:\s*$/.test(l)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const m = /^  ([a-z][a-z0-9-]*):\s*$/.exec(l);
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(l);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]));
})();
const REPO_IF = "if: github.repository == 'antonio-mastropaolo/dsh-model-hub' && github.event_name == 'push'";

test('runs only on a version-tag push: no pull_request, no pull_request_target, no manual or schedule trigger', () => {
  const head = wf.slice(0, wf.indexOf('\njobs:'));
  assert.match(head, /^on:\n  push:\n    tags:\n      - 'v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\n/m);
  assert.ok(!/pull_request|workflow_dispatch|schedule|workflow_run|branches:/.test(head));
});

test('default token is empty and each job declares its own least privilege', () => {
  assert.match(wf, /^permissions: \{\}$/m);
  assert.deepEqual(Object.keys(jobs), ['verify', 'publish', 'release']);
  for (const [n, body] of Object.entries(jobs)) {
    assert.ok(body.includes(REPO_IF), `${n}: fork guard`);
    assert.match(body, /\n    permissions:\n(      [a-z-]+: (read|write)\n)+/, `${n}: permissions block`);
  }
  assert.match(jobs.verify, /permissions:\n      contents: read\n/);
  assert.match(jobs.publish, /permissions:\n      contents: read\n      id-token: write\n/);
  assert.match(jobs.release, /permissions:\n      contents: write\n/);
  assert.equal((wf.match(/id-token: write/g) || []).length, 1);
  assert.equal((wf.match(/contents: write/g) || []).length, 1);
});

test('the npm token exists in exactly one place: the publish step env, behind the environment gate', () => {
  assert.equal((wf.match(/secrets\./g) || []).length, 1);
  assert.match(jobs.publish, /environment: npm-release/);
  assert.match(jobs.publish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.ok(!/secrets\./.test(jobs.verify + jobs.release));
  assert.ok(!/set -x|toJSON\(|printenv|\benv\b\s*$|echo .*TOKEN|ACTIONS_STEP_DEBUG/m.test(wf));
});

test('job order and the publish command', () => {
  assert.match(jobs.publish, /needs: verify/);
  assert.match(jobs.release, /needs: publish/);
  assert.match(jobs.publish, /npm publish "\$TARBALL" --provenance --access public/);
});

test('the tarball path starts with ./ so npm reads it as a file, not GitHub shorthand', () => {
  // `npm publish pack/x.tgz` is parsed as the GitHub repo pack/x.tgz and fails with a git error
  // (release run 43561502543); `./pack/x.tgz` is a local file.
  assert.match(jobs.publish, /TARBALL=\$\(ls \.\/pack\/\*\.tgz\)/);
});

test('every action is pinned to a full commit SHA with a version comment; checkouts keep no credentials', () => {
  const uses = lines.filter((l) => /^\s+- uses:|^\s+uses:/.test(l));
  assert.ok(uses.length >= 5);
  for (const u of uses) assert.match(u, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, u);
  const checkouts = wf.split('actions/checkout@').slice(1);
  for (const c of checkouts) assert.match(c.slice(0, 400), /persist-credentials: false/);
});

test('no expression is interpolated into a run script (untrusted-input injection)', () => {
  let inRun = false; let indent = 0;
  for (const l of lines) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(l);
    if (m) { indent = m[1].length; inRun = m[2] === '|' || m[2] === '>' || m[2] === ''; if (!inRun) assert.ok(!m[2].includes('${{'), l); continue; }
    if (inRun) {
      const lead = /^(\s*)/.exec(l)[1].length;
      if (l.trim() !== '' && lead <= indent) { inRun = false; continue; }
      assert.ok(!l.includes('${{'), `expression in run block: ${l}`);
    }
  }
});
