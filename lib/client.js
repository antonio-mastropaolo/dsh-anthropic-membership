window.__ModuleLoader__.load({
  id: "@local/dsh-model-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const FishLogo = primitives.FishLogo;
    const PORT = 8185;
    const API = "http://127.0.0.1:" + PORT;
    const HEADER = { "x-dsh-model-hub": "1" };
    const h = jsx.jsx;
    const hs = jsx.jsxs;

    // ---- tiny fetch helpers (no secrets ever pass through here) ----
    /** Coerce any host/shim error payload (string | {error|message|detail}) to one readable string. */
    function errStr(x) {
      if (x == null) return "";
      if (typeof x === "string") return x;
      if (typeof x === "object") return errStr(x.error) || errStr(x.message) || errStr(x.detail) || "";
      return String(x);
    }
    function httpError(r, j) {
      const e = new Error(errStr(j && j.error) || errStr(j && j.detail) || r.statusText || "HTTP " + r.status);
      e.status = r.status;
      return e;
    }
    // A network-level failure (no listener on the port) is a TypeError("Failed to fetch"): say what it means.
    const UNREACHABLE = "not reachable at 127.0.0.1:" + PORT + " (is DSH running with this plugin, or is another DSH instance holding the port?)";
    const reachable = (p) => p.catch((e) => { if (e && e.name === "TypeError") throw new Error(UNREACHABLE); throw e; });
    function getJson(path) {
      return reachable(fetch(API + path, { headers: HEADER })).then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw httpError(r, j);
        return j;
      });
    }
    // Every change first asks the hub which DSH instance it belongs to (GET /healthz, fresh each time, no shared
    // state) and is sent only when that is positively this page's instance. So a second instance's UI can never
    // sign in, switch GPUs or refresh grants on the first instance's behalf, not even before its own status loads.
    const NO_OWNER = "The model hub has not reported which DSH instance it belongs to yet; try again in a moment.";
    function postJson(path, body) {
      return getJson("/healthz").then((h) => {
        const owner = h && typeof h.webOrigin === "string" ? h.webOrigin : null;
        if (!owner) throw new Error(NO_OWNER);
        if (otherInstance(owner)) throw new Error(OTHER_INSTANCE(owner));
        return reachable(fetch(API + path, {
          method: "POST",
          headers: { ...HEADER, "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        })).then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw httpError(r, j);
          return j;
        });
      });
    }
    /** Poll a GET endpoint; returns {data, error, reload}. */
    function usePoll(path, ms, enabled) {
      const [state, setState] = react.useState({ data: null, error: null });
      const reload = react.useCallback(() => {
        if (!path) return Promise.resolve();
        return getJson(path).then(
          (data) => setState({ data, error: null }),
          (e) => setState((s) => ({ data: s.data, error: String(e.message || e) })),
        );
      }, [path]);
      react.useEffect(() => {
        if (enabled === false || !path) return undefined;
        reload();
        const id = setInterval(reload, ms);
        return () => clearInterval(id);
      }, [reload, ms, enabled, path]);
      return { ...state, reload };
    }

    const usd = (n) => (typeof n === "number" ? "$" + n.toFixed(n >= 100 ? 0 : 2) : "$0.00");
    const pct = (x) => (typeof x === "number" ? Math.round(x * 100) + "%" : "—");
    const num = (n) => (typeof n === "number" ? n.toLocaleString() : "0");

    function fmtReset(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      const same = d.toDateString() === new Date().toDateString();
      const opts = { hour: "numeric", minute: "2-digit" };
      return same ? d.toLocaleTimeString(undefined, opts) : d.toLocaleString(undefined, { ...opts, weekday: "short" });
    }
    function fmtExpiry(ms) {
      if (typeof ms !== "number") return "";
      const abs = Math.abs(ms);
      const days = abs / 86400000;
      const t = days >= 1 ? days.toFixed(days >= 10 ? 0 : 1) + " d" : abs >= 3600000 ? (abs / 3600000).toFixed(1) + " h" : Math.max(1, Math.round(abs / 60000)) + " min";
      return ms < 0 ? "expired " + t + " ago" : "expires in " + t;
    }

    // ---- provider marks: @lobehub/icons-static-svg@1.102.0 (MIT), rendered with fill=currentColor ----
    const ICONS = {
      "anthropic": {"vb":"0 0 24 24","p":[{"d":"M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/claude.svg (MIT)"},
      "openai-codex": {"vb":"0 0 24 24","p":[{"d":"M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/openai.svg (MIT)"},
      "github-copilot": {"vb":"0 0 24 24","p":[{"d":"M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/githubcopilot.svg (MIT)"},
      "kimi-coding": {"vb":"0 0 24 24","p":[{"d":"M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"},{"d":"M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/kimi.svg (MIT)"},
      "openrouter": {"vb":"0 0 24 24","p":[{"d":"M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/openrouter.svg (MIT)"},
      "xai": {"vb":"0 0 24 24","p":[{"d":"M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/xai.svg (MIT)"},
      "rocco": {"vb":"0 0 24 24","p":[{"d":"M10.212 8.976V7.62c.127-.01.256-.017.388-.021 3.596-.117 5.957 3.184 5.957 3.184s-2.548 3.647-5.282 3.647a3.227 3.227 0 01-1.063-.175v-4.109c1.4.174 1.681.812 2.523 2.258l1.873-1.627a4.905 4.905 0 00-3.67-1.846 6.594 6.594 0 00-.729.044m0-4.476v2.025c.13-.01.259-.019.388-.024 5.002-.174 8.261 4.226 8.261 4.226s-3.743 4.69-7.643 4.69c-.338 0-.675-.031-1.007-.092v1.25c.278.038.558.057.838.057 3.629 0 6.253-1.91 8.794-4.169.421.347 2.146 1.193 2.501 1.564-2.416 2.083-8.048 3.763-11.24 3.763-.308 0-.603-.02-.894-.048V19.5H24v-15H10.21zm0 9.756v1.068c-3.356-.616-4.287-4.21-4.287-4.21a7.173 7.173 0 014.287-2.138v1.172h-.005a3.182 3.182 0 00-2.502 1.178s.615 2.276 2.507 2.931m-5.961-3.3c1.436-1.935 3.604-3.148 5.961-3.336V6.523C5.81 6.887 2 10.723 2 10.723s2.158 6.427 8.21 7.015v-1.166C5.77 16 4.25 10.958 4.25 10.958h-.002z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/nvidia.svg (MIT)"},
      "nvidia": {"vb":"0 0 24 24","p":[{"d":"M10.212 8.976V7.62c.127-.01.256-.017.388-.021 3.596-.117 5.957 3.184 5.957 3.184s-2.548 3.647-5.282 3.647a3.227 3.227 0 01-1.063-.175v-4.109c1.4.174 1.681.812 2.523 2.258l1.873-1.627a4.905 4.905 0 00-3.67-1.846 6.594 6.594 0 00-.729.044m0-4.476v2.025c.13-.01.259-.019.388-.024 5.002-.174 8.261 4.226 8.261 4.226s-3.743 4.69-7.643 4.69c-.338 0-.675-.031-1.007-.092v1.25c.278.038.558.057.838.057 3.629 0 6.253-1.91 8.794-4.169.421.347 2.146 1.193 2.501 1.564-2.416 2.083-8.048 3.763-11.24 3.763-.308 0-.603-.02-.894-.048V19.5H24v-15H10.21zm0 9.756v1.068c-3.356-.616-4.287-4.21-4.287-4.21a7.173 7.173 0 014.287-2.138v1.172h-.005a3.182 3.182 0 00-2.502 1.178s.615 2.276 2.507 2.931m-5.961-3.3c1.436-1.935 3.604-3.148 5.961-3.336V6.523C5.81 6.887 2 10.723 2 10.723s2.158 6.427 8.21 7.015v-1.166C5.77 16 4.25 10.958 4.25 10.958h-.002z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/nvidia.svg (MIT)"},
      "mac": {"vb":"0 0 24 24","p":[{"d":"M11.932 6.908c.95 0 2.727-1.291 4.595-1.1.782.032 2.976.316 4.388 2.38-.113.069-2.622 1.528-2.593 4.565.034 3.617 3.166 4.828 3.221 4.85-.029.086-.506 1.723-1.658 3.416-1.002 1.463-2.039 2.919-3.675 2.95-1.606.03-2.125-.955-3.96-.955s-2.409.923-3.931.984c-1.581.06-2.78-1.58-3.79-3.037-2.065-2.98-3.64-8.422-1.527-12.087 1.051-1.824 2.93-2.98 4.969-3.009 1.549-.032 3.011 1.043 3.96 1.043zM16.552 0c.153 1.407-.411 2.817-1.251 3.833-.837 1.013-2.214 1.804-3.555 1.7-.185-1.378.495-2.814 1.27-3.712C13.883.805 15.346.05 16.553 0z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/apple.svg (MIT)"},
      "google": {"vb":"0 0 24 24","p":[{"d":"M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/gemini.svg (MIT)"},
      "dashscope": {"vb":"0 0 24 24","p":[{"d":"M19.713 2.825h-5.907c0-.251-.066-.503-.196-.728L12.819.728A1.46 1.46 0 0 0 11.559 0h-1.58c-.52 0-1 .275-1.26.728l-2.42 4.19a1.45 1.45 0 0 0 0 1.453l.791 1.37c.26.448.74.727 1.26.727h11.36c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451l-.79-1.37a1.46 1.46 0 0 0-1.26-.728zM.195 9.905l2.951 5.115a1.46 1.46 0 0 0-.531.531l-.791 1.37a1.45 1.45 0 0 0 0 1.452l.79 1.37c.26.448.74.727 1.26.727h4.84c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451L5.086 7.083a1.46 1.46 0 0 0-1.26-.728h-1.58c-.52 0-1 .276-1.26.728l-.79 1.37a1.45 1.45 0 0 0 0 1.452m15.888 13.367 2.951-5.115c.217.125.469.196.728.196h1.582c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451l-2.42-4.191a1.46 1.46 0 0 0-1.259-.728h-1.582c-.52 0-1 .276-1.259.728l-5.678 9.838a1.45 1.45 0 0 0 0 1.452l.79 1.37c.26.448.74.727 1.26.727h1.582c.52 0 1-.275 1.26-.728z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/qwen.svg (MIT)"},
      "ollama": {"vb":"0 0 24 24","p":[{"d":"M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zM7.44 2.3l-.003.002a.659.659 0 00-.285.238l-.005.006c-.138.189-.258.467-.348.832-.17.692-.216 1.631-.124 2.782.43-.128.899-.208 1.404-.237l.01-.001.019-.034c.046-.082.095-.161.148-.239.123-.771.022-1.692-.253-2.444-.134-.364-.297-.65-.453-.813a.628.628 0 00-.107-.09L7.44 2.3zm9.174.04l-.002.001a.628.628 0 00-.107.09c-.156.163-.32.45-.453.814-.29.794-.387 1.776-.23 2.572l.058.097.008.014h.03a5.184 5.184 0 011.466.212c.086-1.124.038-2.043-.128-2.722-.09-.365-.21-.643-.349-.832l-.004-.006a.659.659 0 00-.285-.239h-.004z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/ollama.svg (MIT)"},
      "deepseek": {"vb":"0 0 24 24","p":[{"d":"M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"}],"src":"@lobehub/icons-static-svg@1.102.0 icons/deepseek.svg (MIT)"},
    };
    const NEUTRAL_ICON = { vb: "0 0 24 24", p: [{ d: "M12 3a9 9 0 100 18 9 9 0 000-18zm0 2.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z", fr: "evenodd" }] };
    const ICON_ALIAS = {
      openai: "openai-codex", codex: "openai-codex", chatgpt: "openai-codex",
      claude: "anthropic",
      copilot: "github-copilot", github: "github-copilot",
      kimi: "kimi-coding", moonshot: "kimi-coding",
      grok: "xai",
      gemini: "google",
      qwen: "dashscope", alibaba: "dashscope",
      nearai: "neutral", near: "neutral", abliteration: "neutral", meter: "neutral",
    };
    /** provider / "provider/model" / alias -> ICONS key | "neutral" | null (unknown). */
    function iconKey(p) {
      const k = String(p || "").toLowerCase().trim().split("/")[0];
      if (!k) return null;
      if (ICONS[k]) return k;
      if (ICON_ALIAS[k]) return ICON_ALIAS[k];
      if (/^rocco/.test(k)) return "rocco";
      if (/^mac(-|$)/.test(k)) return "mac";
      return null;
    }
    /** Panel icon key for the configured GPU server: must be an embedded mark, else "nvidia". */
    function gpuIconKey(icon) {
      const k = String(icon || "").toLowerCase();
      return Object.prototype.hasOwnProperty.call(ICONS, k) ? k : "nvidia";
    }
    const gpuLabel = (cfg) => (cfg && cfg.name ? String(cfg.name) : "GPU server");
    const gpuTitle = (cfg) => gpuLabel(cfg) + " GPUs";
    /** Models served by the GPU server: those it owns (owner === its id) when any, else every model not owned by
     *  "mac" (a failover copy on another machine), minus ids containing any gpuServer.hideModels substring. */
    function gpuServerModels(list, cfg) {
      const hide = cfg && Array.isArray(cfg.hideModels) ? cfg.hideModels.filter((s) => typeof s === "string" && s) : [];
      const all = (list || []).filter((m) => m && !hide.some((s) => String(m.id).includes(s)));
      const own = cfg && cfg.id ? all.filter((m) => m.owner === cfg.id) : [];
      return own.length ? own : all.filter((m) => m.owner !== "mac");
    }
    /** Price rows for the GPU server: its defaultModel and the models it reports loaded (not the whole roster),
     *  falling back to the first model; plus the Mac copies. Ids are "<gpu id>/<model>" and "mac/<model>". */
    function gpuPriceIds(list, cfg) {
      if (!cfg || !cfg.id) return [];
      const models = gpuServerModels(list, cfg);
      const pick = new Set();
      if (cfg.defaultModel && models.some((m) => m.id === cfg.defaultModel)) pick.add(cfg.defaultModel);
      models.filter((m) => m.loaded).forEach((m) => pick.add(m.id));
      if (!pick.size && models.length) pick.add(models[0].id);
      const mac = (list || []).filter((m) => m && m.owner === "mac").map((m) => "mac/" + m.id);
      return [...[...pick].map((id) => cfg.id + "/" + id), ...mac];
    }
    /** Default model: the one the GPU endpoint reports loaded, else the first model the server reports loaded, else the first. */
    function defaultGpuModel(models, loadedModel, preferred) {
      if (!models.length) return "";
      if (loadedModel && models.some((m) => m.id === loadedModel)) return loadedModel;
      if (preferred && models.some((m) => m.id === preferred)) return preferred;
      const up = models.find((m) => m.loaded);
      return (up || models[0]).id;
    }
    function ProviderIcon(props) {
      const size = props.size || 16;
      const key = iconKey(props.provider);
      const ic = key === "neutral" ? NEUTRAL_ICON : key ? ICONS[key] : null;
      if (!ic) {
        const letter = (String(props.provider || "?").trim()[0] || "?").toUpperCase();
        return h("span", { className: "dshMh-mono-ico", "aria-hidden": "true", style: { width: size, height: size, fontSize: Math.round(size * 0.72) + "px", lineHeight: size + "px" }, children: letter });
      }
      return h("svg", {
        className: "dshMh-ico",
        width: size,
        height: size,
        viewBox: ic.vb,
        fill: "currentColor",
        "aria-hidden": "true",
        focusable: "false",
        children: ic.p.map((p, i) => h("path", { key: i, d: p.d, fillRule: p.fr || undefined, opacity: p.op == null ? undefined : p.op })),
      });
    }
    function ProviderTile(props) {
      const size = props.size || 28;
      return hs("span", {
        className: "dshMh-tile" + (props.dim ? " is-dim" : ""),
        style: { width: size, height: size },
        children: [
          h(ProviderIcon, { provider: props.provider, size: props.glyph || 16 }),
          props.badge ? h("span", { className: "dshMh-badge is-" + props.badge, "aria-hidden": "true" }) : null,
        ],
      });
    }

    // ---- pure helpers (unit-tested via exports._test) ----
    const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
    const BROKEN = ["expired", "refresh-failed", "expiring"];
    const isBroken = (a) => BROKEN.includes(a && a.health);
    const isAvailable = (a) => !!a && (a.health === "missing" || (!a.health && !a.signedIn));
    /** One human line for an account error; raw text stays in the title. */
    function humanizeError(a) {
      if (!a || !a.lastError) return "";
      let t;
      if (a.errorKind === "revoked") t = "Sign-in was revoked or replaced. Sign in again.";
      else if (a.errorKind === "rejected") t = "The provider rejected the saved sign-in. Sign in again.";
      else if (a.errorKind === "unreachable") t = "Couldn't reach the provider. Retrying automatically.";
      else {
        t = String(a.lastError)
          .replace(/\b(url|body)=\S*/gi, " ")
          .replace(/\{[\s\S]*$/, " ")
          .replace(/\s+/g, " ")
          .replace(/[\s;:,-]+$/, "")
          .trim();
        if (!t) t = "Sign-in problem.";
        if (t.length > 110) t = t.slice(0, 107).trimEnd() + "…";
        if (!/[.!?…]$/.test(t)) t += ".";
      }
      if (a.terminal) t += " Automatic retries paused.";
      return t;
    }
    function acctSubline(a) {
      if (!a) return "";
      const ms = a.expiresInMs;
      const ex = fmtExpiry(ms);
      if (a.health === "missing" || (!a.health && !a.signedIn)) return "Not signed in";
      if (a.health === "expired") return ex ? cap1(ex) : "Expired";
      if (a.health === "refresh-failed") return "Refresh failed" + (ex ? " · " + ex : "");
      if (a.health === "expiring") return "Expiring soon" + (ex ? " · " + ex : "");
      return "Signed in" + (typeof ms === "number" && ms > 0 ? " · " + ex.replace(/^expires in/, "renews in") : "");
    }
    const gpuIdle = (g) => !!g && !(g.processes && g.processes.length) && (g.used_mib || 0) < 1024;
    function gpuSetLabel(gpus, total) {
      if (gpus === "all" || gpus == null) return "all GPUs";
      if (Array.isArray(gpus)) return typeof total === "number" && gpus.length === total && total > 0 ? "all GPUs" : "GPU" + (gpus.length === 1 ? " " : "s ") + gpus.join(",");
      return "GPUs " + gpus;
    }
    function staleLine(reservations, totalGpus) {
      const st = (reservations || []).filter((r) => r && r.stale);
      if (!st.length) return "";
      return st.map((r) => "Stale reservation " + (r.owner || "?") + " (" + gpuSetLabel(r.gpus, totalGpus) + "): container gone. Shown only, never deleted.").join(" ");
    }
    const isLeaseError = (e) => !!e && (e.status === 409 || /\b409\b|lease|conflict/i.test(String(e.message || e)));
    function fmtPm(n) {
      if (typeof n !== "number" || !isFinite(n)) return "?";
      let s = String(+n.toFixed(4));
      if (!s.includes(".")) s += ".00";
      else if (s.split(".")[1].length < 2) s += "0";
      return "$" + s;
    }
    /** The GPU server lists the Mac failover copy as "<gpu id>/mac-…"; price it as mac/mac-…. Only for the configured server. */
    const normPriceId = (id, gpuId) => {
      const s = String(id || "");
      return gpuId && s.startsWith(gpuId + "/mac-") ? "mac/" + s.slice(gpuId.length + 1) : s;
    };
    const priceModelPart = (id) => String(id || "").split("/").slice(1).join("/") || String(id || "");
    /** The ids sent to /prices (max 50): every configured priceModel is kept; GPU-server and recently used
     *  models fill the remaining slots. Display order stays GPU models, priceModels, then recently used. */
    const PRICES_MAX = 50;
    // Same pattern and limit as lib/cost/prices.mjs PRICE_ID_RE / PRICE_ID_MAX (a test keeps them identical):
    // an id the host would reject is never sent, so one odd ledger key cannot fail the whole price request.
    const PRICE_ID_SRC = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}\\/[A-Za-z0-9][A-Za-z0-9._:@\\/-]{0,78}$";
    const PRICE_ID = new RegExp(PRICE_ID_SRC);
    const isPriceId = (s) => typeof s === "string" && s.length <= 120 && PRICE_ID.test(s);
    function priceList(local, priceModels, seen) {
      const ok = (xs) => xs.filter(isPriceId);
      local = ok(local); priceModels = ok(priceModels); seen = ok(seen);
      const keep = new Set(priceModels.slice(0, PRICES_MAX));
      for (const m of [...local, ...seen]) { if (keep.size >= PRICES_MAX) break; keep.add(m); }
      return Array.from(new Set([...local, ...priceModels, ...seen])).filter((m) => keep.has(m));
    }
    /** Normalize, de-duplicate and group the /prices payload for display. */
    function groupPrices(models, providerHealth, gpuId) {
      const seen = new Map();
      for (const [rawId, v] of Object.entries(models || {})) {
        const id = normPriceId(rawId, gpuId);
        if (!seen.has(id) || (v && v.billing === "metered" && seen.get(id).billing !== "metered")) seen.set(id, v || {});
      }
      const rows = [];
      const groups = {};
      for (const [id, v] of seen) {
        const provider = id.split("/")[0];
        const bad = !!(providerHealth && providerHealth[provider] && providerHealth[provider].code != null);
        const info = bad ? providerHealth[provider] : null;
        if (!v.priced) rows.push({ id, provider, kind: "unpriced", noCredit: bad, info });
        else if (v.billing === "metered") {
          const parts = [fmtPm(v.inPerM) + " in", fmtPm(v.outPerM) + " out"];
          if (typeof v.cacheReadPerM === "number") parts.push(fmtPm(v.cacheReadPerM) + " cache");
          rows.push({ id, provider, kind: "metered", line: parts.join(" · "), noCredit: bad, info });
        } else (groups[v.billing || "other"] = groups[v.billing || "other"] || []).push(priceModelPart(id));
      }
      return { rows, groups: Object.entries(groups).map(([k, items]) => ({ label: cap1(k), items })) };
    }
    // a sign-in page is opened and linked only when it is an https URL (never javascript:, data:, file:, http:)
    function signInUrl(u) {
      return typeof u === "string" && /^https:\/\/[^\s]+$/i.test(u) ? u : null;
    }

    function spendView(d) {
      if (!d || !d.totals) return null;
      const ext = d.external && d.external.totals ? d.external : null;
      const dshUsd = d.totals.usd || 0;
      const dshCalls = d.totals.calls || 0;
      const rows = Object.entries(d.byProvider || {}).map(([k, v]) => ({ k, usd: v.usd || 0, calls: v.calls || 0, meter: false }));
      if (ext) for (const [k, v] of Object.entries(ext.byProvider || {})) rows.push({ k, usd: v.usd || 0, calls: v.calls || 0, meter: true });
      rows.sort((a, b) => b.usd - a.usd);
      // complete === false: another DSH process kept rotating the ledger while it was read, so totals may be low
      const partial = d.complete === false;
      const partialLine = d.unreadable ? "partial: the spend ledger could not be read (run dsh-hub doctor), totals may be low" : "partial: the ledger was being rotated by another DSH process, totals may be low";
      return {
        partial,
        usd: dshUsd + (ext ? ext.totals.usd || 0 : 0),
        calls: dshCalls + (ext ? ext.totals.calls || 0 : 0),
        sub: ext ? "DSH " + usd(dshUsd) + " · " + num(dshCalls) + " calls · Meter " + usd(ext.totals.usd) + " · " + num(ext.totals.calls) + " calls" : "",
        subLines: (ext ? ["DSH " + usd(dshUsd) + " · " + num(dshCalls) + " calls", "Meter " + usd(ext.totals.usd) + " · " + num(ext.totals.calls) + " calls"] : []).concat(partial ? [partialLine] : []),
        extUsd: ext ? ext.totals.usd || 0 : 0,
        rows,
      };
    }


    // ---- plan usage (existing Claude card), status endpoint ----
    function useStatus() {
      const { data, error, reload } = usePoll("/status", 4000);
      const st = {
        signedIn: !!data?.signedIn,
        plan: data?.plan || { mode: "signed-out" },
        webOrigin: data?.webOrigin || null,
        spendGuard: data?.spendGuard === true,
        reachable: !!data && !error,
        error,
      };
      return { st, reload };
    }

    const PROVIDER_LABEL = {
      anthropic: "Anthropic (Claude Pro/Max)",
      "openai-codex": "OpenAI Codex (ChatGPT)",
      "github-copilot": "GitHub Copilot",
      "kimi-coding": "Kimi for Coding",
      openrouter: "OpenRouter",
      xai: "xAI",
    };
    const HEALTH = {
      ok: { dot: "ok", text: "Signed in" },
      expiring: { dot: "warn", text: "Expiring soon" },
      expired: { dot: "bad", text: "Expired" },
      "refresh-failed": { dot: "bad", text: "Refresh failed" },
      missing: { dot: "off", text: "Not signed in" },
    };

    // ---------------- shared UI pieces (design A: DSH tokens only, see HUB_CSS) ----------------
    const BILLING_LABEL = { subscription: "Subscription", metered: "Metered", local: "Local", free: "Free", mixed: "Mixed" };
    const billingTone = (b) => (b === "subscription" ? "accent" : b === "local" || b === "free" ? "ok" : "neutral");
    function Pill(props) {
      return h("span", { className: "dshMh-pill is-" + (props.tone || "neutral"), title: props.title, children: props.children });
    }
    const svgIcon = (d, size) => h("svg", { width: size || 14, height: size || 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false", className: "dshMh-ico", children: [].concat(d).map((p, i) => h("path", { key: i, d: p })) });
    const PLUS = ["M12 5v14", "M5 12h14"];
    const OUT_ARROW = ["M7 17 17 7", "M8 7h9v9"];
    const WARN_TRI = ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"];
    /** A labelled bar: label left, value right; tone ok | warn | danger | accent. */
    function Meter(props) {
      const p = Math.max(0, Math.min(100, props.pct || 0));
      return hs("div", { className: "dshMh-meter", children: [
        hs("div", { className: "dshMh-meter-top", children: [h("span", { className: "dshMh-soft", children: props.label }), h("span", { className: "dshMh-num", children: props.value })] }),
        h("div", { className: "dshMh-bar" + (props.thick ? " is-thick" : ""), role: "img", "aria-label": props.label + ": " + (typeof props.value === "string" ? props.value : Math.round(p) + "%"), children: h("span", { className: "dshMh-bar-fill is-" + (props.tone || "accent"), style: { width: (p > 0 ? Math.max(2, p) : 0) + "%" } }) }),
      ] });
    }
    const capTone = (pctUsed) => (pctUsed >= 100 ? "danger" : pctUsed >= 80 ? "warn" : "accent");
    /** Name and plan from the provider label: "Anthropic (Claude Pro/Max)" -> Anthropic · Claude Pro/Max. */
    function splitLabel(p) {
      const full = PROVIDER_LABEL[p] || String(p || "");
      const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(full);
      return m ? { name: m[1], plan: m[2], full } : { name: full, plan: "", full };
    }
    /** GPUs with no process and under 1 GiB used, of all GPUs. */
    function gpuFree(g) {
      const list = g && Array.isArray(g.gpus) ? g.gpus : [];
      return { free: list.filter(gpuIdle).length, total: list.length };
    }
    /** /spend payload -> the "In DSH" rows (per provider, with billing kind) and the "Outside DSH" meter rows. */
    function spendRows(d) {
      if (!d) return { inDsh: [], outside: [] };
      const inDsh = Object.entries(d.byProvider || {}).map(([k, v]) => ({ k, calls: v.calls || 0, usd: v.usd || 0, api: v.apiEquivUsd || 0, billing: v.billing || null, unpriced: v.unpricedCalls || 0 }))
        .sort((a, b) => b.usd - a.usd || b.api - a.api || b.calls - a.calls);
      const ext = d.external && d.external.byProvider ? d.external.byProvider : {};
      const outside = Object.entries(ext).map(([k, v]) => ({ k, calls: v.calls || 0, usd: v.usd || 0 })).sort((a, b) => b.usd - a.usd);
      return { inDsh, outside };
    }
    /** /prices payload -> one row per model with its billing kind; order: subscription, metered, free, local, unpriced. */
    const KIND_ORDER = { subscription: 0, metered: 1, free: 2, local: 3, unpriced: 4 };
    const fmtNum = (n) => (typeof n === "number" && isFinite(n) ? fmtPm(n).slice(1) : "—");
    function priceTable(models, providerHealth, gpuId) {
      const seen = new Map();
      for (const [rawId, v] of Object.entries(models || {})) {
        const id = normPriceId(rawId, gpuId);
        if (!seen.has(id) || (v && v.billing === "metered" && seen.get(id).billing !== "metered")) seen.set(id, v || {});
      }
      const rows = [];
      for (const [id, v] of seen) {
        const provider = id.split("/")[0];
        const info = providerHealth && providerHealth[provider] && providerHealth[provider].code != null ? providerHealth[provider] : null;
        const kind = v.priced ? v.billing || "metered" : "unpriced";
        rows.push({
          id, provider, kind, info, noCredit: !!info,
          model: iconKey(provider) ? priceModelPart(id) : id,
          in: v.priced ? fmtNum(v.inPerM) : "—", out: v.priced ? fmtNum(v.outPerM) : "—",
          cache: v.priced && typeof v.cacheReadPerM === "number" ? fmtNum(v.cacheReadPerM) : "—",
        });
      }
      return rows.map((r, i) => [r, i]).sort((a, b) => ((KIND_ORDER[a[0].kind] ?? 9) - (KIND_ORDER[b[0].kind] ?? 9)) || a[1] - b[1]).map((x) => x[0]);
    }

    // ---------------- Accounts panel (DSH native sign-in via the host) ----------------
    function SignInFlow(props) {
      const provider = props.provider;
      const name = splitLabel(provider).name;
      const [text, setText] = react.useState("");
      const [err, setErr] = react.useState(null);
      const { data } = usePoll("/accounts/signin/" + provider, 1000, props.active);
      const s = data || { state: "running", notices: [], prompt: null };
      const opened = react.useRef(null);
      const url = signInUrl((s.notices || []).map((n) => n && n.url).filter(Boolean).pop());
      const code = (s.notices || []).map((n) => n && n.code).filter(Boolean).pop();
      react.useEffect(() => {
        if (s.state === "authorized") props.onDone && props.onDone("authorized");
        if (s.state === "failed" || s.state === "cancelled") props.onDone && props.onDone(s.state, s.error);
      }, [s.state]);
      react.useEffect(() => {
        if (url && opened.current !== url) {
          opened.current = url;
          try { window.open(url, "_blank", "noopener"); } catch { /* popup blockers: the link below remains */ }
        }
      }, [url]);
      const answer = (value) => {
        setErr(null);
        const v = typeof value === "string" ? value : text;
        postJson("/accounts/signin/" + provider + "/answer", { text: v }).then(() => setText(""), (e) => setErr(String(e.message || e)));
      };
      // pi-ai login prompts come in two shapes: a "select" (e.g. Anthropic asks
      // Browser login vs Copy code) answered with an option id, or free text.
      const choices = s.prompt && Array.isArray(s.prompt.options) && s.prompt.options.length ? s.prompt.options : null;
      const cancel = () => postJson("/accounts/signin/" + provider + "/cancel", {}).catch(() => {});
      return hs("div", {
        className: "dshMh-flow",
        role: "group",
        "aria-label": "Sign in to " + name,
        children: [
          hs("div", { className: "dshMh-flowhead", children: [
            h("span", { className: "dshMh-strong", children: "Sign in to " + name }),
            h("span", { className: "dshMh-soft", children: choices ? "Choose how to sign in" : "Finish in the browser" }),
          ] }),
          choices ? hs("div", { className: "dshMh-prompt", children: [
            s.prompt.message ? h("div", { className: "dshMh-soft", children: s.prompt.message }) : null,
            h("div", { className: "dshMh-choices", children: choices.map((o, i) => hs("button", {
              key: String(o.id ?? i),
              type: "button",
              className: "dshMh-choice" + (i === 0 ? " is-first" : ""),
              onClick: () => answer(String(o.id ?? o.value ?? o.label ?? "")),
              children: [
                h("span", { className: "dshMh-strong", children: o.label || String(o.id) }),
                o.hint || o.description ? h("span", { className: "dshMh-soft", children: String(o.hint || o.description) }) : null,
              ],
            })) }),
          ] }) : hs("div", { className: "dshMh-wait", role: "status", children: [
            h("span", { className: "dshMh-spin", "aria-hidden": "true" }),
            hs("div", { className: "dshMh-wait-text", children: [
              h("div", { className: "dshMh-strong", children: url ? "Waiting for you to finish in the browser…" : "Waiting for DSH to produce the sign-in link…" }),
              h("div", { className: "dshMh-soft", children: url ? "The sign-in page opened in a new tab. Nothing is saved until " + name + " confirms." : "This usually takes a second or two." }),
            ] }),
          ] }),
          url && !choices ? hs("div", { className: "dshMh-row", children: [
            hs("a", { className: "dshMh-btn", href: url, target: "_blank", rel: "noopener noreferrer", children: ["Open the sign-in page", svgIcon(OUT_ARROW, 13)] }),
            code ? hs("span", { className: "dshMh-code", children: ["Code ", h("b", { children: code })] }) : h("span", { className: "dshMh-soft", children: "Popup blocked? Use this link." }),
          ] }) : null,
          !choices && s.prompt ? hs("div", { className: "dshMh-field", children: [
            h("label", { className: "dshMh-soft", htmlFor: "dshMh-code-" + provider, children: s.prompt.message || "Or paste the code shown after sign-in" }),
            hs("div", { className: "dshMh-row dshMh-nowrap", children: [
              h("input", {
                id: "dshMh-code-" + provider,
                className: "dshMh-input dshMh-grow",
                type: s.prompt.kind === "secret" ? "password" : "text",
                value: text,
                placeholder: s.prompt.placeholder || "Paste code",
                autoComplete: "off",
                onChange: (e) => setText(e.target.value),
              }),
              h("button", { type: "button", className: "dshMh-btn is-primary", disabled: !text, onClick: answer, children: "Submit" }),
            ] }),
          ] }) : null,
          err ? h("div", { className: "dshMh-err", children: err }) : null,
          h("div", { className: "dshMh-row dshMh-end", children: h("button", { type: "button", className: "dshMh-btn", onClick: cancel, children: "Cancel" }) }),
        ],
      });
    }

    /** Start / finish a DSH-native sign-in for one provider (shared by connected rows and the add chips). */
    function useSignIn(a, flows, onChange) {
      const [flowing, setFlowing] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const flow = (flows || []).find((f) => f.provider === a.provider);
      const method = flow && flow.methods && flow.methods.includes("oauth") ? "oauth" : flow && flow.methods && flow.methods[0] ? flow.methods[0] : "oauth";
      const start = () => {
        setMsg(null);
        postJson("/accounts/signin", { provider: a.provider, method }).then(
          () => setFlowing(true),
          (e) => { setMsg(String(e.message || e)); if (/progress|409/.test(String(e.message)) || e.status === 409) setFlowing(true); },
        );
      };
      const done = (state, error) => {
        setFlowing(false);
        setMsg(state === "authorized" ? "Signed in." : state === "cancelled" ? "Sign-in cancelled." : "Sign-in failed" + (error ? ": " + error : "."));
        onChange && onChange();
      };
      return { flowing, msg, start, done };
    }

    function ConnectedRow(props) {
      const a = props.account;
      const si = useSignIn(a, props.flows, props.onChange);
      const broken = isBroken(a);
      const lab = splitLabel(a.provider);
      const dot = a.health === "ok" ? "ok" : a.health === "expiring" ? "warn" : broken ? "bad" : null;
      const tn = a.health === "ok" ? "ok" : a.health === "expiring" ? "warn" : broken ? "bad" : "soft";
      const errLine = humanizeError(a);
      return hs("div", { className: "dshMh-acctbox", children: [
        hs("div", { className: "dshMh-acct-head", children: [
          h(ProviderTile, { provider: a.provider, badge: dot, size: 36, glyph: 18 }),
          hs("div", { className: "dshMh-acct-main", children: [
            hs("div", { className: "dshMh-acct-name", title: lab.full, children: [lab.name, lab.plan ? h("span", { className: "dshMh-soft dshMh-normal", children: " · " + lab.plan }) : null] }),
            h("div", { className: "dshMh-acct-sub is-" + tn, children: acctSubline(a) }),
          ] }),
          si.flowing ? null : h("button", { type: "button", className: "dshMh-btn" + (broken ? " is-primary" : ""), onClick: si.start, children: broken ? "Sign in again" : "Reconnect" }),
        ] }),
        errLine ? h("div", { className: "dshMh-err", title: a.lastError, children: errLine }) : null,
        si.msg ? h("div", { className: "dshMh-soft", children: si.msg }) : null,
        si.flowing ? h(SignInFlow, { provider: a.provider, active: true, onDone: si.done }) : null,
      ] });
    }

    function AvailableChip(props) {
      const a = props.account;
      const si = useSignIn(a, props.flows, props.onChange);
      const lab = splitLabel(a.provider);
      const chip = hs("button", {
        type: "button",
        className: "dshMh-addchip",
        disabled: si.flowing,
        title: "Sign in to " + lab.full,
        onClick: si.start,
        children: [h("span", { className: "dshMh-addchip-ico", children: h(ProviderIcon, { provider: a.provider, size: 13 }) }), h("span", { children: lab.name }), svgIcon(PLUS, 14)],
      });
      if (!si.flowing && !si.msg) return chip;
      return hs("div", { className: "dshMh-addwrap" + (si.flowing ? " is-flowing" : ""), children: [
        chip,
        si.msg ? h("div", { className: "dshMh-soft", children: si.msg }) : null,
        si.flowing ? h(SignInFlow, { provider: a.provider, active: true, onDone: si.done }) : null,
      ] });
    }

    function AccountsPanel() {
      const acc = usePoll("/accounts", 5000);
      const fl = usePoll("/accounts/flows", 60000);
      const [checking, setChecking] = react.useState(false);
      const list = (acc.data && acc.data.accounts) || [];
      const need = list.filter((a) => a.health === "refresh-failed" || a.health === "expired").length;
      const connected = list.filter((a) => a.signedIn && a.health !== "refresh-failed" && a.health !== "expired").length;
      const flows = (fl.data && fl.data.flows) || [];
      const full = list.filter((a) => !isAvailable(a)).sort((x, y) => (isBroken(y) ? 1 : 0) - (isBroken(x) ? 1 : 0));
      const avail = list.filter(isAvailable);
      const check = () => {
        setChecking(true);
        postJson("/accounts/refresh", {}).catch(() => {}).then(() => acc.reload()).then(() => setChecking(false), () => setChecking(false));
      };
      return hs("section", {
        className: "dshMh-card",
        "aria-label": "Accounts",
        children: [
          hs("div", { className: "dshMh-cardhead", children: [
            hs("div", { className: "dshMh-headl", children: [
              h("h3", { className: "dshMh-h3", children: "Accounts" }),
              acc.data ? h("span", { className: "dshMh-soft" + (need ? " is-bad" : ""), title: "Background token watchdog", children: (need ? need + " need sign-in" : connected + " connected") + " · " + (acc.data.reportOnly ? "auto-refresh: report only" : "auto-refresh on") }) : null,
            ] }),
            acc.data ? h("button", { type: "button", className: "dshMh-btn", disabled: checking, onClick: check, children: checking ? "Checking…" : "Check now" }) : null,
          ] }),
          acc.error ? h("div", { className: "dshMh-err", children: "Host API unreachable: " + acc.error }) : null,
          acc.data && acc.data.unavailable ? h("div", { className: "dshMh-warn", "data-testid": "accounts-unavailable", children: "Accounts unavailable: " + acc.data.unavailable + ". The plugin cannot read DSH's credential store (set DSH_NODE_MODULES; see the README)." }) : null,
          full.length ? h("div", { className: "dshMh-acctlist", children: full.map((a) => h(ConnectedRow, { key: a.provider, account: a, flows, onChange: acc.reload })) }) : null,
          avail.length ? hs("div", { className: "dshMh-addblock", children: [
            h("span", { className: "dshMh-soft", children: full.length ? "Add a sign-in" : "Sign in to use a subscription" }),
            h("div", { className: "dshMh-addrow", children: avail.map((a) => h(AvailableChip, { key: a.provider, account: a, flows, onChange: acc.reload })) }),
          ] }) : null,
        ],
      });
    }

    // ---------------- GPU server panel ----------------
    function GpuCard(props) {
      const g = props.gpu;
      const idle = gpuIdle(g);
      const used = idle ? 0 : g.total_mib ? Math.round((g.used_mib / g.total_mib) * 100) : 0;
      const owners = (g.processes || []).map((p) => p.user + " · " + p.cmd + " " + Math.round(p.used_mib / 1024 * 10) / 10 + " GiB");
      const res = g.reservation_stale ? [] : (g.reserved_by || []).map((r) => (typeof r === "string" ? r : r && r.owner) || "?");
      const total = g.total_mib ? (g.total_mib / 1024).toFixed(0) : "?";
      return hs("div", {
        className: "dshMh-gpu",
        children: [
          hs("div", { className: "dshMh-gpu-head", children: [
            h("b", { children: "GPU " + g.index }),
            h("span", { className: idle ? "dshMh-oktext" : "dshMh-soft", children: idle ? "Idle" : g.util_pct + "% util" }),
          ] }),
          h("div", { className: "dshMh-bar", role: "img", "aria-label": "GPU " + g.index + " memory " + used + "% used", children: h("span", { className: "dshMh-bar-fill is-" + (used > 85 ? "warn" : "accent"), style: { width: (idle ? 0 : Math.max(2, used)) + "%" } }) }),
          h("div", { className: "dshMh-soft dshMh-num", title: idle ? "driver baseline " + ((g.used_mib || 0) / 1024).toFixed(1) + " GiB, no processes" : undefined, children: (idle ? "0" : (g.used_mib / 1024).toFixed(1)) + " / " + total + " GiB" }),
          owners.length ? h("div", { className: "dshMh-owner", children: owners.map((o, i) => h("div", { key: i, children: o })) }) : null,
          res.map((r) => h(Pill, { key: r, title: "Reserved", children: "reserved · " + r })),
        ],
      });
    }

    /** Hidden entirely unless a GPU server is configured (config.json, see README "GPU server"). */
    function GpuPanel(props) {
      const cfg = props && props.cfg;
      if (!cfg || !cfg.configured) return null;
      return h(GpuServerPanel, { cfg });
    }
    function GpuServerPanel(props) {
      const cfg = props.cfg;
      const label = gpuLabel(cfg);
      const [busy, setBusy] = react.useState(null); // {target, started}
      const [err, setErr] = react.useState(null);
      const [forceable, setForceable] = react.useState(false);
      const lastReq = react.useRef(null);
      const [model, setModel] = react.useState("");
      const [pins, setPins] = react.useState([]);
      const fast = busy ? 2000 : 6000;
      const gp = usePoll("/gpu/gpus", fast);
      const md = usePoll("/gpu/models", fast);
      const g = gp.data;
      const models = gpuServerModels(md.data && md.data.models, cfg);
      // Truth for "loaded" is the GPU endpoint (the shim's per-model flag is stale).
      const loadedModel = g && g.loaded_model ? String(g.loaded_model) : null;
      const mac = ((md.data && md.data.models) || []).filter((m) => m.owner === "mac");
      react.useEffect(() => { if (!model && models.length) setModel(defaultGpuModel(models, loadedModel, cfg && cfg.defaultModel)); }, [models.length, loadedModel]);
      react.useEffect(() => {
        if (busy && busy.target === "unload" && !loadedModel) setBusy(null);
        if (busy && busy.target !== "unload" && loadedModel === busy.target) setBusy(null);
        if (busy && Date.now() - busy.started > 15 * 60000) setBusy(null);
      }, [md.data, gp.data]);
      const togglePin = (i) => setPins((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)));
      const send = (body, track) => {
        setErr(null);
        setForceable(false);
        lastReq.current = body;
        postJson("/gpu/switch", body).then(
          () => { if (track) setBusy({ target: body.model, started: Date.now() }); gp.reload(); md.reload(); },
          (e) => { setErr(String(e.message || e)); if (isLeaseError(e)) setForceable(true); },
        );
      };
      const load = () => send(pins.length ? { model, gpus: pins } : { model }, true);
      const forceSwitch = () => lastReq.current && send({ ...lastReq.current, force: true }, true);
      const pinned = g && g.pin && Array.isArray(g.pin.gpus) && g.pin.gpus.length ? g.pin.gpus : null;
      const unpin = () => send({ model: loadedModel || model, auto: true }, false);
      const unload = () => {
        setErr(null);
        postJson("/gpu/unload", {}).then(
          () => { setBusy({ target: "unload", started: Date.now() }); gp.reload(); md.reload(); },
          (e) => setErr(String(e.message || e)),
        );
      };
      const stale = staleLine((g && g.reservations) || [], g && g.gpus ? g.gpus.length : null);
      const failover = g && g.failover ? typeof g.failover === "string" ? g.failover : errStr(g.failover) || JSON.stringify(g.failover) : "";
      const fr = gpuFree(g);
      const gpuList = g && g.gpus ? g.gpus : [];
      return hs("section", {
        className: "dshMh-card",
        "aria-label": gpuTitle(cfg),
        children: [
          hs("div", { className: "dshMh-cardhead", children: [
            hs("div", { className: "dshMh-headl", children: [
              h(ProviderIcon, { provider: gpuIconKey(cfg.icon), size: 16 }),
              h("h3", { className: "dshMh-h3", children: gpuTitle(cfg) }),
              g && g.manager ? h(Pill, { tone: g.manager.active ? "ok" : "bad", children: g.manager.active ? "Manager active" : "Manager stopped" }) : null,
              g && g.stale ? h(Pill, { tone: "warn", children: "State stale" }) : null,
            ] }),
            fr.total ? h("span", { className: "dshMh-soft", children: fr.free + " of " + fr.total + " free" }) : null,
          ] }),
          gp.error ? h("div", { className: "dshMh-err", children: label + " unreachable: " + gp.error }) : null,
          g && g.ok === false ? h("div", { className: "dshMh-err", children: label + ": " + (g.error || "unavailable") }) : null,
          gpuList.length ? h("div", { className: "dshMh-gpus", children: gpuList.map((x) => h(GpuCard, { key: x.index, gpu: x })) }) : null,
          stale ? hs("div", { className: "dshMh-warn dshMh-warnrow", children: [svgIcon(WARN_TRI, 16), h("span", { children: stale })] }) : null,
          failover ? h("div", { className: "dshMh-soft", children: "Failover: " + failover }) : null,
          hs("div", { className: "dshMh-statusline", children: [
            loadedModel ? hs("span", { children: ["Loaded: ", h("b", { children: loadedModel })] }) : h("span", { children: "Nothing loaded · models load on demand" }),
            mac.length ? hs("span", { className: "dshMh-row", children: [
              h("span", { className: "dshMh-dot " + (mac.some((m) => m.loaded) ? "is-ok" : ""), "aria-hidden": "true" }),
              "Local Mac: " + mac.map((m) => m.id + (m.loaded ? " up" : " down")).join(", "),
            ] }) : null,
          ] }),
          g && g.pin && g.pin.error ? h("div", { className: "dshMh-err", children: "Pin error: " + g.pin.error }) : null,
          hs("div", { className: "dshMh-controls", children: [
            hs("label", { className: "dshMh-field dshMh-grow", children: [
              h("span", { className: "dshMh-soft", children: "Model" }),
              h("select", { className: "dshMh-input dshMh-select", value: model, disabled: !!busy, onChange: (e) => setModel(e.target.value), children: models.map((m) => h("option", { key: m.id, value: m.id, children: m.id + (m.id === loadedModel ? " (loaded)" : "") })) }),
            ] }),
            hs("div", { className: "dshMh-field", children: [
              h("span", { className: "dshMh-soft", id: "dshMh-gpus-label", children: "GPUs" }),
              hs("div", { className: "dshMh-seg", role: "group", "aria-labelledby": "dshMh-gpus-label", children: [
                h("button", { type: "button", className: "dshMh-seg-btn" + (pins.length ? "" : " is-on"), "aria-pressed": pins.length ? "false" : "true", disabled: !!busy, title: "Let the server choose free GPUs", onClick: () => setPins([]), children: "Auto" }),
                ...gpuList.map((x) => h("button", {
                  key: x.index,
                  type: "button",
                  className: "dshMh-seg-btn" + (pins.includes(x.index) ? " is-on" : "") + (gpuIdle(x) ? "" : " is-busy"),
                  "aria-pressed": pins.includes(x.index) ? "true" : "false",
                  disabled: !!busy,
                  title: gpuIdle(x) ? "Pin to GPU " + x.index : "GPU " + x.index + " is in use",
                  onClick: () => togglePin(x.index),
                  children: String(x.index),
                })),
              ] }),
            ] }),
            hs("div", { className: "dshMh-row", children: [
              h("button", { type: "button", className: "dshMh-btn is-primary is-tall", disabled: !!busy || !model, onClick: load, children: pins.length ? "Load on GPU " + pins.join(",") : "Load" }),
              h("button", { type: "button", className: "dshMh-btn is-tall", disabled: !!busy || !loadedModel, onClick: unload, children: "Unload" }),
              forceable ? h("button", { type: "button", className: "dshMh-btn is-tall", disabled: !!busy, title: "Switch even though another session holds the lease", onClick: forceSwitch, children: "Force switch" }) : null,
              pinned ? h("button", { type: "button", className: "dshMh-btn is-tall", disabled: !!busy || !(loadedModel || model), onClick: unpin, children: "Return to auto (pinned to GPU " + pinned.join(",") + ")" }) : null,
            ] }),
          ] }),
          busy ? hs("div", { className: "dshMh-progress", role: "status", children: [
            h("span", { className: "dshMh-spin", "aria-hidden": "true" }),
            (busy.target === "unload" ? "Unloading" : "Loading " + busy.target) + "… " + Math.round((Date.now() - busy.started) / 1000) + " s (polling every 2 s)",
          ] }) : null,
          err ? h("div", { className: "dshMh-err", children: err }) : null,
        ],
      });
    }

    // ---------------- Costs panel ----------------
    function CostsPanel(props) {
      const [period, setPeriod] = react.useState("today");
      const today = props.today || { data: null, error: null };
      const week = usePoll("/spend?since=7d&by=model", 20000);
      const hubCfg = usePoll("/hub/config", 60000);
      const seen = week.data ? Object.keys(week.data.groups || {}) : [];
      const gcfgData = props.gcfg || null;
      const gOn = !!(gcfgData && gcfgData.configured);
      const gm = usePoll(gOn ? "/gpu/models" : null, 60000);
      // keep the last good list so the local price rows survive the GPU server being briefly unreachable
      const lastG = react.useRef([]);
      if (gm.data && Array.isArray(gm.data.models) && gm.data.models.length) lastG.current = gm.data.models;
      const local = gOn ? gpuPriceIds(lastG.current, gcfgData) : [];
      // always-shown rows come from config.json priceModels (GET /hub/config); none by default
      const priceModels = (hubCfg.data && Array.isArray(hubCfg.data.priceModels)) ? hubCfg.data.priceModels : [];
      const models = priceList(local, priceModels, seen);
      // nothing to price yet (fresh install: no priceModels, no usage, no GPU server): do not call /prices at all
      const pr = usePoll(models.length ? "/prices?models=" + encodeURIComponent(models.join(",")) : null, 60000);
      const d = today.data;
      const caps = d && d.caps;
      const lim = caps && caps.limits;
      const sv = spendView(d);
      const shown = period === "7d" ? week.data : d;
      const rows = spendRows(shown);
      const prices = pr.data ? priceTable(pr.data.models, pr.data.providerHealth || {}, gOn ? gcfgData.id : null) : null;
      const unpricedModels = prices ? prices.filter((r) => r.kind === "unpriced").length : 0;
      const capPill = caps ? (caps.action === "block" ? h(Pill, { tone: "bad", title: caps.reason, children: "Cap reached" }) : caps.action === "warn" ? h(Pill, { tone: "warn", title: caps.reason, children: "Near a cap" }) : h(Pill, { tone: "ok", title: caps.reason, children: "Within caps" })) : null;
      const dailyPct = lim && lim.dailyUsd ? (caps.todayUsd / lim.dailyUsd) * 100 : 0;
      const sessSpent = caps && typeof caps.sessionSpentUsd === "number" ? caps.sessionSpentUsd : null;
      const sessPct = lim && lim.sessionUsd && sessSpent !== null ? (sessSpent / lim.sessionUsd) * 100 : 0;
      const tab = (id, text) => h("button", { type: "button", role: "tab", "aria-selected": period === id ? "true" : "false", className: "dshMh-tab" + (period === id ? " is-on" : ""), onClick: () => setPeriod(id), children: text });
      return hs("section", {
        className: "dshMh-card",
        "aria-label": "Costs",
        children: [
          hs("div", { className: "dshMh-cardhead", children: [
            hs("div", { className: "dshMh-headl", children: [h("h3", { className: "dshMh-h3", children: "Costs" }), capPill] }),
            hs("div", { className: "dshMh-tabs", role: "tablist", "aria-label": "Period", children: [tab("today", "Today"), tab("7d", "7 days")] }),
          ] }),
          today.error ? h("div", { className: "dshMh-err", children: "Spend unavailable: " + today.error }) : null,
          sv && sv.partial ? h("div", { className: "dshMh-warn", children: sv.subLines[sv.subLines.length - 1] }) : null,
          d && d.totals && d.totals.unpricedCalls > 0 ? h("div", { className: "dshMh-warn", title: "These calls went to a metered provider whose price is unknown, so their spend is stored as $0 and does not count toward the caps. Add the model to prices.json in the plugin data dir.", children: d.totals.unpricedCalls + " unpriced call" + (d.totals.unpricedCalls === 1 ? "" : "s") + " today — not counted toward caps (add prices.json)" }) : null,
          lim ? hs("div", { className: "dshMh-meters", children: [
            h(Meter, { label: "Daily cap", value: lim.dailyUsd ? usd(caps.todayUsd) + " of " + usd(lim.dailyUsd) : "off", pct: dailyPct, tone: capTone(dailyPct) }),
            h(Meter, { label: "Session cap", value: lim.sessionUsd ? (sessSpent === null ? "—" : usd(sessSpent)) + " of " + usd(lim.sessionUsd) : "off", pct: sessPct, tone: capTone(sessPct) }),
          ] }) : null,
          shown ? hs("div", { className: "dshMh-table", role: "table", "aria-label": "Spend " + (period === "7d" ? "in the last 7 days" : "today"), children: [
            hs("div", { className: "dshMh-thead dshMh-cols-spend", role: "row", children: [
              h("span", { role: "columnheader", children: "In DSH" }), h("span", { role: "columnheader", children: "Billing" }),
              h("span", { role: "columnheader", className: "dshMh-r", children: "Calls" }), h("span", { role: "columnheader", className: "dshMh-r", children: "Charged" }),
              h("span", { role: "columnheader", className: "dshMh-r", children: "API value" }),
            ] }),
            rows.inDsh.length ? rows.inDsh.map((r) => hs("div", { key: "d:" + r.k, className: "dshMh-trow dshMh-cols-spend", role: "row", children: [
              hs("span", { className: "dshMh-pname", role: "cell", children: [h("span", { className: "dshMh-slot", children: h(ProviderIcon, { provider: r.k, size: 14 }) }), h("span", { className: "dshMh-ellipsis", children: r.k })] }),
              h("span", { role: "cell", children: r.billing ? h(Pill, { tone: billingTone(r.billing), children: BILLING_LABEL[r.billing] || cap1(r.billing) }) : h("span", { className: "dshMh-soft", children: "—" }) }),
              h("span", { role: "cell", className: "dshMh-r dshMh-soft dshMh-num", children: num(r.calls) }),
              h("b", { role: "cell", className: "dshMh-r dshMh-num", children: usd(r.usd) }),
              h("span", { role: "cell", className: "dshMh-r dshMh-soft dshMh-num", children: usd(r.api) }),
            ] })) : h("div", { className: "dshMh-soft dshMh-pad", children: "No spend recorded " + (period === "7d" ? "in the last 7 days" : "today") + ". Subscription, free and local usage count as $0." }),
            rows.outside.map((r) => hs("div", { key: "m:" + r.k, className: "dshMh-trow dshMh-cols-spend is-outside", role: "row", title: "Metered outside DSH (an extra ledger from config.json extraLedgers; display only, never capped)", children: [
              hs("span", { className: "dshMh-pname dshMh-stack", role: "cell", children: [
                hs("span", { className: "dshMh-row dshMh-nowrap", children: [h("span", { className: "dshMh-slot", children: h(ProviderIcon, { provider: r.k, size: 14 }) }), h("span", { className: "dshMh-ellipsis", children: r.k })] }),
                h("span", { className: "dshMh-soft dshMh-small", children: "Outside DSH · extra ledger, not capped" }),
              ] }),
              h("span", { role: "cell", children: h(Pill, { tone: "outline", children: "Meter" }) }),
              h("span", { role: "cell", className: "dshMh-r dshMh-soft dshMh-num", children: num(r.calls) }),
              h("b", { role: "cell", className: "dshMh-r dshMh-num", children: usd(r.usd) }),
              h("span", { role: "cell", className: "dshMh-r dshMh-soft", children: "—" }),
            ] })),
          ] }) : null,
          hs("div", { className: "dshMh-pricehead", children: [h("h4", { className: "dshMh-h4", children: "Prices" }), h("span", { className: "dshMh-soft", children: "$ per million tokens" })] }),
          prices && prices.length ? hs("div", { className: "dshMh-table", role: "table", "aria-label": "Prices", children: [
            hs("div", { className: "dshMh-thead dshMh-cols-price", role: "row", children: [
              h("span", { role: "columnheader", children: "Model" }), h("span", { role: "columnheader", className: "dshMh-r", children: "In" }),
              h("span", { role: "columnheader", className: "dshMh-r", children: "Out" }), h("span", { role: "columnheader", className: "dshMh-r", children: "Cache" }),
              h("span", { role: "columnheader", children: "Billing" }),
            ] }),
            prices.map((r) => hs("div", { key: r.id, className: "dshMh-trow dshMh-cols-price" + (r.noCredit ? " is-dead" : ""), role: "row", title: r.id, children: [
              hs("span", { className: "dshMh-pname", role: "cell", children: [h("span", { className: "dshMh-slot", children: h(ProviderIcon, { provider: r.provider, size: 14 }) }), h("span", { className: "dshMh-mono dshMh-ellipsis", children: r.model })] }),
              h("span", { role: "cell", className: "dshMh-r dshMh-num" + (r.kind === "unpriced" ? " dshMh-soft" : ""), children: r.in }),
              h("span", { role: "cell", className: "dshMh-r dshMh-num" + (r.kind === "unpriced" ? " dshMh-soft" : ""), children: r.out }),
              h("span", { role: "cell", className: "dshMh-r dshMh-num" + (r.kind === "unpriced" ? " dshMh-soft" : ""), children: r.cache }),
              h("span", { role: "cell", children: r.noCredit
                ? h(Pill, { tone: "bad", title: (r.info && r.info.message) || "No credit", children: "No credit (" + (r.info && r.info.code != null ? r.info.code : "402") + ")" })
                : r.kind === "unpriced"
                  ? h(Pill, { tone: "warn", title: "No known price: calls are stored at $0 and do not count toward caps. Add it to prices.json in the plugin data dir.", children: "Add price" })
                  : h(Pill, { tone: billingTone(r.kind), children: BILLING_LABEL[r.kind] || cap1(r.kind) }) }),
            ] })),
          ] }) : null,
          unpricedModels ? h("div", { className: "dshMh-soft", children: unpricedModels + " model" + (unpricedModels === 1 ? " has" : "s have") + " no known price: their calls count as $0 and not toward caps. Add " + (unpricedModels === 1 ? "it" : "them") + " to prices.json." }) : null,
          pr.data && pr.data.warnings && pr.data.warnings.length ? h("div", { className: "dshMh-soft", children: pr.data.warnings.join("; ") }) : null,
          !models.length ? h("div", { className: "dshMh-soft", children: "No models to price yet. Models appear here once you use them; to always show some, list them as provider/model in priceModels in config.json." }) : null,
          models.length && pr.error ? h("div", { className: "dshMh-err", children: pr.error }) : null,
        ],
      });
    }

    // The hub port is fixed, so a second DSH instance's UI talks to the first instance's hub. Say so.
    function sameInstance(a, b) {
      try {
        const x = new URL(a), y = new URL(b);
        const host = (u) => (u.hostname === "localhost" ? "127.0.0.1" : u.hostname);
        return x.protocol === y.protocol && x.port === y.port && host(x) === host(y);
      } catch { return true; }
    }
    function otherInstance(webOrigin) {
      return Boolean(webOrigin && typeof location !== "undefined" && !sameInstance(webOrigin, location.origin));
    }
    const OTHER_INSTANCE = (o) => "This page is not the DSH instance that owns the model hub (port " + PORT + "). Accounts, GPU and costs shown here belong to " + o + ", and changes are disabled here: open " + o + " instead.";

    /** The three summary tiles at the top of the Model hub section. */
    function overviewTiles(spend, plan, gpuCfg, gpus) {
      const tiles = [];
      const caps = spend && spend.caps;
      if (caps && caps.limits) {
        const cap = caps.limits.dailyUsd;
        const p = cap ? (caps.todayUsd / cap) * 100 : 0;
        tiles.push({ key: "spend", label: "DSH spend today", value: usd(caps.todayUsd), sub: cap ? "of " + usd(cap) + " daily cap" : "no daily cap", pct: p, tone: capTone(p) });
      }
      if (spend && spend.totals) {
        tiles.push({ key: "api", label: "API-list value today", value: usd(spend.totals.apiEquivUsd || 0), sub: num(spend.totals.calls || 0) + " calls · " + usd(spend.totals.usd || 0) + " charged", pct: null });
      }
      if (gpuCfg && gpuCfg.configured && gpus && Array.isArray(gpus.gpus)) {
        const fr = gpuFree(gpus);
        tiles.push({ key: "gpu", label: gpuTitle(gpuCfg), value: fr.free + " of " + fr.total + " free", sub: gpus.loaded_model ? "loaded: " + gpus.loaded_model : "nothing loaded", pct: fr.total ? (fr.free / fr.total) * 100 : 0, tone: "ok" });
      } else if (plan && plan.mode === "plan" && plan.fiveHour && typeof plan.fiveHour.percent === "number") {
        tiles.push({ key: "plan", label: "Claude 5-hour window", value: plan.fiveHour.percent + "%", sub: "resets " + fmtReset(plan.fiveHour.resetsAt), pct: plan.fiveHour.percent, tone: tone(plan.fiveHour.percent) === "ok" ? "accent" : tone(plan.fiveHour.percent) });
      }
      return tiles;
    }

    function HubSection() {
      const { st } = useStatus();
      const today = usePoll("/spend?since=today&by=provider", 8000);
      const gcfg = usePoll("/gpu/config", 60000);
      const gOn = !!(gcfg.data && gcfg.data.configured);
      const gp = usePoll(gOn ? "/gpu/gpus" : null, 10000);
      const tiles = overviewTiles(today.data, st.plan, gcfg.data, gp.data);
      const up = st.reachable;
      return hs("div", {
        className: "dshMh-hub",
        children: [
          hs("div", { className: "dshMh-hubhead", children: [
            h("div", { className: "dshMh-hubtitle", children: "Model hub" }),
            hs("div", { className: "dshMh-hubstatus", role: "status", children: [
              h("span", { className: "dshMh-dot " + (up ? "is-ok" : st.error ? "is-bad" : ""), "aria-hidden": "true" }),
              h("span", { children: up ? "Hub connected" + (st.spendGuard ? " · spend guard on" : "") : st.error ? "Hub not reachable" : "Connecting…" }),
            ] }),
          ] }),
          otherInstance(st.webOrigin) ? h("div", { className: "dshMh-warn", role: "status", "data-testid": "other-instance", children: OTHER_INSTANCE(st.webOrigin) }) : null,
          tiles.length ? h("div", { className: "dshMh-tiles", children: tiles.map((t) => hs("div", { key: t.key, className: "dshMh-tile2", children: [
            h("span", { className: "dshMh-soft", children: t.label }),
            h("span", { className: "dshMh-big", children: t.value }),
            t.pct !== null ? h("div", { className: "dshMh-bar is-thin", "aria-hidden": "true", children: h("span", { className: "dshMh-bar-fill is-" + (t.tone || "accent"), style: { width: (t.pct > 0 ? Math.max(2, Math.min(100, t.pct)) : 0) + "%" } }) }) : h("div", { className: "dshMh-bar is-thin is-empty", "aria-hidden": "true" }),
            h("span", { className: "dshMh-soft", children: t.sub }),
          ] })) }) : null,
          h("div", { className: "dshMh-grid", children: [h(AccountsPanel, { key: "a" }), h(CostsPanel, { key: "c", today, gcfg: gcfg.data }), h(GpuPanel, { key: "r", cfg: gcfg.data })] }),
        ],
      });
    }

    // ---------------- Claude plan card (existing provider card, now read-only) ----------------
    // "Sent from DSH this window" (DSH's own session logs; the usage % above is account-wide). Only real numbers:
    // when the logs could not be read the line is left out, never shown as 0.
    function dshCountsLine(plan) {
      if (!plan || typeof plan.messages !== "number" || typeof plan.modelCalls !== "number") return null;
      return "Sent from DSH this window: " + plan.messages + " message" + (plan.messages === 1 ? "" : "s") + " · " + plan.modelCalls + " model call" + (plan.modelCalls === 1 ? "" : "s");
    }
    function tone(p) {
      if (typeof p !== "number") return "ok";
      if (p >= 95) return "danger";
      if (p >= 80) return "warn";
      return "ok";
    }
    // Ring gauges (design C): OK = accent arc, warn = amber, danger = red; "over" (a cap reached) closes the ring.
    function ringDash(r, p) {
      const c = 2 * Math.PI * r;
      const v = Math.max(0, Math.min(100, typeof p === "number" ? p : 0));
      return (v > 0 ? (c * Math.max(1, v)) / 100 : 0).toFixed(2) + " " + c.toFixed(2);
    }
    function Ring(props) {
      const size = props.size || 16;
      const r = props.r || (size / 2 - (props.stroke || 2.5) / 2 - 0.5);
      const box = props.box || size;
      const state = props.state || "ok";
      const p = state === "over" ? 100 : props.pct;
      return h("svg", {
        className: "dshMh-ring", width: size, height: size, viewBox: "0 0 " + box + " " + box, role: "img", "aria-label": props.label, focusable: "false",
        children: [
          h("circle", { key: "t", className: "dshMh-ring-track", cx: box / 2, cy: box / 2, r, fill: "none", strokeWidth: props.stroke || 2.5 }),
          // nothing used: no arc at all (a zero-length dash with round caps would still draw a dot)
          typeof p === "number" && p > 0 ? h("circle", { key: "a", className: "dshMh-ring-arc is-" + state, cx: box / 2, cy: box / 2, r, fill: "none", strokeWidth: props.stroke || 2.5, strokeLinecap: "round", strokeDasharray: ringDash(r, p), transform: "rotate(-90 " + box / 2 + " " + box / 2 + ")" }) : null,
        ],
      });
    }
    const ringState = (t) => (t === "danger" ? "danger" : t === "warn" ? "warn" : "ok");
    function planGauge(label, win, longLabel) {
      if (!win || typeof win.percent !== "number") return null;
      const st = ringState(tone(win.percent));
      return hs("div", { className: "dshMh-gauge", children: [
        hs("div", { className: "dshMh-gauge-ring", children: [
          h(Ring, { size: 84, box: 100, r: 42, stroke: 9, pct: win.percent, state: st, label: "Claude " + longLabel + ": " + win.percent + "% used" + (win.resetsAt ? ", resets " + fmtReset(win.resetsAt) : "") }),
          hs("div", { className: "dshMh-gauge-center", "aria-hidden": "true", children: [h("span", { className: "dshMh-gauge-v is-" + st, children: win.percent + "%" }), h("span", { className: "dshMh-soft", children: "used" })] }),
        ] }),
        hs("div", { className: "dshMh-gauge-cap", children: [h("span", { className: "dshMh-strong", children: label }), win.resetsAt ? h("span", { className: "dshMh-soft", children: "Resets " + fmtReset(win.resetsAt) }) : null] }),
      ] });
    }
    function planBody(plan) {
      if (!plan || plan.mode === "signed-out") return h("div", { className: "dshMh-soft", children: "Not signed in. Use Model hub → Accounts below to sign in." });
      if (plan.mode === "expired") return h("div", { className: "dshMh-badtext", children: "Claude sign-in expired — Model hub → Accounts" });
      if (plan.mode === "unavailable") return h("div", { className: "dshMh-soft", children: "Plan usage unavailable (" + (plan.httpStatus ?? "?") + "). The sign-in may need renewing: see Model hub → Accounts." });
      if (plan.mode === "api") return h("div", { className: "dshMh-soft", children: "Using Anthropic API key (billed per token)" });
      const counts = typeof plan.messages === "number" && typeof plan.modelCalls === "number";
      return hs("div", { className: "dshMh-planbody", children: [
        hs("div", { className: "dshMh-gauges", children: [
          planGauge("5-hour window", plan.fiveHour, "5-hour window"),
          planGauge("Weekly", plan.sevenDay, "weekly window"),
          counts ? hs("div", { className: "dshMh-statcol", title: dshCountsLine(plan), children: [
            hs("div", { className: "dshMh-stat", children: [h("span", { className: "dshMh-soft", children: "Messages from DSH" }), h("span", { className: "dshMh-statv", children: String(plan.messages) })] }),
            hs("div", { className: "dshMh-stat", children: [h("span", { className: "dshMh-soft", children: "Model calls from DSH" }), h("span", { className: "dshMh-statv", children: String(plan.modelCalls) })] }),
          ] }) : null,
        ] }),
        h("div", { className: "dshMh-soft", children: "Rings cover every Claude app on this account" + (counts ? "; the two counts are DSH only, this 5-hour window." : ".") }),
      ] });
    }
    function PlanCard() {
      const { st } = useStatus();
      const plan = st.plan;
      return hs("div", { className: "dshMh-plancard", children: [
        hs("div", { className: "dshMh-planhead", children: [
          hs("span", { className: "dshMh-row dshMh-nowrap", children: [h(ProviderIcon, { provider: "anthropic", size: 15 }), h("span", { className: "dshMh-strong", children: "Claude plan usage" })] }),
          plan && plan.mode === "plan" ? h(Pill, { tone: "accent", children: "Subscription" }) : plan && plan.mode === "api" ? h(Pill, { children: "API key" }) : null,
        ] }),
        planBody(plan),
      ] });
    }
    function Card(props) {
      if (!props || !props.provider || props.provider.provider !== "anthropic") return null;
      return h(PlanCard, {});
    }

    let pluginCtx = null;

    // ---------------- dock chip (conversation composer) ----------------
    /** The chip's three segments as plain data (unit-tested): Claude 5-hour window, DSH spend today, prompt cache. */
    function chipModel(plan, spend, cache) {
      let claude;
      if (plan && plan.mode === "expired") claude = { text: "sign-in expired", tone: "danger", bar: null, title: "Claude sign-in expired — Model hub → Accounts" };
      else if (!plan || plan.mode === "signed-out") claude = { text: "off", tone: "dim", bar: null, title: "Sign in with Claude Pro/Max in Settings → Models" };
      else if (plan.mode === "api") claude = { text: "API key", tone: "ok", bar: null, title: "Using Anthropic API key (billed per token)" };
      else {
        const five = plan.fiveHour && typeof plan.fiveHour.percent === "number" ? plan.fiveHour.percent : null;
        const week = plan.sevenDay && typeof plan.sevenDay.percent === "number" ? plan.sevenDay.percent : null;
        claude = {
          text: five === null ? "—" : five + "%", tone: tone(five), bar: five,
          title: plan.mode === "unavailable" ? "Plan usage unavailable (" + (plan.httpStatus ?? "?") + ")"
            : "Claude 5-hour window " + (five === null ? "—" : five + "%") + (plan.fiveHour && plan.fiveHour.resetsAt ? " (resets " + fmtReset(plan.fiveHour.resetsAt) + ")" : "") + ", weekly " + (week === null ? "—" : week + "%") + ". Account-wide; Anthropic does not publish remaining messages." + (dshCountsLine(plan) ? " " + dshCountsLine(plan) + "." : ""),
        };
      }
      const caps = spend && spend.caps;
      const partial = !!(spend && spend.complete === false);
      const ext = spend && spend.external && spend.external.totals ? spend.external.totals : null;
      const action = caps ? caps.action : null;
      const todayUsd = caps ? caps.todayUsd : spend && spend.totals ? spend.totals.usd : null;
      const cap = caps && caps.limits ? caps.limits.dailyUsd : 0;
      const today = {
        text: action === "block" ? "Cap reached" : todayUsd === null || todayUsd === undefined ? "—" : (partial ? "≥" : "") + usd(todayUsd),
        tone: action === "block" ? "danger" : action === "warn" || partial ? "warn" : "ok",
        ring: action === "block" ? "over" : action === "warn" || partial ? "warn" : "ok",
        pct: cap && typeof todayUsd === "number" ? Math.min(100, (todayUsd / cap) * 100) : 0,
        ringLabel: action === "block" ? "DSH spend today: daily cap reached" : cap ? "DSH spend today: " + usd(todayUsd || 0) + " of the " + usd(cap) + " daily cap" : "DSH spend today: no daily cap",
        title: (spend && spend.totals ? "DSH today: " + usd(spend.totals.usd || 0) + " charged · " + num(spend.totals.calls || 0) + " calls. " : "")
          + (ext ? "Outside DSH (extra ledger, not capped): " + usd(ext.usd || 0) + " · " + num(ext.calls || 0) + " calls. " : "")
          + (caps ? "Caps: " + caps.reason + "." : "Model hub host API not reachable."),
      };
      const latest = cache && cache.latest;
      const hit = latest && latest.steps > 1 && typeof latest.lastHit === "number" ? latest.lastHit : null;
      const cacheSeg = {
        text: hit === null ? "—" : pct(hit),
        tone: hit !== null && hit < 0.05 ? "warn" : "ok",
        title: latest && latest.steps > 1 ? "Prompt-cache hit on the last step (token-weighted session average " + pct(latest.avgHit) + ")." : "The cache can only hit from the second step of a session.",
      };
      return { claude, today, cache: cacheSeg };
    }

    const CACHE_REASON = {
      "model-changed": "the model changed",
      "system-prompt-changed": "the system prompt changed",
      "tools-changed": "the tool list changed",
      compaction: "the conversation was compacted",
      unknown: "the provider cache probably expired",
    };

    function DockChip(props) {
      const m = chipModel(props.plan, props.spend, props.cache);
      const five = m.claude.bar;
      return hs("div", {
        className: "dshMh-chip" + (props.spend ? "" : " is-dim"),
        "data-testid": "model-hub-chip",
        title: [m.claude.title, m.today.title, m.cache.title].join(" "),
        children: [
          hs("span", { className: "dshMh-chipseg is-claude is-" + m.claude.tone, children: [
            five !== null ? h(Ring, { size: 16, r: 6, stroke: 2.5, pct: five, state: ringState(m.claude.tone), label: "Claude 5-hour window: " + five + "% used" }) : h(ProviderIcon, { provider: "anthropic", size: 12 }),
            h("span", { className: "dshMh-chipk", children: "5h" }),
            h("b", { className: "dshMh-num", children: m.claude.text }),
          ] }),
          hs("span", { className: "dshMh-chipseg is-" + m.today.tone, children: [
            props.spend && props.spend.caps ? h(Ring, { size: 16, r: 6, stroke: 2.5, pct: m.today.pct, state: m.today.ring, label: m.today.ringLabel }) : null,
            h("span", { className: "dshMh-chipk", children: "Today" }),
            h("b", { className: "dshMh-num", children: m.today.text }),
          ] }),
          hs("span", { className: "dshMh-chipseg is-" + m.cache.tone, children: [h("span", { className: "dshMh-chipk", children: "Cache" }), h("b", { className: "dshMh-num", children: m.cache.text })] }),
        ],
      });
    }

    function DockWidget() {
      const { st } = useStatus();
      const sp = usePoll("/spend?since=today&by=provider", 8000);
      const ca = usePoll("/cache", 4000);
      const [toast, setToast] = react.useState(null);
      const seen = react.useRef(null);
      react.useEffect(() => {
        const sessions = (ca.data && ca.data.sessions) || [];
        if (!ca.data) return;
        if (seen.current === null) { seen.current = {}; sessions.forEach((s) => { seen.current[s.sessionId] = s.alerts || 0; }); return; }
        for (const s of sessions) {
          const prev = seen.current[s.sessionId] || 0;
          if ((s.alerts || 0) > prev && s.lastAlert) {
            setToast({ reason: s.lastAlert.reason, prev: s.lastAlert.prevHit, hit: s.lastAlert.hit });
            setTimeout(() => setToast(null), 12000);
          }
          seen.current[s.sessionId] = s.alerts || 0;
        }
      }, [ca.data]);
      return hs("div", {
        className: "dshAmPlan-wrap",
        children: [
          h("span", { className: "dshAmPlan-logo", title: "DeepSeek Harness", children: h(FishLogo, { size: 18 }) }),
          h(DockChip, { plan: st.plan, spend: sp.data, cache: ca.data }),
          otherInstance(st.webOrigin) ? h(Pill, { tone: "warn", title: OTHER_INSTANCE(st.webOrigin), children: "other DSH's hub" }) : null,
          toast ? hs("div", { className: "dshMh-toast", role: "alert", "data-testid": "cache-toast", children: [
            h("b", { children: "Prompt cache dropped" }),
            "Hit rate fell from " + pct(toast.prev) + " to " + pct(toast.hit) + ": " + (CACHE_REASON[toast.reason] || toast.reason) + ". The next request is billed at the full input price.",
          ] }) : null,
        ],
      });
    }

    // ---------------- styles: every color is a DSH token (light and dark follow DSH's theme) ----------------
    const HUB_CSS = [
      // semantic aliases, scoped to the plugin's own surfaces
      ".dshMh-hub,.dshMh-plancard,.dshAmPlan-wrap,.dshMh-toast{--mh-card:var(--dsw-alias-bg-layer-1,Canvas);--mh-sub:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--mh-card));--mh-line:var(--dsw-alias-border-l2);--mh-line2:var(--dsw-alias-border-l1);--mh-text:var(--dsw-alias-label-primary);--mh-text2:var(--dsw-alias-label-secondary);--mh-track:var(--dsw-alias-border-l2);--mh-accent:var(--dsw-alias-state-business-primary);--mh-accent-soft:var(--dsw-alias-state-business-tertiary);--mh-accent-text:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,var(--dsw-alias-label-primary));--mh-ok:var(--dsw-alias-state-success-primary);--mh-ok-soft:var(--dsw-alias-state-success-tertiary);--mh-ok-text:color-mix(in srgb,var(--dsw-alias-state-success-primary) 58%,var(--dsw-alias-label-primary));--mh-warn:var(--dsw-alias-state-warn-primary);--mh-warn-soft:var(--dsw-alias-state-warn-tertiary);--mh-warn-text:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-label-primary));--mh-bad:var(--dsw-alias-state-error-primary);--mh-bad-soft:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--mh-card));--mh-bad-text:color-mix(in srgb,var(--dsw-alias-state-error-primary) 80%,var(--dsw-alias-label-primary));--mh-primary:var(--dsw-alias-label-primary);--mh-primary-fg:var(--dsw-alias-label-primary-foreground)}",
      ".dshMh-hub{margin:16px 0;color:var(--mh-text);font-size:13px;line-height:20px;min-width:0;display:flex;flex-direction:column;gap:12px}",
      ".dshMh-hub *,.dshMh-plancard *{box-sizing:border-box}",
      ".dshMh-hubhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      ".dshMh-hubtitle{font-size:16px;line-height:24px;font-weight:500}",
      ".dshMh-hubstatus{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}",
      ".dshMh-tile2{min-width:0;display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--mh-line);border-radius:12px;background:var(--mh-card)}",
      ".dshMh-tile2 .dshMh-soft{font-size:12px;line-height:16px}",
      ".dshMh-grid{display:flex;flex-direction:column;gap:12px;min-width:0}",
      ".dshMh-card{min-width:0;padding:16px;border:1px solid var(--mh-line);border-radius:12px;background:var(--mh-card);display:flex;flex-direction:column;gap:14px}",
      ".dshMh-cardhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      ".dshMh-headl{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
      ".dshMh-h3{margin:0;font-size:14px;line-height:20px;font-weight:600}",
      ".dshMh-h4{margin:0;font-size:13px;line-height:20px;font-weight:600}",
      ".dshMh-strong{font-weight:600}.dshMh-normal{font-weight:400}",
      ".dshMh-soft{color:var(--mh-text2);font-size:12px;line-height:16px;overflow-wrap:anywhere}",
      ".dshMh-soft.is-bad{color:var(--mh-bad-text)}",
      ".dshMh-small{font-size:11px;line-height:14px}",
      ".dshMh-oktext{color:var(--mh-ok-text);font-size:12px}.dshMh-warntext{color:var(--mh-warn-text)}.dshMh-dangertext,.dshMh-badtext{color:var(--mh-bad-text)}",
      ".dshMh-num{font-variant-numeric:tabular-nums}",
      ".dshMh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
      ".dshMh-ellipsis{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshMh-err{color:var(--mh-bad-text);font-size:12px;line-height:16px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
      ".dshMh-warn{font-size:12px;line-height:16px;padding:10px 12px;border-radius:10px;color:var(--mh-warn-text);background:var(--mh-warn-soft);overflow-wrap:anywhere}",
      ".dshMh-warnrow{display:flex;gap:8px;align-items:flex-start}",
      ".dshMh-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshMh-nowrap{flex-wrap:nowrap}.dshMh-end{justify-content:flex-end}.dshMh-grow{flex:1 1 auto;min-width:0}.dshMh-r{text-align:right}.dshMh-pad{padding:8px 0}",
      ".dshMh-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:12px;line-height:16px;font-weight:500;white-space:nowrap;color:var(--mh-text2);background:var(--mh-sub)}",
      ".dshMh-pill.is-accent{color:var(--mh-accent-text);background:var(--mh-accent-soft)}.dshMh-pill.is-ok{color:var(--mh-ok-text);background:var(--mh-ok-soft)}",
      ".dshMh-pill.is-warn{color:var(--mh-warn-text);background:var(--mh-warn-soft)}.dshMh-pill.is-bad{color:var(--mh-bad-text);background:var(--mh-bad-soft)}",
      ".dshMh-pill.is-outline{background:transparent;border:1px solid var(--mh-line)}",
      ".dshMh-btn{font:inherit;font-size:13px;line-height:18px;font-weight:500;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--mh-line);background:var(--mh-card);color:var(--mh-text);cursor:pointer;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}",
      ".dshMh-btn.is-tall{height:36px;padding:0 14px}",
      ".dshMh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--mh-sub))}",
      ".dshMh-btn:disabled{opacity:.45;cursor:default}",
      ".dshMh-btn.is-primary{background:var(--mh-primary);color:var(--mh-primary-fg);border-color:transparent}",
      ".dshMh-btn.is-primary:hover:not(:disabled){background:var(--mh-primary);opacity:.88}",
      ".dshMh-btn:focus-visible,.dshMh-tab:focus-visible,.dshMh-seg-btn:focus-visible,.dshMh-addchip:focus-visible,.dshMh-choice:focus-visible,.dshMh-input:focus-visible{outline:2px solid var(--mh-accent);outline-offset:1px}",
      ".dshMh-input{font:inherit;font-size:13px;height:36px;padding:0 10px;border-radius:8px;border:1px solid var(--mh-line);background:var(--mh-card);color:var(--mh-text);min-width:0;max-width:100%}",
      ".dshMh-select{width:100%}",
      ".dshMh-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,var(--mh-line))}",
      ".dshMh-dot.is-ok{background:var(--mh-ok)}.dshMh-dot.is-warn{background:var(--mh-warn)}.dshMh-dot.is-bad{background:var(--mh-bad)}",
      // accounts
      ".dshMh-acctlist{display:flex;flex-direction:column;gap:8px}",
      ".dshMh-acctbox{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:10px;background:var(--mh-sub)}",
      ".dshMh-acct-head{display:flex;align-items:center;gap:12px}",
      ".dshMh-acct-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dshMh-acct-name{font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}",
      ".dshMh-acct-sub{font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-acct-sub.is-ok{color:var(--mh-ok-text)}.dshMh-acct-sub.is-warn{color:var(--mh-warn-text)}.dshMh-acct-sub.is-bad{color:var(--mh-bad-text)}",
      ".dshMh-addblock{display:flex;flex-direction:column;gap:8px}",
      ".dshMh-addrow{display:flex;flex-wrap:wrap;gap:8px}",
      ".dshMh-addchip{font:inherit;font-size:13px;height:32px;padding:0 12px 0 5px;border-radius:999px;border:1px solid var(--mh-line);background:transparent;color:var(--mh-text);display:inline-flex;align-items:center;gap:8px;cursor:pointer}",
      ".dshMh-addchip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--mh-sub))}",
      ".dshMh-addchip:disabled{opacity:.6;cursor:default}",
      ".dshMh-addchip-ico{width:22px;height:22px;border-radius:999px;background:var(--mh-sub);display:inline-flex;align-items:center;justify-content:center;color:var(--mh-text)}",
      ".dshMh-addwrap{display:flex;flex-direction:column;gap:8px}.dshMh-addwrap.is-flowing{flex-basis:100%}",
      // sign-in flow
      ".dshMh-flow{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid var(--mh-line);border-radius:12px;background:var(--mh-card)}",
      ".dshMh-flowhead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:14px}",
      ".dshMh-prompt{display:flex;flex-direction:column;gap:8px}",
      ".dshMh-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}",
      ".dshMh-choice{font:inherit;text-align:left;padding:12px;border-radius:10px;border:1px solid var(--mh-line);background:var(--mh-card);color:var(--mh-text);display:flex;flex-direction:column;gap:4px;cursor:pointer;font-size:13px}",
      ".dshMh-choice.is-first{border:2px solid var(--mh-accent);background:color-mix(in srgb,var(--mh-accent) 5%,var(--mh-card));padding:11px}",
      ".dshMh-choice:hover{background:var(--dsw-alias-interactive-bg-hover,var(--mh-sub))}",
      ".dshMh-wait{display:flex;align-items:center;gap:10px;padding:12px;border-radius:10px;background:var(--mh-sub);font-size:13px}",
      ".dshMh-wait-text{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dshMh-code{font-size:12px}",
      ".dshMh-field{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;border:0;min-width:0;max-width:100%}",
      // GPU server
      ".dshMh-gpus{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}",
      ".dshMh-gpu{min-width:0;display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--mh-line);border-radius:10px;align-items:stretch}",
      ".dshMh-gpu-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:13px}",
      ".dshMh-owner{font-size:12px;line-height:16px;color:var(--mh-text2);overflow-wrap:anywhere}",
      ".dshMh-statusline{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-controls{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px;padding-top:12px;border-top:1px solid var(--mh-line2)}",
      ".dshMh-controls .dshMh-grow{flex:1 1 200px}",
      ".dshMh-seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:8px;background:var(--mh-sub)}",
      ".dshMh-seg-btn{font:inherit;font-size:13px;height:32px;min-width:36px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--mh-text);cursor:pointer}",
      ".dshMh-seg-btn.is-on{background:var(--mh-card);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}",
      ".dshMh-seg-btn.is-busy:not(.is-on){color:var(--mh-text2)}",
      ".dshMh-seg-btn:disabled{opacity:.5;cursor:default}",
      ".dshMh-progress{display:flex;align-items:center;gap:8px;font-size:12px}",
      "@keyframes dshMhSpin{to{transform:rotate(360deg)}}",
      ".dshMh-spin{flex:none;width:14px;height:14px;border-radius:50%;border:2px solid var(--mh-line);border-top-color:var(--mh-accent);animation:dshMhSpin .8s linear infinite}",
      // costs
      ".dshMh-tabs{display:inline-flex;padding:2px;border-radius:8px;background:var(--mh-sub)}",
      ".dshMh-tab{font:inherit;font-size:13px;height:28px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--mh-text2);cursor:pointer}",
      ".dshMh-tab.is-on{background:var(--mh-card);color:var(--mh-text);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.08)}",
      ".dshMh-meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}",
      ".dshMh-meter{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:20px;min-width:0}",
      ".dshMh-meter-top{display:flex;justify-content:space-between;gap:8px;font-size:12px;line-height:16px}",
      ".dshMh-planbody .dshMh-meter-top{font-size:13px;line-height:20px}",
      ".dshMh-bar{width:100%;height:6px;border-radius:999px;background:var(--mh-track);overflow:hidden}",
      ".dshMh-bar.is-thick{height:8px}.dshMh-bar.is-thin{height:4px}.dshMh-bar.is-empty{background:transparent}",
      ".dshMh-bar-fill{display:block;height:100%;border-radius:inherit;background:var(--mh-accent)}",
      ".dshMh-bar-fill.is-ok{background:var(--mh-ok)}.dshMh-bar-fill.is-warn{background:var(--mh-warn)}.dshMh-bar-fill.is-danger{background:var(--mh-bad)}",
      ".dshMh-big{font-size:20px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}",
      ".dshMh-table{display:flex;flex-direction:column}",
      ".dshMh-thead{padding:0 0 6px;font-size:12px;line-height:16px;color:var(--mh-text2);border-bottom:1px solid var(--mh-line2)}",
      ".dshMh-trow{padding:7px 0;font-size:13px;line-height:20px;border-bottom:1px solid var(--mh-line2);align-items:center}",
      ".dshMh-trow.is-outside{border-bottom:0;padding-top:10px}",
      ".dshMh-cols-spend{display:grid;grid-template-columns:minmax(0,1fr) 104px 52px 64px 72px;gap:8px}",
      ".dshMh-cols-price{display:grid;grid-template-columns:minmax(0,1fr) 52px 52px 52px 104px;gap:8px}",
      ".dshMh-trow.dshMh-cols-price{padding:5px 0}",
      ".dshMh-trow.is-dead .dshMh-mono,.dshMh-trow.is-dead .dshMh-num{opacity:.55}",
      ".dshMh-pname{display:inline-flex;align-items:center;gap:6px;min-width:0}",
      ".dshMh-stack{flex-direction:column;align-items:flex-start;gap:0}",
      ".dshMh-slot{flex:none;display:inline-flex;width:16px;justify-content:center;color:var(--mh-text2)}",
      ".dshMh-pricehead{display:flex;justify-content:space-between;align-items:baseline;gap:8px}",
      // plan card
      ".dshMh-plancard{margin:8px 0;padding:14px;border-radius:10px;background:var(--mh-sub);color:var(--mh-text);font-size:13px;line-height:20px;display:flex;flex-direction:column;gap:12px}",
      ".dshMh-planhead{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px}",
      ".dshMh-planbody{display:flex;flex-direction:column;gap:12px}",
      ".dshMh-gauges{display:flex;align-items:stretch;gap:16px;flex-wrap:wrap}",
      ".dshMh-gauge{display:flex;flex-direction:column;align-items:center;gap:6px;width:124px;flex:none;text-align:center}",
      ".dshMh-gauge-ring{position:relative;width:84px;height:84px}",
      ".dshMh-gauge-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}",
      ".dshMh-gauge-v{font-size:18px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}",
      ".dshMh-gauge-v.is-warn{color:var(--mh-warn-text)}.dshMh-gauge-v.is-danger{color:var(--mh-bad-text)}",
      ".dshMh-gauge-cap{display:flex;flex-direction:column}",
      ".dshMh-statcol{flex:1 1 140px;min-width:0;display:flex;flex-direction:column;gap:8px}",
      ".dshMh-ring{display:block;flex:none}.dshMh-ring-track{stroke:var(--mh-track)}",
      ".dshMh-ring-arc.is-ok{stroke:var(--mh-accent)}.dshMh-ring-arc.is-warn{stroke:var(--mh-warn)}.dshMh-ring-arc.is-danger,.dshMh-ring-arc.is-over{stroke:var(--mh-bad-text)}",
      ".dshMh-stat{display:flex;flex-direction:column;gap:2px;padding:10px;border-radius:8px;background:var(--mh-card)}",
      ".dshMh-statv{font-size:18px;line-height:24px;font-weight:600;font-variant-numeric:tabular-nums}",
      // dock chip
      ".dshMh-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:2px;max-width:100%;padding:3px;border-radius:999px;border:1px solid var(--mh-line2);background:var(--mh-sub);font-size:12px;line-height:16px;white-space:nowrap;color:var(--mh-text)}",
      ".dshMh-chip.is-dim{opacity:.75}",
      ".dshMh-chipseg{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px}",
      ".dshMh-chipseg.is-claude{background:var(--mh-card)}",
      ".dshMh-chipk{color:var(--mh-text2)}",
      ".dshMh-chipseg.is-warn:not(.is-claude){background:var(--mh-warn-soft)}.dshMh-chipseg.is-warn b,.dshMh-chipseg.is-warn .dshMh-chipk{color:var(--mh-warn-text)}",
      ".dshMh-chipseg.is-danger:not(.is-claude){background:var(--mh-bad-soft)}.dshMh-chipseg.is-danger b,.dshMh-chipseg.is-danger .dshMh-chipk{color:var(--mh-bad-text)}",
      ".dshMh-chipseg.is-dim{opacity:.7}",
      ".dshAmPlan-wrap{display:flex;justify-content:center;align-items:center;flex-wrap:nowrap;gap:8px;width:100%;flex:none;height:auto;align-self:stretch;box-sizing:border-box;padding:6px 0 2px}",
      ".dshAmPlan-logo{display:inline-flex;align-items:center;color:var(--dsw-alias-label-primary);flex:none;line-height:0}",
      // toast
      ".dshMh-toast{position:fixed;right:16px;bottom:150px;z-index:2147483000;max-width:min(360px,calc(100vw - 32px));padding:12px 14px;border-radius:12px;border:1px solid var(--mh-line);background:var(--mh-card);color:var(--mh-text);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:16px}",
      ".dshMh-toast b{display:block;margin-bottom:2px;color:var(--mh-warn-text)}",
      // icons and tiles
      ".dshMh-ico{flex:none;display:inline-block;vertical-align:middle}",
      ".dshMh-mono-ico{flex:none;display:inline-block;text-align:center;font-weight:700;color:var(--mh-text2)}",
      ".dshMh-tile{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;border:1px solid var(--mh-line);background:var(--mh-card);color:var(--mh-text)}",
      ".dshMh-tile.is-dim{opacity:.55}",
      ".dshMh-badge{position:absolute;right:-3px;bottom:-3px;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,var(--mh-line));box-shadow:0 0 0 2px var(--mh-sub)}",
      ".dshMh-badge.is-ok{background:var(--mh-ok)}.dshMh-badge.is-warn{background:var(--mh-warn)}.dshMh-badge.is-bad{background:var(--mh-bad)}",
      // DSH sets a global corner-shape: superellipse(1.5) (measured 2026-11-08), which turns border-radius:50% dots into squircles.
      ".dshMh-badge,.dshMh-dot,.dshMh-spin{corner-shape:round}",
    ].join("");
    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css='dsh-model-hub-ui']")) {
      const tag = document.createElement("style");
      tag.dataset.pluginCss = "dsh-model-hub-ui";
      tag.textContent = HUB_CSS;
      document.head.appendChild(tag);
    }

    function apply(ctx) {
      pluginCtx = ctx;
      ctx.slots.inject("settings.models.provider-card", () =>
        ctx.slots.register({ name: "settings.models.provider-card", key: "llm-pi-ai" }, Card),
      );
      ctx.slots.inject("settings.models.footer", () =>
        ctx.slots.register({ name: "settings.models.footer", id: "model-hub", order: 10 }, HubSection),
      );
      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          { name: "conversation.composer.dock", id: "anthropic-plan", order: -20, label: "Consumption" },
          DockWidget,
        ),
      );
    }

    exports._test = { GpuPanel, GpuServerPanel, ICONS, iconKey, gpuIconKey, gpuTitle, gpuLabel, gpuServerModels, gpuPriceIds, defaultGpuModel, humanizeError, acctSubline, gpuIdle, staleLine, isLeaseError, fmtPm, normPriceId, priceList, sameInstance, postJson, PRICE_ID_SRC, groupPrices, spendView, errStr, isAvailable, signInUrl, dshCountsLine, planBody, spendRows, priceTable, gpuFree, overviewTiles, chipModel, splitLabel, AccountsPanel, CostsPanel, ringDash };
    exports.apply = apply;
    exports.inject = ["slots", "sessions"];
    return module.exports;
  },
});
