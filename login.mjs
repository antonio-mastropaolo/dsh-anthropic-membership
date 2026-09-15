#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { ensureSettings, login } from "./lib/oauth.mjs";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node ${fileURLToPath(import.meta.url)} [--settings-only]

  (default)  write the anthropic membership route, then run Claude Pro/Max OAuth
  --settings-only   write settings only, do not open the browser
`);
  process.exit(0);
}

const path = ensureSettings();
console.log("settings", path);
if (!args.has("--settings-only")) {
  const st = await login({
    onNotice(n) {
      if (n.url) {
        console.log("If the browser does not open, visit:");
        console.log(n.url);
      } else if (n.message) console.log(n.message);
    },
  });
  console.log("signedIn", st.signedIn, "expiresAt", st.expiresAt);
}
