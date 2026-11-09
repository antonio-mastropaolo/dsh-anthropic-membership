/**
 * Read-only account health from DSH's credentials file. Never returns secret values:
 * only booleans, timestamps and provider ids leave this module.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dshNodeModulesOrNull } from "../dsh-nm.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyError } from "./errors.mjs";

export const OAUTH_PROVIDERS = Object.freeze([
  "anthropic",
  "openai-codex",
  "github-copilot",
  "kimi-coding",
  "openrouter",
  "xai",
]);

// DSH node_modules, found portably (env DSH_NODE_MODULES / DSH_NM, then the dsh install); null when DSH is absent.
export const DSH_NM = dshNodeModulesOrNull();
export const DEFAULT_CREDENTIALS_PATH = join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml");
export const DEFAULT_EXPIRING_MS = 600000;

let cachedYaml;
/** Load DSH's own `yaml` package (sync, CJS build); null when it is not installed. */
export function loadYaml() {
  if (cachedYaml !== undefined) return cachedYaml;
  if (!DSH_NM) return (cachedYaml = null);
  try {
    cachedYaml = createRequire(join(DSH_NM, "x.js"))("yaml");
  } catch {
    cachedYaml = null;
  }
  return cachedYaml;
}

/** True when DSH's YAML parser can be loaded (the credential store can be read). */
export const yamlAvailable = () => Boolean(loadYaml());

function parseDoc(text, parse) {
  const fn = parse || loadYaml()?.parse;
  if (typeof fn !== "function") throw new Error("no YAML parser available (DSH yaml package not found)");
  let doc;
  try { doc = fn.call(loadYaml(), text); }
  catch (e) {
    // the parser's message quotes the offending line of the credentials file: report only where it is
    const line = Number(e?.linePos?.[0]?.line);
    throw new Error(`DSH credentials file is not valid YAML${Number.isFinite(line) && line > 0 ? ` (line ${line})` : ""}`);
  }
  return doc && typeof doc === "object" ? doc : {};
}

function readState(statePath) {
  if (!statePath || !existsSync(statePath)) return {};
  try {
    const s = JSON.parse(readFileSync(statePath, "utf8"));
    return s && typeof s.providers === "object" && s.providers ? s.providers : {};
  } catch {
    return {};
  }
}

/**
 * @param {{credentialsPath?:string, now?:number, statePath?:string, expiringMs?:number,
 *          providers?:readonly string[], parse?:(t:string)=>any}} [opts]
 * @returns {Array<{provider:string, signedIn:boolean, kind:"oauth"|"api-key"|null, expiresAt:number|null,
 *   expired:boolean, expiresInMs:number|null, hasRefresh:boolean,
 *   health:"ok"|"expiring"|"expired"|"missing"|"refresh-failed", lastRefreshAt:number|null, lastError:string|null}>}
 */
export function readAccounts({
  credentialsPath = DEFAULT_CREDENTIALS_PATH,
  now = Date.now(),
  statePath,
  expiringMs = DEFAULT_EXPIRING_MS,
  providers = OAUTH_PROVIDERS,
  parse,
} = {}) {
  let records = {};
  if (existsSync(credentialsPath)) {
    records = parseDoc(readFileSync(credentialsPath, "utf8"), parse).records ?? {};
  }
  const state = readState(statePath);
  return providers.map((provider) => {
    const rec = records[`llm-pi-ai/${provider}`];
    const st = state[provider] ?? {};
    const lastRefreshAt = Number.isFinite(st.lastRefreshAt) ? st.lastRefreshAt : null;
    const lastError = typeof st.lastError === "string" && st.lastError ? st.lastError : null;
    const base = {
      provider, signedIn: false, kind: null, expiresAt: null, expired: false, expiresInMs: null,
      hasRefresh: false, health: "missing", lastRefreshAt, lastError,
      errorKind: lastError ? (typeof st.errorKind === "string" ? st.errorKind : classifyError(lastError)) : null,
      terminal: false,
    };
    if (!rec || typeof rec !== "object") return base;

    if (rec.kind === "api-key") {
      const has = typeof rec.key === "string" && rec.key.length > 0;
      return has ? { ...base, signedIn: true, kind: "api-key", health: "ok" } : base;
    }
    const p = rec.kind === "grant" ? rec.payload : undefined;
    if (!p || typeof p !== "object") return base;
    if (p.type === "api_key") {
      const has = typeof p.key === "string" && p.key.length > 0;
      return has ? { ...base, signedIn: true, kind: "api-key", health: "ok" } : base;
    }
    if (p.type !== "oauth" || typeof p.access !== "string" || !p.access) return base;

    const expiresAt = typeof p.expires === "number" && Number.isFinite(p.expires) ? p.expires : null;
    const expiresInMs = expiresAt === null ? null : expiresAt - now;
    const expired = expiresInMs !== null && expiresInMs <= 0;
    const hasRefresh = typeof p.refresh === "string" && p.refresh.length > 0;
    const expiring = expiresInMs !== null && expiresInMs <= expiringMs;
    let health = expired ? "expired" : expiring ? "expiring" : "ok";
    if (lastError && (expired || expiring)) health = "refresh-failed";
    const terminal = Boolean(lastError && st.terminal === true && st.terminalExpiresAt === expiresAt);
    // A healthy grant (not expired, not expiring) postdates any recorded failure, e.g. a
    // fresh sign-in after a revoked refresh token: showing the old error made a working
    // sign-in look broken.
    const stale = health === "ok";
    return {
      ...base, signedIn: true, kind: "oauth", expiresAt, expired, expiresInMs, hasRefresh, health, terminal,
      lastError: stale ? null : lastError,
      errorKind: stale ? null : base.errorKind,
    };
  });
}
