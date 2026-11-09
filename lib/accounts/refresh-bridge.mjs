/**
 * Refresh bridge: refresh an OAuth grant THROUGH DSH's own credential seam (ctx.credentials,
 * which holds the cross-process lock), using pi-ai's locked refresh. This module never writes
 * the credentials file itself. Returns null when the seam is not reachable (report-only).
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DSH_NM, OAUTH_PROVIDERS } from "./accounts.mjs";

const SCOPE = "llm-pi-ai";
const PROVIDER_FACTORY = {
  anthropic: ["anthropic", "anthropicProvider"],
  "openai-codex": ["openai-codex", "openaiCodexProvider"],
  "github-copilot": ["github-copilot", "githubCopilotProvider"],
  "kimi-coding": ["kimi-coding", "kimiCodingProvider"],
  openrouter: ["openrouter", "openrouterProvider"],
  xai: ["xai", "xaiProvider"],
};

function jsonImage(v) {
  if (Array.isArray(v)) return v.map((e) => (e === undefined ? null : jsonImage(e)));
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    for (const [k, m] of Object.entries(v)) if (m !== undefined) o[k] = jsonImage(m);
    return o;
  }
  return v;
}

/** pi-ai CredentialStore over ctx.credentials records (same mapping as DSH's llm-pi-ai adapter). */
export function credentialStoreOver(creds) {
  const key = (id) => `${SCOPE}/${id}`;
  const toPi = (rec) =>
    rec === undefined ? undefined
      : rec.kind === "api-key" ? { type: "api_key", ...(rec.key === undefined ? {} : { key: rec.key }), ...(rec.env === undefined ? {} : { env: { ...rec.env } }) }
        : rec.payload;
  const toRec = (c) =>
    c.type === "api_key" ? { kind: "api-key", ...(c.key === undefined ? {} : { key: c.key }), ...(c.env === undefined ? {} : { env: { ...c.env } }) }
      : { kind: "grant", payload: jsonImage(c) };
  return {
    async read(id) { return toPi(await creds.readRecord(key(id))); },
    async list() {
      const out = [];
      for (const e of (await creds.listRecords()) ?? []) {
        if (!String(e.key).startsWith(`${SCOPE}/`)) continue;
        out.push({ providerId: String(e.key).slice(SCOPE.length + 1), type: e.kind === "api-key" ? "api_key" : "oauth" });
      }
      return out;
    },
    async modify(id, mutate) {
      return toPi(await creds.modifyRecord(key(id), async (cur) => {
        const next = await mutate(toPi(cur));
        return next === undefined ? undefined : toRec(next);
      }));
    },
    async delete(id) { await creds.deleteRecord(key(id)); },
  };
}

async function loadPiAi(nm = DSH_NM) {
  if (!nm) throw new Error("DeepSeek Harness node_modules not found (set DSH_NODE_MODULES)");
  const base = join(nm, "@earendil-works/pi-ai/dist");
  const imp = (p) => import(pathToFileURL(join(base, p)).href);
  const [index, resolve] = await Promise.all([imp("index.js"), imp("auth/resolve.js")]);
  return {
    createModels: index.createModels,
    refreshStoredOAuthCredential: resolve.refreshStoredOAuthCredential,
    async provider(id) {
      const spec = PROVIDER_FACTORY[id];
      if (!spec) throw new Error(`no provider factory for ${id}`);
      const mod = await imp(`providers/${spec[0]}.js`);
      return mod[spec[1]]();
    },
  };
}

/**
 * @param {object} ctx cordis context (or anything exposing a `credentials` service)
 * @param {{piAi?:object, aheadMs?:number, timeoutMs?:number}} [opts] piAi is injectable for tests
 * @returns {null | ((provider:string)=>Promise<{ok:boolean}>)}
 */
export function makeRefresher(ctx, { piAi, aheadMs = 600000, timeoutMs = 60000 } = {}) {
  // DSH can dispose its credentials provider and register a new one while it runs ("disposing the mounting fiber
  // removes ctx.credentials"), so the seam is resolved again on every refresh, never kept from creation time.
  // ctx.get() returns only a provider whose fiber is active.
  const resolveCreds = () => {
    let c;
    try { c = (typeof ctx?.get === "function" ? ctx.get("credentials") : undefined) ?? ctx?.credentials; } catch { c = undefined; }
    return c && typeof c.modifyRecord === "function" && typeof c.readRecord === "function" ? c : null;
  };
  if (!resolveCreds()) return null;
  let pi;
  const attempt = async (provider) => {
    const creds = resolveCreds();
    if (!creds) throw new Error("DSH credential store not available right now");
    const store = credentialStoreOver(creds);
    const current = await store.read(provider);
    if (!current || current.type !== "oauth") throw new Error("no OAuth grant stored; sign in again");
    if (!current.refresh) throw new Error("grant has no refresh token; sign in again");
    const prov = await pi.provider(provider);
    const signal = AbortSignal.timeout(timeoutMs);
    const oauth = prov?.auth?.oauth;
    if (oauth && typeof pi.refreshStoredOAuthCredential === "function") {
      // Refresh under the store's lock when the grant is expired or within aheadMs of expiry.
      const next = await pi.refreshStoredOAuthCredential(store, provider, oauth, (c) => Date.now() + aheadMs >= c.expires, signal);
      return { ok: Boolean(next) };
    }
    const models = pi.createModels({ credentials: store });
    models.setProvider(prov);
    await models.getAuth(provider);
    return { ok: true };
  };
  // A provider disposed between resolving it and writing refuses BEFORE running the mutation (no token is spent),
  // so one retry against the newly registered provider is safe.
  const DISPOSED = /credentials[\w-]* (is|was) disposed/;
  return async function refresh(provider) {
    if (!OAUTH_PROVIDERS.includes(provider)) throw new Error(`unknown provider ${provider}`);
    pi ??= piAi ?? (await loadPiAi());
    try {
      return await attempt(provider);
    } catch (e) {
      if (!DISPOSED.test(String(e?.message || e))) throw e;
      return attempt(provider);
    }
  };
}

export const _internal = { loadPiAi };
