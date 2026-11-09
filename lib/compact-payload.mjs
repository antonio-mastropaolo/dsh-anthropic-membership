/** Shrink a compaction LLM request so it can fit under the model context cap. */

const TOOL_RESULT_TEXT_CAP = 4000;
const TOOL_RESULT_HEAD = 3000;
const TOOL_RESULT_TAIL = 1000;

function imagePlaceholder(block) {
  const att = block?.attachment || {};
  const name = att.name || "image";
  const w = att.width ?? "?";
  const h = att.height ?? "?";
  return { type: "text", text: `[image omitted: ${name} ${w}x${h}]` };
}

function truncateToolText(text) {
  if (typeof text !== "string" || text.length <= TOOL_RESULT_TEXT_CAP) return text;
  return `${text.slice(0, TOOL_RESULT_HEAD)}\n…[truncated for compaction]\n${text.slice(-TOOL_RESULT_TAIL)}`;
}

// Images and reasoning become placeholders everywhere; text is trimmed ONLY inside tool output, so user
// instructions and the assistant's own text reach the summarizer whole.
function slimBlocks(blocks, { inTool = false } = {}) {
  if (!Array.isArray(blocks)) return blocks;
  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      out.push(block);
      continue;
    }
    if (block.type === "image") {
      out.push(imagePlaceholder(block));
      continue;
    }
    if (block.type === "reasoning" || block.type === "thinking") {
      out.push({ type: "text", text: "[reasoning omitted]" });
      continue;
    }
    if (block.type === "tool-result") {
      out.push({ ...block, content: slimBlocks(block.content, { inTool: true }) });
      continue;
    }
    if (inTool && block.type === "text" && typeof block.text === "string") {
      out.push({ ...block, text: truncateToolText(block.text) });
      continue;
    }
    out.push(block);
  }
  return out;
}

/**
 * Return a shallow copy of messages with images and reasoning replaced by placeholders and oversized
 * tool output trimmed (user and assistant text are kept whole) so a compaction summarizer fits its window.
 * Original messages are not mutated.
 */
export function slimCompactionMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    return { ...message, content: slimBlocks(message.content, { inTool: message.role === "tool" }) };
  });
}

/** Wrap `llm.stream` so compaction calls send the slim payload. */
export function installCompactionSlim(llm) {
  if (!llm || typeof llm.stream !== "function") {
    throw new Error("llm.stream is missing");
  }
  if (llm.__dshAnthropicCompactionSlim) return llm;
  const orig = llm.stream.bind(llm);
  llm.stream = function stream(options) {
    if (options?.purpose === "compaction" && Array.isArray(options.messages)) {
      options = { ...options, messages: slimCompactionMessages(options.messages) };
    }
    return orig(options);
  };
  llm.__dshAnthropicCompactionSlim = true;
  return llm;
}
