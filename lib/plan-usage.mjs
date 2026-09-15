/** Parse Anthropic OAuth usage and format the membership plan card. Never invent remaining-message counts. */

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const USAGE_CACHE_MS = 60_000;
export const USAGE_BACKOFF_MS = 300_000;

/** Values > 1 are already percents (0–100). Values in 0–1 are a different scale — do not mix. */
export function asPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value > 1) return Math.round(value);
  return null;
}

function windowOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  const percent = asPercent(obj.utilization);
  const resetsAt = typeof obj.resets_at === "string" ? obj.resets_at : null;
  if (percent === null || !resetsAt) return null;
  return { percent, resetsAt };
}

export function parseUsagePayload(data) {
  if (!data || typeof data !== "object") {
    return { fiveHour: null, sevenDay: null, scopedWeekly: null, extraEnabled: false };
  }
  const extra = data.extra_usage;
  const extraEnabled = extra?.is_enabled === true;
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
    extraEnabled,
  };
}

export function windowStartMs(resetsAt) {
  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return null;
  return end - FIVE_HOUR_MS;
}

function formatReset(iso, timeZone, now) {
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
    let messages = 0;
    let modelCalls = 0;
    const sinceMs = parsed.fiveHour ? windowStartMs(parsed.fiveHour.resetsAt) : t - FIVE_HOUR_MS;
    try {
      const counts = await countWindow?.({
        sinceMs,
        untilMs: t,
        resetsAt: parsed.fiveHour?.resetsAt,
      });
      if (counts) {
        messages = counts.messages ?? 0;
        modelCalls = counts.modelCalls ?? 0;
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
