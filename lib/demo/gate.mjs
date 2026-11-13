// lib/demo/gate.mjs: the one door into demo mode. A folder is a demo folder only when its marker, manifest, every
// sha256 and the exact file list agree. Reasons are fixed one-line texts; file content is never echoed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEMO_FILES, DEMO_MANIFEST, DEMO_OS_CRUFT, DEMO_MARKER, DEMO_MAX_FILE_BYTES, DEMO_TEXT, DEMO_VERSION, MARKER_LINE } from "./constants.mjs";
import { overlaps, realDataDirs, resolveReal } from "./write.mjs";

const ALLOWED = new Set([...DEMO_FILES, DEMO_MANIFEST, DEMO_MARKER]);
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const shown = (n) => JSON.stringify(String(n).replace(/[^\x20-\x7e]/g, "?").slice(0, 40));

/** True when `dir/DEMO` is a regular file (not a symlink). */
export function demoMarked(dir) {
  try { return fs.lstatSync(path.join(dir, DEMO_MARKER)).isFile(); } catch { return false; }
}

class Reason extends Error {}
const fail = (m) => { throw new Reason(m); };

/** Read a regular file without following a symlink, at most `max` bytes. */
function readRegular(file, label, max = DEMO_MAX_FILE_BYTES) {
  let st;
  try { st = fs.lstatSync(file); } catch { return fail(`${label} is missing`); }
  if (st.isSymbolicLink()) fail(`${label} is a symlink`);
  if (!st.isFile()) fail(`${label} is not a regular file`);
  if (st.size > max) fail(`${label} is too large`);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > max) fail(`${label} is not a regular file of acceptable size`);
    const buf = Buffer.alloc(fst.size);
    let off = 0;
    while (off < buf.length) { const n = fs.readSync(fd, buf, off, buf.length - off, off); if (n <= 0) break; off += n; }
    return buf.subarray(0, off);
  } catch (e) {
    if (e instanceof Reason) throw e;
    return fail(`${label} cannot be read`);
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

/** verifyDemoDir(dir) -> { ok: true, manifest } | { ok: false, reason, marked } */
export function verifyDemoDir(dir) {
  const marked = demoMarked(dir);
  try {
    let st;
    try { st = fs.statSync(dir); } catch { return fail("folder not found"); }
    if (!st.isDirectory()) fail("not a directory");
    for (const n of fs.readdirSync(dir)) {
      if (ALLOWED.has(n)) continue;
      // Finder's .DS_Store is never read; anything else, or a .DS_Store that is not a plain file, is not part of a demo folder
      if (DEMO_OS_CRUFT.includes(n) && fs.lstatSync(path.join(dir, n)).isFile()) continue;
      fail(`unexpected file ${shown(n)}`);
    }

    const marker = readRegular(path.join(dir, DEMO_MARKER), "DEMO marker", 1024).toString("utf8");
    if (marker !== `${MARKER_LINE}\n`) fail("DEMO marker text is wrong");

    let m;
    try { m = JSON.parse(readRegular(path.join(dir, DEMO_MANIFEST), "manifest").toString("utf8")); }
    catch (e) { if (e instanceof Reason) throw e; return fail("manifest is not valid JSON"); }
    if (!m || typeof m !== "object" || Array.isArray(m)) fail("manifest is not an object");
    if (m.version !== DEMO_VERSION) fail("manifest version is not supported");
    if (!Number.isFinite(m.anchorMs) || typeof m.anchor !== "string" || !Number.isInteger(m.seed)) fail("manifest anchor or seed is invalid");
    const files = m.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) fail("manifest has no file list");
    const keys = Object.keys(files);
    if (keys.length !== DEMO_FILES.length || !DEMO_FILES.every((f) => Object.prototype.hasOwnProperty.call(files, f))) fail("manifest file list is not the demo file set");
    for (const f of DEMO_FILES) {
      if (typeof files[f] !== "string" || !/^[0-9a-f]{64}$/.test(files[f])) fail(`manifest hash for ${f} is invalid`);
      const sum = createHash("sha256").update(readRegular(path.join(dir, f), f)).digest("hex");
      if (sum !== files[f]) fail(`${f} does not match the manifest`);
    }
    return { ok: true, manifest: m };
  } catch (e) {
    if (e instanceof Reason) return { ok: false, reason: e.message, marked };
    return { ok: false, reason: "folder cannot be verified", marked };
  }
}

/**
 * resolveDemo(env, { warn, home }) -> { dir, manifest, note } | null.
 * Demo mode needs an explicit DSH_HUB_DEMO naming an absolute path to a verified, sealed demo folder that is not (and
 * does not overlap) a real data dir. Anything else is refused with a warning and the host runs normally.
 */
export function resolveDemo(env = process.env, { warn = () => {}, home = os.homedir() } = {}) {
  const v = env.DSH_HUB_DEMO;
  if (typeof v !== "string" || v === "") return null;
  const refuse = (why) => { try { warn(`model-hub: DSH_HUB_DEMO ignored (${why}): running normally`); } catch { /* ignore */ } return null; };
  if (!path.isAbsolute(v)) return refuse("the path is not absolute");
  let real;
  try { real = fs.realpathSync(v); } catch { return refuse("the folder does not exist"); }
  let dirs;
  try { dirs = realDataDirs({ env, home }); } catch { return refuse("the real data dir cannot be resolved"); }
  const here = resolveReal(real);
  if (dirs.some((d) => overlaps(here, d))) return refuse("it is, or overlaps, a real data dir");
  const r = verifyDemoDir(real);
  if (!r.ok) return refuse(`not a sealed demo folder: ${r.reason}`);
  return { dir: real, manifest: r.manifest, note: DEMO_TEXT };
}
