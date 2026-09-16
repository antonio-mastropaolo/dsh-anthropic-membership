/** Full access: strip needless sandbox escalations and correct the model prompt. */

export const FULL_ACCESS_MODE = "danger-full-access";

export const FULL_ACCESS_SENTENCE =
  "This session already has danger-full-access. Commands run with full file access. Do not set sandbox_permissions.";

export function stripNeedlessEscalation(args, standingMode) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  if (standingMode !== FULL_ACCESS_MODE) return args;
  if (args.sandbox_permissions === undefined && args.justification === undefined) return args;
  const next = { ...args };
  delete next.sandbox_permissions;
  delete next.justification;
  return next;
}

export function standingModeOf(exec, sandboxPolicy) {
  try {
    const session = exec?.agent?.session;
    if (!sandboxPolicy || typeof sandboxPolicy.resolve !== "function") return null;
    const policy = sandboxPolicy.resolve(session ? { session } : {});
    return policy?.mode ?? null;
  } catch {
    return null;
  }
}

export function installFullAccess(ctx) {
  ctx.inject(["sandboxPolicy", "systemPrompt"], (sub) => {
    ctx.on("tools/pre-execute", (exec, next) => {
      const mode = standingModeOf(exec, sub.sandboxPolicy);
      if (mode === FULL_ACCESS_MODE && exec?.arguments && typeof exec.arguments === "object") {
        exec.arguments = stripNeedlessEscalation(exec.arguments, mode);
      }
      return next();
    });
    sub.systemPrompt.context({
      name: "anthropic-membership:full-access",
      order: 10_000,
      text: (context) => {
        const mode = standingModeOf({ agent: context.agent }, sub.sandboxPolicy);
        return mode === FULL_ACCESS_MODE ? FULL_ACCESS_SENTENCE : "";
      },
    });
  });
}
