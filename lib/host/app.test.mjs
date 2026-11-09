import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "./app.mjs";

test("a credential read failure resets subscription billing at once: a grant seen earlier is never reused", () => {
  let t = 1_000_000;
  let mode = "ok";
  const readAccountsFn = () => {
    if (mode === "fail") throw new Error("credentials unreadable");
    return [{ provider: "anthropic", signedIn: true, kind: "oauth" }, { provider: "openai", signedIn: true, kind: "api_key" }];
  };
  const hub = createHub({
    dataDir: mkdtempSync(join(tmpdir(), "hub-app-")), legacy: { status: async () => ({}) },
    engine: { onSessionEvent: async () => null }, now: () => t, readAccountsFn, refreshEnabled: false,
  });
  assert.deepEqual(hub.oauthProviders(), ["anthropic"], "only the OAuth grant counts");
  mode = "fail";
  assert.deepEqual(hub.oauthProviders(), ["anthropic"], "within the 30 s cache window the last answer stands");
  t += 30_001;
  assert.deepEqual(hub.oauthProviders(), [], "after it, a failed read means no subscription (metered)");
  mode = "ok"; t += 30_001;
  assert.deepEqual(hub.oauthProviders(), ["anthropic"], "a good read restores it");
  hub.stop();
});
