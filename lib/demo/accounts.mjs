// lib/demo/accounts.mjs: the demo's sign-in health, through the real readAccounts with an injected parse and a frozen
// "now". No credential file and no secret is involved: demo-accounts.json holds only expiry timestamps.
import path from "node:path";
import { readAccounts } from "../accounts/accounts.mjs";

export function readDemoAccounts({ dir, manifest, readAccountsImpl = readAccounts } = {}) {
  const parse = (text) => {
    const doc = JSON.parse(text);
    const records = {};
    for (const [provider, p] of Object.entries(doc?.providers && typeof doc.providers === "object" ? doc.providers : {})) {
      if (!Number.isFinite(p?.expires)) continue;
      records[`llm-pi-ai/${provider}`] = { kind: "grant", payload: { type: "oauth", access: "x", refresh: p.hasRefresh === false ? "" : "x", expires: p.expires } };
    }
    return { records };
  };
  return readAccountsImpl({
    credentialsPath: path.join(dir, "demo-accounts.json"),
    statePath: path.join(dir, "accounts-state.json"),
    now: manifest.anchorMs,
    parse,
  });
}
