import test from "node:test";
import assert from "node:assert/strict";
import { createRoccoClient, parseGpus } from "./rocco.mjs";

const reply = (status, body, text) => async () => ({ status, json: async () => { if (text) throw new Error("bad"); return body; } });

test("parseGpus", () => {
  assert.equal(parseGpus(undefined), undefined);
  assert.deepEqual(parseGpus([3, 2]), [2, 3]);
  for (const bad of [[], [4], [1, 1], ["1"], "2", [0, 1, 2, 3, 0]]) assert.throws(() => parseGpus(bad), (e) => e.status === 400);
});

test("client: pass-through status/body, models mapping, non-JSON and network errors become 502", async () => {
  const seen = [];
  const f = async (url, init) => { seen.push([init.method, url, init.body]); return reply(202, { status: "switching", gpus: [2] })(); };
  const c = createRoccoClient({ base: "http://shim", fetchImpl: f });
  const r = await c.switch("rocco-qwen38-q4", [2]);
  assert.deepEqual(r, { status: 202, body: { status: "switching", gpus: [2] } });
  assert.deepEqual(seen[0], ["POST", "http://shim/v1/switch", JSON.stringify({ model: "rocco-qwen38-q4", gpus: [2] })]);
  await c.switch("m");
  assert.equal(seen[1][2], JSON.stringify({ model: "m" }));
  const m = await createRoccoClient({ base: "http://s", fetchImpl: reply(200, { data: [{ id: "a", loaded: true, owned_by: "rocco", extra: "x" }] }) }).models();
  assert.deepEqual(m.body, { models: [{ id: "a", loaded: true, owner: "rocco" }] });
  assert.equal((await createRoccoClient({ base: "http://s", fetchImpl: reply(200, null, true) }).gpus()).status, 502);
  assert.equal((await createRoccoClient({ base: "http://s", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }).unload()).status, 502);
  assert.equal((await createRoccoClient({ base: "http://s", fetchImpl: reply(502, { error: "x" }) }).unload()).status, 502);
});

test("switch passes force/auto; errMessage flattens nested errors", async () => {
  const { errMessage } = await import("./rocco.mjs");
  const sent = [];
  const c = createRoccoClient({ base: "http://s", fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return { status: 200, json: async () => ({}) }; } });
  await c.switch("m", undefined, { auto: true, force: true });
  await c.switch("m", [2], { auto: true });
  assert.deepEqual(sent[0], { model: "m", auto: true, force: true });
  assert.deepEqual(sent[1], { model: "m", gpus: [2] });
  assert.equal(errMessage({ error: { message: "x" } }), "x");
  assert.equal(errMessage({ error: "y" }), "y");
  assert.equal(errMessage({ detail: { error: "z" } }), "z");
});

test("errMessage always returns a string, even for nested or odd shapes", async () => {
  const { errMessage } = await import("./rocco.mjs");
  assert.equal(errMessage({ detail: { error: { message: "deep" } } }), "deep");
  assert.equal(errMessage({ detail: { error: { code: 1 } } }), '{"error":{"code":1}}');
  assert.equal(errMessage({ detail: "plain" }), "plain");
  assert.equal(errMessage({}), "unknown error");
  assert.equal(errMessage(null), "unknown error");
  for (const b of [{ error: { a: { b: {} } } }, { detail: { error: {} } }, { error: 5 }]) assert.equal(typeof errMessage(b), "string");
});
