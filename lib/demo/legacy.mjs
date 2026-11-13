// lib/demo/legacy.mjs: the demo's stand-in for the Claude plan/identity reader. Fixed gauges, no token, no network.
import { DEMO_IDENTITY } from "./constants.mjs";

const HOUR = 3600e3;
const DAY = 24 * HOUR;

export function createDemoLegacy({ manifest, features = {} } = {}) {
  const at = manifest.anchorMs;
  const identity = { ...DEMO_IDENTITY };
  return {
    async status() {
      return {
        signedIn: true,
        imageCap: false,
        compactionSlim: false,
        spendGuard: false,
        codex: { available: false },
        ...features,
        plan: {
          mode: "plan", httpStatus: 200, fetchedAt: at,
          fiveHour: { percent: 62, resetsAt: new Date(at + 2.5 * HOUR).toISOString() },
          sevenDay: { percent: 41, resetsAt: new Date(at + 3 * DAY).toISOString() },
          extraEnabled: false, messages: 37, modelCalls: 214,
        },
        identity,
        demo: true,
      };
    },
    async identities() { return { anthropic: { ...identity } }; },
  };
}
