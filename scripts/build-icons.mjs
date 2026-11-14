#!/usr/bin/env node
// scripts/build-icons.mjs — dev-time generator for the picker's logos and billing glyphs. Not shipped (see package.json "files").
//
//   mkdir <fresh-dir-a> <fresh-dir-b>
//   (cd <fresh-dir-a> && npm pack @lobehub/icons-static-svg@1.102.0 && tar -xzf *.tgz)    # LobeHub Icons, MIT
//   (cd <fresh-dir-b> && npm pack @phosphor-icons/core@2.1.1 && tar -xzf *.tgz)           # Phosphor Icons, MIT
//   node scripts/build-icons.mjs <fresh-dir-a>/package <fresh-dir-b>/package
//
// Every SVG is checked, then converted to plain data ({ viewBox, paths:[{ d, fill, fr?, op? }], defs?: linear gradients }).
// The result is written to lib/icons-data.mjs and copied between the "icons-data" markers of lib/client.js, which is one
// self-contained file (a test keeps the two identical). The client renders React elements from the data: there is no
// runtime network access and no innerHTML.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOBE_VERSION = '1.102.0';
export const PHOSPHOR_VERSION = '2.1.1';
/** family key -> LobeHub file (without .svg) */
export const FAMILY_FILES = {
  claude: 'claude-color', qwen: 'qwen-color', glm: 'chatglm-color', kimi: 'kimi-color', openai: 'openai',
  gemini: 'gemini-color', gemma: 'gemma-color', grok: 'grok', llama: 'meta-color', mistral: 'mistral-color',
};
/** billing kind -> Phosphor fill glyph */
export const GLYPH_FILES = {
  plan: 'ticket-fill', metered: 'coins-fill', unpriced: 'question-fill', free: 'gift-fill', gpu: 'hard-drives-fill', mac: 'laptop-fill',
};

const TAGS = new Set(['svg', 'title', 'defs', 'linearGradient', 'stop', 'path']);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Throws on anything an icon must never contain. */
export function assertSafe(name, text) {
  if (/<\s*script/i.test(text)) throw new Error(`${name}: contains <script`);
  if (/\son[a-z]+\s*=/i.test(text)) throw new Error(`${name}: contains an on…= attribute`);
  if (/javascript\s*:/i.test(text)) throw new Error(`${name}: contains javascript:`);
  if (/<\s*(style|use|image|foreignObject|a|iframe|object|embed)\b/i.test(text)) throw new Error(`${name}: contains a forbidden element`);
  if (/\b(xlink:)?href\s*=/i.test(text)) throw new Error(`${name}: contains an href`);
}

const attrs = (s) => { const o = {}; for (const m of s.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2]; return o; };
const clean = (v) => String(v).trim();
const ok = (v, re) => re.test(v);
const NUM = /^-?(\d+(\.\d+)?|\.\d+)%?$/;
const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;

/** One SVG text -> { viewBox, paths, defs? }. Only svg, title, defs, linearGradient, stop and path are understood. */
export function convertSvg(name, text) {
  assertSafe(name, text);
  const svgAttrs = attrs((/<svg\b([^>]*)>/.exec(text) || [])[1] || '');
  if (!svgAttrs.viewBox || !ok(svgAttrs.viewBox, /^[\d.\s-]+$/)) throw new Error(`${name}: no usable viewBox`);
  const rootFill = svgAttrs.fill || null;
  const rootRule = svgAttrs['fill-rule'] || null;
  const body = text.replace(/<title>[\s\S]*?<\/title>/g, '');
  const defs = [];
  // gradients may be defined after the paths that use them: number them in a first pass
  const idMap = new Map();
  for (const m of body.matchAll(/<linearGradient\b([^>]*)>/g)) { const gid = attrs(m[1]).id; if (gid && !idMap.has(gid)) idMap.set(gid, `g${idMap.size}`); }
  const paths = [];
  let grad = null;
  for (const m of body.matchAll(/<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g)) {
    const [, close, tag, rest] = m;
    if (!TAGS.has(tag)) throw new Error(`${name}: unsupported element <${tag}>`);
    if (close) { if (tag === 'linearGradient') grad = null; continue; }
    const a = attrs(rest);
    if (tag === 'linearGradient') {
      const id = idMap.get(a.id);
      if (!id) throw new Error(`${name}: gradient without an id`);
      grad = { id, x1: clean(a.x1 ?? '0%'), y1: clean(a.y1 ?? '0%'), x2: clean(a.x2 ?? '100%'), y2: clean(a.y2 ?? '0%'), stops: [] };
      for (const k of ['x1', 'y1', 'x2', 'y2']) if (!ok(grad[k], NUM)) throw new Error(`${name}: bad gradient ${k}`);
      if (a.gradientUnits) { if (a.gradientUnits !== 'userSpaceOnUse' && a.gradientUnits !== 'objectBoundingBox') throw new Error(`${name}: bad gradientUnits`); grad.units = a.gradientUnits; }
      if (a.gradientTransform || a.spreadMethod) throw new Error(`${name}: gradientTransform / spreadMethod are not supported`);
      defs.push(grad);
    } else if (tag === 'stop') {
      if (!grad) throw new Error(`${name}: <stop> outside a gradient`);
      const c = clean(a['stop-color'] ?? '#000');
      if (!ok(c, COLOR) || !ok(clean(a.offset ?? '0'), NUM)) throw new Error(`${name}: bad stop`);
      const s = { o: clean(a.offset ?? '0'), c };
      if (a['stop-opacity'] !== undefined) { if (!ok(clean(a['stop-opacity']), NUM)) throw new Error(`${name}: bad stop-opacity`); s.a = clean(a['stop-opacity']); }
      grad.stops.push(s);
    } else if (tag === 'path') {
      if (!a.d || !ok(a.d, /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/)) throw new Error(`${name}: bad path data`);
      let fill = a.fill ?? rootFill ?? 'currentColor';
      const ref = /^url\(#([^)]+)\)$/.exec(fill);
      if (ref) { if (!idMap.has(ref[1])) throw new Error(`${name}: fill refers to an unknown gradient`); fill = `url(#${idMap.get(ref[1])})`; } else if (!ok(fill, COLOR) && fill !== 'currentColor') throw new Error(`${name}: bad fill`);
      const p = { d: a.d.trim(), fill };
      const fr = a['fill-rule'] ?? rootRule;
      if (fr === 'evenodd') p.fr = 'evenodd';
      if (a.opacity !== undefined) { if (!ok(clean(a.opacity), NUM)) throw new Error(`${name}: bad opacity`); p.op = Number(a.opacity); }
      paths.push(p);
    }
  }
  if (!paths.length) throw new Error(`${name}: no paths`);
  return { viewBox: svgAttrs.viewBox.trim(), paths, ...(defs.length ? { defs } : {}) };
}

const readPkgVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

export function build(lobeDir, phosphorDir) {
  if (readPkgVersion(lobeDir) !== LOBE_VERSION) throw new Error(`LobeHub package must be ${LOBE_VERSION}`);
  if (readPkgVersion(phosphorDir) !== PHOSPHOR_VERSION) throw new Error(`Phosphor package must be ${PHOSPHOR_VERSION}`);
  const FAMILY_LOGOS = {};
  for (const [k, f] of Object.entries(FAMILY_FILES)) FAMILY_LOGOS[k] = convertSvg(f, fs.readFileSync(path.join(lobeDir, 'icons', `${f}.svg`), 'utf8'));
  const GLYPHS = {};
  for (const [k, f] of Object.entries(GLYPH_FILES)) GLYPHS[k] = convertSvg(f, fs.readFileSync(path.join(phosphorDir, 'assets', 'fill', `${f}.svg`), 'utf8'));
  return { FAMILY_LOGOS, GLYPHS };
}

export const BEGIN = '// <icons-data:begin> generated by scripts/build-icons.mjs from lib/icons-data.mjs (do not edit by hand)';
export const END = '// <icons-data:end>';
/** The block of lib/client.js that mirrors lib/icons-data.mjs. */
export const clientBlock = ({ FAMILY_LOGOS, GLYPHS }, indent = '    ') =>
  `${indent}${BEGIN}\n${indent}// Family logos: @lobehub/icons-static-svg@${LOBE_VERSION} (MIT). Billing glyphs: @phosphor-icons/core@${PHOSPHOR_VERSION} fill weight (MIT).\n`
  + `${indent}const FAMILY_LOGOS = ${JSON.stringify(FAMILY_LOGOS)};\n${indent}const GLYPHS = ${JSON.stringify(GLYPHS)};\n${indent}${END}`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [lobeDir, phosphorDir] = process.argv.slice(2);
  if (!lobeDir || !phosphorDir) { console.error('usage: node scripts/build-icons.mjs <lobehub package dir> <phosphor package dir>'); process.exit(2); }
  const data = build(path.resolve(lobeDir), path.resolve(phosphorDir));
  const mod = path.join(HERE, '..', 'lib', 'icons-data.mjs');
  fs.writeFileSync(mod, `// lib/icons-data.mjs — GENERATED by scripts/build-icons.mjs; do not edit by hand.\n// Family logos: @lobehub/icons-static-svg@${LOBE_VERSION} (MIT). Billing glyphs: @phosphor-icons/core@${PHOSPHOR_VERSION}, fill weight (MIT).\n// lib/client.js carries a copy of this data between its "icons-data" markers (a test keeps them identical).\n`
    + `export const FAMILY_LOGOS = ${JSON.stringify(data.FAMILY_LOGOS)};\nexport const GLYPHS = ${JSON.stringify(data.GLYPHS)};\n`);
  const cl = path.join(HERE, '..', 'lib', 'client.js');
  let src = fs.readFileSync(cl, 'utf8');
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < 0) { console.error('lib/client.js has no icons-data markers; add them first'); process.exit(1); }
  const lineStart = src.lastIndexOf('\n', a) + 1;
  src = src.slice(0, lineStart) + clientBlock(data) + src.slice(b + END.length);
  fs.writeFileSync(cl, src);
  console.log('wrote lib/icons-data.mjs and updated lib/client.js:', Object.keys(data.FAMILY_LOGOS).length, 'logos,', Object.keys(data.GLYPHS).length, 'glyphs');
}
