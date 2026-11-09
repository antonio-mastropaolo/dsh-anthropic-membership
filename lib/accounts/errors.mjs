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

/**
 * Redact secrets from any text: known token shapes (sk-…, GitHub gh?_…, Google AIza…, JWTs, Bearer …),
 * secret-ish query/form parameters (token=, code=, key=, …) and long opaque runs (20+ chars, `/` included).
 * The one redactor the plugin uses for anything that leaves the process (API replies, CLI, persisted errors).
 */
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b((?:refresh|access|id)_token|code|key|api_key|apikey|token|secret|password|client_secret)=([^&\s"']+)/gi, "$1=[redacted]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g, "[redacted]")
    // opaque secrets of unknown shape: any 24+ run without '/' (as before), and a 20+ run WITH '/' only when it
    // looks random (upper + lower + digit) — so "google/gemini-3.8-flash"-style model ids stay readable.
    .replace(/[A-Za-z0-9_\-.~+=/]{20,}/g, (m) => {
      if (!m.includes("/")) return m.length >= 24 ? "[redacted]" : m;
      return /[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) ? "[redacted]" : m.replace(/[A-Za-z0-9_\-.~+=]{24,}/g, "[redacted]");
    });
}

/** Strip url=… fragments and URLs, redact secrets, cap at a word boundary. */
export function sanitizeError(err) {
  let msg = String(err?.message ?? err ?? "refresh failed");
  msg = redactSecrets(msg
    .replace(/\burl=\S*/gi, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " "))
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
