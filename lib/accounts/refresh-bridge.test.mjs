import test from "node:test";
import assert from "node:assert/strict";
import { makeRefresher, credentialStoreOver } from "./refresh-bridge.mjs";

function fakeCreds(initial) {
  const recs = new Map(Object.entries(initial));
  return {
    recs,
    async readRecord(k) { return recs.get(k); },
    async listRecords() { return [...recs].map(([key, r]) => ({ key, kind: r.kind })); },
    async modifyRecord(k, fn) { const n = await fn(recs.get(k)); if (n !== undefined) recs.set(k, n); return recs.get(k); },
    async deleteRecord(k) { recs.delete(k); },
  };
}
const grant = (over = {}) => ({ kind: "grant", payload: { type: "oauth", access: "A", refresh: "R", expires: 1000, ...over } });

test("returns null when no credential seam is reachable", () => {
  assert.equal(makeRefresher({}), null);
  assert.equal(makeRefresher(undefined), null);
  assert.equal(makeRefresher({ get: () => undefined }), null);
  assert.equal(makeRefresher({ credentials: { readRecord() {} } }), null);
});

test("finds the seam via ctx.get or ctx.credentials", () => {
  const c = fakeCreds({});
  assert.equal(typeof makeRefresher({ get: (n) => (n === "credentials" ? c : undefined) }), "function");
  assert.equal(typeof makeRefresher({ credentials: c }), "function");
});

test("refreshes through the seam's modifyRecord and rotates the stored grant", async () => {
  const c = fakeCreds({ "llm-pi-ai/anthropic": grant() });
  let sawCurrent;
  const piAi = {
    async provider() { return { auth: { oauth: {} } }; },
    async refreshStoredOAuthCredential(store, id, oauth, need) {
      return store.modify(id, async (cur) => {
        sawCurrent = cur;
        return need(cur) ? { ...cur, access: "A2", refresh: "R2", expires: Date.now() + 3.6e6 } : undefined;
      });
    },
  };
  const r = makeRefresher({ credentials: c }, { piAi });
  const out = await r("anthropic");
  assert.equal(out.ok, true);
  assert.equal(sawCurrent.refresh, "R");
  assert.equal(c.recs.get("llm-pi-ai/anthropic").payload.access, "A2");
  assert.equal(c.recs.get("llm-pi-ai/anthropic").kind, "grant");
});

test("not-due grant is left untouched (mutate returns undefined)", async () => {
  const far = Date.now() + 86400e3;
  const c = fakeCreds({ "llm-pi-ai/anthropic": grant({ expires: far }) });
  const piAi = {
    async provider() { return { auth: { oauth: {} } }; },
    async refreshStoredOAuthCredential(store, id, oauth, need) {
      return store.modify(id, async (cur) => (need(cur) ? { ...cur, access: "X" } : undefined));
    },
  };
  await makeRefresher({ credentials: c }, { piAi })("anthropic");
  assert.equal(c.recs.get("llm-pi-ai/anthropic").payload.access, "A");
});

test("errors: unknown provider, signed out, no refresh token, upstream failure", async () => {
  const piAi = { async provider() { return { auth: { oauth: {} } }; }, async refreshStoredOAuthCredential() { throw new Error("oauth refresh failed"); } };
  const r = makeRefresher({ credentials: fakeCreds({ "llm-pi-ai/xai": grant({ refresh: "" }), "llm-pi-ai/anthropic": grant() }) }, { piAi });
  await assert.rejects(r("nope"), /unknown provider/);
  await assert.rejects(r("openrouter"), /sign in again/);
  await assert.rejects(r("xai"), /no refresh token/);
  await assert.rejects(r("anthropic"), /oauth refresh failed/);
});

test("credentialStoreOver maps api-key records and lists only llm-pi-ai", async () => {
  const c = fakeCreds({ "llm-pi-ai/openrouter": { kind: "api-key", key: "k" }, "other/x": grant(), "llm-pi-ai/anthropic": grant() });
  const s = credentialStoreOver(c);
  assert.deepEqual(await s.read("openrouter"), { type: "api_key", key: "k" });
  assert.deepEqual((await s.list()).map((e) => e.providerId).sort(), ["anthropic", "openrouter"]);
});

test("a credentials provider disposed and replaced by DSH is never reused: resolved per refresh, one safe retry", async () => {
  const disposed = (name) => ({
    ...fakeCreds({ "llm-pi-ai/anthropic": grant() }),
    async modifyRecord(k) { throw new Error(`${name} is disposed: cannot modify "${k}"`); },
  });
  const fresh = fakeCreds({ "llm-pi-ai/anthropic": grant() });
  let mutations = 0;
  const piAi = {
    async provider() { return { auth: { oauth: {} } }; },
    async refreshStoredOAuthCredential(store, id, oauth, need) {
      return store.modify(id, async (cur) => { mutations++; return need(cur) ? { ...cur, access: "A2", refresh: "R2", expires: Date.now() + 3.6e6 } : undefined; });
    },
  };
  // 1) the provider seen at creation is disposed later; the next refresh resolves the current one
  let current = fakeCreds({ "llm-pi-ai/anthropic": grant() });
  const r = makeRefresher({ get: (n) => (n === "credentials" ? current : undefined) }, { piAi });
  current = fresh;
  assert.equal((await r("anthropic")).ok, true);
  assert.equal(fresh.recs.get("llm-pi-ai/anthropic").payload.access, "A2");
  // 2) disposed between resolving and writing: DSH refuses before the mutation runs; one retry on the new provider
  const fresh2 = fakeCreds({ "llm-pi-ai/anthropic": grant() });
  let calls = 0;
  const r2 = makeRefresher({ get: (n) => (n === "credentials" ? (calls++ === 1 ? disposed("credentials-local") : fresh2) : undefined) }, { piAi });
  mutations = 0;
  assert.equal((await r2("anthropic")).ok, true);
  assert.equal(mutations, 1, "the mutation (the network refresh) ran exactly once");
  assert.equal(fresh2.recs.get("llm-pi-ai/anthropic").payload.access, "A2");
  // 3) any other error is not retried
  const boom = { ...fakeCreds({ "llm-pi-ai/anthropic": grant() }), async modifyRecord() { throw new Error("lock timeout"); } };
  await assert.rejects(makeRefresher({ credentials: boom }, { piAi })("anthropic"), /lock timeout/);
});
