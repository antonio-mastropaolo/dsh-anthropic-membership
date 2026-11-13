// lib/demo/write.mjs: writes a sealed demo folder, and only ever there. Every refusal happens before the first byte is
// written; nothing is written through a symlink; the DEMO marker is written last.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, defaultDataDir, secureDir } from "../paths.mjs";
import { DEMO_FILES, DEMO_MANIFEST, DEMO_OS_CRUFT, DEMO_MARKER, MARKER_LINE } from "./constants.mjs";
import { buildDemo } from "./build.mjs";

export class DemoError extends Error {
  constructor(message, code = 1) { super(message); this.name = "DemoError"; this.code = code; }
}

/** realpath of the deepest existing ancestor of `p`, with the missing remainder appended (symlinks resolved). */
export function resolveReal(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); }
    catch (e) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
      const up = path.dirname(cur);
      if (up === cur) return path.join(cur, ...rest.reverse());
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

const within = (parent, child) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
/** True when a and b are the same path, or one lies inside the other. */
export const overlaps = (a, b) => within(a, b) || within(b, a);

/** The folders the plugin keeps real data in: the configured data dir, $DSH_HOME/model-hub and ~/.dsh/model-hub. */
export function realDataDirs({ env = process.env, home = os.homedir() } = {}) {
  const dshHome = env.DSH_HOME || path.join(home, ".dsh");
  const list = [defaultDataDir(env), path.join(dshHome, "model-hub"), path.join(home, ".dsh", "model-hub")];
  const seen = new Set();
  const out = [];
  for (const d of list) { const r = resolveReal(d); if (!seen.has(r)) { seen.add(r); out.push(r); } }
  return out;
}

const ALLOWED = new Set([...DEMO_FILES, DEMO_MANIFEST, DEMO_MARKER]);
const shown = (n) => JSON.stringify(String(n).replace(/[^\x20-\x7e]/g, "?").slice(0, 60));

function guardOut(out, dirs) {
  let st = null;
  try { st = fs.lstatSync(out); } catch (e) { if (e?.code !== "ENOENT") throw new DemoError(`cannot inspect --out (${e.code || "error"})`); }
  if (st) {
    if (st.isSymbolicLink()) throw new DemoError("--out is a symlink: refusing (give the real folder)");
    if (!st.isDirectory()) throw new DemoError("--out is not a directory");
  }
  const real = resolveReal(out);
  for (const d of dirs) if (overlaps(real, d)) throw new DemoError("--out is, lies inside, or contains the real data dir: refusing");
  return { exists: Boolean(st), real };
}

/**
 * writeDemo({ out, at, seed, force, tzOffsetMin, env, home, hooks }) -> summary + { out, files }.
 * DemoError code 2 = bad input, code 1 = refused.
 */
export function writeDemo({ out, at, seed, force = false, tzOffsetMin, env = process.env, home = os.homedir(), hooks = {} } = {}) {
  if (typeof out !== "string" || !out.trim()) throw new DemoError("--out is required", 2);
  const target = path.resolve(out);
  let built;
  try { built = buildDemo({ at, seed, tzOffsetMin }); }
  catch (e) { if (/^bad --/.test(String(e?.message))) throw new DemoError(e.message, 2); throw e; }
  const dirs = realDataDirs({ env, home });
  const g = guardOut(target, dirs);

  const names = [];
  if (g.exists) {
    const entries = fs.readdirSync(target);
    if (entries.length) {
      if (!force) throw new DemoError("--out is not empty: pass an empty or new folder (--force only regenerates a folder that already has the DEMO marker)");
      let marker = null;
      try { marker = fs.lstatSync(path.join(target, DEMO_MARKER)); } catch { /* no marker */ }
      let text = "";
      if (marker?.isFile() && marker.size <= 1024) { try { text = fs.readFileSync(path.join(target, DEMO_MARKER), "utf8"); } catch { /* unreadable */ } }
      if (!marker?.isFile() || text !== `${MARKER_LINE}\n`) throw new DemoError("--out is not empty and has no DEMO marker: refusing to touch it");
      for (const n of entries) {
        // Finder's .DS_Store is neither a demo file nor a reason to refuse: it is left as it is
        if (DEMO_OS_CRUFT.includes(n) && fs.lstatSync(path.join(target, n)).isFile()) continue;
        if (!ALLOWED.has(n)) throw new DemoError(`--out holds a file that is not part of a demo folder (${shown(n)}): refusing to regenerate`);
        if (fs.lstatSync(path.join(target, n)).isDirectory()) throw new DemoError(`--out/${n} is a directory: refusing to regenerate`);
        names.push(n);
      }
    }
  }

  // last look before the first write: --out must still be the same kind of path
  guardOut(target, dirs);
  // The old DEMO marker stays until the new one replaces it (an atomic rename), so a run that dies half-way leaves a
  // folder that still carries its marker and can be regenerated with --force.
  for (const n of names) if (n !== DEMO_MARKER) fs.unlinkSync(path.join(target, n)); // unlink never follows a symlink
  secureDir(target);
  const written = [];
  for (const [name, text] of built.files) {
    if (name === DEMO_MARKER) continue;
    atomicWriteFile(path.join(target, name), text, 0o600);
    written.push(name);
  }
  if (typeof hooks.beforeMarker === "function") hooks.beforeMarker();
  atomicWriteFile(path.join(target, DEMO_MARKER), built.files.get(DEMO_MARKER), 0o600);
  written.push(DEMO_MARKER);
  return { ...built.summary, out: target, files: written };
}
