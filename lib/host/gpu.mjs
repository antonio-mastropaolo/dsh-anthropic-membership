/**
 * Client for the configured GPU server (an OpenAI-compatible switch shim; see README "GPU server").
 * The base URL comes from config.json (lib/config.mjs) on every call. Server-side only: no Origin is sent.
 */
import { loadConfig } from "../config.mjs";
import { redactSecrets } from "../accounts/errors.mjs";

export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** Validate a pin: 1-64 unique GPU indices 0..63 (the GPU server rejects indices it does not have).
 *  Returns the sorted array, undefined (absent), or throws a 400 error. */
export function parseGpus(v) {
  if (v === undefined || v === null) return undefined;
  const bad = () => { const e = new Error("gpus must be 1-64 unique integers in 0..63"); e.status = 400; return e; };
  if (!Array.isArray(v) || v.length < 1 || v.length > 64) throw bad();
  const seen = new Set();
  for (const g of v) {
    if (!Number.isInteger(g) || g < 0 || g > 63 || seen.has(g)) throw bad();
    seen.add(g);
  }
  return [...v].sort((a, b) => a - b);
}

/**
 * `base` pins a fixed URL (tests); otherwise `getConfig()` is consulted per call so config edits apply live.
 * With no GPU server configured every call resolves to 409 {error:"no GPU server configured"}.
 */
const ERROR_KEYS = new Set(["error", "errors", "detail", "details", "message", "reason"]);
const MAX_DEPTH = 32;
/**
 * Redact a GPU server reply in place, at any HTTP status: every string anywhere under an error-bearing key
 * (error/errors/detail/details/message/reason, including inside arrays and nested objects) goes through the
 * redactor. Iterative, so a deeply nested reply cannot overflow the stack; anything nested deeper than 32 levels
 * is replaced, never passed through unchecked.
 */
export function redactErrorFields(root) {
  if (!root || typeof root !== "object") return root;
  const stack = [[root, false, 0]];
  while (stack.length) {
    const [node, inError, depth] = stack.pop();
    for (const k of Object.keys(node)) {
      const x = node[k];
      const err = inError || (!Array.isArray(node) && ERROR_KEYS.has(k));
      if (typeof x === "string") { if (err) node[k] = redactSecrets(x); }
      else if (x && typeof x === "object") {
        if (depth >= MAX_DEPTH) node[k] = "[omitted: nested too deep]";
        else stack.push([x, err, depth + 1]);
      }
    }
  }
  return root;
}

export function createGpuClient({ base, getConfig = () => loadConfig(), fetchImpl = globalThis.fetch } = {}) {
  async function call(method, path, body, timeoutMs) {
    const url = base ?? getConfig()?.gpuServer?.url;
    if (!url) return { status: 409, body: { ok: false, configured: false, error: "no GPU server configured" } };
    let res;
    try {
      res = await fetchImpl(`${url}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { status: 502, body: { ok: false, error: `GPU server unreachable (${e?.name === "TimeoutError" ? "timeout" : "connection failed"})` } };
    }
    let parsed;
    try {
      parsed = await res.json();
    } catch {
      return { status: 502, body: { ok: false, error: `GPU server returned non-JSON (HTTP ${res.status})` } };
    }
    if (parsed === null || typeof parsed !== "object") parsed = { value: parsed };
    return { status: res.status, body: redactErrorFields(parsed) };
  }
  return {
    async gpus() {
      const r = await call("GET", "/v1/gpus", undefined, 20000);
      // process command lines can carry flags like --api-key: redact before anything shows or stores them
      if (Array.isArray(r.body?.gpus)) {
        for (const g of r.body.gpus) {
          if (!Array.isArray(g?.processes)) continue;
          for (const p of g.processes) if (p && typeof p === "object" && "cmd" in p) p.cmd = redactSecrets(Array.isArray(p.cmd) ? p.cmd.join(" ") : p.cmd);
        }
      }
      return r;
    },
    async models() {
      const r = await call("GET", "/v1/models", undefined, 10000);
      if (r.status !== 200 || !Array.isArray(r.body?.data)) return r;
      return {
        status: 200,
        body: { models: r.body.data.map((m) => ({ id: String(m.id), loaded: Boolean(m.loaded), owner: String(m.owned_by ?? "") })) },
      };
    },
    /** opts: { force } overrides the server's 300 s lease; { auto } clears a GPU pin (cannot combine with gpus). */
    switch(model, gpus, { force = false, auto = false } = {}) {
      const body = { model };
      if (gpus) body.gpus = gpus;
      if (auto && !gpus) body.auto = true;
      if (force) body.force = true;
      return call("POST", "/v1/switch", body, 30000);
    },
    unload: () => call("POST", "/v1/unload", {}, 30000),
    health: () => call("GET", "/health", undefined, 5000),
  };
}

/** Human message from a GPU server reply body: always a string. Handles {error:"x"}, {error:{message}}, {detail:{error:{message}}}, {detail:"x"}. */
export function errMessage(b) {
  const pick = (v, depth = 0) => {
    if (typeof v === "string") return v.trim() || null;
    if (!v || typeof v !== "object" || depth > 4) return null;
    return pick(v.message, depth + 1) ?? pick(v.error, depth + 1) ?? pick(v.detail, depth + 1);
  };
  const m = pick(b?.error) ?? pick(b?.detail) ?? pick(b?.message);
  if (m) return redactSecrets(m.slice(0, 300));
  const raw = b?.error ?? b?.detail;
  if (raw !== undefined && raw !== null) { try { return redactSecrets(JSON.stringify(raw).slice(0, 300)); } catch { /* fallthrough */ } }
  return "unknown error";
}
