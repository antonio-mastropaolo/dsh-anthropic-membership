import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDemo } from "./write.mjs";
import { verifyDemoDir, resolveDemo, demoMarked } from "./gate.mjs";
import { DEMO_TEXT, MARKER_LINE, DEMO_MAX_FILE_BYTES } from "./constants.mjs";

const AT = "2026-11-12T15:00:00Z";
const tmp = () => mkdtempSync(join(tmpdir(), "demo-gate-"));
function fresh() {
  const base = tmp();
  const real = join(base, "real");
  mkdirSync(real);
  const env = { DSH_HUB_DATA_DIR: real };
  const w = writeDemo({ out: join(base, "demo"), at: AT, seed: 3, tzOffsetMin: 0, env, home: join(base, "home") });
  return { base, real, env, dir: w.out, home: join(base, "home") };
}
const oneLine = (r) => { assert.equal(r.ok, false); assert.equal(typeof r.reason, "string"); assert.ok(r.reason.length > 0 && r.reason.length < 200 && !r.reason.includes("\n"), r.reason); return r; };

test("verifyDemoDir accepts a fresh folder", () => {
  const f = fresh();
  const v = verifyDemoDir(f.dir);
  assert.equal(v.ok, true);
  assert.equal(v.manifest.version, 1);
  assert.equal(demoMarked(f.dir), true);
  assert.equal(readFileSync(join(f.dir, "DEMO"), "utf8"), `${MARKER_LINE}\n`);
});

test("verifyDemoDir rejects every tampering with a one-line reason that never echoes content", () => {
  const SECRET = "SECRET-CONTENT-XYZ";
  const cases = {
    "missing marker": (d) => unlinkSync(join(d, "DEMO")),
    "wrong marker text": (d) => writeFileSync(join(d, "DEMO"), `${SECRET}\n`),
    "marker is a symlink": (d) => { const t = join(d, "..", "m.txt"); writeFileSync(t, `${MARKER_LINE}\n`); unlinkSync(join(d, "DEMO")); symlinkSync(t, join(d, "DEMO")); },
    "extra spend.1.jsonl": (d) => writeFileSync(join(d, "spend.1.jsonl"), SECRET),
    "extra prices.litellm.json": (d) => writeFileSync(join(d, "prices.litellm.json"), SECRET),
    "extra provider-health.json": (d) => writeFileSync(join(d, "provider-health.json"), SECRET),
    ".DS_Store that is a directory": (d) => mkdirSync(join(d, ".DS_Store")),
    ".DS_Store that is a symlink": (d) => { const t = join(d, "..", "ds.txt"); writeFileSync(t, SECRET); symlinkSync(t, join(d, ".DS_Store")); },
    "extra .localized": (d) => writeFileSync(join(d, ".localized"), SECRET),
    "missing file": (d) => unlinkSync(join(d, "caps.json")),
    "appended byte": (d) => appendFileSync(join(d, "spend.jsonl"), SECRET),
    "edited manifest hash": (d) => { const m = JSON.parse(readFileSync(join(d, "demo-manifest.json"), "utf8")); m.files["caps.json"] = "0".repeat(64); writeFileSync(join(d, "demo-manifest.json"), JSON.stringify(m)); },
    "unknown manifest file": (d) => { const m = JSON.parse(readFileSync(join(d, "demo-manifest.json"), "utf8")); m.files[SECRET] = "0".repeat(64); writeFileSync(join(d, "demo-manifest.json"), JSON.stringify(m)); },
    "manifest not json": (d) => writeFileSync(join(d, "demo-manifest.json"), SECRET),
    "manifest wrong version": (d) => { const m = JSON.parse(readFileSync(join(d, "demo-manifest.json"), "utf8")); m.version = 2; writeFileSync(join(d, "demo-manifest.json"), JSON.stringify(m)); },
    "file replaced by a symlink": (d) => { const t = join(d, "..", "c.json"); writeFileSync(t, readFileSync(join(d, "caps.json"))); unlinkSync(join(d, "caps.json")); symlinkSync(t, join(d, "caps.json")); },
    "oversized file": (d) => writeFileSync(join(d, "spend.jsonl"), Buffer.alloc(DEMO_MAX_FILE_BYTES + 1, 97)),
    "file is a directory": (d) => { unlinkSync(join(d, "caps.json")); mkdirSync(join(d, "caps.json")); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const f = fresh();
    mutate(f.dir);
    const r = oneLine(verifyDemoDir(f.dir));
    assert.ok(!r.reason.includes(SECRET), `${name}: ${r.reason}`);
    assert.equal(typeof r.marked, "boolean");
  }
  const g = fresh();
  unlinkSync(join(g.dir, "DEMO"));
  assert.equal(verifyDemoDir(g.dir).marked, false);
  const h = fresh();
  appendFileSync(join(h.dir, "caps.json"), " ");
  assert.equal(verifyDemoDir(h.dir).marked, true);
  assert.equal(verifyDemoDir(join(h.base, "nope")).ok, false);
});

test("a macOS .DS_Store beside the demo files does not unseal the folder (and no other cruft is allowed)", () => {
  const f = fresh();
  writeFileSync(join(f.dir, ".DS_Store"), "finder");
  assert.equal(verifyDemoDir(f.dir).ok, true);
  assert.ok(resolveDemo({ DSH_HUB_DEMO: f.dir, DSH_HUB_DATA_DIR: f.real }, { home: f.home }));
});

test("resolveDemo refuses a relative DSH_HUB_DEMO even when it names a valid demo folder from the cwd", () => {
  const f = fresh();
  const rel = relative(process.cwd(), f.dir);
  assert.ok(!isAbsolute(rel) && rel.length > 0);
  const warns = [];
  assert.equal(resolveDemo({ DSH_HUB_DEMO: rel, DSH_HUB_DATA_DIR: f.real }, { warn: (m) => warns.push(m), home: f.home }), null);
  assert.deepEqual(warns, ["model-hub: DSH_HUB_DEMO ignored (the path is not absolute): running normally"]);
  assert.ok(resolveDemo({ DSH_HUB_DEMO: f.dir, DSH_HUB_DATA_DIR: f.real }, { home: f.home }), "the same folder by its absolute path is accepted");
});

test("resolveDemo: unset is silent; every bad target warns and returns null; a valid folder resolves", () => {
  const f = fresh();
  const warns = [];
  const warn = (m) => warns.push(m);
  assert.equal(resolveDemo({}, { warn, home: f.home }), null);
  assert.equal(resolveDemo({ DSH_HUB_DEMO: "" }, { warn, home: f.home }), null);
  assert.deepEqual(warns, []);
  const bad = (env) => { warns.length = 0; assert.equal(resolveDemo(env, { warn, home: f.home }), null); assert.equal(warns.length, 1); assert.match(warns[0], /^model-hub: DSH_HUB_DEMO ignored \(.+\): running normally$/); };
  bad({ DSH_HUB_DEMO: "relative/demo" });
  const markerOnly = join(f.base, "markeronly");
  mkdirSync(markerOnly);
  writeFileSync(join(markerOnly, "DEMO"), `${MARKER_LINE}\n`);
  bad({ DSH_HUB_DEMO: markerOnly });
  writeFileSync(join(f.real, "DEMO"), `${MARKER_LINE}\n`);
  bad({ DSH_HUB_DEMO: f.real, DSH_HUB_DATA_DIR: f.real });
  bad({ DSH_HUB_DEMO: f.base, DSH_HUB_DATA_DIR: f.real });
  bad({ DSH_HUB_DEMO: join(f.base, "missing") });
  const t = fresh();
  appendFileSync(join(t.dir, "spend.jsonl"), "x");
  bad({ DSH_HUB_DEMO: t.dir, DSH_HUB_DATA_DIR: t.real });
  warns.length = 0;
  const r = resolveDemo({ DSH_HUB_DEMO: f.dir, DSH_HUB_DATA_DIR: f.real }, { warn, home: f.home });
  assert.equal(warns.length, 0);
  assert.equal(r.dir, fs.realpathSync(f.dir));
  assert.equal(r.note, DEMO_TEXT);
  assert.equal(r.manifest.version, 1);
});

test("resolveDemo reads nothing inside any real data dir", () => {
  const f = fresh();
  writeFileSync(join(f.real, "spend.jsonl"), "real spend\n");
  const real = fs.realpathSync(f.real);
  const demo = fs.realpathSync(f.dir);
  const touched = [];
  const names = ["readFileSync", "openSync", "readdirSync", "statSync", "lstatSync"];
  const orig = {};
  for (const n of names) { orig[n] = fs[n]; fs[n] = (p, ...a) => { touched.push(String(p)); return orig[n](p, ...a); }; }
  try { assert.ok(resolveDemo({ DSH_HUB_DEMO: f.dir, DSH_HUB_DATA_DIR: f.real }, { home: f.home })); resolveDemo({ DSH_HUB_DEMO: f.real, DSH_HUB_DATA_DIR: f.real }, { warn() {}, home: f.home }); }
  finally { for (const n of names) fs[n] = orig[n]; }
  assert.ok(touched.length > 0);
  for (const p of touched) assert.ok(p.startsWith(demo) || !(p === real || p.startsWith(real + sep)), `touched ${p}`);
});

test("source scan: the demo modules carry no network, listener or process code", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  for (const f of ["build", "write", "gate", "accounts", "prices", "constants"]) {
    const src = readFileSync(join(dir, `${f}.mjs`), "utf8");
    for (const bad of ["node:http", "node:https", "node:net", "node:dgram", "fetch(", "listen(", "child_process"]) assert.ok(!src.includes(bad), `${f}.mjs contains ${bad}`);
  }
});
