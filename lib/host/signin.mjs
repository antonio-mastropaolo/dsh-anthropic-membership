/**
 * Native provider sign-in driver over DSH's `authorization` service (ctx.authorization.begin).
 * The attempt lives in this process; the UI polls it. Nothing here touches the credential file:
 * DSH's own flow writes the grant under its lock. Notices/prompts carry URLs and codes meant for the
 * operator's browser; they are returned to the (Origin-pinned) UI only, never logged.
 */
import { sanitizeError } from "../accounts/errors.mjs";
import { OAUTH_PROVIDERS } from "../accounts/index.mjs";

const MAX_NOTICES = 20;

const flowKey = (provider) => `llm-pi-ai/${provider}`;
const text = (v, n = 400) => (typeof v === "string" ? v.slice(0, n) : undefined);

function cleanNotice(n) {
  const o = { message: text(n?.message) ?? "" };
  if (typeof n?.url === "string" && /^https?:\/\//i.test(n.url)) o.url = n.url.slice(0, 2000);
  if (typeof n?.code === "string") o.code = n.code.slice(0, 64);
  return o;
}

const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export function createSignIn({ getAuthorization, onSettled, now = () => Date.now() } = {}) {
  const attempts = new Map(); // provider -> attempt

  const authz = () => {
    const a = getAuthorization?.();
    if (!a || typeof a.begin !== "function") {
      const e = new Error("DSH authorization service is not available");
      e.status = 503;
      throw e;
    }
    return a;
  };

  function view(a) {
    return {
      provider: a.provider, state: a.state, startedAt: a.startedAt, notices: a.notices,
      prompt: a.prompt ? { kind: a.prompt.kind, message: a.prompt.message, placeholder: a.prompt.placeholder, options: a.prompt.options } : null,
      ...(a.error ? { error: a.error } : {}),
    };
  }

  async function flows() {
    const a = authz();
    const list = typeof a.list === "function" ? await a.list() : [];
    return (Array.isArray(list) ? list : [])
      .filter((f) => typeof f?.key === "string" && f.key.startsWith("llm-pi-ai/"))
      .map((f) => ({
        provider: f.key.slice("llm-pi-ai/".length), label: text(f.label, 80) ?? f.key,
        methods: Array.isArray(f.methods) ? f.methods.map((m) => (typeof m === "string" ? m : m?.id ?? m?.method ?? "?")).slice(0, 8) : [],
        inFlight: Boolean(f.inFlight),
      }));
  }

  function start(provider, method = "oauth") {
    if (!OAUTH_PROVIDERS.includes(provider)) {
      const e = new Error("unknown provider");
      e.status = 400;
      throw e;
    }
    if (typeof method !== "string" || !/^[a-z-]{1,24}$/.test(method)) {
      const e = new Error("bad method");
      e.status = 400;
      throw e;
    }
    const a = authz();
    const cur = attempts.get(provider);
    expireIfStale(cur);
    if (cur && cur.state === "running") {
      const e = new Error("sign-in already in progress");
      e.status = 409;
      throw e;
    }
    const ac = new AbortController();
    const at = { provider, state: "running", startedAt: now(), notices: [], prompt: null, resolvePrompt: null, ac };
    attempts.set(provider, at);
    const interaction = {
      notify: (n) => {
        at.notices.push(cleanNotice(n));
        if (at.notices.length > MAX_NOTICES) at.notices.shift();
      },
      prompt: (p) => new Promise((resolve, reject) => {
        at.prompt = { kind: text(p?.kind, 12) ?? "text", message: text(p?.message) ?? "", placeholder: text(p?.placeholder, 120), options: Array.isArray(p?.options) ? p.options.slice(0, 20) : undefined };
        at.resolvePrompt = (v) => { at.prompt = null; at.resolvePrompt = null; resolve(v); };
        const onAbort = () => { at.prompt = null; at.resolvePrompt = null; reject(new Error("cancelled")); };
        if (ac.signal.aborted) onAbort(); else ac.signal.addEventListener("abort", onAbort, { once: true });
      }),
    };
    Promise.resolve()
      .then(() => a.begin({ key: flowKey(provider), method, interaction, signal: ac.signal }))
      .then((r) => {
        if (at.state !== "running") return; // already cancelled/expired: a late result does not resurrect it
        at.state = r?.status === "authorized" ? "authorized" : r?.status === "cancelled" ? "cancelled" : "failed";
      }, (err) => {
        if (at.state !== "running") return;
        const code = String(err?.code || "");
        at.state = ac.signal.aborted || code.includes("DECLINED") ? "cancelled" : "failed";
        if (at.state === "failed") at.error = code === "ALREADY_IN_FLIGHT" ? "sign-in already in progress in DSH" : sanitizeError(err?.message || "sign-in failed");
      })
      .finally(() => {
        at.prompt = null;
        at.resolvePrompt = null;
        try { onSettled?.(provider, at.state); } catch { /* ignore */ }
      });
    return view(at);
  }

  // A running attempt that DSH never settles (dead callback server, ignored abort) must not lock the
  // provider forever: after ATTEMPT_TTL_MS it becomes "cancelled" and a new sign-in may start.
  function finish(at, state, error) {
    if (!at || at.state !== "running") return;
    at.state = state;
    if (error) at.error = error;
    try { at.ac.abort(); } catch { /* ignore */ }
    at.prompt = null;
    at.resolvePrompt = null;
  }
  function expireIfStale(at) {
    if (at && at.state === "running" && now() - at.startedAt > ATTEMPT_TTL_MS) finish(at, "cancelled", "sign-in timed out");
  }

  function status(provider) {
    const a = attempts.get(provider);
    expireIfStale(a);
    return a ? view(a) : { provider, state: "idle", notices: [], prompt: null };
  }

  function answer(provider, value) {
    const a = attempts.get(provider);
    if (!a || a.state !== "running" || !a.resolvePrompt) {
      const e = new Error("no pending prompt");
      e.status = 409;
      throw e;
    }
    if (typeof value !== "string" || value.length > 4096) {
      const e = new Error("expected { text: string }");
      e.status = 400;
      throw e;
    }
    a.resolvePrompt(value);
    return { ok: true };
  }

  async function cancel(provider) {
    const a = attempts.get(provider);
    if (a && a.state === "running") {
      finish(a, "cancelled"); // terminal now, even if DSH's begin() ignores the abort signal
      try { await authz().cancel?.(flowKey(provider)); } catch { /* ignore */ }
    }
    return status(provider);
  }

  return { flows, start, status, answer, cancel };
}
