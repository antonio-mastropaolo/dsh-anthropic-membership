/**
 * Plugin config: <dataDir>/config.json (+ env overrides). The ONLY place the GPU server URL is set.
 *
 *   { "gpuServer": { "id": "mybox", "name": "My GPU box", "url": "http://127.0.0.1:8000", "icon": "nvidia" } | null,
 *     "localProviders": ["mybox", "mac"],
 *     "hub": { "allowedOrigins": ["http://127.0.0.1:3200"] },        // extra UI origins for the host API
 *     "priceModels": ["google/gemini-3.8-flash"],                      // always-shown price rows (provider/model)
 *     "plans": { "ollama": { "name": "Pro", "includedUsd": 60, "resetsOnDay": 9 } },   // prepaid monthly credits
 *     "subscriptions": ["zai"],                                        // providers declared as subscription (not capped)
 *     "extraLedgers": ["/abs/path/spend.jsonl"],                       // other meters to show (display only)
 *     "guard": { "onError": "allow" | "block" } }                      // what the spend guard does when it fails itself (default allow)
 *
 * With no file and no env, gpuServer is null and localProviders is [] (GPU features off, nothing errors).
 * Never throws; a bad file or field yields defaults plus an entry in `errors`. The result is frozen and holds no secrets.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DEFAULT_DATA_DIR } from "./paths.mjs";
import { isPriceId, PRICE_ID_MAX } from "./cost/prices.mjs";

export { DEFAULT_DATA_DIR };
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;
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

  // hub.allowedOrigins: exact origins (scheme://host[:port], no path) the host API also accepts.
  const allowedOrigins = [];
  if (file.hub !== undefined) {
    const hub = file.hub && typeof file.hub === "object" && !Array.isArray(file.hub) ? file.hub : null;
    if (!hub) errors.push("hub must be an object");
    else if (hub.allowedOrigins !== undefined) {
      if (!Array.isArray(hub.allowedOrigins) || hub.allowedOrigins.length > 20) errors.push("hub.allowedOrigins must be an array of at most 20 origins");
      else for (const o of hub.allowedOrigins) {
        let ok = false;
        try { ok = typeof o === "string" && ORIGIN_RE.test(o) && new URL(o).origin === o; } catch { ok = false; }
        if (ok) { if (!allowedOrigins.includes(o)) allowedOrigins.push(o); }
        else errors.push("hub.allowedOrigins entries must be exact origins like http://127.0.0.1:3200");
      }
    }
  }
  // priceModels: provider/model ids always shown in the Costs panel's price list.
  const priceModels = [];
  if (file.priceModels !== undefined) {
    if (!Array.isArray(file.priceModels) || file.priceModels.length > 50) errors.push("priceModels must be an array of at most 50 provider/model ids");
    else for (const m of file.priceModels) {
      if (isPriceId(m)) { if (!priceModels.includes(m)) priceModels.push(m); }
      else errors.push(`priceModels entries must look like provider/model (at most ${PRICE_ID_MAX} characters)`);
    }
  }
  // extraLedgers: absolute paths of other spend ledgers (JSONL) shown next to DSH's own spend; display only.
  const extraLedgers = [];
  if (file.extraLedgers !== undefined) {
    if (!Array.isArray(file.extraLedgers) || file.extraLedgers.length > 10) errors.push("extraLedgers must be an array of at most 10 absolute paths");
    else for (const f of file.extraLedgers) {
      if (typeof f === "string" && isAbsolute(f) && f.length < 1024 && !CTRL_RE.test(f)) { if (!extraLedgers.includes(f)) extraLedgers.push(f); }
      else errors.push("extraLedgers entries must be absolute paths");
    }
  }
  // plans: prepaid monthly credits per provider. Calls within includedUsd in the current cycle are billed "credits"
  // ($0, not capped); resetsOnDay (1-31) is clamped to the month's last day when the cycle is computed.
  const plans = Object.create(null);
  if (file.plans !== undefined) {
    if (!file.plans || typeof file.plans !== "object" || Array.isArray(file.plans)) errors.push("plans must be an object keyed by provider id");
    else {
      let n = 0;
      for (const [p, v] of Object.entries(file.plans)) {
        if (++n > 20) { errors.push("plans: at most 20 plans, the rest ignored"); break; }
        if (!SLUG_RE.test(p)) { errors.push("plans keys must match [a-z0-9][a-z0-9-]{0,39}"); continue; }
        const o = v && typeof v === "object" && !Array.isArray(v) ? v : null;
        if (!o) { errors.push(`plans.${p} must be an object`); continue; }
        const problems = [];
        if (typeof o.name !== "string" || !NAME_RE.test(o.name) || CTRL_RE.test(o.name)) problems.push(`plans.${p}.name must be 1-40 printable characters`);
        if (typeof o.includedUsd !== "number" || !Number.isFinite(o.includedUsd) || o.includedUsd < 0) problems.push(`plans.${p}.includedUsd must be a number >= 0`);
        if (!Number.isInteger(o.resetsOnDay) || o.resetsOnDay < 1 || o.resetsOnDay > 31) problems.push(`plans.${p}.resetsOnDay must be an integer 1-31`);
        if (problems.length) errors.push(...problems);
        else plans[p] = Object.freeze({ name: o.name, includedUsd: o.includedUsd, resetsOnDay: o.resetsOnDay });
      }
    }
  }
  // subscriptions: provider ids declared as subscription-billed. A provider that is also in localProviders stays local.
  const subscriptions = [];
  if (file.subscriptions !== undefined) {
    if (!Array.isArray(file.subscriptions) || file.subscriptions.length > 50) errors.push("subscriptions must be an array of at most 50 provider ids");
    else for (const p of file.subscriptions) {
      if (typeof p !== "string" || !SLUG_RE.test(p)) errors.push("subscriptions entries must match [a-z0-9][a-z0-9-]{0,39}");
      else if (local.includes(p)) errors.push(`subscriptions: ${p} is also in localProviders; it stays local`);
      else if (!subscriptions.includes(p)) subscriptions.push(p);
    }
  }
  // guard.onError: what the spend guard does when it throws internally. allow (default) lets the request through,
  // block returns the request as a spend-cap stop. Either way the exception is counted (GET /status guard).
  let guardOnError = "allow";
  if (file.guard !== undefined) {
    const g = file.guard && typeof file.guard === "object" && !Array.isArray(file.guard) ? file.guard : null;
    if (!g) errors.push("guard must be an object");
    else if (g.onError !== undefined) {
      if (g.onError === "allow" || g.onError === "block") guardOnError = g.onError;
      else errors.push('guard.onError must be "allow" or "block"');
    }
  }
  return Object.freeze({
    gpuServer, localProviders: Object.freeze(local),
    guard: Object.freeze({ onError: guardOnError }),
    plans: Object.freeze(plans), subscriptions: Object.freeze(subscriptions),
    hub: Object.freeze({ allowedOrigins: Object.freeze(allowedOrigins) }),
    priceModels: Object.freeze(priceModels), extraLedgers: Object.freeze(extraLedgers),
    errors: Object.freeze(errors),
  });
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
  let parsed = false; // a document was read and parsed (its value may itself be null)
  if (mtime >= 0 || readFile) {
    try {
      const text = (readFile || ((p) => readFileSync(p, "utf8")))(path);
      if (text !== undefined && text !== null) { raw = JSON.parse(String(text)); parsed = true; }
    } catch (e) {
      if (e?.code !== "ENOENT") errors.push(`config.json unreadable: ${e instanceof SyntaxError ? "invalid JSON" : "read error"}`);
    }
  }
  if (parsed && (raw === null || typeof raw !== "object" || Array.isArray(raw))) errors.push("config.json must be a JSON object: ignored");
  const value = build(raw, env, errors);
  // never cache a parse failure: a config.json caught mid-write would otherwise stay "broken" for that mtime
  const parseFailed = errors.some((e) => e.startsWith("config.json unreadable"));
  if (canCache && !parseFailed) { cache.set(path, { sig, value }); if (cache.size > 32) cache.delete(cache.keys().next().value); }
  return value;
}
