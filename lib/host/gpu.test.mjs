import test from "node:test";
import assert from "node:assert/strict";
import { createGpuClient, errMessage, parseGpus } from "./gpu.mjs";

const reply = (status, body, text) => async () => ({ status, json: async () => { if (text) throw new Error("bad"); return body; } });

test("parseGpus", () => {
  assert.equal(parseGpus(undefined), undefined);
  assert.deepEqual(parseGpus([3, 2]), [2, 3]);
  for (const bad of [[], [64], [-1], [1.5], [1, 1], ["1"], "2", [0, 1, 2, 3, 0], Array.from({ length: 65 }, (_, i) => i)]) assert.throws(() => parseGpus(bad), (e) => e.status === 400);
});

test("client: pass-through status/body, models mapping, non-JSON and network errors become 502", async () => {
  const seen = [];
  const f = async (url, init) => { seen.push([init.method, url, init.body]); return reply(202, { status: "switching", gpus: [2] })(); };
  const c = createGpuClient({ base: "http://shim", fetchImpl: f });
  const r = await c.switch("model-a", [2]);
  assert.deepEqual(r, { status: 202, body: { status: "switching", gpus: [2] } });
  assert.deepEqual(seen[0], ["POST", "http://shim/v1/switch", JSON.stringify({ model: "model-a", gpus: [2] })]);
  await c.switch("m");
  assert.equal(seen[1][2], JSON.stringify({ model: "m" }));
  const m = await createGpuClient({ base: "http://s", fetchImpl: reply(200, { data: [{ id: "a", loaded: true, owned_by: "box", extra: "x" }] }) }).models();
  assert.deepEqual(m.body, { models: [{ id: "a", loaded: true, owner: "box" }] });
  assert.equal((await createGpuClient({ base: "http://s", fetchImpl: reply(200, null, true) }).gpus()).status, 502);
  assert.equal((await createGpuClient({ base: "http://s", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }).unload()).status, 502);
  assert.equal((await createGpuClient({ base: "http://s", fetchImpl: reply(502, { error: "x" }) }).unload()).status, 502);
});

test("switch passes force/auto; errMessage flattens nested errors", async () => {
  const { errMessage } = await import("./gpu.mjs");
  const sent = [];
  const c = createGpuClient({ base: "http://s", fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return { status: 200, json: async () => ({}) }; } });
  await c.switch("m", undefined, { auto: true, force: true });
  await c.switch("m", [2], { auto: true });
  assert.deepEqual(sent[0], { model: "m", auto: true, force: true });
  assert.deepEqual(sent[1], { model: "m", gpus: [2] });
  assert.equal(errMessage({ error: { message: "x" } }), "x");
  assert.equal(errMessage({ error: "y" }), "y");
  assert.equal(errMessage({ detail: { error: "z" } }), "z");
});

test("errMessage always returns a string, even for nested or odd shapes", async () => {
  const { errMessage } = await import("./gpu.mjs");
  assert.equal(errMessage({ detail: { error: { message: "deep" } } }), "deep");
  assert.equal(errMessage({ detail: { error: { code: 1 } } }), '{"error":{"code":1}}');
  assert.equal(errMessage({ detail: "plain" }), "plain");
  assert.equal(errMessage({}), "unknown error");
  assert.equal(errMessage(null), "unknown error");
  for (const b of [{ error: { a: { b: {} } } }, { detail: { error: {} } }, { error: 5 }]) assert.equal(typeof errMessage(b), "string");
});

test("base URL comes from config per call; unconfigured -> 409 and no network", async () => {
  let cfg = { gpuServer: { url: "http://one" } };
  const seen = [];
  const c = createGpuClient({ getConfig: () => cfg, fetchImpl: async (u) => { seen.push(u); return reply(200, { ok: true })(); } });
  await c.gpus();
  cfg = { gpuServer: { url: "http://two" } };
  await c.gpus();
  assert.deepEqual(seen, ["http://one/v1/gpus", "http://two/v1/gpus"]);
  cfg = { gpuServer: null };
  const r = await c.switch("m");
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "no GPU server configured");
  assert.equal(seen.length, 2);
});

test("gpus(): process command lines are redacted; errMessage redacts tokens", async () => {
  const body = { gpus: [{ index: 0, processes: [{ user: "u", cmd: "llama-server --api-key s3cr3tvalue -m /models/q.gguf" }] }] };
  const r = await createGpuClient({ base: "http://s", fetchImpl: reply(200, body) }).gpus();
  assert.equal(r.body.gpus[0].processes[0].cmd, "llama-server --api-key [redacted] -m /models/q.gguf");
  assert.doesNotMatch(errMessage({ error: "denied: Bearer abc.def" }), /abc\.def/);
});

test("error-bearing fields are redacted at any HTTP status (a 200 with ok:false too)", async () => {
  const body = { ok: false, error: "failed sk-ant-oat01-ABCDEFGHIJKLMN", detail: { error: { message: "Bearer abc.def" } }, loaded_model: "Qwen/Qwen3-8B" };
  const r = await createGpuClient({ base: "http://s", fetchImpl: reply(200, body) }).gpus();
  assert.equal(r.status, 200);
  assert.doesNotMatch(JSON.stringify(r.body), /sk-ant|abc\.def/);
  assert.equal(r.body.loaded_model, "Qwen/Qwen3-8B", "non-error fields untouched");
});
