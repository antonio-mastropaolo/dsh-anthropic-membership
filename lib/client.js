window.__ModuleLoader__.load({
  id: "dsh-anthropic-membership",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const FishLogo = primitives.FishLogo;
    const PORT = 8185;
    const API = "http://127.0.0.1:" + PORT;
    const HEADER = { "x-dsh-membership": "1" };

    function useStatus() {
      const [st, setSt] = react.useState({ signedIn: false, plan: { mode: "signed-out" }, error: null, busy: false });
      const refresh = react.useCallback(() => {
        fetch(API + "/status", { headers: HEADER })
          .then((r) => r.json())
          .then((j) =>
            setSt((s) => ({
              ...s,
              signedIn: !!j.signedIn,
              plan: j.plan || { mode: j.signedIn ? "plan" : "signed-out" },
              access: j.access || s.access || { full: false },
              codex: j.codex || { available: false },
              error: null,
            })),
          )
          .catch((e) => setSt((s) => ({ ...s, error: String(e) })));
      }, []);
      react.useEffect(() => {
        refresh();
        const id = setInterval(refresh, 4000);
        return () => clearInterval(id);
      }, [refresh]);
      const signIn = react.useCallback(() => {
        setSt((s) => ({ ...s, busy: true, error: null }));
        fetch(API + "/login", { method: "POST", headers: HEADER })
          .then(async (r) => {
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || r.statusText);
            setSt({ signedIn: !!j.signedIn, plan: j.plan || { mode: "plan" }, error: null, busy: false });
          })
          .catch((e) => setSt((s) => ({ ...s, busy: false, error: String(e.message || e) })));
      }, []);
      const signOut = react.useCallback(() => {
        fetch(API + "/logout", { method: "POST", headers: HEADER })
          .then((r) => r.json())
          .then((j) => setSt({ signedIn: false, plan: { mode: "signed-out" }, error: null, busy: false }))
          .catch((e) => setSt((s) => ({ ...s, error: String(e) })));
      }, []);
      const setFull = react.useCallback((full) => {
        fetch(API + "/access", {
          method: "POST",
          headers: { ...HEADER, "content-type": "application/json" },
          body: JSON.stringify({ full: !!full }),
        })
          .then((r) => r.json())
          .then((j) => {
            setSt((s) => ({ ...s, access: { full: !!j.full, defaultPreset: j.defaultPreset } }));
            try {
              const ctx = pluginCtx;
              const id = ctx?.sessions?.list?.getSnapshot?.()?.current;
              const live = id ? ctx.sessions.binding(id)?.session : null;
              if (live?.command) {
                live.command(full ? "/permission danger-full-access" : "/permission workspace-write").catch(() => false);
              }
            } catch {
              /* composer PermissionSelect remains the fallback */
            }
          })
          .catch((e) => setSt((s) => ({ ...s, error: String(e.message || e) })));
      }, []);
      return { st, signIn, signOut, refresh, setFull };
    }

    function fmtReset(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      const same = d.toDateString() === new Date().toDateString();
      const opts = { hour: "numeric", minute: "2-digit" };
      return same ? d.toLocaleTimeString(undefined, opts) : d.toLocaleString(undefined, { ...opts, weekday: "short" });
    }

    function pctColor(p) {
      if (typeof p !== "number") return undefined;
      if (p >= 95) return "#b42318";
      if (p >= 80) return "#b54708";
      return undefined;
    }

    function windowLine(label, win) {
      if (!win || typeof win.percent !== "number") return null;
      return jsx.jsx("div", {
        style: { fontSize: 13, marginBottom: 4, color: pctColor(win.percent) },
        children: label + ": " + win.percent + "% used · resets " + fmtReset(win.resetsAt),
      });
    }

    function PlanBody(plan) {
      if (!plan || plan.mode === "signed-out") {
        return jsx.jsx("div", {
          style: { fontSize: 13, opacity: 0.8, marginBottom: 10 },
          children: "Uses your Claude Pro/Max membership.",
        });
      }
      if (plan.mode === "api") {
        return jsx.jsxs("div", {
          style: { fontSize: 13, marginBottom: 10 },
          children: [
            jsx.jsx("div", { children: "Using Anthropic API key (billed per token)" }),
            jsx.jsx("div", { style: { opacity: 0.8, marginTop: 4 }, children: "Switch to membership" }),
          ],
        });
      }
      const grey = plan.mode === "unavailable" ? { opacity: 0.65 } : {};
      const when = plan.fetchedAt
        ? new Date(plan.fetchedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
        : null;
      return jsx.jsxs("div", {
        style: { fontSize: 13, marginBottom: 10, ...grey },
        children: [
          plan.mode === "unavailable"
            ? jsx.jsx("div", {
                style: { color: "#b42318", marginBottom: 6 },
                children: "Plan usage unavailable (" + (plan.httpStatus ?? "?") + ")" + (when ? " · " + when : ""),
              })
            : jsx.jsx("div", { style: { marginBottom: 6 }, children: "Signed in · Claude Pro/Max" }),
          windowLine("5-hour window", plan.fiveHour),
          windowLine("Weekly", plan.sevenDay),
          typeof plan.messages === "number" && typeof plan.modelCalls === "number"
            ? jsx.jsx("div", {
                style: { marginTop: 6 },
                children:
                  "Sent from DSH this window: " + plan.messages + " messages · " + plan.modelCalls + " model calls",
              })
            : null,
          jsx.jsx("div", {
            style: { opacity: 0.75, marginTop: 8, fontSize: 12 },
            children:
              "Usage % counts every Claude app on this account. Message counts are DSH only. Anthropic does not publish remaining messages.",
          }),
          plan.extraEnabled
            ? jsx.jsx("div", {
                style: { marginTop: 6 },
                children: "Extra usage enabled: messages beyond the plan window are billed to your Anthropic balance.",
              })
            : null,
        ],
      });
    }

    function Panel() {
      const { st, signIn, signOut } = useStatus();
      return jsx.jsxs("div", {
        style: {
          margin: "12px 0 16px",
          padding: "12px 14px",
          border: "1px solid rgba(127,127,127,0.35)",
          borderRadius: 8,
        },
        children: [
          jsx.jsx("div", {
            style: { fontWeight: 600, marginBottom: 8 },
            children: "Anthropic subscription (Claude Pro/Max)",
          }),
          PlanBody(st.plan),
          st.error
            ? jsx.jsx("div", { style: { color: "#b42318", fontSize: 13, marginBottom: 8 }, children: st.error })
            : null,
          jsx.jsxs("div", {
            style: { display: "flex", gap: 8 },
            children: [
              jsx.jsx("button", {
                type: "button",
                disabled: st.busy || st.signedIn,
                onClick: signIn,
                children: st.busy ? "Waiting for Claude login…" : "Sign in with Claude Pro/Max",
              }),
              st.signedIn
                ? jsx.jsx("button", { type: "button", onClick: signOut, children: "Sign out" })
                : null,
            ],
          }),
        ],
      });
    }

    function Card(props) {
      if (props?.provider?.provider !== "anthropic") return null;
      return jsx.jsx(Panel, {});
    }

    let pluginCtx = null;

    const PLAN_CSS = [
      ".dshAmPlan-wrap{display:flex;justify-content:center;align-items:center;flex-wrap:nowrap;gap:8px;width:100%;flex:none;height:auto;align-self:stretch;box-sizing:border-box;padding:6px 0 2px}",
      ".dshAmPlan-logo{display:inline-flex;align-items:center;color:var(--dsw-alias-label-primary);flex:none;line-height:0}",
      ".dshAmPlan{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;max-width:100%;height:28px;padding:2px 5px 2px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-specific-tip,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;line-height:16px;white-space:nowrap}",
      ".dshAmPlan-mark{flex:none;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}",
      ".dshAmPlan-cell{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)}",
      ".dshAmPlan-k{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}",
      ".dshAmPlan-v{font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".dshAmPlan-track{display:inline-block;width:34px;height:4px;border-radius:99px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.28));overflow:hidden}",
      ".dshAmPlan-fill{display:block;height:100%;border-radius:inherit;background:currentColor}",
      ".dshAmPlan-cell.is-ok{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-secondary))}",
      ".dshAmPlan-cell.is-warn{color:#b54708;background:color-mix(in srgb,#b54708 14%, transparent)}",
      ".dshAmPlan-cell.is-warn .dshAmPlan-v{color:#b54708}",
      ".dshAmPlan-cell.is-danger{color:var(--dsw-alias-state-error-primary,#b42318);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#b42318) 16%, transparent)}",
      ".dshAmPlan-cell.is-danger .dshAmPlan-v{color:var(--dsw-alias-state-error-primary,#b42318)}",
      ".dshAmPlan.is-dim{opacity:.82}",
      ".dshAmPlan-sw{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px 0 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-specific-tip,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;font-weight:600;line-height:16px}",
      ".dshAmPlan-sw:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshAmPlan-knob{position:relative;width:28px;height:16px;border-radius:99px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.35));flex:none}",
      ".dshAmPlan-knob:after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .12s}",
      ".dshAmPlan-sw.is-on{color:var(--dsw-alias-label-primary)}",
      ".dshAmPlan-sw.is-on .dshAmPlan-knob{background:var(--dsw-alias-state-business-primary,#10a37f)}",
      ".dshAmPlan-sw.is-on .dshAmPlan-knob:after{left:14px}",
    ].join("");

    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css='dsh-anthropic-membership-plan']")) {
      const tag = document.createElement("style");
      tag.dataset.pluginCss = "dsh-anthropic-membership-plan";
      tag.textContent = PLAN_CSS;
      document.head.appendChild(tag);
    }

    function tone(p) {
      if (typeof p !== "number") return "ok";
      if (p >= 95) return "danger";
      if (p >= 80) return "warn";
      return "ok";
    }

    function PlanCell(props) {
      const cls = "dshAmPlan-cell is-" + (props.tone || "ok");
      return jsx.jsxs("span", {
        className: cls,
        children: [
          jsx.jsx("span", { className: "dshAmPlan-k", children: props.k }),
          props.bar != null
            ? jsx.jsx("span", {
                className: "dshAmPlan-track",
                children: jsx.jsx("span", {
                  className: "dshAmPlan-fill",
                  style: { width: Math.max(3, Math.min(100, props.bar)) + "%" },
                }),
              })
            : null,
          jsx.jsx("span", { className: "dshAmPlan-v", children: props.v }),
        ],
      });
    }

    function ClaudeChip(plan) {
      if (!plan || plan.mode === "signed-out") {
        return jsx.jsxs("div", {
          className: "dshAmPlan is-dim",
          title: "Sign in with Claude Pro/Max in Settings → Models",
          children: [
            jsx.jsx("span", { className: "dshAmPlan-mark", children: "Claude" }),
            jsx.jsx(PlanCell, { k: "plan", v: "off" }),
          ],
        });
      }
      if (plan.mode === "api") {
        return jsx.jsxs("div", {
          className: "dshAmPlan",
          title: "Using Anthropic API key (billed per token)",
          children: [
            jsx.jsx("span", { className: "dshAmPlan-mark", children: "Claude" }),
            jsx.jsx(PlanCell, { k: "api", v: "key" }),
          ],
        });
      }
      const five = plan.fiveHour && typeof plan.fiveHour.percent === "number" ? plan.fiveHour.percent : null;
      const week = plan.sevenDay && typeof plan.sevenDay.percent === "number" ? plan.sevenDay.percent : null;
      return jsx.jsxs("div", {
        className: "dshAmPlan" + (plan.mode === "unavailable" ? " is-dim" : ""),
        title: plan.mode === "unavailable"
          ? "Plan usage unavailable (" + (plan.httpStatus ?? "?") + ")"
          : "Claude Pro/Max · 5h and weekly % are account-wide. Anthropic does not publish remaining messages.",
        children: [
          jsx.jsx("span", { className: "dshAmPlan-mark", children: "Claude" }),
          jsx.jsx(PlanCell, { k: "5h", v: five !== null ? five + "%" : "—", bar: five, tone: tone(five) }),
          jsx.jsx(PlanCell, { k: "wk", v: week !== null ? week + "%" : "—", bar: week, tone: tone(week) }),
        ],
      });
    }

    function CodexChip(codex) {
      const on = !!(codex && codex.available);
      const five = on && codex.fiveHour && typeof codex.fiveHour.percent === "number" ? codex.fiveHour.percent : null;
      return jsx.jsxs("div", {
        className: "dshAmPlan" + (on ? "" : " is-dim"),
        title: on
          ? "ChatGPT Codex usage"
          : "Codex consumption lights up once an openai-codex grant is signed in.",
        children: [
          jsx.jsx("span", { className: "dshAmPlan-mark", children: "Codex" }),
          five !== null
            ? jsx.jsx(PlanCell, { k: "5h", v: five + "%", bar: five, tone: tone(five) })
            : jsx.jsx(PlanCell, { k: "plan", v: on ? "on" : "off" }),
        ],
      });
    }

    function AccessSwitch({ full, onChange }) {
      return jsx.jsxs("button", {
        type: "button",
        className: "dshAmPlan-sw" + (full ? " is-on" : ""),
        "aria-pressed": full ? "true" : "false",
        title: full
          ? "Full access is on. Click for workspace-write."
          : "Workspace-write. Click for full access (danger-full-access).",
        onClick: () => onChange(!full),
        children: [
          jsx.jsx("span", { children: "Full access" }),
          jsx.jsx("span", { className: "dshAmPlan-knob", "aria-hidden": true }),
        ],
      });
    }

    function DockWidget() {
      const { st, setFull } = useStatus();
      return jsx.jsxs("div", {
        className: "dshAmPlan-wrap",
        children: [
          jsx.jsx("span", {
            className: "dshAmPlan-logo",
            title: "DeepSeek Harness",
            children: jsx.jsx(FishLogo, { size: 18 }),
          }),
          ClaudeChip(st.plan),
          CodexChip(st.codex),
          jsx.jsx(AccessSwitch, { full: !!(st.access && st.access.full), onChange: setFull }),
        ],
      });
    }

    function apply(ctx) {
      pluginCtx = ctx;
      ctx.slots.inject("settings.models.provider-card", () =>
        ctx.slots.register(
          {
            name: "settings.models.provider-card",
            key: "llm-pi-ai",
          },
          Card,
        ),
      );
      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.composer.dock",
            id: "anthropic-plan",
            order: -20,
            label: "Consumption",
          },
          DockWidget,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "sessions"];
    return module.exports;
  },
});
