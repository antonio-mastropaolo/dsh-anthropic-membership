import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./dsh-hub.mjs";
import { verifyDemoDir } from "../lib/demo/gate.mjs";

const AT = "2026-11-12T15:00:00Z";
function ctx() {
  const base = mkdtempSync(join(tmpdir(), "hub-demo-cli-"));
  const real = join(base, "real");
  mkdirSync(real);
  return { base, real, out: join(base, "demo"), home: join(base, "home") };
}
async function run(c, args) {
  const o = [], er = [];
  let fetched = 0;
  const code = await main(args, { out: (s) => o.push(s), err: (s) => er.push(s), env: { DSH_HUB_DATA_DIR: c.real, DSH_HUB_URL: "http://127.0.0.1:9" }, home: c.home, fetch: async () => { fetched++; throw new Error("network"); } });
  return { code, out: o.join("\n"), err: er.join("\n"), fetched };
}

test("demo --out writes a sealed folder and prints the next steps", async () => {
  const c = ctx();
  const r = await run(c, ["demo", "--out", c.out, "--at", AT, "--seed", "5"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(verifyDemoDir(c.out).ok, true);
  assert.match(r.out, new RegExp(`DSH_HUB_DEMO=${c.out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(r.out, /caps OFF/);
  assert.match(r.out, /10 files/);
  const j = await run({ ...c, out: join(c.base, "demo2") }, ["demo", "--out", join(c.base, "demo2"), "--at", AT, "--json"]);
  assert.equal(j.code, 0);
  const s = JSON.parse(j.out);
  assert.equal(s.out, join(c.base, "demo2"));
  assert.equal(s.anchor.slice(0, 13), "2026-11-12T15");
  assert.equal(s.files.length, 10);
  assert.ok(s.rows > 500);
  assert.equal(s.seed, 20261112);
  assert.equal(readdirSync(c.real).length, 0);
});

test("demo without --out, a bad --at and a bad --seed exit 2", async () => {
  const c = ctx();
  const a = await run(c, ["demo"]);
  assert.equal(a.code, 2); assert.match(a.err, /usage: dsh-hub demo --out/);
  assert.equal((await run(c, ["demo", "--out", c.out, "--at", "yesterday"])).code, 2);
  assert.equal((await run(c, ["demo", "--out", c.out, "--seed", "-3"])).code, 2);
  assert.equal((await run(c, ["demo", "--out", c.out, "--seed", "1.5"])).code, 2);
  const j = await run(c, ["demo", "--json"]);
  assert.equal(j.code, 2);
  assert.equal(JSON.parse(j.out).code, 2);
  assert.deepEqual(readdirSync(c.base).sort(), ["real"]);
});

test("demo refusals exit 1 with one line, or {error, code} with --json", async () => {
  const c = ctx();
  mkdirSync(c.out);
  writeFileSync(join(c.out, "mine.txt"), "keep");
  const r = await run(c, ["demo", "--out", c.out]);
  assert.equal(r.code, 1);
  assert.equal(r.err.split("\n").length, 1);
  assert.match(r.err, /not empty/);
  const k = await run(c, ["demo", "--out", c.real, "--json"]);
  assert.equal(k.code, 1);
  const o = JSON.parse(k.out);
  assert.equal(o.code, 1); assert.match(o.error, /real data dir/);
  assert.equal(readFileSync(join(c.out, "mine.txt"), "utf8"), "keep");
});

test("demo never calls fetch and never touches the hub; help lists demo", async () => {
  const c = ctx();
  const r = await run(c, ["demo", "--out", c.out, "--at", AT]);
  assert.equal(r.code, 0);
  assert.equal(r.fetched, 0);
  const h = await run(c, ["--help"]);
  assert.match(h.out, /demo --out <dir> \[--at <ISO time\|now>\] \[--seed <n>\] \[--force\]/);
});
