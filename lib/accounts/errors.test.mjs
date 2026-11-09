import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, sanitizeError } from "./errors.mjs";

test("redactSecrets covers the token shapes the plugin can meet", () => {
  const cases = [
    "sk-ant-oat01-ABCDEFGHIJ", "sk-or-v1-abcdef123456", "ghp_ABCDEFGH12345678", "ghu_abcdefgh12345678",
    "AIzaSyABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", "Bearer abc.def",
    "refresh_token=rt-123", "code=AUTHCODE42", "key=k123", "access_token=at_9",
    "a/Very/Long/Opaque/Value9/with/slashes", "0123456789abcdef0123456789abcdef01",
  ];
  for (const c of cases) {
    const out = redactSecrets(`before ${c} after`);
    assert.ok(!out.includes(c), `${c} -> ${out}`);
    assert.match(out, /before .*\[redacted\].* after/);
  }
  assert.equal(redactSecrets("plain short words stay"), "plain short words stay");
  for (const id of ["google/gemini-3.8-flash", "anthropic/claude-opus-5-5", "openrouter/anthropic/claude-sonnet-4.5", "dashscope/deepseek-v4-flash"])
    assert.equal(redactSecrets(`unknown model ${id}`), `unknown model ${id}`, `model id ${id} stays readable`);
});

test("sanitizeError never returns a token, a URL or more than ~160 chars", () => {
  const raw = "Anthropic refresh failed. url=https://console.anthropic.com/v1/oauth/token?code=abc; body={\"error\":\"invalid_grant\",\"token\":\"sk-ant-ort01-SECRETSECRETSECRET\"} " + "x ".repeat(200);
  const out = sanitizeError(new Error(raw));
  assert.ok(!/sk-ant|SECRET|https?:/.test(out), out);
  assert.ok(out.length <= 161);
});

test("redactSecrets: command-line secret flags (GPU process cmd) are redacted, the rest of the line stays", () => {
  const cmd = "python -m vllm.entrypoints.openai.api_server --model Qwen/Qwen3-8B --api-key hunter2 --hf-token=hf_abc --port 8003";
  const out = redactSecrets(cmd);
  assert.doesNotMatch(out, /hunter2|hf_abc/);
  assert.match(out, /--api-key \[redacted\]/);
  assert.match(out, /--hf-token=\[redacted\]/);
  assert.match(out, /--model Qwen\/Qwen3-8B --api-key/);
  assert.match(out, /--port 8003$/);
});
