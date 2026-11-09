import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "hub-cfg-"));
const put = (d, v) => writeFileSync(join(d, "config.json"), typeof v === "string" ? v : JSON.stringify(v));
const GOOD = { gpuServer: { id: "rocco", name: "rocco", url: "http://127.0.0.1:4010", icon: "nvidia" }, localProviders: ["rocco", "mac"] };

test("defaults: no file, no env -> GPU off, no errors, frozen", () => {
  const c = loadConfig({ dataDir: dir(), env: {} });
  assert.equal(c.gpuServer, null);
  assert.deepEqual([...c.localProviders], []);
  assert.deepEqual([...c.errors], []);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.localProviders));
});

test("valid file", () => {
  const d = dir(); put(d, GOOD);
  const c = loadConfig({ dataDir: d, env: {} });
  assert.deepEqual({ ...c.gpuServer, hideModels: [...c.gpuServer.hideModels] }, { ...GOOD.gpuServer, hideModels: [], defaultModel: null });
  assert.deepEqual([...c.localProviders], ["rocco", "mac"]);
  assert.ok(Object.isFrozen(c.gpuServer));
  assert.equal(c.errors.length, 0);
});

test("gpuServer.id is always in localProviders; defaults fill name/icon", () => {
  const d = dir(); put(d, { gpuServer: { id: "box", url: "https://gpu.example.com:8000/" }, localProviders: ["mac"] });
  const c = loadConfig({ dataDir: d, env: {} });
  assert.deepEqual([...c.localProviders], ["mac", "box"]);
  assert.equal(c.gpuServer.name, "box");
  assert.equal(c.gpuServer.icon, "nvidia");
  assert.equal(c.gpuServer.url, "https://gpu.example.com:8000");
});

test("invalid url -> gpuServer null + error", () => {
  for (const url of ["not a url", "ftp://x/y", "", 5, undefined]) {
    const d = dir(); put(d, { gpuServer: { id: "a", url } });
    const c = loadConfig({ dataDir: d, env: {} });
    assert.equal(c.gpuServer, null, String(url));
    assert.ok(c.errors.some((e) => /url/.test(e)));
  }
});

test("bad id / icon / name -> gpuServer null + error", () => {
  const base = { id: "a", name: "n", url: "http://127.0.0.1:1", icon: "nvidia" };
  for (const [k, v, re] of [["id", "Bad Id", /id/], ["id", "-x", /id/], ["id", "a".repeat(41), /id/], ["icon", "../x", /icon/], ["name", "x".repeat(41), /name/], ["name", "bad\nname", /name/], ["name", "", /name/]]) {
    const d = dir(); put(d, { gpuServer: { ...base, [k]: v } });
    const c = loadConfig({ dataDir: d, env: {} });
    assert.equal(c.gpuServer, null, `${k}=${v}`);
    assert.ok(c.errors.some((e) => re.test(e)), `${k}=${v}`);
  }
  const d = dir(); put(d, { localProviders: ["ok", "Bad One", 7] });
  const c = loadConfig({ dataDir: d, env: {} });
  assert.deepEqual([...c.localProviders], ["ok"]);
  assert.equal(c.errors.length, 2);
});

test("env overrides: DSH_HUB_GPU_URL/NAME, ROCCO_SHIM_URL back-compat, precedence", () => {
  const d = dir();
  let c = loadConfig({ dataDir: d, env: { DSH_HUB_GPU_URL: "http://10.0.0.5:9000", DSH_HUB_GPU_NAME: "Lab box" } });
  assert.equal(c.gpuServer.url, "http://10.0.0.5:9000");
  assert.equal(c.gpuServer.name, "Lab box");
  assert.deepEqual([...c.localProviders], ["gpu"]);
  c = loadConfig({ dataDir: d, env: { ROCCO_SHIM_URL: "http://127.0.0.1:4010" } });
  assert.equal(c.gpuServer.url, "http://127.0.0.1:4010");
  c = loadConfig({ dataDir: d, env: { ROCCO_SHIM_URL: "http://old:1", DSH_HUB_GPU_URL: "http://new:2" } });
  assert.equal(c.gpuServer.url, "http://new:2");
  put(d, GOOD);
  c = loadConfig({ dataDir: d, env: { DSH_HUB_GPU_URL: "http://other:3", DSH_HUB_GPU_NAME: "Renamed" } });
  assert.equal(c.gpuServer.id, "rocco");
  assert.equal(c.gpuServer.url, "http://other:3");
  assert.equal(c.gpuServer.name, "Renamed");
  c = loadConfig({ dataDir: d, env: { DSH_HUB_GPU_URL: "garbage" } });
  assert.equal(c.gpuServer.url, "http://127.0.0.1:4010", "invalid env URL falls back to the file URL");
  assert.ok(c.errors.length);
});

test("mtime reload: edits are picked up, unchanged file is served from cache", () => {
  const d = dir(); put(d, GOOD);
  const a = loadConfig({ dataDir: d, env: {} });
  assert.equal(loadConfig({ dataDir: d, env: {} }), a);
  put(d, { ...GOOD, gpuServer: { ...GOOD.gpuServer, name: "renamed" } });
  const t = new Date(Date.now() + 5000); utimesSync(join(d, "config.json"), t, t);
  const b = loadConfig({ dataDir: d, env: {} });
  assert.notEqual(b, a);
  assert.equal(b.gpuServer.name, "renamed");
});

test("malformed JSON / wrong shapes never throw", () => {
  for (const text of ["{nope", "", "[]", "null", "42", '{"gpuServer":"x","localProviders":"y"}']) {
    const d = dir(); put(d, text);
    const c = loadConfig({ dataDir: d, env: {} });
    assert.equal(c.gpuServer, null, text);
    assert.deepEqual([...c.localProviders], []);
    if (text !== "[]" && text !== "null" && text !== "42") assert.ok(c.errors.length, text);
  }
});

test("injected readFile; carries no secrets", () => {
  const c = loadConfig({ dataDir: "/nowhere", env: {}, readFile: () => JSON.stringify({ ...GOOD, apiKey: "sk-secret123456789" }) });
  assert.equal(c.gpuServer.id, "rocco");
  assert.ok(!JSON.stringify(c).includes("sk-secret"));
});

test("gpuServer.hideModels: plain substrings kept, bad shapes turn the server off with a reason", () => {
  let d = dir(); put(d, { ...GOOD, gpuServer: { ...GOOD.gpuServer, hideModels: ["flash-next", "a.*b"] } });
  let c = loadConfig({ dataDir: d, env: {} });
  assert.deepEqual([...c.gpuServer.hideModels], ["flash-next", "a.*b"]);
  assert.ok(Object.isFrozen(c.gpuServer.hideModels));
  for (const bad of ["flash-next", [1], [""], Array.from({ length: 21 }, (_, i) => "m" + i), ["x".repeat(81)]]) {
    d = dir(); put(d, { ...GOOD, gpuServer: { ...GOOD.gpuServer, hideModels: bad } });
    c = loadConfig({ dataDir: d, env: {} });
    assert.equal(c.gpuServer, null, JSON.stringify(bad).slice(0, 40));
    assert.ok(c.errors.some((e) => e.includes("hideModels")));
  }
});

test("url hygiene: credentials, query or fragment are rejected; a path prefix is fine", () => {
  for (const url of ["http://u:p@h:1/x", "http://h:1/x?k=1", "http://h:1/#a"]) {
    const d = dir(); put(d, { ...GOOD, gpuServer: { ...GOOD.gpuServer, url } });
    assert.equal(loadConfig({ dataDir: d, env: {} }).gpuServer, null, url);
  }
  const d = dir(); put(d, { ...GOOD, gpuServer: { ...GOOD.gpuServer, url: "http://h:8000/prefix/" } });
  assert.equal(loadConfig({ dataDir: d, env: {} }).gpuServer.url, "http://h:8000/prefix");
});

test("an invalid env URL falls back to the file URL and says so", () => {
  const d = dir(); put(d, GOOD);
  const c = loadConfig({ dataDir: d, env: { DSH_HUB_GPU_URL: "not a url" } });
  assert.equal(c.gpuServer.url, "http://127.0.0.1:4010");
  assert.ok(c.errors.some((e) => e.includes("using config.json url")));
  assert.equal(loadConfig({ dataDir: dir(), env: { DSH_HUB_GPU_URL: "not a url" } }).gpuServer, null);
});

test("defaultModel validated; a parse failure is not cached", () => {
  let d = dir(); put(d, { ...GOOD, gpuServer: { ...GOOD.gpuServer, defaultModel: "m-1" } });
  assert.equal(loadConfig({ dataDir: d, env: {} }).gpuServer.defaultModel, "m-1");
  d = dir(); put(d, { ...GOOD, gpuServer: { ...GOOD.gpuServer, defaultModel: "../x" } });
  assert.equal(loadConfig({ dataDir: d, env: {} }).gpuServer, null);
  d = dir(); const t0 = 1_700_000_000_000; let text = '{"gpuServer": {';
  const opts = { dataDir: d, env: {}, readFile: () => text, statMtime: () => t0 };
  assert.ok(loadConfig(opts).errors.some((e) => e.includes("invalid JSON")));
  text = JSON.stringify(GOOD);
  assert.equal(loadConfig(opts).gpuServer.id, "rocco", "same mtime, but the half-written result was not cached");
});

test("priceModels use the same provider/model rule as /prices: nested model ids ok, 120-char limit", async () => {
  const { isPriceId } = await import("./cost/prices.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cfg-ids-"));
  const long = "p/" + "m".repeat(119);
  const ids = ["openrouter/vendor/model", "google/gemini-3.8-flash", long, "bare", "/x", "UPPER/Model_1"];
  writeFileSync(join(dir, "config.json"), JSON.stringify({ priceModels: ids }));
  const c = loadConfig({ dataDir: dir, env: {} });
  for (const id of ids) assert.equal(c.priceModels.includes(id), isPriceId(id), id);
  assert.ok(c.priceModels.includes("openrouter/vendor/model"));
  assert.ok(!c.priceModels.includes(long), "over 120 chars is rejected by both");
});
