/** Refresh-error sanitising + classification. Output is short, URL-free and never carries a token. */

export const ERROR_KINDS = Object.freeze(["revoked", "rejected", "unreachable", "other"]);
const MAX_ERROR = 160;

/** Classify a raw refresh failure. Pass the RAW error (message), not the sanitised string. */
export function classifyError(err) {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  if (!msg) return "other";
  if (/invalid_grant|unauthorized_client/.test(msg)) return "revoked";
  if (/\b(401|403)\b|unauthorized|forbidden/.test(msg)) return "rejected";
  if (/timeout|timed out|econn|enotfound|etimedout|eai_again|fetch failed|socket hang|network|\b5\d\d\b/.test(msg)) return "unreachable";
  return "other";
}

/** Strip url=… fragments and URLs, redact token-like runs (no `/` in the class), cap at a word boundary. */
export function sanitizeError(err) {
  let msg = String(err?.message ?? err ?? "refresh failed");
  msg = msg
    .replace(/\burl=\S*/gi, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
    .replace(/[A-Za-z0-9_\-.~+=]{24,}/g, "[redacted]")
    .replace(/(?:\s*;\s*){2,}/g, "; ")
    .replace(/\s+/g, " ")
    .replace(/\s+([;,.])/g, "$1")
    .trim();
  if (!msg) return "refresh failed";
  if (msg.length > MAX_ERROR) {
    const cut = msg.slice(0, MAX_ERROR);
    const sp = cut.lastIndexOf(" ");
    msg = `${(sp > 80 ? cut.slice(0, sp) : cut).replace(/[\s;,:]+$/, "")}…`;
  }
  return msg;
}
