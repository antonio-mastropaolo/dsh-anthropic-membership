import { strict as assert } from "node:assert";
import { countEventsInWindow } from "./dsh-messages.mjs";

const events = [
  {
    type: "user/message",
    time: 1000,
    data: { source: { kind: "user" } },
  },
  {
    type: "user/message",
    time: 1500,
    data: { source: { kind: "goal" } },
  },
  {
    type: "user/message",
    time: 2000,
    data: { source: { kind: "user" } },
  },
  {
    type: "user/message",
    time: 50,
    data: { source: { kind: "user" } },
  },
  {
    type: "request/header",
    time: 1100,
    data: { header: { config: { provider: "anthropic", model: "claude-opus-4-8" } } },
  },
  {
    type: "request/header",
    time: 1200,
    data: { header: { config: { provider: "openai-codex" } } },
  },
  {
    type: "request/header",
    time: 2100,
    data: { header: { config: { provider: "anthropic" } } },
  },
];

const c = countEventsInWindow(events, { sinceMs: 900, untilMs: 3000 });
assert.equal(c.messages, 2);
assert.equal(c.modelCalls, 2);
console.log("pass");

// DSH 0.2.2 writes session.v4.jsonl.zstd; Node's built-in zstd decodes it (no zstd program needed)
{
  const { countDshWindow } = await import("./dsh-messages.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const zlib = (await import("node:zlib")).default;
  const root = mkdtempSync(join(tmpdir(), "dsh-sessions-"));
  const dir = join(root, "--ws--", "session-abc");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const lines = [
    { type: "user/message", time: now - 1000, data: { source: { kind: "user" } } },
    { type: "user/message", time: now - 900, data: { source: { kind: "skill-catalog" } } },
    { type: "request/header", time: now - 800, data: { header: { config: { provider: "anthropic" } } } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n";
  if (typeof zlib.zstdCompressSync === "function") {
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(lines)));
    assert.deepEqual(countDshWindow({ sessionsRoot: root, sinceMs: now - 60_000, untilMs: now }), { messages: 1, modelCalls: 1 });
  }
  // a log that cannot be decoded makes the counts unknown, never 0
  writeFileSync(join(dir, "session.v4.jsonl.zstd"), "not zstd");
  const unknown = countDshWindow({ sessionsRoot: root, sinceMs: now - 60_000, untilMs: now, decode: () => null });
  assert.equal(unknown.messages, null);
  assert.equal(unknown.modelCalls, null);
}

// DSH appends one zstd frame per write: every frame is decoded (Node's decoder alone stops after the first)
{
  const { zstdDecodeAll, zstdFrameLength } = await import("./dsh-messages.mjs");
  const zlib = (await import("node:zlib")).default;
  if (typeof zlib.zstdCompressSync === "function") {
    const parts = ["a\n", "b".repeat(200000) + "\n", "c\n"];
    const file = Buffer.concat(parts.map((p) => zlib.zstdCompressSync(Buffer.from(p))));
    assert.equal(zstdDecodeAll(file), parts.join(""), "all three frames");
    const skippable = Buffer.alloc(12); skippable.writeUInt32LE(0x184d2a50, 0); skippable.writeUInt32LE(4, 4);
    assert.equal(zstdDecodeAll(Buffer.concat([skippable, file])), parts.join(""), "a skippable frame is skipped");
    assert.equal(zstdDecodeAll(file.subarray(0, file.length - 2)), null, "a cut-off last frame is reported, never read as partial text");
    assert.equal(zstdFrameLength(Buffer.from("not zstd"), 0), null);
  }
}
