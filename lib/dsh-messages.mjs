/** Count DSH user messages and Anthropic model calls in a time window. */

import { dshHome } from "./paths.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
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
      else if (/^session\.v\d+\.jsonl\.zstd$/.test(ent.name)) out.push(p); // DSH 0.2.2 writes v4
    }
  }
  return out;
}

/** Byte length of the zstd frame (or skippable frame) at `pos`, from its headers; null if the bytes are not one. */
export function zstdFrameLength(buf, pos) {
  if (pos + 4 > buf.length) return null;
  const magic = buf.readUInt32LE(pos);
  if ((magic & 0xfffffff0) === 0x184d2a50) return pos + 8 <= buf.length ? 8 + buf.readUInt32LE(pos + 4) : null; // skippable
  if (magic !== 0xfd2fb528) return null;
  let p = pos + 4;
  if (p >= buf.length) return null;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, didFlag = fhd & 3;
  p += (single ? 0 : 1) + [0, 1, 2, 4][didFlag] + [single ? 1 : 0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (p + 3 > buf.length) return null;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const type = (h >> 1) & 3, size = h >>> 3;
    if (type === 3) return null; // reserved block type: corrupt
    p += type === 1 ? 1 : size; // RLE blocks carry one byte
    if (p > buf.length) return null;
    if (h & 1) break; // last block
  }
  if (checksum) p += 4;
  return p <= buf.length ? p - pos : null;
}

/** All frames of a zstd file. DSH appends one frame per write, and Node's zstdDecompressSync decodes only the first
 *  frame of its input (and returns partial output for a cut-off one), so each frame is located and decoded alone. */
export function zstdDecodeAll(buf) {
  const parts = [];
  let pos = 0;
  while (pos < buf.length) {
    const len = zstdFrameLength(buf, pos);
    if (len === null) return null;
    if (buf.readUInt32LE(pos) === 0xfd2fb528) parts.push(zlib.zstdDecompressSync(buf.subarray(pos, pos + len), { maxOutputLength: 256 * 1024 * 1024 }));
    pos += len;
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Session log text, or null when it cannot be decoded: Node's built-in zstd (Node >= 22.15; DSH itself needs
 *  Node >= 24.9), frame by frame, else the `zstd` program. */
function decodeZstd(path) {
  if (typeof zlib.zstdDecompressSync === "function") {
    try { const t = zstdDecodeAll(readFileSync(path)); if (typeof t === "string") return t; }
    catch { /* fall through to the zstd program */ }
  }
  const r = spawnSync("zstd", ["-dc", path], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
}

export function countDshWindow({
  sessionsRoot = join(dshHome(), "sessions"),
  sinceMs,
  untilMs = Date.now(),
  decode = decodeZstd,
} = {}) {
  if (!Number.isFinite(sinceMs)) return { messages: 0, modelCalls: 0 };
  let messages = 0;
  let modelCalls = 0;
  // a session log that cannot be decoded makes the counts unknown (null), never a misleading 0
  for (const file of walkZstdLogs(sessionsRoot)) {
    try {
      if (statSync(file).mtimeMs < sinceMs) continue;
    } catch {
      continue;
    }
    const text = decode(file);
    if (typeof text !== "string") return { messages: null, modelCalls: null, unavailable: "session logs could not be decoded (zstd)" };
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
