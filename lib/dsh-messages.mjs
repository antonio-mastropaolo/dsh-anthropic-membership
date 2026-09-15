/** Count DSH user messages and Anthropic model calls in a time window. */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function countEventsInWindow(events, { sinceMs, untilMs = Infinity } = {}) {
  let messages = 0;
  let modelCalls = 0;
  for (const ev of events) {
    const t = ev?.time;
    if (typeof t !== "number" || t < sinceMs || t > untilMs) continue;
    if (ev.type === "user/message" && ev.data?.source?.kind === "user") messages += 1;
    if (ev.type === "request/header" && ev.data?.header?.config?.provider === "anthropic") {
      modelCalls += 1;
    }
  }
  return { messages, modelCalls };
}

function walkZstdLogs(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name === "session.v3.jsonl.zstd") out.push(p);
    }
  }
  return out;
}

function decodeZstd(path) {
  const r = spawnSync("zstd", ["-dc", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return "";
  return r.stdout || "";
}

export function countDshWindow({
  sessionsRoot = join(homedir(), ".dsh", "sessions"),
  sinceMs,
  untilMs = Date.now(),
  decode = decodeZstd,
} = {}) {
  if (!Number.isFinite(sinceMs)) return { messages: 0, modelCalls: 0 };
  let messages = 0;
  let modelCalls = 0;
  for (const file of walkZstdLogs(sessionsRoot)) {
    try {
      if (statSync(file).mtimeMs < sinceMs) continue;
    } catch {
      continue;
    }
    const text = decode(file);
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* skip bad line */
      }
    }
    const c = countEventsInWindow(events, { sinceMs, untilMs });
    messages += c.messages;
    modelCalls += c.modelCalls;
  }
  return { messages, modelCalls };
}
