// A real data dir on the CLI side, a host in demo mode on the other: nothing synthetic may be shown as real.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./dsh-hub.mjs";
import { writeDemo } from "../lib/demo/write.mjs";
import { resolveDemo } from "../lib/demo/gate.mjs";
import { createDemoHub } from "../lib/demo/host.mjs";
import { DEMO_TEXT } from "../lib/demo/constants.mjs";

const AT = "2026-11-12T15:00:00Z";

async function withDemoHost(fn) {
  const base = mkdtempSync(join(tmpdir(), "demo-host-cli-"));
  const real = join(base, "real");
  const home = join(base, "home");
  mkdirSync(real);
  mkdirSync(home);
  const env = { DSH_HUB_DATA_DIR: real, DSH_HOME: join(base, "dsh"), HOME: home };
  const w = writeDemo({ out: join(base, "demo"), at: AT, seed: 3, tzOffsetMin: 0, env, home });
  const demo = resolveDemo({ ...env, DSH_HUB_DEMO: w.out }, { home });
  assert.ok(demo);
  let handler;
  const server = createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const hub = createDemoHub({ demo, allowedOrigins: ["http://127.0.0.1:3080"], port });
  handler = hub.handler;
  await hub.replayed;
  const run = async (args) => {
    const o = [], er = [];
    const code = await main(args, { out: (s) => o.push(s), err: (s) => er.push(s), env: { ...env, DSH_HUB_URL: `http://127.0.0.1:${port}` }, home });
    return { code, out: o.join("\n"), err: er.join("\n") };
  };
  try { await fn({ run }); } finally { hub.stop(); await new Promise((r) => server.close(r)); }
}

test("cache against a demo host (real data dir) is bannered, as text and as --json", async () => {
  await withDemoHost(async ({ run }) => {
    const t = await run(["cache"]);
    assert.equal(t.code, 0, t.err);
    assert.equal(t.out.split("\n")[0], DEMO_TEXT);
    assert.match(t.out, /demo-s-cache/);
    const j = JSON.parse((await run(["cache", "--json"])).out);
    assert.equal(j.demo, true);
    assert.equal(j.demoNote, DEMO_TEXT);
  });
});

test("accounts against a demo host never attaches the host's demo identity to a real row", async () => {
  await withDemoHost(async ({ run }) => {
    const t = await run(["accounts"]);
    assert.ok(!/demo@example\.com|Demo Org/.test(t.out), t.out);
    const j = await run(["accounts", "--json"]);
    assert.ok(!/demo@example\.com|Demo Org/.test(j.out), j.out);
    for (const a of JSON.parse(j.out).accounts) assert.equal(a.identity, undefined, a.provider);
  });
});
