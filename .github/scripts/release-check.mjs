#!/usr/bin/env node
// Release gate helpers: the tag must equal package.json's version, and the CHANGELOG must hold a dated section for it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function versionFromTag(tag) {
  if (typeof tag !== 'string' || !TAG.test(tag)) throw new Error(`${JSON.stringify(tag)} is not a release tag (expected vMAJOR.MINOR.PATCH)`);
  return tag.slice(1);
}

export function checkTag(tag, pkg) {
  const version = versionFromTag(tag);
  if (pkg.version !== version) throw new Error(`tag ${tag} does not match package.json version ${pkg.version}`);
  if (pkg.private === true) throw new Error('package.json is private: nothing to publish');
  return version;
}

export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const head = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](?: - (.*))?$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  const date = head.exec(lines[start])[1] ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`CHANGELOG.md section [${version}] has no release date (found "${date || 'none'}"): replace "Unreleased" with YYYY-MM-DD`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md section [${version}] is empty`);
  return `${body}\n`;
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

export function main(argv) {
  const [cmd, tag, ...rest] = argv;
  try {
    if (cmd !== 'tag' && cmd !== 'notes') { process.stderr.write('usage: release-check.mjs tag|notes <vX.Y.Z> [--package package.json] [--changelog CHANGELOG.md]\n'); return 2; }
    const pkg = JSON.parse(readFileSync(option(rest, '--package', 'package.json'), 'utf8'));
    const version = checkTag(tag, pkg);
    if (cmd === 'tag') { process.stdout.write(`${version}\n`); return 0; }
    process.stdout.write(changelogSection(readFileSync(option(rest, '--changelog', 'CHANGELOG.md'), 'utf8'), version));
    return 0;
  } catch (e) {
    process.stderr.write(`release-check: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
