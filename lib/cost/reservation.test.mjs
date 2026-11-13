import test from "node:test";
import assert from "node:assert/strict";
import { estimateRequest, createReservations, approxChars, approxPromptTokens, OUTPUT_CEILING_TOKENS, RESERVATION_IDLE_MS, RESERVATION_MAX_AGE_MS } from "./reservation.mjs";
import { costOf } from "./cost.mjs";

const PRICE = { inPerM: 1, outPerM: 4, cacheReadPerM: 0.1, cacheWritePerM: 1.25, source: "litellm", billing: "metered" };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("constants: ceiling 32000 tokens, idle 10 min, max age 2 h", () => {
  assert.equal(OUTPUT_CEILING_TOKENS, 32000);
  assert.equal(RESERVATION_IDLE_MS, 600_000);
  assert.equal(RESERVATION_MAX_AGE_MS, 7_200_000);
});

test("estimate: maxTokens and chars/4 prompt, priced as the worse of all-input and all-cache-write", () => {
  const e = estimateRequest({ maxTokens: 1000, messages: [{ role: "user", content: "x".repeat(4000) }] }, PRICE);
  // the key names and the role string add a few characters on top of the 4000
  assert.equal(e.basis, "request-size");
  assert.equal(e.outputTokens, 1000);
  assert.ok(e.promptTokens >= 1000 && e.promptTokens <= 1010, String(e.promptTokens));
  const expected = Math.max(costOf({ input: e.promptTokens, output: 1000 }, PRICE).usd, costOf({ cacheWrite: e.promptTokens, output: 1000 }, PRICE).usd);
  near(e.usd, expected);
  near(e.usd, (e.promptTokens * 1.25 + 1000 * 4) / 1e6);
});

test("estimate: a bare string prompt of 4000 chars is exactly 1000 tokens and $0.00525 at 1.25/4", () => {
  const e = estimateRequest({ maxTokens: 1000, system: "x".repeat(4000) }, PRICE);
  assert.equal(e.promptTokens, 1000);
  near(e.usd, 0.00525);
});

test("estimate: maxTokens unset, 0, NaN, negative or a string -> the 32000-token ceiling", () => {
  for (const maxTokens of [undefined, 0, NaN, -5, "9", Infinity, null]) {
    assert.equal(estimateRequest({ maxTokens, messages: [] }, PRICE).outputTokens, OUTPUT_CEILING_TOKENS, String(maxTokens));
  }
  assert.equal(estimateRequest(undefined, PRICE).outputTokens, OUTPUT_CEILING_TOKENS);
});

test("estimate: a known previous prompt size wins over the request size", () => {
  const e = estimateRequest({ maxTokens: 10, messages: [{ role: "user", content: "hi" }] }, PRICE, { previousPromptTokens: 50000 });
  assert.equal(e.basis, "previous-prompt");
  assert.equal(e.promptTokens, 50000);
  near(e.usd, (50000 * 1.25 + 10 * 4) / 1e6);
  for (const bad of [0, -1, NaN, null, "5"]) assert.equal(estimateRequest({ maxTokens: 10, messages: [] }, PRICE, { previousPromptTokens: bad }).basis, "request-size");
});

test("estimate: above-200k prompt uses the high tier, exactly as costOf bills it", () => {
  const price = { ...PRICE, above200k: { inPerM: 2, outPerM: 8, cacheReadPerM: 0.2, cacheWritePerM: 2.5 } };
  const e = estimateRequest({ maxTokens: 1000, messages: [] }, price, { previousPromptTokens: 250000 });
  near(e.usd, costOf({ cacheWrite: 250000, output: 1000 }, price).usd);
  assert.ok(e.usd > estimateRequest({ maxTokens: 1000, messages: [] }, { ...price, above200k: null }, { previousPromptTokens: 250000 }).usd);
  const low = estimateRequest({ maxTokens: 1000, messages: [] }, price, { previousPromptTokens: 100000 });
  near(low.usd, costOf({ cacheWrite: 100000, output: 1000 }, price).usd);
});

test("estimate: a cheaper cache-write than input rate still reserves the all-input price", () => {
  const p = { ...PRICE, cacheWritePerM: 0.5 };
  const e = estimateRequest({ maxTokens: 100, messages: [] }, p, { previousPromptTokens: 1_000_000 });
  near(e.usd, (1_000_000 * 1 + 100 * 4) / 1e6);
});

test("estimate: system, messages and tool schemas are all counted; an image block is 1500 tokens, not its base64 length", () => {
  const base = approxPromptTokens({});
  assert.equal(base, 0);
  const sys = approxPromptTokens({ system: "s".repeat(400) });
  const msg = approxPromptTokens({ messages: [{ role: "user", content: "m".repeat(400) }] });
  const tools = approxPromptTokens({ tools: [{ name: "t", description: "d".repeat(400), schema: { type: "object" } }] });
  assert.ok(sys >= 100 && msg >= 100 && tools >= 100);
  assert.equal(approxPromptTokens({ messages: [{ type: "image", data: "A".repeat(2_000_000) }] }), 1500);
  const img = approxPromptTokens({ messages: [{ role: "user", content: [{ type: "image", data: "A".repeat(2_000_000) }] }] });
  assert.ok(img >= 1500 && img < 1510, String(img)); // the block, plus a few characters of role/content keys
  assert.equal(approxChars({ type: "image", source: "x".repeat(10) }), 6000);
});

test("estimate: hostile shapes never throw", () => {
  const deep = {}; let cur = deep; for (let i = 0; i < 50; i++) { cur.n = {}; cur = cur.n; }
  const shapes = [null, undefined, 1, "s", [], {}, { messages: null }, { messages: 5 }, { messages: [null, 1, "x", [[[]]], { content: 7 }] }, { tools: { a: { b: { c: [1, 2, { d: null }] } } } }, { system: deep }, { messages: deep }, { maxTokens: {} }, Object.create(null), { messages: [Symbol("x")] }, { messages: [() => 1] }, { messages: [10n] }];
  for (const s of shapes) {
    const e = estimateRequest(s, PRICE);
    assert.ok(Number.isFinite(e.usd) && e.usd >= 0, JSON.stringify(Object.keys(s ?? {})));
    assert.ok(Number.isInteger(e.promptTokens) && Number.isInteger(e.outputTokens));
  }
  assert.equal(estimateRequest({ messages: [] }, null).usd, 0);
  assert.equal(estimateRequest({ messages: [] }, undefined).usd, 0);
});

test("estimate: a cyclic structure is cut by the depth bound", () => {
  const a = { x: 1 }; a.self = a;
  assert.doesNotThrow(() => estimateRequest({ messages: [a] }, PRICE));
});

test("store: reserve/totals shape (null-prototype objects keyed by provider and raw session id)", () => {
  const r = createReservations({ now: () => 0 });
  const a = r.reserve({ provider: "google", sessionId: "s1", usd: 0.5 });
  const b = r.reserve({ provider: "google", sessionId: "s2", usd: 0.25 });
  const c = r.reserve({ provider: "openai", sessionId: "s1", usd: 1 });
  assert.ok(a && b && c && a !== b);
  const t = r.totals();
  near(t.usd, 1.75);
  assert.equal(t.count, 3);
  near(t.byProvider.google, 0.75); near(t.byProvider.openai, 1);
  near(t.bySession.s1, 1.5); near(t.bySession.s2, 0.25);
  assert.equal(Object.getPrototypeOf(t.byProvider), null);
  assert.equal(Object.getPrototypeOf(t.bySession), null);
  assert.equal(t.byProvider.__proto__, undefined);
});

test("store: a hostile provider or session id such as __proto__ is just a key", () => {
  const r = createReservations({ now: () => 0 });
  r.reserve({ provider: "__proto__", sessionId: "constructor", usd: 1 });
  const t = r.totals();
  assert.equal(t.byProvider["__proto__"], 1);
  assert.equal(t.bySession.constructor, 1);
  assert.equal(({}).polluted, undefined);
});

test("store: release is exactly once; null/unknown tokens are false", () => {
  const r = createReservations({ now: () => 0 });
  const k = r.reserve({ provider: "p", sessionId: "s", usd: 1 });
  assert.equal(r.release(k), true);
  assert.equal(r.release(k), false);
  assert.equal(r.release(null), false);
  assert.equal(r.release(undefined), false);
  assert.equal(r.release(9999), false);
  assert.equal(r.totals().count, 0);
  assert.deepEqual(r.stats(), { reserved: 1, released: 1, expired: 0, active: 0 });
});

test("store: idle expiry with a fake clock; touch extends the deadline", () => {
  let t = 1000;
  const r = createReservations({ now: () => t, idleMs: 100, maxAgeMs: 100000 });
  const a = r.reserve({ provider: "p", sessionId: "s", usd: 1 });
  const b = r.reserve({ provider: "p", sessionId: "s", usd: 2 });
  t += 90; r.touch(b);
  t += 50; // a idle 140 > 100, b idle 50
  near(r.totals().usd, 2);
  assert.equal(r.stats().expired, 1);
  assert.equal(r.release(a), false, "an expired reservation cannot be released again");
  t += 101;
  assert.equal(r.totals().count, 0);
  assert.deepEqual(r.stats(), { reserved: 2, released: 0, expired: 2, active: 0 });
});

test("store: an entry touched forever is dropped at maxAgeMs", () => {
  let t = 0;
  const r = createReservations({ now: () => t, idleMs: 100, maxAgeMs: 1000 });
  const k = r.reserve({ provider: "p", sessionId: "s", usd: 1 });
  for (let i = 0; i < 11; i++) { t += 90; r.touch(k); assert.equal(r.totals().count, 1, `at ${t}`); } // 990 ms old, always freshly touched
  t += 20;
  assert.equal(r.totals().count, 0);
  assert.equal(r.stats().expired, 1);
});

test("store: touching a missing token is a no-op; defaults are the module constants", () => {
  const r = createReservations();
  assert.doesNotThrow(() => { r.touch(5); r.touch(null); });
  const k = r.reserve({ provider: "p", sessionId: "s", usd: 1 });
  assert.equal(r.totals().count, 1);
  r.release(k);
});

test("store: reserved === released + expired + active under a random walk", () => {
  let t = 0;
  const r = createReservations({ now: () => t, idleMs: 50, maxAgeMs: 400 });
  const live = [];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const x = rnd();
    if (x < 0.3) live.push(r.reserve({ provider: "p" + (i % 3), sessionId: "s" + (i % 5), usd: rnd() }));
    else if (x < 0.5 && live.length) r.release(live[Math.floor(rnd() * live.length)]);
    else if (x < 0.7 && live.length) r.touch(live[Math.floor(rnd() * live.length)]);
    else t += Math.floor(rnd() * 40);
    const s = r.stats();
    assert.equal(s.reserved, s.released + s.expired + s.active, `step ${i}`);
    assert.equal(r.totals().count, r.stats().active);
  }
});
