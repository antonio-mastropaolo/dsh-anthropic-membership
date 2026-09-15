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
      const [st, setSt] = react.useState({ signedIn: false, expiresAt: null, error: null, busy: false });
      const refresh = react.useCallback(() => {
        fetch(API + "/status", { headers: HEADER })
          .then((r) => r.json())
          .then((j) => setSt((s) => ({ ...s, signedIn: !!j.signedIn, expiresAt: j.expiresAt || null, error: null })))
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
            setSt({ signedIn: !!j.signedIn, expiresAt: j.expiresAt || null, error: null, busy: false });
          })
          .catch((e) => setSt((s) => ({ ...s, busy: false, error: String(e.message || e) })));
      }, []);
      const signOut = react.useCallback(() => {
        fetch(API + "/logout", { method: "POST", headers: HEADER })
          .then((r) => r.json())
          .then((j) => setSt({ signedIn: !!j.signedIn, expiresAt: null, error: null, busy: false }))
          .catch((e) => setSt((s) => ({ ...s, error: String(e) })));
      }, []);
      return { st, signIn, signOut, refresh };
    }

    function Panel() {
      const { st, signIn, signOut } = useStatus();
      const exp = st.expiresAt ? new Date(st.expiresAt).toLocaleString() : null;
      return jsx.jsxs("div", {
        style: {
          margin: "12px 0 16px",
          padding: "12px 14px",
          border: "1px solid rgba(127,127,127,0.35)",
          borderRadius: 8,
        },
        children: [
          jsx.jsx("div", {
            style: { fontWeight: 600, marginBottom: 4 },
            children: "Anthropic subscription (Claude Pro/Max)",
          }),
          jsx.jsx("div", {
            style: { fontSize: 13, opacity: 0.8, marginBottom: 10 },
            children: st.signedIn
              ? "Signed in with membership. Pick an anthropic / claude-* model. No API key."
              : "Uses your Claude Pro/Max membership. Does not bill Anthropic API.",
          }),
          jsx.jsx("div", {
            style: { fontSize: 13, marginBottom: 10 },
            children: st.signedIn
              ? "Status: signed in" + (exp ? " · expires " + exp : "")
              : "Status: not signed in",
          }),
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
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
