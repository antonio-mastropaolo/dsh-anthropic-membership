import { strict as assert } from "node:assert";
import { slimCompactionMessages, installCompactionSlim } from "./compact-payload.mjs";

const huge = "x".repeat(12000);
const messages = [
  {
    role: "user",
    content: [
      { type: "text", text: "continue" },
      {
        type: "image",
        attachment: { name: "shot.png", width: 2449, height: 1712, attachmentId: "sha256:abcd" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "think ".repeat(5000) },
      { type: "text", text: "ok" },
      { type: "tool-call", name: "read", arguments: "{}" },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        content: [{ type: "text", text: huge }],
      },
    ],
  },
];

const slimmed = slimCompactionMessages(messages);
const blob = JSON.stringify(slimmed);
assert.ok(!blob.includes("think think"), "reasoning body must not be replayed");
assert.ok(!/2449/.test(JSON.stringify(slimmed[0].content.find((b) => b.type === "image") || {})), "image block must be gone");
assert.equal(
  slimmed[0].content.some((b) => b.type === "text" && /image omitted/i.test(b.text)),
  true,
);
assert.equal(
  slimmed[1].content.some((b) => b.type === "text" && /reasoning omitted/i.test(b.text)),
  true,
);
const toolText = slimmed[2].content[0].content[0].text;
assert.ok(toolText.length < huge.length, "tool result must shrink");
assert.ok(toolText.includes("truncated"), "truncation marker");
assert.ok(JSON.stringify(messages).includes("think think"), "original messages stay intact");

const seen = [];
const llm = {
  async *stream(options) {
    seen.push(options);
    yield { type: "text", text: "summary" };
  },
};
installCompactionSlim(llm);
const compacted = [];
for await (const chunk of llm.stream({ purpose: "compaction", messages })) {
  compacted.push(chunk);
}
assert.equal(seen.length, 1);
assert.equal(seen[0].purpose, "compaction");
assert.ok(!JSON.stringify(seen[0].messages).includes("think think"));
assert.equal(compacted[0].text, "summary");

seen.length = 0;
for await (const _ of llm.stream({ purpose: "agent", messages })) {
  /* drain */
}
assert.ok(JSON.stringify(seen[0].messages).includes("think think"), "non-compaction streams stay full");

console.log("pass");
