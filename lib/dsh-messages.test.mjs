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
