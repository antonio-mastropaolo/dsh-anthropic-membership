/** Shared Claude Pro/Max OAuth + DSH credential/settings writes. */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const PORT = 8185;
export const DSH_NM = "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules";
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
export const OLLAMA_SETTINGS = join(homedir(), ".ollama/launch/dsh/settings.yaml");
export const RECORD = "llm-pi-ai/anthropic";
export const ALLOWED_ORIGINS = Object.freeze([
  "http://127.0.0.1:3080",
  "http://localhost:3080",
]);

const yamlMod = await import(pathToFileURL(join(DSH_NM, "yaml/dist/index.js")).href);
const YAML = yamlMod.default ?? yamlMod;
const { createModels } = await import(
  pathToFileURL(join(DSH_NM, "@earendil-works/pi-ai/dist/index.js")).href
);
const { anthropicProvider } = await import(
  pathToFileURL(join(DSH_NM, "@earendil-works/pi-ai/dist/providers/anthropic.js")).href
);

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

function fileStore() {
  return {
    async read(providerId) {
      if (providerId !== "anthropic") return undefined;
      const rec = loadCredDoc().records[RECORD];
      if (rec?.kind === "grant" && rec.payload?.type === "oauth") return rec.payload;
      return undefined;
    },
    async list() {
      const rec = loadCredDoc().records[RECORD];
      if (rec?.kind === "grant" && rec.payload?.type === "oauth") {
        return [{ providerId: "anthropic", type: "oauth" }];
      }
      return [];
    },
    async modify(providerId, fn) {
      if (providerId !== "anthropic") {
        throw new Error(`this store only holds anthropic, not ${providerId}`);
      }
      const doc = loadCredDoc();
      const rec = doc.records[RECORD];
      const current =
        rec?.kind === "grant" && rec.payload?.type === "oauth" ? rec.payload : undefined;
      const next = await fn(current);
      if (next == null) delete doc.records[RECORD];
      else doc.records[RECORD] = { kind: "grant", payload: next };
      atomicWrite(CREDS, YAML.stringify(doc), 0o600);
      return next;
    },
    async delete(providerId) {
      if (providerId !== "anthropic") return;
      const doc = loadCredDoc();
      delete doc.records[RECORD];
      atomicWrite(CREDS, YAML.stringify(doc), 0o600);
    },
  };
}

function openUrl(url) {
  spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
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

export async function login({ onNotice } = {}) {
  ensureSettings();
  const models = createModels({ credentials: fileStore() });
  models.setProvider(anthropicProvider());
  const cred = await models.login("anthropic", "oauth", {
    signal: AbortSignal.timeout(10 * 60 * 1000),
    notify(event) {
      if (event?.type === "auth_url" && event.url) {
        onNotice?.({ message: "Opening Claude Pro/Max in the browser", url: event.url });
        try {
          openUrl(event.url);
        } catch {
          /* ignore */
        }
        return;
      }
      if (event?.message) onNotice?.({ message: event.message });
    },
    prompt() {
      return new Promise(() => {});
    },
  });
  if (!cred || cred.type !== "oauth" || !cred.access) {
    throw new Error("login returned no OAuth grant");
  }
  return status();
}

export function logout() {
  const doc = loadCredDoc();
  delete doc.records[RECORD];
  atomicWrite(CREDS, YAML.stringify(doc), 0o600);
  return status();
}
