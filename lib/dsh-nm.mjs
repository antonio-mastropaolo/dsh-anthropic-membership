/** Locate the DeepSeek Harness node_modules tree (yaml, sharp, pi-ai). */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function pushFrom(from, out) {
  try {
    const req = createRequire(from);
    const pkg = req.resolve("@deepseek-ai/dsh/package.json");
    out.push(join(dirname(pkg), "node_modules"));
  } catch {
    /* not resolvable from this origin */
  }
}

export function resolveDshNodeModules() {
  if (process.env.DSH_NODE_MODULES) return process.env.DSH_NODE_MODULES;
  const candidates = [];
  pushFrom(import.meta.url, candidates);
  if (process.argv[1]) pushFrom(process.argv[1], candidates);
  candidates.push(
    "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules",
    "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules",
  );
  const seen = new Set();
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (existsSync(join(dir, "yaml")) && existsSync(join(dir, "sharp"))) return dir;
  }
  throw new Error(
    "Cannot find DeepSeek Harness node_modules (need yaml + sharp). Set DSH_NODE_MODULES to the dsh package's node_modules directory.",
  );
}
