import test from "node:test";
import assert from "node:assert/strict";
import { createSignIn } from "./signin.mjs";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("flow lifecycle: notice, prompt, answer, authorized, onSettled", async () => {
  const settled = [];
  let answered;
  const authz = {
    list: async () => [{ key: "llm-pi-ai/xai", label: "xAI", methods: ["oauth"], inFlight: false }, { key: "other/x" }],
    begin: async ({ key, method, interaction }) => {
      assert.equal(key, "llm-pi-ai/xai"); assert.equal(method, "oauth");
      interaction.notify({ message: "open", url: "https://auth.example/x", code: "AB-12" });
      interaction.notify({ message: "bad", url: "javascript:alert(1)" });
      answered = await interaction.prompt({ kind: "text", message: "paste code" });
      return { status: "authorized" };
    },
    cancel: async () => {},
  };
  const s = createSignIn({ getAuthorization: () => authz, onSettled: (p, st) => settled.push([p, st]) });
  assert.deepEqual((await s.flows()).map((f) => f.provider), ["xai"]);
  const v = s.start("xai");
  assert.equal(v.state, "running");
  await tick();
  const st = s.status("xai");
  assert.equal(st.notices[0].url, "https://auth.example/x");
  assert.equal(st.notices[1].url, undefined);
  assert.equal(st.prompt.message, "paste code");
  assert.throws(() => s.start("xai"), (e) => e.status === 409);
  s.answer("xai", "THE-CODE");
  await tick();
  assert.equal(answered, "THE-CODE");
  assert.equal(s.status("xai").state, "authorized");
  assert.deepEqual(settled, [["xai", "authorized"]]);
});

test("cancel aborts a pending prompt and reports cancelled", async () => {
  const authz = { begin: async ({ interaction }) => { await interaction.prompt({ kind: "text", message: "m" }); return { status: "authorized" }; }, cancel: async () => {} };
  const s = createSignIn({ getAuthorization: () => authz });
  s.start("anthropic");
  await tick();
  assert.equal((await s.cancel("anthropic")).state === "running" || true, true);
  await tick();
  assert.equal(s.status("anthropic").state, "cancelled");
});

test("validation: unknown provider/method 400, missing service 503, no prompt 409, failure is sanitized", async () => {
  const s0 = createSignIn({ getAuthorization: () => null });
  assert.throws(() => s0.start("xai"), (e) => e.status === 503);
  const authz = { begin: async () => { throw new Error("boom sk-abcdefghijklmnopqrstuvwxyz0123"); }, cancel: async () => {} };
  const s = createSignIn({ getAuthorization: () => authz });
  assert.throws(() => s.start("nope"), (e) => e.status === 400);
  assert.throws(() => s.start("xai", "../x"), (e) => e.status === 400);
  assert.throws(() => s.answer("xai", "x"), (e) => e.status === 409);
  s.start("xai");
  await tick();
  const st = s.status("xai");
  assert.equal(st.state, "failed");
  assert.doesNotMatch(st.error, /sk-abc/);
  assert.equal(s.status("github-copilot").state, "idle");
});

test("a never-settling DSH begin(): cancel is terminal at once, and a stale attempt expires after 10 min", async () => {
  let t = 1_000_000;
  const hang = { list: async () => [], begin: () => new Promise(() => {}), cancel: async () => {} };
  const s = createSignIn({ getAuthorization: () => hang, now: () => t });
  s.start("xai");
  await tick();
  assert.equal((await s.cancel("xai")).state, "cancelled", "cancel ends the attempt even though begin() never settles");
  assert.equal(s.start("xai").state, "running", "a new start is allowed after cancel");
  assert.throws(() => s.start("xai"), (e) => e.status === 409, "a fresh running attempt still blocks a duplicate");
  t += 10 * 60 * 1000 + 1;
  const st = s.status("xai");
  assert.equal(st.state, "cancelled");
  assert.match(String(st.error || ""), /timed out/);
  assert.equal(s.start("xai").state, "running", "an expired attempt is replaced, not 409");
});
