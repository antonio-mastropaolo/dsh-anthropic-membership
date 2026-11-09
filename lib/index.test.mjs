import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL(".", import.meta.url));
const run = (code, env) => execFileSync(process.execPath, ["--input-type=module", "-e", code], {
  env: { PATH: process.env.PATH, ...env }, encoding: "utf8",
});

test("the plugin imports even when DeepSeek Harness node_modules cannot be found (no top-level throw)", () => {
  const home = mkdtempSync(join(tmpdir(), "hub-home-"));
  const empty = mkdtempSync(join(tmpdir(), "hub-nm-"));
  const out = run(`
    const m = await import(${JSON.stringify(join(LIB, "index.js"))});
    const o = await import(${JSON.stringify(join(LIB, "oauth.mjs"))});
    const r = await import(${JSON.stringify(join(LIB, "request-image.mjs"))});
    console.log(JSON.stringify({ apply: typeof m.apply, status: o.status(), sharp: r.sharpAvailable(), token: o.getAccessToken() }));
  `, { DSH_NODE_MODULES: empty, DSH_HOME: join(home, "dsh"), DSH_HUB_DATA_DIR: join(home, "data"), HOME: home });
  const r = JSON.parse(out.trim().split("\n").pop());
  assert.equal(r.apply, "function");
  assert.equal(r.status.signedIn, false);
  assert.match(r.status.unavailable, /cannot load yaml|not found/);
  assert.equal(r.sharp, false);
  assert.equal(r.token, null);
  // importing never writes anything: no settings.yaml, no ~/.dsh, no data dir
  assert.deepEqual(readdirSync(home).sort(), [], "nothing created under HOME at import");
});

test("the full-access preference lives in the plugin's data dir, never in DSH settings files", () => {
  const home = mkdtempSync(join(tmpdir(), "hub-home-"));
  const data = join(home, "data");
  mkdirSync(join(home, "dsh"), { recursive: true });
  run(`
    const o = await import(${JSON.stringify(join(LIB, "oauth.mjs"))});
    o.setPermissionDefault("danger-full-access");
    if (o.getPermissionDefault() !== "danger-full-access") throw new Error("not persisted");
  `, { DSH_HOME: join(home, "dsh"), DSH_HUB_DATA_DIR: data, HOME: home });
  assert.equal(JSON.parse(readFileSync(join(data, "prefs.json"), "utf8")).defaultPreset, "danger-full-access");
  assert.deepEqual(readdirSync(join(home, "dsh")), [], "DSH_HOME untouched (no settings.yaml)");
  assert.equal(statSync(join(data, "prefs.json")).mode & 0o777, 0o600);
});

test("allowed UI origins: 3080 defaults + DSH's advertised origin (+twin) + config + env", async () => {
  const { buildAllowedOrigins, originsFor } = await import("./index.js");
  assert.deepEqual(originsFor("http://127.0.0.1:3311/"), ["http://127.0.0.1:3311", "http://localhost:3311"]);
  assert.deepEqual(originsFor("javascript:alert(1)"), []);
  const list = buildAllowedOrigins({
    advertised: "http://localhost:4000/ui/",
    config: { hub: { allowedOrigins: ["https://dsh.example:8443"] } },
    env: { DSH_HUB_ALLOWED_ORIGINS: "http://10.0.0.5:3080, nonsense" },
  });
  for (const o of ["http://127.0.0.1:3080", "http://localhost:3080", "http://localhost:4000", "http://127.0.0.1:4000",
    "https://dsh.example:8443", "http://10.0.0.5:3080"]) assert.ok(list.includes(o), o);
  assert.ok(!list.some((o) => /nonsense/.test(o)));
});
