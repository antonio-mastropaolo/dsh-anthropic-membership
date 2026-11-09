import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDshNodeModules, dshCandidates } from "./dsh-nm.mjs";

// a fake `npm i -g @deepseek-ai/dsh` under <prefix>
function fakePrefix() {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "dsh-prefix-")));
  const pkg = join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh");
  for (const d of ["yaml", "sharp"]) mkdirSync(join(pkg, "node_modules", d), { recursive: true });
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0" }));
  writeFileSync(join(pkg, "bin", "dsh.js"), "");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  return { prefix, nm: join(pkg, "node_modules"), bin: join(pkg, "bin", "dsh.js") };
}
const nowhere = () => pathToFileURL(join(mkdtempSync(join(tmpdir(), "dsh-self-")), "x.mjs")).href;

test("finds a global npm install from the running Node's prefix (setup-node, nvm, Homebrew, /usr/local)", () => {
  const f = fakePrefix();
  const got = resolveDshNodeModules({ env: {}, execPath: join(f.prefix, "bin", "node"), argv1: undefined, selfUrl: nowhere() });
  assert.equal(got, f.nm);
});

test("finds it through the symlinked `dsh` bin when the Node prefix differs", () => {
  const f = fakePrefix();
  const link = join(f.prefix, "bin", "dsh");
  symlinkSync(f.bin, link);
  const cands = dshCandidates({ execPath: "/nonexistent/bin/node", argv1: link, selfUrl: nowhere() });
  assert.equal(cands[0], f.nm, "the realpath of argv[1] resolves the package first");
  assert.equal(resolveDshNodeModules({ env: {}, execPath: "/nonexistent/bin/node", argv1: link, selfUrl: nowhere() }), f.nm);
});

test("DSH_NODE_MODULES wins when valid and is refused (not silently ignored) when it is not", () => {
  const f = fakePrefix();
  assert.equal(resolveDshNodeModules({ env: { DSH_NODE_MODULES: f.nm } }), f.nm);
  assert.throws(() => resolveDshNodeModules({ env: { DSH_NODE_MODULES: "/nonexistent" } }), /DSH_NODE_MODULES=\/nonexistent/);
});
