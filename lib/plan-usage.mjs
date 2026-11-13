/** Parse Anthropic OAuth usage and format the membership plan card. Never invent remaining-message counts. */

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const USAGE_CACHE_MS = 60_000;
export const USAGE_BACKOFF_MS = 300_000;
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Host-side usage fetch. Never log `token`. */
export async function fetchOauthUsage(token) {
  const res = await fetch(USAGE_URL, {
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

/** Values > 1 are already percents (0–100). Values in 0–1 are a different scale — do not mix. */
export function asPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value > 1) return Math.round(value);
  return null;
}

function windowOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.utilization !== "number" || !Number.isFinite(obj.utilization)) return null;
  const rounded = Math.round(obj.utilization);
  if (rounded < 0) return null;
  // over 100 is an exhausted window, not a missing one: keep it as 100 so the plan guard still sees it
  const percent = Math.min(100, rounded);
  const resetsAt = typeof obj.resets_at === "string" ? obj.resets_at : null;
  if (!resetsAt) return null;
  return { percent, resetsAt };
}

export function parseUsagePayload(data) {
  if (!data || typeof data !== "object") {
    return { fiveHour: null, sevenDay: null, scopedWeekly: null, sevenDayOpus: null, sevenDaySonnet: null, extraEnabled: false, extraKnown: false };
  }
  const extra = data.extra_usage;
  const extraEnabled = extra?.is_enabled === true;
  // false when the payload has no boolean is_enabled: the UI then says nothing about extra usage instead of guessing
  const extraKnown = typeof extra?.is_enabled === "boolean";
  let scopedWeekly = null;
  const limits = Array.isArray(data.limits) ? data.limits : [];
  for (const lim of limits) {
    if (!lim || lim.kind !== "weekly_scoped") continue;
    const label =
      lim.scope?.model?.display_name || lim.label || lim.display_name || null;
    if (!label) continue;
    const percent = typeof lim.percent === "number" ? Math.round(lim.percent) : asPercent(lim.utilization);
    if (percent === null) continue;
    scopedWeekly = {
      percent,
      resetsAt: typeof lim.resets_at === "string" ? lim.resets_at : null,
      label: String(label),
    };
  }
  return {
    fiveHour: windowOf(data.five_hour),
    sevenDay: windowOf(data.seven_day),
    scopedWeekly,
    sevenDayOpus: windowOf(data.seven_day_opus),
    sevenDaySonnet: windowOf(data.seven_day_sonnet),
    extraEnabled,
    extraKnown,
  };
}

export function windowStartMs(resetsAt) {
  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return null;
  return end - FIVE_HOUR_MS;
}

export function formatReset(iso, timeZone, now) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const opts = { timeZone, hour: "numeric", minute: "2-digit" };
  const d = new Date(ms);
  const sameDay =
    new Date(now).toLocaleDateString("en-US", { timeZone }) ===
    d.toLocaleDateString("en-US", { timeZone });
  if (sameDay) return d.toLocaleTimeString("en-US", opts);
  return d.toLocaleString("en-US", { ...opts, weekday: "short" });
}

const CAPTION =
  "Usage % counts every Claude app on this account. Message counts are DSH only. Anthropic does not publish remaining messages.";

export function formatPlanLines({
  mode,
  parsed,
  messages,
  modelCalls,
  now = Date.now(),
  timeZone = "UTC",
  httpStatus,
  fetchedAt,
  lastGood,
} = {}) {
  if (mode === "api") {
    return ["Using Anthropic API key (billed per token)", "Switch to membership"];
  }
  if (mode === "signed-out") {
    return ["Not signed in", "Uses your Claude Pro/Max membership."];
  }
  const src = mode === "unavailable" ? lastGood : parsed;
  const lines = [];
  if (mode === "unavailable") {
    const when = fetchedAt
      ? new Date(fetchedAt).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
      : null;
    lines.push(`Plan usage unavailable (${httpStatus ?? "?"})${when ? ` · ${when}` : ""}`);
  }
  if (src?.fiveHour) {
    lines.push(
      `5-hour window: ${src.fiveHour.percent}% used · resets ${formatReset(src.fiveHour.resetsAt, timeZone, now)}`,
    );
  }
  if (src?.sevenDay) {
    lines.push(
      `Weekly: ${src.sevenDay.percent}% used · resets ${formatReset(src.sevenDay.resetsAt, timeZone, now)}`,
    );
  }
  if (src?.scopedWeekly?.label) {
    lines.push(
      `${src.scopedWeekly.label}: ${src.scopedWeekly.percent}% used · resets ${formatReset(src.scopedWeekly.resetsAt, timeZone, now)}`,
    );
  }
  if (typeof messages === "number" && typeof modelCalls === "number") {
    lines.push(`Sent from DSH this window: ${messages} messages · ${modelCalls} model calls`);
  }
  lines.push(CAPTION);
  if (src?.extraEnabled) {
    lines.push(
      "Extra usage enabled: messages beyond the plan window are billed to your Anthropic balance.",
    );
  }
  return lines;
}

export function warnLevel(percent) {
  if (typeof percent !== "number") return "ok";
  if (percent >= 95) return "danger";
  if (percent >= 80) return "warn";
  return "ok";
}

/**
 * Host-side usage cache. Token is read via getToken() and never stored on the card.
 */
export function createPlanUsageStore({
  now = () => Date.now(),
  getToken,
  fetchUsage,
  countWindow,
  cacheMs = USAGE_CACHE_MS,
  backoffMs = USAGE_BACKOFF_MS,
  onReading,
} = {}) {
  let cached = null;
  let cachedAt = 0;
  let backoffUntil = 0;
  let lastGood = null;
  let inflight = null;

  async function load() {
    const t = now();
    if (cached && t - cachedAt < cacheMs) return cached;
    if (t < backoffUntil && lastGood) {
      cached = {
        mode: "unavailable",
        httpStatus: cached?.httpStatus ?? 429,
        fetchedAt: cachedAt,
        ...lastGood,
      };
      return cached;
    }
    const token = getToken?.();
    if (!token) {
      cached = { mode: "signed-out" };
      cachedAt = t;
      return cached;
    }
    const res = await fetchUsage(token);
    if (!res?.ok) {
      const status = res?.status ?? 0;
      if (status === 429 || status === 403) backoffUntil = t + backoffMs;
      cached = {
        mode: "unavailable",
        httpStatus: status,
        fetchedAt: t,
        lastGood,
        ...(lastGood || {}),
      };
      cachedAt = t;
      return cached;
    }
    const parsed = parseUsagePayload(res.data);
    // a NEW reading (a successful fetch; a cached or backed-off read is not): the history keeps percent/resetsAt/fetchedAt only
    try { onReading?.({ fetchedAt: t, fiveHour: parsed.fiveHour, sevenDay: parsed.sevenDay }); } catch { /* best effort: the card never depends on the history */ }
    let messages = null; // null = unknown: the card then omits the line instead of showing 0
    let modelCalls = null;
    const sinceMs = parsed.fiveHour ? windowStartMs(parsed.fiveHour.resetsAt) : t - FIVE_HOUR_MS;
    try {
      const counts = await countWindow?.({
        sinceMs,
        untilMs: t,
        resetsAt: parsed.fiveHour?.resetsAt,
      });
      if (counts) {
        messages = typeof counts.messages === "number" ? counts.messages : null;
        modelCalls = typeof counts.modelCalls === "number" ? counts.modelCalls : null;
      }
    } catch {
      /* counts are best-effort */
    }
    lastGood = {
      fiveHour: parsed.fiveHour,
      sevenDay: parsed.sevenDay,
      scopedWeekly: parsed.scopedWeekly,
      extraEnabled: parsed.extraEnabled,
      parsed,
      messages,
      modelCalls,
    };
    cached = { mode: "plan", fetchedAt: t, ...lastGood };
    cachedAt = t;
    return cached;
  }

  return {
    async read() {
      if (inflight) return inflight;
      inflight = load().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      cached = null;
      cachedAt = 0;
    },
  };
}

// ---------------- signed-in account identity (Claude) ----------------
export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const PROFILE_CACHE_MS = 600_000;
export const PROFILE_FAIL_MS = 300_000;

/** Host-side profile fetch (same headers as the usage call). INFERRED endpoint (Claude Code's own profile call); a
 *  non-200 simply means "no identity". Never log `token` or the response. */
export async function fetchOauthProfile(token) {
  const res = await fetch(PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "claude-code/2.1.272",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { ok: false, status: res.status, data: null };
  return { ok: true, status: res.status, data: await res.json() };
}

const text = (v, n) => (typeof v === "string" && v.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v.trim().slice(0, n) : null);

/** "Max 20x" | "Max 5x" | "Max" | "Pro" | "Team" | "Enterprise" | null (unknown: omitted). */
export function planLabel(account, org) {
  const tier = String(org?.rate_limit_tier ?? "").toLowerCase();
  const type = String(org?.organization_type ?? "").toLowerCase();
  const mult = /max[_-]?(\d+)x/.exec(tier);
  if (type.includes("enterprise") || tier.includes("enterprise")) return "Enterprise";
  if (type.includes("team") || tier.includes("team")) return "Team";
  if (type.includes("max") || tier.includes("max") || account?.has_claude_max === true) return mult ? `Max ${mult[1]}x` : "Max";
  if (type.includes("pro") || tier.includes("pro") || account?.has_claude_pro === true) return "Pro";
  return null;
}

/** Defensive parse of the OAuth profile: { email, name, org, plan } (any may be null) or null when nothing usable. Never throws. */
export function parseProfilePayload(data) {
  try {
    if (!data || typeof data !== "object") return null;
    const account = data.account && typeof data.account === "object" ? data.account : {};
    const orgRaw = data.organization && typeof data.organization === "object" ? data.organization : {};
    const email = text(account.email ?? account.email_address, 200);
    const name = text(account.display_name, 100) ?? text(account.full_name, 100);
    let org = text(orgRaw.name, 100);
    // a personal org is named after the account ("<email>'s Organization"): not worth showing
    if (org && (/'s organization$/i.test(org) || (email && org.toLowerCase().includes(email.toLowerCase())))) org = null;
    const plan = planLabel(account, orgRaw);
    if (!email && !name && !org && !plan) return null;
    return { email, name, org, plan };
  } catch { return null; }
}

/** Identity cache: 10 min, refetched when the signed-in token changes; failures are remembered for 5 min. The token
 *  is only compared by a hash held in memory. Returns the identity or null. */
export function createIdentityStore({ now = () => Date.now(), getToken, fetchProfile = fetchOauthProfile, cacheMs = PROFILE_CACHE_MS, failMs = PROFILE_FAIL_MS, hash } = {}) {
  let cached = null; let at = 0; let key = null; let ttl = cacheMs; let inflight = null;
  let good = null; // { key, value }: the last identity fetched for a token; a failed refresh of the same token keeps it
  const fp = hash ?? ((t) => `${t.length}:${t.slice(-8)}:${t.slice(0, 6)}`);
  const tokenKey = () => { let token = null; try { token = getToken?.() ?? null; } catch { token = null; } return token ? { token, k: fp(token) } : null; };
  async function load() {
    const cur = tokenKey();
    if (!cur) { cached = null; key = null; return null; }
    const { token, k } = cur;
    if (k === key && now() - at < ttl) return cached;
    key = k; at = now();
    try {
      const res = await fetchProfile(token);
      cached = res?.ok ? parseProfilePayload(res.data) : null;
    } catch { cached = null; }
    if (cached) good = { key: k, value: cached };
    ttl = cached ? cacheMs : failMs;
    return cached;
  }
  const read = () => { if (!inflight) inflight = load().finally(() => { inflight = null; }); return inflight; };
  return {
    read,
    /** Never waits: the last identity fetched for the current token (null before the first one lands, or for another
     *  token), and a background fetch when that is missing or older than the cache. /status and /accounts use this so a
     *  slow profile call (15 s timeout) never holds up a poll. */
    peek() {
      const cur = tokenKey();
      if (!cur) return null;
      if (!inflight && !(cur.k === key && now() - at < ttl)) read().catch(() => {});
      return good && good.key === cur.k ? good.value : null;
    },
    invalidate() { at = 0; key = null; },
  };
}
