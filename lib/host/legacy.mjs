/** Membership status + access preset (/status, /access) over oauth.mjs (read-only) + plan-usage. Sign-in/out are DSH-native. */
import { apiKeyInEnv, getAccessToken, getPermissionDefault, setPermissionDefault, status } from "../oauth.mjs";
import { countDshWindow } from "../dsh-messages.mjs";
import { createPlanUsageStore } from "../plan-usage.mjs";
import { readAccounts } from "../accounts/accounts.mjs";

async function fetchOauthUsage(token) {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
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

/** True when an openai-codex grant exists and is not expired (read-only view of DSH's credentials). */
function codexAvailable(readAcc) {
  try {
    const a = readAcc({ providers: ["openai-codex"] })[0];
    return Boolean(a && a.signedIn && !a.expired);
  } catch {
    return false;
  }
}

export function createLegacy({ features, deps = {} }) {
  const statusFn = deps.status ?? status;
  const readAcc = deps.readAccounts ?? readAccounts;
  const nowFn = deps.now ?? Date.now;
  const planStore = deps.planStore ?? createPlanUsageStore({
    getToken: getAccessToken,
    fetchUsage: fetchOauthUsage,
    countWindow: ({ sinceMs, untilMs }) => countDshWindow({ sinceMs, untilMs }),
  });
  const accessBody = () => {
    const preset = getPermissionDefault();
    return { full: preset === "danger-full-access", defaultPreset: preset };
  };

  return {
    async status() {
      const st = statusFn();
      const base = { signedIn: st.signedIn, imageCap: features.imageCap(), compactionSlim: features.compactionSlim(), spendGuard: features.spendGuard(), access: accessBody(), codex: { available: codexAvailable(readAcc) } };
      if (apiKeyInEnv()) return { ...base, plan: { mode: "api" } };
      if (!st.signedIn) return { ...base, signedIn: false, plan: { mode: "signed-out" } };
      // An expired grant cannot call the usage API (it only returns 401): report it instead.
      if (st.expiresAt !== null && st.expiresAt !== undefined && st.expiresAt <= nowFn()) {
        return { ...base, signedIn: true, plan: { mode: "expired", expiresAt: st.expiresAt } };
      }
      let plan;
      try {
        plan = publicPlan(await planStore.read());
      } catch {
        plan = { mode: "unavailable", httpStatus: 0 };
      }
      return { ...base, signedIn: true, plan };
    },
    async access(body) {
      const preset = body.full === true ? "danger-full-access" : body.full === false ? "workspace-write" : null;
      if (!preset) return [400, { error: "expected { full: boolean }" }];
      try {
        setPermissionDefault(preset);
        return [200, { full: preset === "danger-full-access", defaultPreset: preset }];
      } catch {
        return [500, { error: "could not set access" }];
      }
    },
  };
}
