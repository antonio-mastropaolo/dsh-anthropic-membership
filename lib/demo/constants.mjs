// lib/demo/constants.mjs: names and texts shared by the demo writer, the verifier and (later) the demo host/CLI.
export const DEMO_MARKER = "DEMO";
export const DEMO_MANIFEST = "demo-manifest.json";
export const DEMO_VERSION = 1;
/** The banner, byte for byte, on every surface that shows demo data. */
export const DEMO_TEXT = "DEMO DATA: synthetic, nothing is recorded or capped";
export const MARKER_LINE = "dsh-model-hub DEMO DATA: synthetic, written by `dsh-hub demo`; a host or CLI pointed at this folder records nothing and applies no caps.";
/** The exact data files of a sealed demo folder (besides the manifest and the marker). */
export const DEMO_FILES = Object.freeze(["spend.jsonl", "caps.json", "config.json", "prices.json", "accounts-state.json", "demo-accounts.json", "extra-ledger.jsonl", "demo-cache.json"]);
export const DEMO_IDENTITY = Object.freeze({ email: "demo@example.com", name: null, org: "Demo Org", plan: "Max" });
export const DEMO_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const DEMO_DEFAULT_SEED = 20261112;
export const DEMO_DAILY_CAP_USD = 25;
export const DEMO_GPU_ID = "demo-gpu";
export const DEMO_GPU_URL = "http://127.0.0.1:9";
/** The one OS-cruft name a demo folder may also hold (macOS Finder writes it when the folder is opened); a regular file only. */
export const DEMO_OS_CRUFT = Object.freeze([".DS_Store"]);
/** The demo conversation (Ledger v2 rows with turns): the session a turn cost line can be shown for, and its one subagent. */
export const DEMO_CONV_SESSION = "demo-s-conv";
export const DEMO_CONV_SUB = "demo-s-conv-sub";
