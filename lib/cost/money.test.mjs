import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fmtUsdSmall } from './money.mjs';

const CASES = [[0, '$0.00'], [Number.NaN, '$0.00'], [undefined, '$0.00'], [-0.5, '$0.00'], [0.00003, '<$0.0001'], [0.0001, '$0.0001'], [0.1265, '$0.1265'], [0.99994, '$0.9999'], [1, '$1.00'], [1.5, '$1.50'], [123.456, '$123.46']];

test('fmtUsdSmall: exact zero is $0.00, a real charge never prints as zero, 4 decimals under $1, 2 from $1', () => {
  for (const [n, s] of CASES) assert.equal(fmtUsdSmall(n), s, String(n));
});

test('the client keeps a copy of fmtUsdSmall (it cannot import modules) that agrees on every case', () => {
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const m = /const fmtUsdSmall = (\(n\) => [^\n]+);\n/.exec(src);
  assert.ok(m, 'client.js defines fmtUsdSmall on one line');
  const fn = new Function(`return ${m[1]}`)();
  for (const [n, s] of CASES) assert.equal(fn(n), s, String(n));
});
