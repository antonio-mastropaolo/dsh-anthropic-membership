import test from "node:test";
import assert from "node:assert/strict";
import { createLegacy } from "./legacy.mjs";

const features = { imageCap: () => true, compactionSlim: () => true, spendGuard: () => true };
const NOW = 2e12;

function mkLegacy({ expiresAt, codex, signedIn = true }) {
  let reads = 0;
  const legacy = createLegacy({
    features,
    deps: {
      now: () => NOW,
      status: () => ({ signedIn, expiresAt }),
      readAccounts: () => [codex],
      planStore: { read: async () => { reads++; return { mode: "subscription", httpStatus: 200 }; } },
    },
  });
  return { legacy, reads: () => reads };
}

test("expired Anthropic grant: no usage API call, plan.mode expired with expiresAt", async () => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  const { legacy, reads } = mkLegacy({ expiresAt: NOW - 53 * 864e5, codex: { signedIn: false, expired: false } });
  const s = await legacy.status();
  assert.deepEqual(s.plan, { mode: "expired", expiresAt: NOW - 53 * 864e5 });
  assert.equal(s.signedIn, true);
  assert.equal(reads(), 0);
  assert.ok(!("access" in s), "the Full access switch is gone from /status");
});

test("live grant still reads plan usage; codex.available follows the openai-codex grant", async () => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  let r = mkLegacy({ expiresAt: NOW + 1e6, codex: { signedIn: true, expired: false } });
  let s = await r.legacy.status();
  assert.equal(s.plan.mode, "subscription");
  assert.equal(r.reads(), 1);
  assert.deepEqual(s.codex, { available: true });
  r = mkLegacy({ expiresAt: NOW + 1e6, codex: { signedIn: true, expired: true } });
  assert.deepEqual((await r.legacy.status()).codex, { available: false });
  r = mkLegacy({ expiresAt: null, codex: undefined });
  assert.deepEqual((await r.legacy.status()).codex, { available: false });
});

test("the plan card follows the credential DSH sends: a route API key wins; an env key only when nothing is stored", async () => {
  const mkL = ({ signedIn, routeKey }) => createLegacy({ features, deps: {
    now: () => NOW, status: () => ({ signedIn, expiresAt: NOW + 1e6 }), readAccounts: () => [],
    planStore: { read: async () => ({ mode: "subscription", httpStatus: 200 }) }, routeUsesApiKey: () => routeKey,
  } });
  process.env.ANTHROPIC_API_KEY = "sk-ant-demo-not-real";
  try {
    assert.equal((await mkL({ signedIn: true, routeKey: false }).status()).plan.mode, "subscription", "a stored grant owns the provider");
    assert.equal((await mkL({ signedIn: false, routeKey: false }).status()).plan.mode, "api", "nothing stored: the env key is used");
  } finally { delete process.env.ANTHROPIC_API_KEY; }
  assert.equal((await mkL({ signedIn: true, routeKey: true }).status()).plan.mode, "api", "the route names an API key");
});
