import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, realpathSync, statSync, lstatSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDemo, realDataDirs, DemoError } from "./write.mjs";
import { verifyDemoDir } from "./gate.mjs";

const AT = "2026-11-12T15:00:00Z";
const tmp = () => mkdtempSync(join(tmpdir(), "demo-write-"));
function ctx() {
  const base = tmp();
  const real = join(base, "real");
  mkdirSync(real);
  return { base, real, home: join(base, "home"), env: { DSH_HUB_DATA_DIR: real }, base_out: join(base, "out") };
}
const run = (c, extra = {}) => writeDemo({ out: c.base_out, at: AT, seed: 3, tzOffsetMin: 0, env: c.env, home: c.home, ...extra });
const list = (d) => readdirSync(d).sort();
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof DemoError && e.code === 1 && re.test(e.message) && !e.message.includes("\n"));

test("refuses a non-empty --out without --force and writes nothing", () => {
  const c = ctx();
  mkdirSync(c.base_out);
  writeFileSync(join(c.base_out, "mine.txt"), "keep");
  refused(() => run(c), /not empty/);
  assert.deepEqual(list(c.base_out), ["mine.txt"]);
  const w = run({ ...c, base_out: join(c.base, "fresh") });
  refused(() => run({ ...c, base_out: w.out }), /not empty/);
});

test("--force refuses a non-empty folder without the DEMO marker", () => {
  const c = ctx();
  mkdirSync(c.base_out);
  writeFileSync(join(c.base_out, "mine.txt"), "keep");
  refused(() => run(c, { force: true }), /no DEMO marker/);
  assert.deepEqual(list(c.base_out), ["mine.txt"]);
});

test("--force regenerates a marked folder byte-identically and refuses one with a foreign file", () => {
  const c = ctx();
  const w = run(c);
  const before = Object.fromEntries(w.files.map((f) => [f, readFileSync(join(w.out, f), "utf8")]));
  writeFileSync(join(w.out, "caps.json"), "tampered");
  run(c, { force: true });
  for (const f of w.files) assert.equal(readFileSync(join(w.out, f), "utf8"), before[f], f);
  assert.equal(verifyDemoDir(w.out).ok, true);
  writeFileSync(join(w.out, "notes.txt"), "mine");
  refused(() => run(c, { force: true }), /notes\.txt/);
  assert.equal(readFileSync(join(w.out, "notes.txt"), "utf8"), "mine");
  assert.equal(readFileSync(join(w.out, "demo-manifest.json"), "utf8"), before["demo-manifest.json"]);
});

test("refuses the configured data dir, a path inside it, a path that contains it", () => {
  const c = ctx();
  refused(() => run(c, { out: c.real }), /real data dir/);
  refused(() => run(c, { out: join(c.real, "sub", "demo") }), /real data dir/);
  refused(() => run(c, { out: c.base }), /real data dir/);
  assert.deepEqual(list(c.real), []);
});

test("refuses $DSH_HOME/model-hub and ~/.dsh/model-hub", () => {
  const c = ctx();
  const dshHome = join(c.base, "dshhome");
  refused(() => run({ ...c, env: { DSH_HOME: dshHome } }, { out: join(dshHome, "model-hub") }), /real data dir/);
  refused(() => run({ ...c, env: {} }, { out: join(c.home, ".dsh", "model-hub", "demo") }), /real data dir/);
  refused(() => run({ ...c, env: {} }, { out: join(c.home, ".dsh") }), /real data dir/);
  const dirs = realDataDirs({ env: { DSH_HOME: join(c.base, "dshhome") }, home: c.home });
  assert.equal(dirs.length, 2);
  const rb = realpathSync(c.base);
  assert.ok(dirs.includes(join(rb, "home", ".dsh", "model-hub")) && dirs.includes(join(rb, "dshhome", "model-hub")));
});

test("refuses a symlink that points at the real data dir, and --out itself being a symlink", () => {
  const c = ctx();
  const link = join(c.base, "link");
  symlinkSync(c.real, link);
  refused(() => run(c, { out: join(link, "demo") }), /real data dir/);
  refused(() => run(c, { out: link }), /symlink/);
  const empty = join(c.base, "emptydir");
  mkdirSync(empty);
  const l2 = join(c.base, "link2");
  symlinkSync(empty, l2);
  refused(() => run(c, { out: l2 }), /symlink/);
  assert.deepEqual(list(empty), []);
  assert.deepEqual(list(c.real), []);
});

test("refuses --out that is a file", () => {
  const c = ctx();
  writeFileSync(c.base_out, "x");
  refused(() => run(c), /not a directory/);
  assert.equal(readFileSync(c.base_out, "utf8"), "x");
});

test("never follows a symlink planted inside --out", () => {
  const c = ctx();
  const w = run(c);
  const outside = join(c.base, "outside.txt");
  writeFileSync(outside, "precious");
  unlinkSync(join(w.out, "caps.json"));
  symlinkSync(outside, join(w.out, "caps.json"));
  run(c, { force: true });
  assert.equal(readFileSync(outside, "utf8"), "precious");
  assert.equal(lstatSync(join(w.out, "caps.json")).isSymbolicLink(), false);
  assert.equal(verifyDemoDir(w.out).ok, true);
});

test("an interrupted run leaves no marker", () => {
  const c = ctx();
  assert.throws(() => run(c, { hooks: { beforeMarker() { throw new Error("boom"); } } }), /boom/);
  const v = verifyDemoDir(c.base_out);
  assert.equal(v.ok, false);
  assert.equal(v.marked, false);
  assert.ok(!list(c.base_out).includes("DEMO"));
});

test("modes: dir 0700, files 0600", () => {
  const c = ctx();
  const before = process.umask(0o022);
  try {
    const w = run(c);
    assert.equal(statSync(w.out).mode & 0o777, 0o700);
    for (const f of w.files) assert.equal(statSync(join(w.out, f)).mode & 0o777, 0o600, f);
  } finally { process.umask(before); }
});

test("bad inputs are usage errors with code 2", () => {
  const c = ctx();
  assert.throws(() => run(c, { at: "yesterday" }), (e) => e instanceof DemoError && e.code === 2);
  assert.throws(() => run(c, { seed: -1 }), (e) => e instanceof DemoError && e.code === 2);
  assert.throws(() => run(c, { out: "" }), (e) => e instanceof DemoError && e.code === 2);
  assert.deepEqual(readdirSync(c.base).sort(), ["real"]);
});

test("a run that dies before the marker is written leaves a marked folder that --force regenerates", () => {
  const c = ctx();
  const w = run(c);
  const before = Object.fromEntries(w.files.map((f) => [f, readFileSync(join(w.out, f), "utf8")]));
  assert.throws(() => run(c, { force: true, hooks: { beforeMarker: () => { throw new Error("killed"); } } }), /killed/);
  assert.ok(existsSync(join(w.out, "DEMO")), "the marker survives the interrupted regeneration");
  run(c, { force: true });
  for (const f of w.files) assert.equal(readFileSync(join(w.out, f), "utf8"), before[f], f);
  assert.equal(verifyDemoDir(w.out).ok, true);
});

test("--force leaves a macOS .DS_Store alone and still regenerates the folder", () => {
  const c = ctx();
  const w = run(c);
  writeFileSync(join(w.out, ".DS_Store"), "finder");
  run(c, { force: true });
  assert.equal(readFileSync(join(w.out, ".DS_Store"), "utf8"), "finder");
  assert.equal(verifyDemoDir(w.out).ok, true);
  mkdirSync(join(w.out, "sub"));
  refused(() => run(c, { force: true }), /sub/);
});
