// lib/demo/gpu.mjs: an in-process fake GPU server that answers the README "What a GPU server must implement" contract
// at the fetch layer of the REAL createGpuClient. No listener, no socket, no module that could open one: the client
// calls the function below instead of the network. State is per instance and lives in memory only.
import { createGpuClient } from "../host/gpu.mjs";
import { DEMO_GPU_ID } from "./constants.mjs";

const TOTAL_MIB = 49152;
const LEASE_S = 300;
const GPU_COUNT = 4;
const LOADED_DEFAULT = "demo-qwen-32b";
const MODELS = Object.freeze([
  { id: "demo-qwen-32b", owned_by: DEMO_GPU_ID },
  { id: "demo-llama-70b", owned_by: DEMO_GPU_ID },
  { id: "demo-small-8b", owned_by: DEMO_GPU_ID },
  { id: "mac-demo-8b", owned_by: "mac" },
]);

const reply = (status, body) => ({ status, ok: status < 400, json: async () => JSON.parse(JSON.stringify(body)) });

/** (url, init) => Promise<{status, json()}>; the documented contract, served from memory. */
export function createDemoGpuFetch({ now = Date.now } = {}) {
  let loaded = LOADED_DEFAULT;
  let loadedGpus = [0, 1];
  let pin = null;
  let leaseUntil = 0;
  const reservations = [{ owner: "demo-batch-run", gpus: "3", stale: false }, { owner: "demo-old-run", gpus: "all", stale: true }];
  const reservedBy = (i) => reservations.filter((r) => r.gpus === String(i)).map((r) => r.owner);

  const gpusBody = () => ({
    ok: true,
    manager: { active: true },
    tier: 4,
    loaded_model: loaded,
    state_age_s: 3,
    stale: false,
    gpus: Array.from({ length: GPU_COUNT }, (_, index) => {
      const mine = loaded !== null && loadedGpus.includes(index);
      const owners = reservedBy(index);
      return {
        index,
        used_mib: mine ? 41200 : owners.length ? 18400 : 0,
        total_mib: TOTAL_MIB,
        util_pct: mine ? 37 : owners.length ? 91 : 0,
        processes: mine ? [{ user: "demo", cmd: `vllm serve ${loaded}`, used_mib: 41200 }] : [],
        reserved_by: owners,
        reservation_stale: false,
      };
    }),
    reservations: reservations.map((r) => ({ ...r })),
    ...(pin ? { pin: { gpus: [...pin], error: null } } : {}),
  });

  const modelsBody = () => ({ data: MODELS.map((m) => ({ id: m.id, loaded: m.owned_by === "mac" ? true : m.id === loaded, owned_by: m.owned_by })) });

  function doSwitch(b) {
    const model = typeof b?.model === "string" ? b.model : "";
    const entry = MODELS.find((m) => m.id === model);
    if (!entry) return reply(400, { error: `unknown model: ${model.slice(0, 80)}` });
    if (entry.owned_by !== DEMO_GPU_ID) return reply(400, { error: `${model} is served by ${entry.owned_by}, not by this GPU server` });
    let wanted = null;
    if (b.gpus !== undefined) {
      const g = b.gpus;
      const ok = Array.isArray(g) && g.length >= 1 && g.length <= GPU_COUNT && new Set(g).size === g.length && g.every((x) => Number.isInteger(x) && x >= 0 && x < GPU_COUNT);
      if (!ok) return reply(400, { error: `gpus must be 1-${GPU_COUNT} unique indices in 0..${GPU_COUNT - 1}` });
      wanted = [...g].sort((x, y) => x - y);
    }
    const t = now();
    if (t < leaseUntil && b.force !== true) return reply(409, { error: "lease held (demo): retry or force" });
    const free = [0, 1, 2, 3].filter((i) => reservedBy(i).length === 0);
    if (wanted && wanted.some((i) => reservedBy(i).length) && b.force !== true) return reply(503, { error: "a requested GPU is reserved (demo)" });
    if (b.auto === true) pin = null;
    if (wanted) pin = wanted;
    const use = wanted ?? pin ?? free.slice(0, 2);
    loaded = model;
    loadedGpus = [...use];
    leaseUntil = t + LEASE_S * 1000;
    return reply(200, { status: "loaded", gpus: [...use] });
  }

  return async function demoGpuFetch(url, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    let path;
    try { path = new URL(String(url)).pathname; } catch { return reply(400, { error: "bad url" }); }
    let body;
    if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { return reply(400, { error: "body is not JSON" }); } }
    if (method === "GET" && path === "/v1/gpus") return reply(200, gpusBody());
    if (method === "GET" && path === "/v1/models") return reply(200, modelsBody());
    if (method === "GET" && path === "/health") return reply(200, { status: "ok" });
    if (method === "POST" && path === "/v1/switch") return doSwitch(body && typeof body === "object" ? body : {});
    if (method === "POST" && path === "/v1/unload") { loaded = null; loadedGpus = []; leaseUntil = 0; return reply(200, { status: "unloaded" }); }
    return reply(404, { error: "not found" });
  };
}

/** The real GPU client, wired to the fake. */
export function createDemoGpuClient(opts) {
  return createGpuClient({ base: "http://demo-gpu.invalid", fetchImpl: createDemoGpuFetch(opts) });
}
