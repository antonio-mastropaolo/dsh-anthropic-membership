import test from 'node:test';
import assert from 'node:assert/strict';
import { createCacheTracker } from './cache-check.mjs';

const step = (t, over = {}) => t.observe({ sessionId: 's', provider: 'google', model: 'm', fingerprints: { system: 'S1', tools: 'T1' }, ...over });
const hit = (read, input) => ({ input, output: 10, cacheRead: read, cacheWrite: 0 });

test('hitRatio = cacheRead / billed prompt; OpenAI-style usage normalized', () => {
  const t = createCacheTracker();
  assert.equal(step(t, { usage: hit(900, 100) }).hitRatio, 0.9);
  assert.equal(step(t, { sessionId: 'o', usage: { prompt_tokens: 1000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 250 } } }).hitRatio, 0.25);
  assert.equal(step(t, { sessionId: 'z', usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0 } }).hitRatio, 0);
});
test('no alert on the first step or while warm', () => {
  const t = createCacheTracker();
  assert.equal(step(t, { usage: hit(0, 5000) }).alert, undefined);
  assert.equal(step(t, { usage: hit(4500, 500) }).alert, undefined);
  assert.equal(step(t, { usage: hit(4600, 500) }).alert, undefined);
});
test('alert reasons: system-prompt-changed / tools-changed / model-changed / compaction / unknown', () => {
  const cases = [
    ['system-prompt-changed', { fingerprints: { system: 'S2', tools: 'T1' } }, 5000],
    ['tools-changed', { fingerprints: { system: 'S1', tools: 'T2' } }, 5000],
    ['model-changed', { model: 'other' }, 5000],
    ['compaction', {}, 1500 + 600], // prompt 2100 < 0.6 * 5000
    ['unknown', {}, 5000],
  ];
  for (const [reason, over, newPrompt] of cases) {
    const t = createCacheTracker();
    step(t, { usage: hit(4500, 500) });
    const r = step(t, { ...over, usage: hit(0, newPrompt) });
    assert.equal(r.alert?.reason, reason, reason);
    assert.equal(r.alert.prevHit, 0.9); assert.equal(r.alert.hit, 0);
  }
});
test('thresholds: prev hit < 0.5, current >= 0.05 or prompt < 2000 => no alert', () => {
  let t = createCacheTracker(); step(t, { usage: hit(400, 600) }); assert.equal(step(t, { usage: hit(0, 5000) }).alert, undefined);
  t = createCacheTracker(); step(t, { usage: hit(4500, 500) }); assert.equal(step(t, { usage: hit(300, 4700) }).alert, undefined); // 6%
  t = createCacheTracker(); step(t, { usage: hit(4500, 500) }); assert.equal(step(t, { usage: hit(0, 1999) }).alert, undefined);
  t = createCacheTracker(); step(t, { usage: hit(4500, 500) }); assert.ok(step(t, { usage: hit(0, 2000) }).alert);
});
test('sessions are isolated; stats aggregate; forget clears', () => {
  const t = createCacheTracker();
  step(t, { usage: hit(900, 100) }); step(t, { usage: hit(0, 1000) });
  step(t, { sessionId: 'b', usage: hit(500, 500) });
  const s = t.stats('s');
  assert.equal(s.steps, 2); assert.equal(s.lastHit, 0); assert.equal(s.avgHit, 0.45); assert.equal(s.cacheReadTokens, 900); assert.equal(s.promptTokens, 2000);
  assert.equal(s.alerts, 0); assert.equal(t.stats('b').avgHit, 0.5); assert.equal(t.stats('nope'), null);
  t.forget('b'); assert.equal(t.stats('b'), null);
});
test('alert counted in stats and not repeated while the cache stays cold', () => {
  const t = createCacheTracker();
  step(t, { usage: hit(4500, 500) }); assert.ok(step(t, { usage: hit(0, 5000) }).alert);
  assert.equal(step(t, { usage: hit(0, 5000) }).alert, undefined);
  assert.equal(t.stats('s').alerts, 1); assert.equal(t.stats('s').lastAlert.reason, 'unknown');
});
test('LRU bound on sessions', () => {
  const t = createCacheTracker({ maxSessions: 3 });
  for (const id of ['a', 'b', 'c', 'd']) t.observe({ sessionId: id, usage: hit(1, 1) });
  assert.deepEqual(t.sessionIds(), ['b', 'c', 'd']);
});
