window.__ModuleLoader__.load({
  id: "dsh-anthropic-membership",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
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
      return { st, signIn, signOut, refresh };
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

    function DockWidget() {
      const { st } = useStatus();
      const plan = st.plan;
      if (!plan || plan.mode === "signed-out") return null;
      if (plan.mode === "api") {
        return jsx.jsx("div", {
          style: {
            fontSize: 12,
            lineHeight: "20px",
            opacity: 0.8,
            padding: "2px 0 6px",
          },
          children: "Claude · API key (billed per token)",
        });
      }
      const five = plan.fiveHour && typeof plan.fiveHour.percent === "number" ? plan.fiveHour.percent : null;
      const week = plan.sevenDay && typeof plan.sevenDay.percent === "number" ? plan.sevenDay.percent : null;
      const parts = ["Claude"];
      if (five !== null) parts.push("5h " + five + "%");
      if (week !== null) parts.push("wk " + week + "%");
      if (typeof plan.messages === "number") parts.push(plan.messages + " msgs");
      const title =
        plan.mode === "unavailable"
          ? "Plan usage unavailable"
          : "Usage % is every Claude app. Message counts are DSH only. Anthropic does not publish remaining messages.";
      return jsx.jsx("div", {
        title: title,
        style: {
          fontSize: 12,
          lineHeight: "20px",
          padding: "2px 0 6px",
          color: pctColor(five) || "inherit",
          opacity: plan.mode === "unavailable" ? 0.65 : 0.9,
        },
        children: parts.join(" · "),
      });
    }

    function apply(ctx) {
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
            order: -10,
            label: "Claude plan",
          },
          DockWidget,
        ),
      );
    }

    exports.apply = apply;
    // Cordis fiber inject is SERVICE names (ctx.slots), not package names.
    // Package load order belongs in package.json dsh.client.inject.
    exports.inject = ["slots"];
    return module.exports;
  },
});
