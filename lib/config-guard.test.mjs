import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "hub-cfg-guard-"));
const put = (d, v) => writeFileSync(join(d, "config.json"), JSON.stringify(v));
const load = (d) => loadConfig({ dataDir: d, env: {} });

test("guard.onError defaults to allow with no file and with no guard key; no error", () => {
  assert.equal(load(dir()).guard.onError, "allow");
  const d = dir(); put(d, { subscriptions: [] });
  const c = load(d);
  assert.equal(c.guard.onError, "allow");
  assert.deepEqual([...c.errors], []);
});

test("guard.onError accepts allow and block", () => {
  for (const v of ["allow", "block"]) {
    const d = dir(); put(d, { guard: { onError: v } });
    const c = load(d);
    assert.equal(c.guard.onError, v);
    assert.deepEqual([...c.errors], []);
  }
});

test("an invalid guard.onError falls back to allow with the exact error text", () => {
  for (const v of ["BLOCK", true, 1, null, {}]) {
    const d = dir(); put(d, { guard: { onError: v } });
    const c = load(d);
    assert.equal(c.guard.onError, "allow", JSON.stringify(v));
    assert.deepEqual([...c.errors], ['guard.onError must be "allow" or "block"'], JSON.stringify(v));
  }
});

test("a guard that is not an object falls back to allow with the exact error text", () => {
  for (const v of [[], "x", 3, null, true]) {
    const d = dir(); put(d, { guard: v });
    const c = load(d);
    assert.equal(c.guard.onError, "allow", JSON.stringify(v));
    assert.deepEqual([...c.errors], ["guard must be an object"], JSON.stringify(v));
  }
});

test("an empty guard object keeps allow and is not an error; the value is frozen", () => {
  const d = dir(); put(d, { guard: {} });
  const c = load(d);
  assert.equal(c.guard.onError, "allow");
  assert.deepEqual([...c.errors], []);
  assert.ok(Object.isFrozen(c.guard));
  assert.throws(() => { "use strict"; c.guard.onError = "block"; }, TypeError);
});

test("guard.onError is re-read when config.json changes", () => {
  const d = dir(); put(d, { guard: { onError: "block" } });
  assert.equal(load(d).guard.onError, "block");
  put(d, { guard: { onError: "allow" }, subscriptions: ["zai"] });
  utimesSync(join(d, "config.json"), new Date(), new Date(Date.now() + 5000));
  assert.equal(load(d).guard.onError, "allow");
});
