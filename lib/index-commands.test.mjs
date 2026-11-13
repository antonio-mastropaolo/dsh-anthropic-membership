import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const INDEX = join(HERE, "index.js");

/** Run apply() from lib/index.js in a child: listen patched to port 0, fetch refused, a fake ctx whose "commands" service records or refuses names. */
function runHost({ refuse = [], noService = false }) {
  const base = mkdtempSync(join(tmpdir(), "idx-cmds-"));
  const code = `
    import net from "node:net";
    import http from "node:http";
    globalThis.fetch = async () => { throw new Error("network forbidden"); };
    const servers = [];
    const origListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...a) { servers.push(this); return origListen.call(this, 0, "127.0.0.1"); };
    const injects = [], logs = [], registered = [], refuse = ${JSON.stringify(refuse)};
    const ctx = {
      logger: { warn: (m) => logs.push(String(m)) },
      inject: (deps, cb) => {
        injects.push(deps);
        if (deps.length === 1 && deps[0] === "webApp") cb({ webApp: { getAdvertisedUrl: () => "http://127.0.0.1:3080/" } });
        if (deps.length === 1 && deps[0] === "commands" && ${JSON.stringify(!noService)}) cb({ commands: { register: (def) => { if (refuse.includes(def.name)) throw new Error('command "' + def.name + '" is already registered'); registered.push(def.name); } } });
      },
      on: (name, fn) => { if (name === "dispose") ctx.dispose = fn; },
      get: () => undefined,
    };
    const m = await import(${JSON.stringify(INDEX)});
    m.apply(ctx);
    await new Promise((r) => { const s = servers[0]; if (s.listening) r(); else s.once("listening", r); });
    const port = servers[0].address().port;
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/status", headers: { host: "127.0.0.1:8185", origin: "http://127.0.0.1:3080", "x-dsh-model-hub": "1" }, setHost: false }, (res) => {
        const ch = []; res.on("data", (c) => ch.push(c)); res.on("end", () => resolve(JSON.parse(Buffer.concat(ch).toString("utf8"))));
      });
      req.on("error", reject); req.end();
    });
    try { ctx.dispose?.(); } catch {}
    console.log("RESULT " + JSON.stringify({ injects, logs, registered, status }));
    process.exit(0);
  `;
  const env = { PATH: process.env.PATH, HOME: join(base, "home"), DSH_HUB_DATA_DIR: join(base, "data"), DSH_HOME: join(base, "dsh"), DSH_NODE_MODULES: join(base, "no-nm") };
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 60_000 });
  const line = out.split("\n").reverse().find((l) => l.startsWith("RESULT "));
  assert.ok(line, `child printed no RESULT: ${out.slice(0, 400)}`);
  return JSON.parse(line.slice(7));
}

test("the normal host registers the four slash commands and /status lists them", () => {
  const r = runHost({});
  assert.deepEqual(r.registered, ["cost", "caps", "route", "receipt"]);
  assert.deepEqual(r.status.commands, { registered: ["cost", "caps", "route", "receipt"], collided: [] });
  assert.ok(r.injects.some((d) => d.length === 1 && d[0] === "commands"));
  assert.deepEqual(r.logs.filter((l) => /slash command/.test(l)), []);
});

test("a name collision leaves three commands, lists /cost as collided, warns exactly once and the plugin keeps serving", () => {
  const r = runHost({ refuse: ["cost"] });
  assert.deepEqual(r.registered, ["caps", "route", "receipt"]);
  assert.deepEqual(r.status.commands, { registered: ["caps", "route", "receipt"], collided: ["cost"] });
  const warns = r.logs.filter((l) => /slash command/.test(l));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /\/cost/);
  assert.equal(typeof r.status.spendGuard, "boolean", "/status still answers with the rest of the status");
});

test("with no commands service injected, /status reports none registered and the plugin runs", () => {
  const r = runHost({ noService: true });
  assert.deepEqual(r.status.commands, { registered: [], collided: [] });
});
