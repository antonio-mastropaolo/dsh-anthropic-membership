import { strict as assert } from "node:assert";
import { stripNeedlessEscalation, FULL_ACCESS_MODE } from "./full-access.mjs";

const args = {
  command: "ls",
  description: "List files",
  sandbox_permissions: "workspace-write",
  justification: "need write",
};
const stripped = stripNeedlessEscalation(args, FULL_ACCESS_MODE);
assert.equal(stripped.command, "ls");
assert.equal(stripped.sandbox_permissions, undefined);
assert.equal(stripped.justification, undefined);
assert.equal(args.sandbox_permissions, "workspace-write", "original intact");

const confined = stripNeedlessEscalation(args, "workspace-write");
assert.equal(confined.sandbox_permissions, "workspace-write");

const clean = stripNeedlessEscalation({ command: "pwd" }, FULL_ACCESS_MODE);
assert.deepEqual(clean, { command: "pwd" });
console.log("pass");
