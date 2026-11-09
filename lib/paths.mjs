/**
 * One place for the plugin's on-disk locations and safe file writes.
 *
 * Data dir: $DSH_HUB_DATA_DIR, else $DSH_HOME/model-hub, else ~/.dsh/model-hub — so an isolated DSH
 * (DSH_HOME=…) keeps its ledger, caps and config next to its own profile instead of the user's main one.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), ".dsh");
}

export function defaultDataDir(env = process.env) {
  return env.DSH_HUB_DATA_DIR || join(dshHome(env), "model-hub");
}

export const DEFAULT_DATA_DIR = defaultDataDir();

/** Create `dir` (0700) and tighten it to 0700 even when it already existed with looser bits. */
export function secureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to chmod (e.g. read-only mount): leave as is */
  }
  return dir;
}

/**
 * Atomic write: a random, exclusively-created temp file (O_CREAT|O_EXCL, so a planted file or symlink at
 * that name makes the write fail instead of following it), fsync-free rename over the target.
 */
export function atomicWriteFile(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
