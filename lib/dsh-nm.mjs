/** Locate the DeepSeek Harness node_modules tree (yaml, sharp, pi-ai). */
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const DSH_PKG = join("@deepseek-ai", "dsh");

function pushFrom(from, out) {
  try {
    const req = createRequire(from);
    const pkg = req.resolve("@deepseek-ai/dsh/package.json");
    out.push(join(dirname(pkg), "node_modules"));
  } catch {
    /* not resolvable from this origin */
  }
}

/**
 * Where an installed DSH's node_modules may be, most specific first:
 *  1. resolvable from this plugin's own location;
 *  2. resolvable from the running script, as given and with symlinks resolved (inside DSH, argv[1] is the `dsh`
 *     bin, which an `npm i -g` links into <prefix>/bin);
 *  3. the global npm prefix of the Node that runs us (<prefix>/lib/node_modules: setup-node, nvm, Homebrew,
 *     /usr/local and other standard Unix installs);
 *  4. the Homebrew and /usr/local prefixes, for a CLI run by a different Node than DSH's.
 */
export function dshCandidates({ execPath = process.execPath, argv1 = process.argv[1], selfUrl = import.meta.url } = {}) {
  const out = [];
  pushFrom(selfUrl, out);
  if (argv1) {
    pushFrom(argv1, out);
    try { pushFrom(realpathSync(argv1), out); } catch { /* not a file */ }
  }
  if (execPath) out.push(join(dirname(dirname(execPath)), "lib", "node_modules", DSH_PKG, "node_modules"));
  out.push(
    join("/opt/homebrew/lib/node_modules", DSH_PKG, "node_modules"),
    join("/usr/local/lib/node_modules", DSH_PKG, "node_modules"),
  );
  return [...new Set(out.filter(Boolean))];
}

const usable = (dir) => existsSync(join(dir, "yaml")) && existsSync(join(dir, "sharp"));

export function resolveDshNodeModules(opts = {}) {
  const env = opts.env ?? process.env;
  const fromEnv = env.DSH_NODE_MODULES || env.DSH_NM;
  if (fromEnv) {
    if (usable(fromEnv)) return fromEnv;
    throw new Error(`DSH_NODE_MODULES=${fromEnv} has no yaml + sharp: point it at the dsh package's node_modules directory.`);
  }
  for (const dir of dshCandidates(opts)) if (usable(dir)) return dir;
  throw new Error(
    "Cannot find DeepSeek Harness node_modules (need yaml + sharp). Set DSH_NODE_MODULES (or DSH_NM) to the dsh package's node_modules directory.",
  );
}

/** Same lookup, but null instead of throwing (for modules that must import without DSH present). */
export function dshNodeModulesOrNull(opts = {}) {
  try {
    return resolveDshNodeModules(opts);
  } catch {
    return null;
  }
}
