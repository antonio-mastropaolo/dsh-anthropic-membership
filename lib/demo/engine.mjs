// lib/demo/engine.mjs: the cost engine on a demo folder: frozen clock, bundled offline prices, snapshot Ollama table,
// the folder's extra ledger. The facade's guard/record calls are inert, so nothing is recorded, capped or written.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { createCostEngine } from "../host/engine.mjs";
import { DEMO_OAUTH_PROVIDERS, demoLoadOllama, demoLoadTable } from "./prices.mjs";

/** env {} so DSH_HUB_GPU_URL and friends cannot redirect a demo. */
export const demoConfig = (dir) => loadConfig({ dataDir: dir, env: {} });

export function createDemoEngine({ dir, manifest }) {
  const real = createCostEngine({
    dataDir: dir,
    now: () => manifest.anchorMs,
    loadTable: demoLoadTable,
    loadOllama: demoLoadOllama,
    localProviders: () => demoConfig(dir).localProviders,
    plans: () => demoConfig(dir).plans,
    subscriptions: () => demoConfig(dir).subscriptions,
    oauthProviders: [...DEMO_OAUTH_PROVIDERS],
    externalLedger: () => [join(dir, "extra-ledger.jsonl")],
    logger: null,
  });
  return {
    ...real,
    guard: async () => ({ action: "ok" }),
    recordUsage: async () => null,
    recordProviderFailure: () => false,
    clearProviderHealth: () => {},
  };
}

/** Feed demo-cache.json through engine.onSessionEvent, in order (the collapse session last), so /cache shows it. */
export async function replayDemoCache(engine, dir) {
  const doc = JSON.parse(readFileSync(join(dir, "demo-cache.json"), "utf8"));
  for (const s of Array.isArray(doc?.sessions) ? doc.sessions : []) {
    for (const st of s.steps) {
      await engine.onSessionEvent({ id: s.sessionId }, { type: "assistant/message", data: { step: st.step, usage: st.usage, message: { source: { provider: s.provider, model: s.model } } } });
    }
  }
}
