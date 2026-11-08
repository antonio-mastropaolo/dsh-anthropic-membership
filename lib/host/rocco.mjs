/** Client for the rocco switch shim (127.0.0.1:4010). Server-side only: no Origin is sent. */
export const SHIM_URL = process.env.ROCCO_SHIM_URL || "http://127.0.0.1:4010";

export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** Validate a pin: unique ints 0..3. Returns the array, undefined (absent), or throws a 400 error. */
export function parseGpus(v) {
  if (v === undefined || v === null) return undefined;
  const bad = () => { const e = new Error("gpus must be 1-4 unique integers in 0..3"); e.status = 400; return e; };
  if (!Array.isArray(v) || v.length < 1 || v.length > 4) throw bad();
  const seen = new Set();
  for (const g of v) {
    if (!Number.isInteger(g) || g < 0 || g > 3 || seen.has(g)) throw bad();
    seen.add(g);
  }
  return [...v].sort((a, b) => a - b);
}

export function createRoccoClient({ base = SHIM_URL, fetchImpl = globalThis.fetch } = {}) {
  async function call(method, path, body, timeoutMs) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { status: 502, body: { ok: false, error: `rocco shim unreachable (${e?.name === "TimeoutError" ? "timeout" : "connection failed"})` } };
    }
    let parsed;
    try {
      parsed = await res.json();
    } catch {
      return { status: 502, body: { ok: false, error: `rocco shim returned non-JSON (HTTP ${res.status})` } };
    }
    if (parsed === null || typeof parsed !== "object") parsed = { value: parsed };
    return { status: res.status, body: parsed };
  }
  return {
    gpus: () => call("GET", "/v1/gpus", undefined, 20000),
    async models() {
      const r = await call("GET", "/v1/models", undefined, 10000);
      if (r.status !== 200 || !Array.isArray(r.body?.data)) return r;
      return {
        status: 200,
        body: { models: r.body.data.map((m) => ({ id: String(m.id), loaded: Boolean(m.loaded), owner: String(m.owned_by ?? "") })) },
      };
    },
    /** opts: { force } overrides the shim's 300 s lease; { auto } clears a GPU pin (cannot combine with gpus). */
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

/** Human message from a shim reply body: always a string. Handles {error:"x"}, {error:{message}}, {detail:{error:{message}}}, {detail:"x"}. */
export function errMessage(b) {
  const pick = (v, depth = 0) => {
    if (typeof v === "string") return v.trim() || null;
    if (!v || typeof v !== "object" || depth > 4) return null;
    return pick(v.message, depth + 1) ?? pick(v.error, depth + 1) ?? pick(v.detail, depth + 1);
  };
  const m = pick(b?.error) ?? pick(b?.detail) ?? pick(b?.message);
  if (m) return m.slice(0, 300);
  const raw = b?.error ?? b?.detail;
  if (raw !== undefined && raw !== null) { try { return JSON.stringify(raw).slice(0, 300); } catch { /* fallthrough */ } }
  return "unknown error";
}
