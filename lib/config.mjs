/**
 * Plugin config: <dataDir>/config.json (+ env overrides). The ONLY place the GPU server URL is set.
 *
 *   { "gpuServer": { "id": "mybox", "name": "My GPU box", "url": "http://127.0.0.1:8000", "icon": "nvidia" } | null,
 *     "localProviders": ["mybox", "mac"] }
 *
 * With no file and no env, gpuServer is null and localProviders is [] (GPU features off, nothing errors).
 * Never throws; a bad file or field yields defaults plus an entry in `errors`. The result is frozen and holds no secrets.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DATA_DIR = process.env.DSH_HUB_DATA_DIR || join(homedir(), ".dsh", "model-hub");
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_RE = /^[\x20-\x7e -￿]{1,40}$/u;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const cache = new Map(); // path -> { sig, value }

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/; // same rule as lib/host/gpu.mjs MODEL_RE

function parseUrl(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    // the plugin appends /v1/... to this base, and fetch() rejects embedded credentials
    if (u.search || u.hash || u.username || u.password) return null;
    return u.href.replace(/\/+$/, "");
  } catch { return null; }
}

function build(raw, env, errors) {
  const file = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fs0 = file.gpuServer;
  let gpuServer = null;
  const envUrl = env.DSH_HUB_GPU_URL || env.ROCCO_SHIM_URL || "";
  const envName = env.DSH_HUB_GPU_NAME || "";

  if (fs0 !== undefined && fs0 !== null && (typeof fs0 !== "object" || Array.isArray(fs0))) {
    errors.push("gpuServer must be an object or null");
  }
  const obj = fs0 && typeof fs0 === "object" && !Array.isArray(fs0) ? fs0 : null;
  const envUrlOk = envUrl ? parseUrl(envUrl) : null;
  if (envUrl && !envUrlOk && obj) errors.push("DSH_HUB_GPU_URL/ROCCO_SHIM_URL is not a valid http(s) base URL; using config.json url");
  if (obj || envUrl) {
    const src = { ...(obj || {}) };
    if (envUrlOk || (envUrl && !obj)) src.url = envUrl;
    if (envName) src.name = envName;
    const id = src.id === undefined ? "gpu" : src.id;
    const icon = src.icon === undefined ? "nvidia" : src.icon;
    const name = src.name === undefined ? (typeof id === "string" && src.id !== undefined ? id : "GPU server") : src.name;
    const url = parseUrl(src.url);
    const problems = [];
    if (typeof id !== "string" || !SLUG_RE.test(id)) problems.push("gpuServer.id must match [a-z0-9][a-z0-9-]{0,39}");
    if (typeof icon !== "string" || !SLUG_RE.test(icon)) problems.push("gpuServer.icon must match [a-z0-9][a-z0-9-]{0,39}");
    if (typeof name !== "string" || !NAME_RE.test(name) || CTRL_RE.test(name)) problems.push("gpuServer.name must be 1-40 printable characters");
    if (!url) problems.push("gpuServer.url must be a valid http(s) URL");
    // hideModels: plain substrings (never regexes) of model ids to leave out of the panel's model list,
    // e.g. models that run as dedicated containers and cannot be loaded or unloaded by the server.
    let hideModels = [];
    if (src.hideModels !== undefined) {
      if (!Array.isArray(src.hideModels) || src.hideModels.length > 20) problems.push("gpuServer.hideModels must be an array of at most 20 strings");
      else if (src.hideModels.some((s) => typeof s !== "string" || !s || s.length > 80 || CTRL_RE.test(s))) problems.push("gpuServer.hideModels entries must be 1-80 printable characters");
      else hideModels = [...src.hideModels];
    }
    // defaultModel: the model the panel preselects when nothing is loaded (else the first one listed).
    const defaultModel = src.defaultModel === undefined ? null : src.defaultModel;
    if (defaultModel !== null && (typeof defaultModel !== "string" || !MODEL_ID_RE.test(defaultModel))) problems.push("gpuServer.defaultModel must match [A-Za-z0-9][A-Za-z0-9._-]{0,79}");
    if (problems.length) errors.push(...problems);
    else gpuServer = Object.freeze({ id, name, url, icon, hideModels: Object.freeze(hideModels), defaultModel });
  }

  const local = [];
  if (file.localProviders !== undefined) {
    if (!Array.isArray(file.localProviders)) errors.push("localProviders must be an array of provider ids");
    else for (const p of file.localProviders) {
      if (typeof p === "string" && SLUG_RE.test(p)) { if (!local.includes(p)) local.push(p); }
      else errors.push("localProviders entries must match [a-z0-9][a-z0-9-]{0,39}");
    }
  }
  if (gpuServer && !local.includes(gpuServer.id)) local.push(gpuServer.id);
  return Object.freeze({ gpuServer, localProviders: Object.freeze(local), errors: Object.freeze(errors) });
}

/**
 * loadConfig({ dataDir, env, readFile, statMtime }). The parsed result is cached per file and re-read
 * when the file's mtime changes (one stat per call). Injecting `readFile` without `statMtime` disables the cache.
 */
export function loadConfig({ dataDir = DEFAULT_DATA_DIR, env = process.env, readFile, statMtime } = {}) {
  const path = join(dataDir, "config.json");
  const envSig = `${env.DSH_HUB_GPU_URL || ""}|${env.ROCCO_SHIM_URL || ""}|${env.DSH_HUB_GPU_NAME || ""}`;
  const canCache = !readFile || !!statMtime;
  let mtime = -1;
  try { mtime = (statMtime || ((p) => statSync(p).mtimeMs))(path); } catch { mtime = -1; }
  const sig = `${mtime}|${envSig}`;
  if (canCache) {
    const hit = cache.get(path);
    if (hit && hit.sig === sig) return hit.value;
  }
  const errors = [];
  let raw = null;
  if (mtime >= 0 || readFile) {
    try {
      const text = (readFile || ((p) => readFileSync(p, "utf8")))(path);
      if (text !== undefined && text !== null) raw = JSON.parse(String(text));
    } catch (e) {
      if (e?.code !== "ENOENT") errors.push(`config.json unreadable: ${e instanceof SyntaxError ? "invalid JSON" : "read error"}`);
    }
  }
  const value = build(raw, env, errors);
  // never cache a parse failure: a config.json caught mid-write would otherwise stay "broken" for that mtime
  const parseFailed = errors.some((e) => e.startsWith("config.json unreadable"));
  if (canCache && !parseFailed) { cache.set(path, { sig, value }); if (cache.size > 32) cache.delete(cache.keys().next().value); }
  return value;
}
