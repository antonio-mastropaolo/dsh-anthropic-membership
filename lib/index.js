/**
 * Host half: loopback control API for Claude Pro/Max membership.
 * Bound to 127.0.0.1:8185. Origin pinned to the DSH web UI.
 */
import { createServer } from "node:http";
import { ALLOWED_ORIGINS, PORT, apiKeyInEnv, ensureSettings, getAccessToken, getPermissionDefault, login, logout, setPermissionDefault, status } from "./oauth.mjs";
import { installCompactionSlim } from "./compact-payload.mjs";
import { countDshWindow } from "./dsh-messages.mjs";
import { installFullAccess } from "./full-access.mjs";
import { createPlanUsageStore } from "./plan-usage.mjs";
import { installRequestImageCap } from "./request-image.mjs";

const HEADER = "x-dsh-membership";

function allowOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.includes(origin);
}

function send(res, origin, statusCode, body) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (allowOrigin(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
    headers["access-control-allow-headers"] = HEADER;
    headers.vary = "Origin";
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
}

function reject(res, origin, statusCode, error) {
  send(res, origin, statusCode, { error });
}

let loginInFlight = null;
let imageCapInstalled = false;
let compactionSlimInstalled = false;

async function fetchOauthUsage(token) {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "claude-code/2.1.272",
    },
  });
  if (!res.ok) return { ok: false, status: res.status, data: null };
  return { ok: true, status: res.status, data: await res.json() };
}

const planStore = createPlanUsageStore({
  getToken: getAccessToken,
  fetchUsage: fetchOauthUsage,
  countWindow: ({ sinceMs, untilMs }) => countDshWindow({ sinceMs, untilMs }),
});

function publicPlan(card) {
  if (!card || card.mode === "signed-out") return { mode: "signed-out" };
  if (card.mode === "api") return { mode: "api" };
  return {
    mode: card.mode,
    httpStatus: card.httpStatus ?? null,
    fetchedAt: card.fetchedAt ?? null,
    fiveHour: card.fiveHour ?? card.parsed?.fiveHour ?? null,
    sevenDay: card.sevenDay ?? card.parsed?.sevenDay ?? null,
    extraEnabled: card.extraEnabled ?? card.parsed?.extraEnabled ?? false,
    messages: card.messages ?? null,
    modelCalls: card.modelCalls ?? null,
  };
}

function accessBody() {
  const preset = getPermissionDefault();
  return { full: preset === "danger-full-access", defaultPreset: preset };
}

async function statusBody() {
  const st = status();
  const access = accessBody();
  if (apiKeyInEnv()) {
    return { signedIn: st.signedIn, imageCap: imageCapInstalled, compactionSlim: compactionSlimInstalled, plan: { mode: "api" }, access, codex: { available: false } };
  }
  if (!st.signedIn) {
    return { signedIn: false, imageCap: imageCapInstalled, compactionSlim: compactionSlimInstalled, plan: { mode: "signed-out" }, access, codex: { available: false } };
  }
  let plan;
  try {
    plan = publicPlan(await planStore.read());
  } catch {
    plan = { mode: "unavailable", httpStatus: 0 };
  }
  return {
    signedIn: true,
    imageCap: imageCapInstalled,
    compactionSlim: compactionSlimInstalled,
    plan,
    access,
    codex: { available: false },
  };
}

function handle(req, res) {
  const origin = req.headers.origin;
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "OPTIONS") {
    if (!allowOrigin(origin)) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": HEADER,
      "access-control-max-age": "600",
      vary: "Origin",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    if (origin !== undefined && !allowOrigin(origin)) {
      reject(res, origin, 403, "origin not allowed");
      return;
    }
    statusBody().then(
      (body) => send(res, origin, 200, body),
      () => send(res, origin, 200, { signedIn: false, plan: { mode: "unavailable", httpStatus: 0 } }),
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    send(res, origin, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/login" || url.pathname === "/logout")) {
    if (!allowOrigin(origin)) {
      reject(res, origin, 403, "origin not allowed");
      return;
    }
    if (req.headers[HEADER] !== "1") {
      reject(res, origin, 403, "missing membership header");
      return;
    }
    if (url.pathname === "/logout") {
      planStore.invalidate();
      send(res, origin, 200, { ...logout(), plan: { mode: "signed-out" } });
      return;
    }
    if (loginInFlight) {
      reject(res, origin, 409, "login already in progress");
      return;
    }
    loginInFlight = login().finally(() => {
      loginInFlight = null;
    });
    loginInFlight.then(
      (st) => {
        planStore.invalidate();
        send(res, origin, 200, { ...st, plan: { mode: "plan" } });
      },
      (err) => reject(res, origin, 500, String(err?.message || err)),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/access") {
    if (!allowOrigin(origin)) {
      reject(res, origin, 403, "origin not allowed");
      return;
    }
    if (req.headers[HEADER] !== "1") {
      reject(res, origin, 403, "missing membership header");
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        reject(res, origin, 400, "invalid json");
        return;
      }
      const preset = body.full === true ? "danger-full-access" : body.full === false ? "workspace-write" : null;
      if (!preset) {
        reject(res, origin, 400, "expected { full: boolean }");
        return;
      }
      try {
        setPermissionDefault(preset);
        send(res, origin, 200, { full: preset === "danger-full-access", defaultPreset: preset });
      } catch (err) {
        reject(res, origin, 500, String(err?.message || err));
      }
    });
    return;
  }

  reject(res, origin, 404, "not found");
}

export const name = "anthropic-membership";

export function apply(ctx) {
  ensureSettings();
  ctx.inject(["attachments"], (sub) => {
    installRequestImageCap(sub.attachments);
    imageCapInstalled = true;
  });
  ctx.inject(["llm"], (sub) => {
    installCompactionSlim(sub.llm);
    compactionSlimInstalled = true;
  });
  installFullAccess(ctx);
  const server = createServer(handle);
  server.listen(PORT, "127.0.0.1");
  ctx?.on?.("dispose", () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  });
}

export default apply;
