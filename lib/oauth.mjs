/**
 * Read-only view of the Anthropic grant, plus the plugin's own "full access" preference.
 *
 * This module NEVER writes DSH's files: not the credentials store (sign-in/out go through DSH's native flow,
 * refresh through ctx.credentials, both under DSH's cross-process lock) and not DSH settings (in DSH 0.2.x the
 * live config is the profile's cordis.patch.yml). DSH's YAML parser is loaded lazily, so the plugin still
 * loads when DSH's node_modules cannot be found; the Claude grant view then reports itself unavailable.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dshNodeModulesOrNull } from "./dsh-nm.mjs";
import { atomicWriteFile, DEFAULT_DATA_DIR, dshHome } from "./paths.mjs";

/** The host API port. Fixed: the browser half of the plugin cannot discover another one. */
export const PORT = 8185;
export const DSH_HOME = dshHome();
export const RECORD = "llm-pi-ai/anthropic";
/** UI origins always accepted; the host adds the origin DSH actually advertises, plus config/env extras. */
export const DEFAULT_ORIGINS = Object.freeze(["http://127.0.0.1:3080", "http://localhost:3080"]);
/** @deprecated kept for older imports; the live allowlist is built in index.js. */
export const ALLOWED_ORIGINS = DEFAULT_ORIGINS;
export const CREDS = join(DSH_HOME, ".credentials.yaml");

let yaml; // undefined = not tried, null = unavailable
let yamlError = null;
/** DSH's own `yaml` package, or null (with yamlUnavailableReason()) when DSH's node_modules are not found. */
export function loadYamlModule() {
  if (yaml !== undefined) return yaml;
  const nm = dshNodeModulesOrNull();
  if (!nm) {
    yaml = null;
    yamlError = "DeepSeek Harness node_modules not found (set DSH_NODE_MODULES)";
    return yaml;
  }
  try {
    yaml = createRequire(join(nm, "x.js"))("yaml");
  } catch (e) {
    yaml = null;
    yamlError = `cannot load yaml from ${nm}: ${e?.code || "error"}`;
  }
  return yaml;
}
export const yamlUnavailableReason = () => (loadYamlModule() ? null : yamlError);

function loadCredDoc() {
  const empty = { version: 1, refs: {}, records: {} };
  const Y = loadYamlModule();
  if (!Y || !existsSync(CREDS)) return empty;
  try {
    const doc = Y.parse(readFileSync(CREDS, "utf8"));
    if (!doc || typeof doc !== "object") return empty;
    if (!doc.records || typeof doc.records !== "object") doc.records = {};
    return doc;
  } catch {
    return empty;
  }
}

export function status() {
  const rec = loadCredDoc().records[RECORD];
  const payload = rec?.kind === "grant" ? rec.payload : undefined;
  const signedIn = payload?.type === "oauth" && typeof payload.access === "string";
  return {
    signedIn,
    expiresAt: signedIn && typeof payload.expires === "number" ? payload.expires : null,
    ...(yamlUnavailableReason() ? { unavailable: yamlUnavailableReason() } : {}),
  };
}

/** Access token for host-side usage fetch. Never log the return value. */
export function getAccessToken() {
  const rec = loadCredDoc().records[RECORD];
  const payload = rec?.kind === "grant" ? rec.payload : undefined;
  if (payload?.type === "oauth" && typeof payload.access === "string") return payload.access;
  return null;
}

export function apiKeyInEnv() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const PERMISSION_PRESETS = new Set(["danger-full-access", "workspace-write"]);
const prefsPath = (dataDir) => join(dataDir, "prefs.json");

/** The "Full access" switch's remembered default, kept in the plugin's own data dir (never in DSH settings). */
export function getPermissionDefault(dataDir = DEFAULT_DATA_DIR) {
  try {
    const v = JSON.parse(readFileSync(prefsPath(dataDir), "utf8"))?.defaultPreset;
    return PERMISSION_PRESETS.has(v) ? v : "workspace-write";
  } catch {
    return "workspace-write";
  }
}

export function setPermissionDefault(preset, dataDir = DEFAULT_DATA_DIR) {
  if (!PERMISSION_PRESETS.has(preset)) throw new Error("unknown permission preset");
  let prefs = {};
  try {
    prefs = JSON.parse(readFileSync(prefsPath(dataDir), "utf8")) || {};
  } catch {
    /* none yet */
  }
  atomicWriteFile(prefsPath(dataDir), JSON.stringify({ ...prefs, defaultPreset: preset }) + "\n", 0o600);
  return preset;
}
