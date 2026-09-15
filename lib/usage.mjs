#!/usr/bin/env node
/** Print Claude Pro/Max plan windows + DSH message counts. Never prints tokens. */
import { fileURLToPath } from "node:url";
import { apiKeyInEnv, getAccessToken, status } from "./lib/oauth.mjs";
import { countDshWindow } from "./lib/dsh-messages.mjs";
import {
  FIVE_HOUR_MS,
  fetchOauthUsage,
  formatPlanLines,
  parseUsagePayload,
  windowStartMs,
} from "./lib/plan-usage.mjs";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node ${fileURLToPath(import.meta.url)} [--json]

  Print 5-hour / weekly plan % and DSH user-message counts.
  Does not print remaining messages, tokens, or dollars.
`);
  process.exit(0);
}

const asJson = args.has("--json");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

if (apiKeyInEnv()) {
  const lines = formatPlanLines({ mode: "api" });
  if (asJson) console.log(JSON.stringify({ mode: "api" }));
  else for (const line of lines) console.log(line);
  process.exit(0);
}

const st = status();
if (!st.signedIn) {
  const lines = formatPlanLines({ mode: "signed-out" });
  if (asJson) console.log(JSON.stringify({ mode: "signed-out", signedIn: false }));
  else for (const line of lines) console.log(line);
  process.exit(1);
}

const token = getAccessToken();
if (!token) {
  console.error("signed in flag set but no access token");
  process.exit(1);
}

const res = await fetchOauthUsage(token);
if (!res.ok) {
  const lines = formatPlanLines({ mode: "unavailable", httpStatus: res.status });
  if (asJson) console.log(JSON.stringify({ mode: "unavailable", httpStatus: res.status }));
  else for (const line of lines) console.error(line);
  process.exit(2);
}

const parsed = parseUsagePayload(res.data);
const now = Date.now();
const sinceMs = parsed.fiveHour ? windowStartMs(parsed.fiveHour.resetsAt) : now - FIVE_HOUR_MS;
const counts = countDshWindow({ sinceMs, untilMs: now });
const publicPlan = {
  mode: "plan",
  fiveHour: parsed.fiveHour,
  sevenDay: parsed.sevenDay,
  extraEnabled: parsed.extraEnabled,
  messages: counts.messages,
  modelCalls: counts.modelCalls,
};
if (asJson) {
  console.log(JSON.stringify(publicPlan));
} else {
  for (const line of formatPlanLines({
    mode: "plan",
    parsed,
    messages: counts.messages,
    modelCalls: counts.modelCalls,
    now,
    timeZone: tz,
  })) {
    console.log(line);
  }
}
