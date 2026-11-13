import test from "node:test";
import assert from "node:assert/strict";
import { parseProfilePayload, planLabel, createIdentityStore } from "./plan-usage.mjs";

test("profile: full Max payload -> email, name, plan label; personal org name is dropped", () => {
  const p = parseProfilePayload({ account: { email: "a@example.com", display_name: "Ann", full_name: "Ann B", has_claude_max: true }, organization: { name: "a@example.com's Organization", organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } });
  assert.deepEqual(p, { email: "a@example.com", name: "Ann", org: null, plan: "Max 20x" });
  assert.equal(parseProfilePayload({ account: { email: "a@x.io" }, organization: { name: "Acme Labs", organization_type: "claude_team" } }).org, "Acme Labs");
});
test("profile: plan labels and missing fields", () => {
  assert.equal(planLabel({}, { rate_limit_tier: "default_claude_max_5x" }), "Max 5x");
  assert.equal(planLabel({ has_claude_max: true }, {}), "Max");
  assert.equal(planLabel({ has_claude_pro: true }, {}), "Pro");
  assert.equal(planLabel({}, { organization_type: "claude_team" }), "Team");
  assert.equal(planLabel({}, { organization_type: "claude_enterprise" }), "Enterprise");
  assert.equal(planLabel({}, {}), null);
  assert.deepEqual(parseProfilePayload({ account: { email: "a@x.io" } }), { email: "a@x.io", name: null, org: null, plan: null });
});
test("profile: garbage never throws and yields no identity", () => {
  for (const v of [null, undefined, 5, "x", [], {}, { account: 5, organization: [] }, { account: { email: "a\nb@x" } }]) assert.equal(parseProfilePayload(v), null);
});
test("identity store: non-200 or a throwing fetch -> null, cached; refetch on token change; 10 min cache", async () => {
  let n = 0, tok = "tok-AAAAAAAA", t = 0;
  const ok = async () => { n++; return { ok: true, data: { account: { email: "a@x.io" } } }; };
  const s = createIdentityStore({ now: () => t, getToken: () => tok, fetchProfile: ok });
  assert.equal((await s.read()).email, "a@x.io"); await s.read(); assert.equal(n, 1);
  t += 11 * 60e3; await s.read(); assert.equal(n, 2);
  tok = "tok-BBBBBBBB"; await s.read(); assert.equal(n, 3);
  const bad = createIdentityStore({ getToken: () => "t", fetchProfile: async () => ({ ok: false, status: 404, data: null }) });
  assert.equal(await bad.read(), null);
  const boom = createIdentityStore({ getToken: () => "t", fetchProfile: async () => { throw new Error("net"); } });
  assert.equal(await boom.read(), null);
  assert.equal(await createIdentityStore({ getToken: () => null, fetchProfile: ok }).read(), null);
});

test("identity store peek(): never waits; null until the first fetch for this token lands, then the identity; stale -> old value + background refresh; a failed refresh keeps the last good identity for the same token", async () => {
  let t = 0, tok = "tok-AAAAAAAA", n = 0, release = null, fail = false;
  const fetchProfile = () => { n++; return new Promise((res, rej) => { release = () => (fail ? rej(new Error("net")) : res({ ok: true, data: { account: { email: `u${n}@x.io` } } })); }); };
  const s = createIdentityStore({ now: () => t, getToken: () => tok, fetchProfile });
  assert.equal(s.peek(), null); assert.equal(n, 1, "peek starts a fetch");
  assert.equal(s.peek(), null); assert.equal(n, 1, "one fetch in flight at a time");
  release(); await new Promise((r) => setImmediate(r));
  assert.equal(s.peek().email, "u1@x.io"); assert.equal(n, 1, "fresh: no refetch");
  t += 11 * 60e3;                                  // past the 10 min cache
  assert.equal(s.peek().email, "u1@x.io", "stale value served at once"); assert.equal(n, 2, "and refreshed in the background");
  fail = true; release(); await new Promise((r) => setImmediate(r));
  assert.equal(s.peek().email, "u1@x.io", "a failed refresh keeps the last good identity for the same token");
  tok = "tok-BBBBBBBB";
  assert.equal(s.peek(), null, "another token never shows the old account");
});
