/**
 * Read-only view of the Anthropic grant + DSH settings helpers. This module NEVER writes the credentials
 * file: sign-in/out go through DSH's native flow (ctx.authorization) and refresh through ctx.credentials,
 * both under DSH's cross-process lock.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDshNodeModules } from "./dsh-nm.mjs";

export const PORT = 8185;
export const DSH_NM = resolveDshNodeModules();
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
export const OLLAMA_SETTINGS = join(homedir(), ".ollama/launch/dsh/settings.yaml");
export const RECORD = "llm-pi-ai/anthropic";
export const ALLOWED_ORIGINS = Object.freeze([
  "http://127.0.0.1:3080",
  "http://localhost:3080",
]);

const yamlMod = await import(pathToFileURL(join(DSH_NM, "yaml/dist/index.js")).href);
const YAML = yamlMod.default ?? yamlMod;

export function resolveSettingsPath() {
  if (process.env.DSH_SETTINGS) return process.env.DSH_SETTINGS;
  if (existsSync(OLLAMA_SETTINGS)) return OLLAMA_SETTINGS;
  return join(DSH_HOME, "settings.yaml");
}

export const SETTINGS = resolveSettingsPath();
export const CREDS = join(DSH_HOME, ".credentials.yaml");

function loadYaml(path, fallback) {
  if (!existsSync(path)) return fallback;
  const parsed = YAML.parse(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" ? parsed : fallback;
}

function atomicWrite(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function ensureSettings() {
  if (!existsSync(SETTINGS)) {
    atomicWrite(
      SETTINGS,
      YAML.stringify({
        "llm-pi-ai": {
          providers: {
            anthropic: { displayName: "Anthropic (Claude Pro/Max)" },
          },
        },
      }),
      0o600,
    );
    return SETTINGS;
  }
  const doc = YAML.parseDocument(readFileSync(SETTINGS, "utf8"));
  if (!doc.getIn(["llm-pi-ai"])) doc.setIn(["llm-pi-ai"], {});
  if (!doc.getIn(["llm-pi-ai", "providers"])) doc.setIn(["llm-pi-ai", "providers"], {});
  const anth = doc.getIn(["llm-pi-ai", "providers", "anthropic"]);
  if (!anth) {
    doc.setIn(["llm-pi-ai", "providers", "anthropic"], {
      displayName: "Anthropic (Claude Pro/Max)",
    });
  } else if (anth && typeof anth.delete === "function") {
    anth.delete("apiKeyEnv");
    if (!anth.get("displayName")) anth.set("displayName", "Anthropic (Claude Pro/Max)");
  }
  atomicWrite(SETTINGS, String(doc), 0o600);
  return SETTINGS;
}

function loadCredDoc() {
  const doc = loadYaml(CREDS, { version: 1, refs: {}, records: {} });
  if (doc.version == null) doc.version = 1;
  if (!doc.refs || typeof doc.refs !== "object") doc.refs = {};
  if (!doc.records || typeof doc.records !== "object") doc.records = {};
  return doc;
}

export function status() {
  const rec = loadCredDoc().records[RECORD];
  const payload = rec?.kind === "grant" ? rec.payload : undefined;
  const signedIn = payload?.type === "oauth" && typeof payload.access === "string";
  return {
    signedIn,
    expiresAt: signedIn && typeof payload.expires === "number" ? payload.expires : null,
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

export function getPermissionDefault() {
  const doc = loadYaml(SETTINGS, {});
  const v = doc?.permission?.defaultPreset;
  return PERMISSION_PRESETS.has(v) ? v : "workspace-write";
}

export function setPermissionDefault(preset) {
  if (!PERMISSION_PRESETS.has(preset)) throw new Error("unknown permission preset");
  ensureSettings();
  const doc = YAML.parseDocument(readFileSync(SETTINGS, "utf8"));
  if (!doc.get("permission")) doc.set("permission", {});
  doc.setIn(["permission", "defaultPreset"], preset);
  atomicWrite(SETTINGS, String(doc), 0o600);
  return preset;
}
