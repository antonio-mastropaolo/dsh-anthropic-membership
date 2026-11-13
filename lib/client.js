window.__ModuleLoader__.load({
  id: "dsh-model-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const reactDom = require("react-dom");
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
    // ---- pure helpers (unit-tested via exports._test) ----
    /** The dock adds a row only when there is something to show: spend or cache data, or a plan that is not signed out. */
    function dockVisible(plan, spend, cache) {
      if (spend || cache) return true;
      return !!(plan && typeof plan === "object" && plan.mode !== "signed-out");
    }
    const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
    const BROKEN = ["expired", "refresh-failed", "expiring"];
    const isBroken = (a) => BROKEN.includes(a && a.health);
    const isAvailable = (a) => !!a && (a.health === "missing" || (!a.health && !a.signedIn));
    /** One human line for an account error; raw text stays in the title. */
    function humanizeError(a) {
      if (!a || !a.lastError) return "";
      let t;
      if (a.errorKind === "revoked") t = "The sign-in was revoked or replaced.";
      else if (a.errorKind === "rejected") t = "The provider rejected the saved sign-in.";
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
      if (a.terminal) t += " Automatic retries are paused.";
      return t;
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
        identity: data?.identity || null,
        webOrigin: data?.webOrigin || null,
        spendGuard: data?.spendGuard === true,
        caps: data?.caps || null,
        demo: data?.demo === true,
        reachable: !!data && !error,
        error,
      };
      return { st, reload };
    }

    const PROVIDER_LABEL = {
      anthropic: "Anthropic (Claude Pro/Max)",
      "openai-codex": "OpenAI Codex (ChatGPT)",
      "github-copilot": "GitHub Copilot",
      openrouter: "OpenRouter",
      xai: "xAI",
    };
    // ---------------- shared UI pieces (design A: DSH tokens only, see HUB_CSS) ----------------
    const BILLING_LABEL = { subscription: "Subscription", credits: "Credits", metered: "Metered", local: "Local", free: "Free", mixed: "Mixed" };
    function Pill(props) {
      return h("span", { className: "dshMh-pill is-" + (props.tone || "neutral"), title: props.title, children: props.children });
    }
    const svgIcon = (d, size) => h("svg", { width: size || 14, height: size || 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false", className: "dshMh-ico", children: [].concat(d).map((p, i) => h("path", { key: i, d: p })) });
    // The banner on every surface that shows demo data; byte-identical to lib/demo/constants.mjs DEMO_TEXT (a test pins it).
    const DEMO_TEXT = "DEMO DATA: synthetic, nothing is recorded or capped";
    /** Rendered as text nodes only. Shown when the host reports demo:true. */
    function DemoBanner(props) {
      return hs("div", { className: "dshMh-demo", role: "status", "data-testid": "demo-banner", children: [svgIcon(WARN_TRI, 14), h("span", { children: DEMO_TEXT + (props && props.long ? ". The host reads only the demo folder and writes nothing there." : "") })] });
    }
    const PLUS = ["M12 5v14", "M5 12h14"];
    const OUT_ARROW = ["M7 17 17 7", "M8 7h9v9"];
    const WARN_TRI = ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"];
    const capTone = (pctUsed) => (pctUsed >= 100 ? "danger" : pctUsed >= 80 ? "warn" : "accent");
    /** Name and plan from the provider label: "Anthropic (Claude Pro/Max)" -> Anthropic · Claude Pro/Max. */
    function splitLabel(p) {
      const full = PROVIDER_LABEL[p] || String(p || "");
      const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(full);
      return m ? { name: m[1], plan: m[2], full } : { name: full, plan: "", full };
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
    /** Ledger v2 `purpose` -> Costs card label. `unknown` = rows written before ledger v2 (they carry no purpose). */
    const PURPOSE_LABEL = { chat: "Chat", compaction: "Compaction", "session-title": "Title", "auto-review": "Review", unknown: "Before ledger v2" };
    /** /spend payload byPurpose -> one row per purpose, biggest API value first, with its share of the summed API value. */
    function purposeRows(d) {
      const m = d && d.byPurpose && typeof d.byPurpose === "object" ? d.byPurpose : {};
      const list = Object.entries(m).map(([k, v]) => ({ key: k, label: PURPOSE_LABEL[k] || cap1(k), calls: (v && v.calls) || 0, usd: (v && v.usd) || 0, api: (v && v.apiEquivUsd) || 0 }));
      const total = list.reduce((a, r) => a + r.api, 0);
      return list.map((r) => ({ ...r, pct: total > 0 ? (r.api / total) * 100 : 0 })).sort((a, b) => b.api - a.api || b.calls - a.calls);
    }
    /** The Costs card's ledger status from a GET /ledger/verify report: { tone, text, title? } (the card's footer row already says "Spend ledger"). `running` wins over an old result. */
    function ledgerLine(report, error, running) {
      if (running) return { tone: "neutral", text: "Verifying…" };
      if (error) return { tone: "bad", text: "Verify failed: " + error };
      if (!report) return { tone: "neutral", text: "Not checked yet. Every amount on this card comes from it." };
      if (report.complete === false || report.unreadable) return { tone: "warn", text: "Could not be read in full. Run Verify again." };
      if (report.ok) return { tone: "ok", text: num(report.rows) + " rows verified · " + report.mismatchCount + " mismatches", title: num(report.v1) + " older rows (before ledger v2) are counted but cannot be re-derived. Verify proves arithmetic and file integrity, not that a published price was right." };
      return { tone: "bad", text: report.mismatchCount + " mismatch" + (report.mismatchCount === 1 ? "" : "es") + (report.tornLines ? ", " + report.tornLines + " torn line" + (report.tornLines === 1 ? "" : "s") : "") + " · run dsh-hub ledger verify" };
    }
    /** The Costs card's guard line from the /spend caps payload (caps.guard, from the DSH process that owns the host port): null until the spend guard has hit an internal error. Text only. */
    function guardLine(caps) {
      const g = caps && caps.guard;
      const n = g && g.errors && g.errors.count;
      if (!(n > 0)) return null;
      const last = g.errors.last && typeof g.errors.last.message === "string" ? g.errors.last.message.slice(0, 160) : "";
      const block = g.onError === "block";
      return {
        text: "guard errors: " + n + (last ? ", last " + last : ""),
        title: "config.json guard.onError is \"" + (block ? "block" : "allow") + "\" (" + (block ? "requests are held back when the guard fails" : "requests go through when the guard fails") + ")",
      };
    }
    /** Dollars reserved (worst case) by requests in flight in the DSH process that owns the host port (caps.reserved from /spend), as line segments ({ b } is bold): null when nothing is in flight. Text only. */
    function reservedSegs(caps) {
      const r = caps && caps.reserved;
      if (!r || typeof r.usd !== "number" || !Number.isInteger(r.count) || r.count <= 0) return null;
      return [{ b: usd(r.usd) }, " for " + r.count + " request" + (r.count === 1 ? "" : "s") + " in flight, counted at their worst case."];
    }
    const segText = (list) => (list || []).map((x) => (typeof x === "string" ? x : x.b)).join("");
    function reservedLine(caps) {
      const sg = reservedSegs(caps);
      return sg ? segText(sg) : null;
    }
    /** Up to three mismatching fields of a failed report as plain text lines (ids and values come from the ledger file: text only). */
    function ledgerDetail(report) {
      const list = report && !report.ok && Array.isArray(report.mismatches) ? report.mismatches : [];
      const show = (v) => { const t = typeof v === "string" ? v : JSON.stringify(v); return String(t === undefined ? "null" : t).slice(0, 80); };
      const lines = list.slice(0, 3).map((m) => (m.id || "(no id)") + " · " + m.field + ": stored " + show(m.stored) + ", expected " + show(m.expected));
      const more = (report && report.mismatchCount ? report.mismatchCount : list.length) - lines.length;
      if (lines.length && more > 0) lines.push("… and " + more + " more (dsh-hub ledger verify lists them)");
      return lines;
    }
    /** /spend payload plans -> one row per plan-credit plan: "Ollama Pro credits", resets Dec 9, "$X of $60" (frac = used / included, may pass 1). */
    function planRows(d) {
      const list = d && Array.isArray(d.plans) ? d.plans : [];
      return list.map((p) => {
        const used = (p.usedUsd || 0) + (p.overageUsd || 0);
        const pctUsed = p.includedUsd > 0 ? (used / p.includedUsd) * 100 : (used > 0 ? 100 : 0);
        const reset = p.resetsAt ? new Date(p.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : "";
        const name = (PROVIDER_LABEL[p.provider] ? splitLabel(p.provider).name : cap1(p.provider)) + " " + p.name;
        return { key: p.provider, label: name + " credits", reset, spent: used, cap: p.includedUsd || 0, value: usd(used) + " of " + usd(p.includedUsd), frac: pctUsed / 100, pct: pctUsed, tone: capTone(pctUsed), over: p.overageUsd || 0, partial: p.complete === false };
      });
    }
    /** /prices payload -> one row per model with its billing kind; order: subscription, metered, free, local, unpriced. */
    const KIND_ORDER = { subscription: 0, credits: 0, metered: 1, free: 2, local: 3, unpriced: 4 };
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
          // any provider/model id splits the same way, known icon or not; a bare alias stays whole
          split: id.includes("/"), model: id.includes("/") ? priceModelPart(id) : id,
          in: v.priced ? fmtNum(v.inPerM) : "—", out: v.priced ? fmtNum(v.outPerM) : "—",
          cache: v.priced && typeof v.cacheReadPerM === "number" ? fmtNum(v.cacheReadPerM) : "—",
        });
      }
      return rows.map((r, i) => [r, i]).sort((a, b) => ((KIND_ORDER[a[0].kind] ?? 9) - (KIND_ORDER[b[0].kind] ?? 9)) || a[1] - b[1]).map((x) => x[0]);
    }

    // ---------------- Accounts panel (DSH native sign-in via the host) ----------------
    const CHECK_PATH = "M3.9 7.3l2.1 2.1 4.1-4.5";
    /** An account as the row shows it: { tone: ok | warn | bad | off, word, sub } (pure). Revoked / expired / refresh-failed get their own word. */
    function acctState(a) {
      if (!a) return { tone: "off", word: "", sub: "" };
      const ms = a.expiresInMs, ex = fmtExpiry(ms);
      if (a.errorKind === "revoked") return { tone: "bad", word: "Revoked", sub: ex };
      if (a.health === "missing" || (!a.health && !a.signedIn)) return { tone: "off", word: "Not signed in", sub: "" };
      if (a.health === "expired") return { tone: "bad", word: "Expired", sub: ex };
      if (a.health === "refresh-failed") return { tone: "bad", word: "Refresh failed", sub: ex };
      if (a.health === "expiring") return { tone: "warn", word: "Expiring soon", sub: ex };
      return { tone: "ok", word: "Signed in", sub: typeof ms === "number" && ms > 0 ? ex.replace(/^expires in/, "renews in") : "" };
    }
    /** The identity line is drawn only when the host reports one (an email, a name, a plan or an organization). */
    const hasIdentity = (id) => !!(id && (id.email || id.name || id.plan || id.org));
    const WARN_ICON = (size) => svgIcon(WARN_TRI, size || 14);
    const copyIcon = () => h("svg", { className: "dshMh-ico", width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinejoin: "round", "aria-hidden": "true", focusable: "false", children: [h("rect", { key: "a", x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }), h("path", { key: "b", d: "M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" })] });
    /** A ring that is part full: the 16 px spinner of a waiting sign-in and a loading model (spins unless it is a still). */
    function RingSpin(props) {
      return hs("svg", { className: "dshMh-rspin", width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false", children: [
        h("circle", { key: "t", className: "dshMh-rspin-t", cx: 8, cy: 8, r: 6, fill: "none", strokeWidth: 2.5 }),
        h("circle", { key: "a", className: "dshMh-rspin-a", cx: 8, cy: 8, r: 6, fill: "none", strokeWidth: 2.5, strokeLinecap: "round", strokeDasharray: "10.56 37.70", transform: "rotate(-90 8 8)" }),
      ] });
    }
    function SignInFlow(props) {
      const provider = props.provider;
      const name = splitLabel(provider).name;
      const [text, setText] = react.useState("");
      const [err, setErr] = react.useState(null);
      const [copied, setCopied] = react.useState(false);
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
      const copyCode = () => copyMarkdown(code, typeof navigator === "undefined" ? null : navigator, (m) => { setCopied(m === "Copied"); setTimeout(() => setCopied(false), 1800); });
      // pi-ai login prompts come in two shapes: a "select" (e.g. Anthropic asks
      // Browser login vs Copy code) answered with an option id, or free text.
      const choices = s.prompt && Array.isArray(s.prompt.options) && s.prompt.options.length ? s.prompt.options : null;
      const inputId = "dshMh-code-" + provider;
      return hs("div", {
        className: "dshMh-flow",
        role: "group",
        "aria-label": "Sign in to " + name,
        children: [
          choices ? hs("div", { className: "dshMh-prompt", children: [
            hs("div", { className: "dshMh-flowhead", children: [
              h("span", { className: "dshMh-flowtitle", children: "Choose how to sign in" }),
              h("span", { className: "dshMh-soft", children: "Either way the provider’s own page opens in your browser." }),
            ] }),
            h("div", { className: "dshMh-choices", children: choices.map((o, i) => hs("button", {
              key: String(o.id ?? i),
              type: "button",
              className: "dshMh-choice",
              onClick: () => answer(String(o.id ?? o.value ?? o.label ?? "")),
              children: [
                h("span", { className: "dshMh-flowtitle", children: o.label || String(o.id) }),
                o.hint || o.description ? h("span", { className: "dshMh-soft", children: String(o.hint || o.description) }) : null,
              ],
            })) }),
          ] }) : hs("div", { className: "dshMh-wait", role: "status", children: [
            h("span", { className: "dshMh-wait-ico", children: h(RingSpin, {}) }),
            hs("div", { className: "dshMh-wait-text", children: [
              h("span", { className: "dshMh-flowtitle", children: url ? "Waiting for you to finish in the browser" : "Waiting for DSH to produce the sign-in link" }),
              h("span", { className: "dshMh-soft", children: url ? "The page opened in a new tab. Nothing is saved until " + name + " confirms." : "This usually takes a second or two." }),
            ] }),
          ] }),
          url && !choices ? hs("div", { className: "dshMh-flowrow", children: [
            hs("a", { className: "dshMh-b", href: url, target: "_blank", rel: "noopener noreferrer", children: ["Open the sign-in page", svgIcon(OUT_ARROW, 13)] }),
            code ? hs("span", { className: "dshMh-flowrow", children: [
              h("span", { className: "dshMh-soft", children: "and enter this code there" }),
              hs("span", { className: "dshMh-codechip", children: [
                h("span", { className: "dshMh-codetext", children: code }),
                h("button", { type: "button", className: "dshMh-iconbtn", "aria-label": "Copy the code", title: copied ? "Copied" : "Copy the code", onClick: copyCode, children: copyIcon() }),
              ] }),
            ] }) : h("span", { className: "dshMh-soft", children: "Tab did not open? Use this link." }),
          ] }) : null,
          !choices && s.prompt ? hs("div", { className: "dshMh-flowfield", children: [
            hs("div", { className: "dshMh-flowform", children: [
              hs("div", { className: "dshMh-capfield", children: [
                h("label", { className: "dshMh-lbl", htmlFor: inputId, children: s.prompt.message || "Paste the code shown after sign-in" }),
                h("div", { className: "dshMh-inbox", children: h("input", { id: inputId, className: "dshMh-in", type: s.prompt.kind === "secret" ? "password" : "text", value: text, placeholder: s.prompt.placeholder || "Paste code", autoComplete: "off", spellCheck: false, onChange: (e) => setText(e.target.value) }) }),
              ] }),
              h("button", { type: "button", className: "dshMh-b is-primary is-field", disabled: !text, onClick: answer, children: "Submit" }),
            ] }),
          ] }) : null,
          err ? hs("div", { className: "dshMh-ferr", role: "alert", children: [WARN_ICON(14), h("span", { children: err })] }) : null,
        ],
      });
    }

    /** One sign-in per provider, held by the Accounts card so a row keeps its panel when it moves from the "Add a sign-in" chips to the list. */
    function useSignIns(flows, onChange) {
      const [sess, setSess] = react.useState({});
      const patch = (provider, v) => setSess((m) => { const n = { ...m }; if (v === null) delete n[provider]; else n[provider] = { ...(n[provider] || {}), ...v }; return n; });
      const forAccount = (a) => {
        const cur = sess[a.provider] || {};
        const flow = (flows || []).find((f) => f.provider === a.provider);
        const method = flow && flow.methods && flow.methods.includes("oauth") ? "oauth" : flow && flow.methods && flow.methods[0] ? flow.methods[0] : "oauth";
        return {
          flowing: !!cur.flowing,
          msg: cur.msg || null,
          failed: !!cur.failed,
          fresh: !!cur.fresh,
          active: !!(cur.flowing || cur.failed),
          start: () => {
            patch(a.provider, { msg: null, failed: false, fresh: false });
            postJson("/accounts/signin", { provider: a.provider, method }).then(
              () => patch(a.provider, { flowing: true }),
              (e) => { const m = String(e.message || e); if (/progress|409/.test(m) || e.status === 409) patch(a.provider, { flowing: true, msg: m }); else patch(a.provider, { flowing: false, failed: true, msg: m }); },
            );
          },
          cancel: () => { postJson("/accounts/signin/" + a.provider + "/cancel", {}).catch(() => {}); patch(a.provider, null); },
          done: (state, error) => {
            if (state === "authorized") patch(a.provider, { flowing: false, failed: false, msg: null, fresh: true });
            else if (state === "cancelled") patch(a.provider, null);
            else patch(a.provider, { flowing: false, failed: true, msg: error ? String(error) : "" });
            onChange && onChange();
          },
        };
      };
      return forAccount;
    }

    function SignInDot(props) { return h("span", { className: "dshMh-dot is-" + props.tone, "aria-hidden": "true" }); }
    /** One sign-in in fixed columns: mark, name + identity, state, action; the sign-in panel opens under it and the button becomes Cancel. */
    function AccountRow(props) {
      const a = props.account, si = props.si;
      const lab = splitLabel(a.provider);
      const st = acctState(a);
      const broken = st.tone === "bad";
      const errLine = humanizeError(a);
      const ident = a.signedIn && hasIdentity(a.identity) ? identityLine(a.identity) : null;
      const state = si.flowing || si.failed || !a.signedIn && st.tone === "off"
        ? h("span", { className: "dshMh-acct-off", children: "Not signed in" })
        : st.tone === "warn" || st.tone === "bad"
          ? hs("div", { className: "dshMh-acct-state", children: [h("span", { className: "dshMh-pill is-" + (st.tone === "bad" ? "bad" : "warn"), children: st.word }), st.sub ? h("span", { className: "dshMh-acct-sub", children: st.sub }) : null] })
          : hs("div", { className: "dshMh-acct-state", children: [hs("span", { className: "dshMh-acct-word" + (si.fresh ? " is-fresh" : ""), children: [si.fresh ? h(LedgerMark, { tone: "ok" }) : h(SignInDot, { tone: st.tone === "ok" ? "ok" : "off" }), st.word] }), st.sub ? h("span", { className: "dshMh-acct-sub", children: st.sub }) : null] });
      const action = si.flowing
        ? h("button", { type: "button", className: "dshMh-b", onClick: si.cancel, children: "Cancel" })
        : si.failed
          ? h("button", { type: "button", className: "dshMh-b is-primary", onClick: si.start, children: "Try again" })
          : h("button", { type: "button", className: "dshMh-b" + (broken ? " is-primary" : ""), onClick: si.start, children: broken ? "Sign in again" : a.signedIn ? "Reconnect" : "Sign in" });
      return hs("div", { className: "dshMh-acct", role: "listitem", "data-provider": a.provider, children: [
        h("span", { className: "dshMh-mark", "aria-hidden": "true", children: iconKey(a.provider) === "anthropic" ? ASTERISK : h(ProviderIcon, { provider: a.provider, size: 16 }) }),
        hs("div", { className: "dshMh-acct-main", children: [
          hs("span", { className: "dshMh-acct-name", title: lab.full, children: [lab.name, lab.plan ? h("span", { className: "dshMh-acct-plan", children: " · " + lab.plan }) : null] }),
          ident ? h("span", { className: "dshMh-acct-ident", title: "The account this sign-in belongs to", children: ident }) : null,
        ] }),
        state,
        h("div", { className: "dshMh-acct-act", children: action }),
        errLine && !si.flowing && !si.failed ? hs("div", { className: "dshMh-acct-line is-bad", role: "status", title: a.lastError, children: [WARN_ICON(14), h("span", { children: errLine })] }) : null,
        si.failed ? hs("div", { className: "dshMh-acct-line is-fail", role: "alert", children: [WARN_ICON(14), hs("span", { children: [h("b", { className: "dshMh-acct-fail", children: "Sign-in failed." }), si.msg ? " " + si.msg.replace(/^Sign-in failed:?\s*/i, "") : "", " Nothing was saved."] })] }) : null,
        si.flowing && si.msg ? h("div", { className: "dshMh-acct-line is-soft", children: si.msg }) : null,
        si.flowing ? h(SignInFlow, { provider: a.provider, active: true, onDone: si.done }) : null,
      ] });
    }

    function AvailableChip(props) {
      const a = props.account, si = props.si;
      const lab = splitLabel(a.provider);
      return hs("button", {
        type: "button",
        className: "dshMh-b",
        title: "Sign in to " + lab.full,
        onClick: si.start,
        children: [h(ProviderIcon, { provider: a.provider, size: 14 }), lab.name, h("span", { className: "dshMh-soft", children: svgIcon(PLUS, 14) })],
      });
    }

    function AccountsPanel(props) {
      const acc = usePoll("/accounts", 5000);
      const fl = usePoll("/accounts/flows", 60000);
      const [checking, setChecking] = react.useState(false);
      const list = (acc.data && acc.data.accounts) || [];
      const flows = (fl.data && fl.data.flows) || [];
      const sign = useSignIns(flows, acc.reload);
      const bad = (a) => (acctState(a).tone === "bad" ? 1 : 0);
      const full = list.filter((a) => !isAvailable(a) || sign(a).active).sort((x, y) => bad(y) - bad(x));
      const avail = list.filter((a) => isAvailable(a) && !sign(a).active);
      const check = () => {
        setChecking(true);
        postJson("/accounts/refresh", {}).catch(() => {}).then(() => acc.reload()).then(() => setChecking(false), () => setChecking(false));
      };
      return hs("section", {
        className: "dshMh-card",
        "aria-label": "Accounts",
        children: [
          hs("div", { className: "dshMh-cardhead", children: [
            h("div", { className: "dshMh-headl", children: h("h3", { className: "dshMh-h3", children: "Accounts" }) }),
            hs("div", { className: "dshMh-headr", children: [
              acc.data ? h("span", { className: "dshMh-soft", title: "Background token watchdog", children: acc.data.reportOnly ? "Auto-refresh: report only" : "Auto-refresh on" }) : null,
              acc.data ? h("button", { type: "button", className: "dshMh-b", disabled: checking, onClick: check, children: checking ? "Checking…" : "Check now" }) : null,
            ] }),
          ] }),
          acc.error ? h("div", { className: "dshMh-err", children: "Host API unreachable: " + acc.error }) : null,
          acc.data && acc.data.unavailable ? h("div", { className: "dshMh-warn", "data-testid": "accounts-unavailable", children: "Accounts unavailable: " + acc.data.unavailable + ". The plugin cannot read DSH's credential store (set DSH_NODE_MODULES; see the README)." }) : null,
          full.length || avail.length ? hs("div", { className: "dshMh-acctwrap", children: [
            full.length ? h("div", { className: "dshMh-acctlist", role: "list", children: full.map((a) => h(AccountRow, { key: a.provider, account: a, si: sign(a) })) }) : null,
            avail.length ? hs("div", { className: "dshMh-addblock" + (full.length ? " has-rule" : ""), children: [
              h("span", { className: "dshMh-soft dshMh-addlabel", children: "Add a sign-in" }),
              h("div", { className: "dshMh-addrow", children: avail.map((a) => h(AvailableChip, { key: a.provider, account: a, si: sign(a) })) }),
            ] }) : null,
          ] }) : null,
        ],
      });
    }

    // ---------------- GPU server panel ----------------
    const RING_C = 2 * Math.PI * 12;
    /** One GPU as the row of rings draws it (pure): memory percent, the one-line size text and a tooltip with what is running and reserved. */
    function gpuRingModel(g) {
      const idle = gpuIdle(g);
      const pct = idle ? 0 : g.total_mib ? Math.max(0, Math.min(100, Math.round((g.used_mib / g.total_mib) * 100))) : 0;
      const total = g.total_mib ? (g.total_mib / 1024).toFixed(0) : "?";
      const owners = (g.processes || []).map((p) => p.user + " · " + p.cmd + " " + Math.round(p.used_mib / 1024 * 10) / 10 + " GiB");
      const res = g.reservation_stale ? [] : (g.reserved_by || []).map((r) => (typeof r === "string" ? r : r && r.owner) || "?");
      const tip = [idle ? "Idle (driver baseline " + ((g.used_mib || 0) / 1024).toFixed(1) + " GiB, no processes)" : g.util_pct + "% util"].concat(owners, res.map((r) => "reserved · " + r)).join("\n");
      return { index: g.index, idle, pct, tone: pct > 85 ? "warn" : "ok", sub: idle ? "Free · " + total + " GiB" : (g.used_mib / 1024).toFixed(1) + " / " + total + " GiB", dash: (RING_C * pct / 100).toFixed(2) + " " + RING_C.toFixed(2), tip };
    }
    function GpuCard(props) {
      const m = gpuRingModel(props.gpu);
      return hs("div", { className: "dshMh-gpu", title: m.tip, children: [
        hs("svg", { className: "dshMh-gpu-ring", width: 32, height: 32, viewBox: "0 0 32 32", role: "img", "aria-label": "GPU " + m.index + " memory: " + m.pct + "% used", focusable: "false", children: [
          h("circle", { key: "t", className: "dshMh-gpu-track", cx: 16, cy: 16, r: 12, fill: "none", strokeWidth: 4 }),
          m.pct > 0 ? h("circle", { key: "a", className: "dshMh-gpu-arc is-" + m.tone, cx: 16, cy: 16, r: 12, fill: "none", strokeWidth: 4, strokeLinecap: "round", strokeDasharray: m.dash, transform: "rotate(-90 16 16)" }) : null,
        ] }),
        hs("div", { className: "dshMh-gpu-txt", children: [h("span", { className: "dshMh-gpu-name", children: "GPU " + m.index }), h("span", { className: "dshMh-gpu-sub", children: m.sub })] }),
      ] });
    }
    /**
     * The model list of the GPU server (pure): one row per model it serves, each with what its button does:
     * "load" (nothing is loaded), "switch" (another model is), "unload" (this one is loaded; also a "Loaded" pill), "loading" (the model being loaded now).
     */
    function gpuModelRows(models, cfg, loadedModel, busy) {
      const preferred = cfg && cfg.defaultModel && models.some((m) => m.id === cfg.defaultModel) ? cfg.defaultModel : "";
      return models.map((m) => {
        const loaded = !!loadedModel && m.id === loadedModel;
        let action = loadedModel ? (loaded ? "unload" : "switch") : "load";
        let loading = false;
        if (busy) {
          if (busy.target === m.id) { loading = true; action = null; }
          else if (busy.target === "unload" && loaded) { loading = true; action = null; }
        }
        return { id: m.id, isDefault: !!preferred && m.id === preferred, loaded, action, loading };
      });
    }
    /** A long server model list shows MODEL_ROWS_MAX rows until "Show all" (pure): the loaded, loading and default
     *  models always stay in view; the rest keep the server's order. One hidden row is never worth a button. */
    const MODEL_ROWS_MAX = 8;
    function visibleModelRows(rows, showAll) {
      if (showAll || rows.length <= MODEL_ROWS_MAX + 1) return { shown: rows, hidden: 0 };
      const pinned = new Set(rows.filter((r) => r.loaded || r.loading || r.isDefault).map((r) => r.id));
      let room = Math.max(0, MODEL_ROWS_MAX - pinned.size);
      const shown = rows.filter((r) => pinned.has(r.id) || (room > 0 && room--));
      return { shown, hidden: rows.length - shown.length };
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
      const [pins, setPins] = react.useState([]);
      const [showAllModels, setShowAllModels] = react.useState(false);
      const [, setTick] = react.useState(0);
      const fast = busy ? 2000 : 6000;
      const gp = usePoll("/gpu/gpus", fast);
      const md = usePoll("/gpu/models", fast);
      const g = gp.data;
      const models = gpuServerModels(md.data && md.data.models, cfg);
      // Truth for "loaded" is the GPU endpoint (the shim's per-model flag is stale).
      const loadedModel = g && g.loaded_model ? String(g.loaded_model) : null;
      const mac = ((md.data && md.data.models) || []).filter((m) => m.owner === "mac");
      react.useEffect(() => {
        if (busy && busy.target === "unload" && !loadedModel) setBusy(null);
        if (busy && busy.target !== "unload" && loadedModel === busy.target) setBusy(null);
        if (busy && Date.now() - busy.started > 15 * 60000) setBusy(null);
      }, [md.data, gp.data]);
      // the "Loading · 42 s" counter moves once a second while a switch is running
      react.useEffect(() => {
        if (!busy) return undefined;
        const id = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(id);
      }, [!!busy]);
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
      const load = (id) => send(pins.length ? { model: id, gpus: pins } : { model: id }, true);
      const forceSwitch = () => lastReq.current && send({ ...lastReq.current, force: true }, true);
      const pinned = g && g.pin && Array.isArray(g.pin.gpus) && g.pin.gpus.length ? g.pin.gpus : null;
      const unpin = () => send({ model: loadedModel || (models[0] && models[0].id) || "", auto: true }, false);
      const unload = () => {
        setErr(null);
        postJson("/gpu/unload", {}).then(
          () => { setBusy({ target: "unload", started: Date.now() }); gp.reload(); md.reload(); },
          (e) => setErr(String(e.message || e)),
        );
      };
      const stale = staleLine((g && g.reservations) || [], g && g.gpus ? g.gpus.length : null);
      const failover = g && g.failover ? typeof g.failover === "string" ? g.failover : errStr(g.failover) || JSON.stringify(g.failover) : "";
      const gpuList = g && g.gpus ? g.gpus : [];
      const rows = gpuModelRows(models, cfg, loadedModel, busy);
      const vis = visibleModelRows(rows, showAllModels);
      const secs = busy ? Math.round((Date.now() - busy.started) / 1000) : 0;
      const gstat = g && g.manager ? (g.manager.active ? h("span", { className: "dshMh-status", children: [h(SignInDot, { tone: "ok" }), "Manager active"] }) : h("span", { className: "dshMh-pill is-bad", children: "Manager stopped" })) : null;
      return hs("section", {
        className: "dshMh-card",
        "aria-label": gpuTitle(cfg),
        children: [
          hs("div", { className: "dshMh-cardhead", children: [
            hs("div", { className: "dshMh-headl", children: [
              h("h3", { className: "dshMh-h3 dshMh-h3-ico", children: [h(ProviderIcon, { key: "i", provider: gpuIconKey(cfg.icon), size: 16 }), gpuTitle(cfg)] }),
            ] }),
            hs("div", { className: "dshMh-headr", children: [
              g && g.stale ? h("span", { className: "dshMh-pill is-warn", children: "State stale" }) : null,
              stale ? h("span", { className: "dshMh-pill is-warn", title: stale, children: "Stale reservation" }) : null,
              gstat,
            ] }),
          ] }),
          gp.error ? h("div", { className: "dshMh-err", children: label + " unreachable: " + gp.error }) : null,
          g && g.ok === false ? h("div", { className: "dshMh-err", children: label + ": " + (g.error || "unavailable") }) : null,
          gpuList.length ? h("div", { className: "dshMh-gpus", style: { gridTemplateColumns: "repeat(" + Math.min(gpuList.length, 4) + ", minmax(0, 1fr))" }, children: gpuList.map((x) => h(GpuCard, { key: x.index, gpu: x })) }) : null,
          g && g.pin && g.pin.error ? h("div", { className: "dshMh-err", children: "Pin error: " + g.pin.error }) : null,
          hs("div", { className: "dshMh-mlist", children: [
            hs("div", { className: "dshMh-sechead is-gpu", children: [
              h("h4", { className: "dshMh-h4", children: "Models" }),
              hs("div", { className: "dshMh-headr is-tight", children: [
                h("span", { className: "dshMh-soft", id: "dshMh-gpus-label", children: "Load on GPU" }),
                hs("div", { className: "dshMh-sg" + (busy ? " is-off" : ""), role: "group", "aria-label": "GPUs for the next load", children: [
                  h("button", { type: "button", className: "dshMh-sg-b" + (pins.length ? "" : " is-on"), "aria-pressed": pins.length ? "false" : "true", disabled: !!busy, title: "Let the server choose free GPUs", onClick: () => setPins([]), children: "Auto" }),
                  ...gpuList.map((x) => h("button", {
                    key: x.index,
                    type: "button",
                    className: "dshMh-sg-b" + (pins.includes(x.index) ? " is-on" : "") + (gpuIdle(x) ? "" : " is-busy"),
                    "aria-pressed": pins.includes(x.index) ? "true" : "false",
                    disabled: !!busy,
                    title: gpuIdle(x) ? "Pin to GPU " + x.index : "GPU " + x.index + " is in use",
                    onClick: () => togglePin(x.index),
                    children: String(x.index),
                  })),
                ] }),
              ] }),
            ] }),
            hs("div", { role: "list", className: "dshMh-mrows", children: [
              vis.shown.map((r) => hs("div", { key: r.id, role: "listitem", className: "dshMh-mrow", children: [
                hs("span", { className: "dshMh-mname", children: [h("span", { className: "dshMh-mname-t", children: r.id }), r.isDefault ? h("span", { className: "dshMh-tag is-pad", children: "Default" }) : null] }),
                hs("span", { className: "dshMh-mact", children: [
                  r.loading ? hs("span", { role: "status", className: "dshMh-status is-live", children: [h(RingSpin, {}), (busy.target === "unload" ? "Unloading" : "Loading") + " · " + secs + " s"] }) : null,
                  r.loaded && !r.loading ? h("span", { className: "dshMh-pill is-ok", children: "Loaded" }) : null,
                  r.action === "load" || r.action === "switch" ? h("button", { type: "button", className: "dshMh-b", disabled: !!busy, onClick: () => load(r.id), children: r.action === "switch" ? "Switch" : "Load" }) : null,
                  r.action === "unload" ? h("button", { type: "button", className: "dshMh-b", disabled: !!busy, onClick: unload, children: "Unload" }) : null,
                ] }),
              ] })),
              vis.hidden > 0 || showAllModels && rows.length > MODEL_ROWS_MAX + 1 ? h("div", { key: "more", role: "listitem", className: "dshMh-mrow is-more", children: h("button", { type: "button", className: "dshMh-b", "aria-expanded": showAllModels ? "true" : "false", onClick: () => setShowAllModels(!showAllModels), children: showAllModels ? "Show fewer models" : "Show all " + rows.length + " models" }) }) : null,
              mac.map((m) => hs("div", { key: "mac:" + m.id, role: "listitem", className: "dshMh-mrow", children: [
                hs("span", { className: "dshMh-mname", children: [h("span", { className: "dshMh-mname-t", children: m.id }), h("span", { className: "dshMh-tag is-pad", children: "Mac copy" })] }),
                h("span", { className: "dshMh-mact", children: hs("span", { className: "dshMh-status", children: [h(SignInDot, { tone: m.loaded ? "ok" : "off" }), m.loaded ? "Up" : "Down"] }) }),
              ] })),
            ] }),
            hs("div", { className: "dshMh-mfoot", children: [
              h("span", { className: "dshMh-soft", children: busy ? "Load and Unload are paused until this finishes." : pinned ? "Pinned to GPU " + pinned.join(",") + "." : loadedModel ? "" : "Nothing is loaded. A model loads by itself when a session asks for it." }),
              hs("span", { className: "dshMh-mact", children: [
                forceable ? h("button", { type: "button", className: "dshMh-b", disabled: !!busy, title: "Switch even though another session holds the lease", onClick: forceSwitch, children: "Force switch" }) : null,
                pinned ? h("button", { type: "button", className: "dshMh-b", disabled: !!busy || !(loadedModel || models.length), onClick: unpin, children: "Return to auto" }) : null,
              ] }),
            ] }),
            failover ? h("div", { className: "dshMh-soft dshMh-mnote", children: "Failover: " + failover }) : null,
            err ? hs("div", { className: "dshMh-ferr dshMh-mnote", role: "alert", children: [WARN_ICON(14), h("span", { children: err })] }) : null,
          ] }),
        ],
      });
    }

    // ---------------- Costs panel ----------------
    /** The `caps.json invalid: ...` line from GET /caps, or null when the file is fine (or not loaded yet). Rendered as text. */
    function capsProblemLine(view) { return (view && typeof view.problem === "string" && view.problem) || null; }
    // ---- caps editor: pure helpers (same rules as validateCapsChange in lib/cost/caps.mjs; the host re-validates) ----
    const CAP_MAX_USD = 1000000;
    const MAX_PROVIDER_CAPS = 64;
    const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
    const NUM_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
    const capNum = (s) => { const t = String(s === undefined || s === null ? "" : s).trim(); return NUM_TEXT.test(t) ? Number(t) : NaN; };
    const MONEY_ERR = "Number from 0 to 1,000,000.";
    /** A money value as a field shows it: whole cents ("40.00"); anything that is not a number is shown as it is. */
    const capText = (v) => (v === undefined ? "" : typeof v === "number" && isFinite(v) ? v.toFixed(2) : String(v));
    /** GET /caps view -> draft: strings { dailyUsd, sessionUsd, warnPct, providers:[{id, usd}] } and the plan-stop switch { stopAtPlanLimit }. */
    function capsDraft(view) {
      const c = (view && view.caps) || {};
      const per = (c.perProviderDailyUsd && typeof c.perProviderDailyUsd === "object") ? c.perProviderDailyUsd : {};
      return {
        dailyUsd: capText(c.dailyUsd),
        sessionUsd: capText(c.sessionUsd),
        warnPct: String(c.warnPct === undefined ? "" : c.warnPct),
        providers: Object.keys(per).map((id) => ({ id, usd: capText(per[id]) })),
        stopAtPlanLimit: !!(view && view.stopAtPlanLimit === true),
      };
    }
    /** draft + view -> { ok:true, changes } (only what differs; a removed row -> null) | { ok:false, errors:{field: message} }.
     *  When the view reports a problem with caps.json, every field is sent so Save rewrites (repairs) the file. */
    function capsChanges(draft, view) {
      const cur = (view && view.caps) || {};
      const curPer = (cur.perProviderDailyUsd && typeof cur.perProviderDailyUsd === "object") ? cur.perProviderDailyUsd : {};
      const errors = {}; const changes = {};
      const repair = !!(view && view.problem);
      for (const k of ["dailyUsd", "sessionUsd"]) {
        const v = capNum(draft[k]);
        if (!(Number.isFinite(v) && v >= 0 && v <= CAP_MAX_USD)) errors[k] = MONEY_ERR;
        else if (repair || v !== cur[k]) changes[k] = v;
      }
      const w = capNum(draft.warnPct);
      if (!(Number.isInteger(w) && w >= 1 && w <= 99)) errors.warnPct = "Whole number, 1 to 99.";
      else if (repair || w !== cur.warnPct) changes.warnPct = w;
      const rows = Array.isArray(draft.providers) ? draft.providers : [];
      if (rows.length > MAX_PROVIDER_CAPS) errors.providers = "At most " + MAX_PROVIDER_CAPS + " provider caps.";
      const seen = {}; const next = {};
      rows.forEach((row, i) => {
        const id = String(row && row.id !== undefined ? row.id : "").trim(); const usdText = String(row && row.usd !== undefined ? row.usd : "").trim();
        if (!id && !usdText) return;
        if (!PROVIDER_ID.test(id) || id in Object.prototype) { errors["provider." + i + ".id"] = "Lowercase letters, digits and dashes, up to 40."; return; }
        if (seen[id]) { errors["provider." + i + ".id"] = "Already listed."; return; }
        seen[id] = true;
        const v = capNum(usdText);
        if (!(Number.isFinite(v) && v >= 0 && v <= CAP_MAX_USD)) { errors["provider." + i + ".usd"] = MONEY_ERR + " 0 removes the cap."; return; }
        if (v > 0) next[id] = v;
      });
      if (!Object.keys(errors).length) {
        for (const id of Object.keys(next)) if (repair || next[id] !== curPer[id]) changes["provider." + id] = next[id];
        for (const id of Object.keys(curPer)) if (!(id in next)) changes["provider." + id] = null;
        // the plan-stop switch is saved with the rest (a draft without it, or a view that does not report it, leaves it alone)
        if (typeof draft.stopAtPlanLimit === "boolean" && (draft.stopAtPlanLimit !== (view && view.stopAtPlanLimit === true) || (repair && view && typeof view.stopAtPlanLimit === "boolean"))) changes.stopAtPlanLimit = draft.stopAtPlanLimit;
        return { ok: true, changes };
      }
      return { ok: false, errors };
    }
    /** Validate, then POST /caps {set: changes} through postJson (ownership check). Never throws. */
    function submitCapsDraft(draft, view, post) {
      const r = capsChanges(draft, view);
      if (!r.ok) return Promise.resolve({ ok: false, errors: r.errors });
      if (!Object.keys(r.changes).length) return Promise.resolve({ ok: true });
      return Promise.resolve().then(() => (post || postJson)("/caps", { set: r.changes })).then(
        () => ({ ok: true }),
        (e) => ({ ok: false, error: String((e && e.message) || e) }),
      );
    }

    // ---- caps editor: components ----
    /** A text field in a bordered box with an optional "$" in front and a unit behind (never a number spinner: the value is validated as text). */
    function InBox(props) {
      return hs("div", { className: "dshMh-inbox" + (props.err ? " is-bad" : ""), children: [
        props.prefix ? h("span", { className: "dshMh-inpre", "aria-hidden": "true", children: props.prefix }) : null,
        h("input", { id: props.id, ref: props.inputRef, className: "dshMh-in", type: "text", inputMode: props.numeric ? "decimal" : undefined, autoComplete: "off", spellCheck: false, value: props.value, placeholder: props.placeholder, "aria-label": props.ariaLabel, "aria-invalid": props.err ? "true" : undefined, "aria-describedby": props.err ? props.id + "-err" : undefined, onChange: props.onChange }),
        props.unit ? h("span", { className: "dshMh-inunit", "aria-hidden": "true", children: props.unit }) : null,
      ] });
    }
    const FieldErr = (id, text) => hs("span", { id: id + "-err", className: "dshMh-ferr", role: "alert", children: [WARN_ICON(14), h("span", { children: text })] });
    function CapsForm(props) {
      const draft = props.draft; const errors = props.errors || {}; const busy = !!props.busy;
      const set = (patch) => props.onChange({ ...draft, ...patch });
      const setRow = (i, patch) => set({ providers: draft.providers.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
      const field = (key, id, label, prefix, unit, ref) => {
        const err = errors[key];
        return hs("div", { className: "dshMh-capfield", children: [
          h("label", { className: "dshMh-lbl", htmlFor: id, children: label }),
          h(InBox, { id, inputRef: ref, prefix, unit, numeric: true, value: draft[key], err, onChange: (e) => set({ [key]: e.target.value }) }),
          err ? FieldErr(id, err) : null,
        ] });
      };
      const rowsOut = draft.providers.map((r, i) => {
        const ide = errors["provider." + i + ".id"]; const use = errors["provider." + i + ".usd"];
        const idId = "dshMh-cap-p" + i + "-id", usdId = "dshMh-cap-p" + i + "-usd";
        return hs("div", { key: i, className: "dshMh-caprowform", children: [
          hs("div", { className: "dshMh-capcell", children: [h(InBox, { id: idId, placeholder: "provider id", ariaLabel: "Provider id, row " + (i + 1), value: r.id, err: ide, onChange: (e) => setRow(i, { id: e.target.value }) }), ide ? FieldErr(idId, ide) : null] }),
          hs("div", { className: "dshMh-capcell", children: [h(InBox, { id: usdId, prefix: "$", unit: "per day", numeric: true, ariaLabel: "Dollars per day for " + (String(r.id).trim() || "provider, row " + (i + 1)), value: r.usd, err: use, onChange: (e) => setRow(i, { usd: e.target.value }) }), use ? FieldErr(usdId, use) : null] }),
          h("button", { type: "button", className: "dshMh-b is-field", "aria-label": "Remove the " + (String(r.id).trim() || "row " + (i + 1)) + " cap", onClick: () => set({ providers: draft.providers.filter((_, j) => j !== i) }), children: "Remove" }),
        ] });
      });
      return h("form", {
        className: "dshMh-capsform", "aria-label": "Edit spend caps", noValidate: true,
        onSubmit: (e) => { e.preventDefault(); props.onSubmit(); },
        onKeyDown: (e) => { if (e.key === "Escape") { e.stopPropagation(); props.onCancel(); } },
        children: hs("fieldset", { disabled: busy, children: [
          hs("section", { className: "dshMh-capsbox", children: [
            hs("div", { className: "dshMh-capsbody", children: [
              h("span", { className: "dshMh-soft", children: "Caps stop metered requests before they are sent. Enter 0 to turn a cap off." }),
              hs("div", { className: "dshMh-capsgrid", children: [
                field("dailyUsd", "dshMh-cap-daily", "Daily cap", "$", "per day", props.firstRef),
                field("sessionUsd", "dshMh-cap-session", "Session cap", "$", "per session"),
                field("warnPct", "dshMh-cap-warn", "Alert at", null, "% of a cap"),
              ] }),
              hs("div", { className: "dshMh-capgroup", role: "group", "aria-labelledby": "dshMh-cap-prov-label", children: [
                h("span", { id: "dshMh-cap-prov-label", className: "dshMh-lbl", children: "Provider caps, per day" }),
                rowsOut,
                errors.providers ? FieldErr("dshMh-cap-providers", errors.providers) : null,
                h("div", { className: "dshMh-capadd", children: hs("button", { type: "button", className: "dshMh-b", onClick: () => set({ providers: [...draft.providers, { id: "", usd: "" }] }), children: [svgIcon(PLUS, 14), "Add provider cap"] }) }),
              ] }),
            ] }),
            h(PlanStopSwitch, { stop: draft.stopAtPlanLimit === true, unavailable: busy, onToggle: (v) => set({ stopAtPlanLimit: v }), description: props.stopDescription || "" }),
          ] }),
          props.serverError ? h("div", { className: "dshMh-ferr", role: "alert", children: [WARN_ICON(14), h("span", { key: "m", children: props.serverError })] }) : null,
          hs("div", { className: "dshMh-capsact", children: [
            h("button", { type: "button", className: "dshMh-b", onClick: props.onCancel, children: "Cancel" }),
            h("button", { type: "submit", className: "dshMh-b is-primary", children: busy ? "Saving…" : "Save" }),
          ] }),
        ] }),
      });
    }
    /** The line under the plan-stop switch in the caps editor: what happens past a full Claude plan window. */
    const stopDescription = (plan, on) => (plan && (plan.mode === "plan" || plan.mode === "unavailable") ? planFooter(plan, on) : "DSH refuses Claude requests in a full plan window until it resets.");
    function CapsEditor(props) {
      const [draft, setDraft] = react.useState(() => capsDraft(props.view));
      const [errors, setErrors] = react.useState({});
      const [busy, setBusy] = react.useState(false);
      const [serverError, setServerError] = react.useState("");
      const firstRef = react.useRef(null);
      react.useEffect(() => { if (firstRef.current && firstRef.current.focus) firstRef.current.focus(); }, []);
      const onSubmit = () => {
        if (busy) return;
        setBusy(true); setServerError("");
        submitCapsDraft(draft, props.view).then((r) => {
          setBusy(false);
          if (r.ok) { setErrors({}); props.onSaved(); return; }
          if (r.errors) {
            setErrors(r.errors);
            const first = Object.keys(r.errors)[0];
            const el = first && typeof document !== "undefined" && document.getElementById(first === "dailyUsd" ? "dshMh-cap-daily" : first === "sessionUsd" ? "dshMh-cap-session" : first === "warnPct" ? "dshMh-cap-warn" : "dshMh-cap-" + first.replace(/^provider\.(\d+)\.(id|usd)$/, "p$1-$2"));
            if (el && el.focus) setTimeout(() => el.focus(), 0);
          } else setServerError(r.error || "Could not save the caps.");
        });
      };
      return h(CapsForm, { draft, errors, busy, serverError, firstRef, stopDescription: stopDescription(props.plan, draft.stopAtPlanLimit), onChange: (d) => { setDraft(d); setErrors({}); }, onSubmit, onCancel: props.onCancel });
    }

    // ---- spend forecast (GET /forecast): ESTIMATES. Shown only when the pace has enough calls behind it. ----
    const usdRate = (n) => (typeof n === "number" ? "$" + n.toFixed(n >= 0.1 ? 2 : 3) : "$0.00");
    const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    // local clock ("4:40 PM"), with a short weekday when the day differs from the report's own day
    function fcClock(ms, refMs) {
      const d = new Date(ms);
      const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      return d.toDateString() === new Date(refMs).toDateString() ? t : WEEKDAY[d.getDay()] + " " + t;
    }
    const MERIDIEM = /[\s ]*[AP]M$/i;
    /** "4:15–5:20 PM": the first time drops its AM/PM (and weekday) when the second one says the same. */
    function fcRange(r, refMs) {
      const a = r.earliestAt === null ? "later" : fcClock(r.earliestAt, refMs);
      const b = r.latestAt === null ? "later" : fcClock(r.latestAt, refMs);
      const ma = MERIDIEM.exec(a), mb = MERIDIEM.exec(b);
      const day = (x) => x.replace(/\d+:\d+.*$/, "");
      const short = ma && mb && ma[0].replace(/\s/g, "") === mb[0].replace(/\s/g, "") && day(a) === day(b) ? a.slice(0, a.length - ma[0].length) : a;
      return short + "–" + b;
    }
    // A forecast is shown only while it is current: usePoll keeps the last good data when a later fetch fails, and an
    // estimate that is minutes old would read as live. Returns the report, or null.
    const FORECAST_FRESH_MS = 60 * 1000;
    function freshForecast(poll, nowMs) {
      if (!poll || poll.error || !poll.data || typeof poll.data.generatedAt !== "number") return null;
      const now = typeof nowMs === "number" ? nowMs : Date.now();
      return Math.abs(now - poll.data.generatedAt) > FORECAST_FRESH_MS ? null : poll.data;
    }
    /** The forecast sentence of the Costs card as { segs ({ b } is bold), text, title, projectedUsd, dailyReached } or null. An estimate: it never blocks anything. */
    function forecastSpendLine(spend) {
      if (!spend || spend.complete === false || !spend.charged || spend.charged.status !== "ok") return null;
      const c = spend.charged;
      const rate = c.ratePerHour, proj = c.projectedTodayUsd;
      if (!rate || !proj) return null;
      const ref = typeof spend.generatedAt === "number" ? spend.generatedAt : Date.now();
      const caps = Array.isArray(spend.caps) ? spend.caps : [];
      const capName = (e) => (e.which === "provider-daily" ? String(e.provider) : e.which === "session" ? "session" : "daily");
      const atPace = caps.filter((e) => e.state === "at-pace" && typeof e.reachedAt === "number");
      const first = atPace.reduce((a, e) => (!a || e.reachedAt < a.reachedAt ? e : a), null);
      const daily = caps.find((e) => e.which === "daily");
      // a reached cap is a fact (the guard is blocking on it), so it is always named; then the first cap reached at this pace, else the daily fallback
      const reached = caps.filter((e) => e.state === "reached").map((e) => capName(e) + " cap reached");
      const segs = [{ b: usdRate(rate.m15) }, " an hour now"];
      if (reached.length || first) {
        segs.push(": ");
        reached.forEach((t, i) => segs.push((i ? "; " : "") + t));
        if (first) {
          segs.push((reached.length ? "; " : "") + capName(first) + " cap reached around ", { b: fcClock(first.reachedAt, ref) });
          if (first.range) segs.push(" (range " + fcRange(first.range, ref) + ")");
        }
      } else {
        segs.push(", about ", { b: usd(proj.mid) }, " by midnight");
        if (daily && daily.state === "not-at-this-pace") segs.push(", under the daily cap");
      }
      segs.push(".");
      const ranges = atPace.filter((e) => e.range).map((e) => capName(e) + " cap range " + fcRange(e.range, ref));
      const title = "Estimate, not a limit. Based on " + c.calls15 + " metered call" + (c.calls15 === 1 ? "" : "s") + " in the last 15 min: charged pace " + usdRate(rate.m15) + "/h (15 min), " + usdRate(rate.m60) + "/h (60 min). Today adds that pace to the " + usd(c.todayUsd) + " spent so far, up to midnight (range " + usd(proj.low) + "-" + usd(proj.high) + ")."
        + (ranges.length ? " " + ranges.join("; ") + "." : "") + " Nothing is blocked by this; caps read only the ledger.";
      return { segs, text: segText(segs), title, projectedUsd: proj.mid, dailyReached: !!(daily && (daily.state === "reached" || daily.state === "at-pace")) };
    }

    // ---- the Costs card: pure models ----
    /** Billing as the table says it: the word, and a tooltip where the word needs one. A provider declared in config.json `subscriptions` says so (a typo stays visible). */
    function billingText(kind, provider, declared) {
      const isDecl = kind === "subscription" && Array.isArray(declared) && declared.indexOf(provider) >= 0;
      return { text: (BILLING_LABEL[kind] || cap1(kind)) + (isDecl ? " · declared" : ""), title: isDecl ? "Declared in config.json (subscriptions): billed as a subscription, never capped. Check the provider id if this is a surprise." : kind === "credits" ? "Covered by the plan's prepaid credits: charged $0 until they run out" : undefined };
    }
    /** How a provider's swatch looks (and its bar segment): solid = charged, hatched = plan credits, tinted = API value that was not charged, outline = nothing to show. */
    function provLook(r) {
      if (r.usd > 0) return "solid";
      if (r.api - r.usd > 0) return r.billing === "credits" ? "hatch" : "tint";
      return "outline";
    }
    /** /spend payload -> the hero (pure): the charged money, the API value that was not charged, the bar, and the call count; null without totals. */
    function spendHeroModel(d, period) {
      if (!d || !d.totals) return null;
      const t = d.totals, chargedUsd = t.usd || 0, api = t.apiEquivUsd || 0, calls = t.calls || 0;
      const partial = d.complete === false || d.unreadable === true;
      const ge = partial ? "≥" : "";
      const notCharged = Math.max(0, api - chargedUsd);
      const week = period === "7d";
      const segments = [];
      if (chargedUsd > 0) segments.push({ key: "charged", look: "solid", value: chargedUsd, label: "charged" });
      spendRows(d).inDsh.map((r) => ({ r, nc: r.api - r.usd })).filter((x) => x.nc > 0).sort((a, b) => b.nc - a.nc)
        .forEach((x) => segments.push({ key: x.r.k, look: x.r.billing === "credits" ? "hatch" : "tint", value: x.nc, label: x.r.k + " (" + (BILLING_LABEL[x.r.billing] || x.r.billing || "not charged") + ") not charged" }));
      return {
        empty: calls === 0, emptyText: partial ? "Calls not known" : "No model calls " + (week ? "in the last 7 days" : "today"), partial,
        chargedLabel: week ? "Charged in the last 7 days, in DSH" : "Charged today, in DSH",
        barLabel: (week ? "The last 7 days" : "Today") + "'s API value in DSH by billing: ",
        charged: ge + heroUsd(chargedUsd), notCharged: ge + heroUsd(notCharged),
        total: chargedUsd > 0 && notCharged > 0 ? ge + heroUsd(api) : null,
        callsText: num(calls) + (calls === 1 ? " call" : " calls"),
        segments: calls === 0 ? [] : segments,
      };
    }
    /**
     * The rows of "Caps and plan credits" (pure): Today (daily cap), Latest session, a provider's daily cap, each plan-credit plan.
     * { key, label, sub, spent, cap, frac, est (the forecast as a fraction of the cap, or null), tone, hatch, aria }.
     */
    function capRowsModel(d, plans, fcl) {
      const caps = d && d.caps, lim = caps && caps.limits;
      const rows = [];
      const warnAt = lim && lim.warnPct > 0 ? lim.warnPct : 80;
      const toneOf = (frac, at) => (frac >= 1 ? "danger" : frac * 100 >= at ? "warn" : "accent");
      if (lim && lim.dailyUsd > 0) {
        const spent = caps.todayUsd || 0, frac = spent / lim.dailyUsd, p = Math.round(frac * 100);
        let est = null;
        if (fcl && fcl.projectedUsd > spent) est = fcl.dailyReached ? Math.max(1, fcl.projectedUsd / lim.dailyUsd) : fcl.projectedUsd / lim.dailyUsd;
        rows.push({ key: "daily", label: "Today", sub: "", spent, cap: lim.dailyUsd, frac, est, tone: toneOf(frac, warnAt), hatch: true,
          aria: "Daily cap: " + usd(spent) + " spent today of " + usd(lim.dailyUsd) + ", " + p + "%" + (frac * 100 >= warnAt && frac < 1 ? ", past the " + warnAt + "% alert" : "") + (est !== null ? ". Estimate: " + (fcl.dailyReached ? "the cap is reached today" : "about " + usd(fcl.projectedUsd) + " by midnight") + "." : "") });
      }
      if (lim && lim.sessionUsd > 0) {
        const known = typeof caps.sessionSpentUsd === "number", spent = known ? caps.sessionSpentUsd : 0, frac = spent / lim.sessionUsd;
        rows.push({ key: "session", label: "Latest session", sub: "", spent: known ? spent : null, cap: lim.sessionUsd, frac, est: null, tone: toneOf(frac, warnAt), hatch: true,
          aria: "Session cap: " + (known ? usd(spent) + " spent of " + usd(lim.sessionUsd) + ", " + Math.round(frac * 100) + "%" : "not known, of " + usd(lim.sessionUsd)) });
      }
      const per = lim && lim.perProviderDailyUsd && typeof lim.perProviderDailyUsd === "object" ? lim.perProviderDailyUsd : {};
      for (const id of Object.keys(per)) {
        if (!(per[id] > 0)) continue;
        const spent = (d.byProvider && d.byProvider[id] && d.byProvider[id].usd) || 0, frac = spent / per[id];
        rows.push({ key: "p:" + id, label: id, sub: "daily cap", spent, cap: per[id], frac, est: null, tone: toneOf(frac, warnAt), hatch: true, aria: id + " daily cap: " + usd(spent) + " spent today of " + usd(per[id]) + ", " + Math.round(frac * 100) + "%" });
      }
      for (const p of plans || []) {
        rows.push({ key: "plan:" + p.key, label: p.label, sub: p.reset ? "resets " + p.reset : "", spent: p.spent, cap: p.cap, frac: p.frac, est: null, tone: p.frac >= 1 ? "danger" : p.frac >= 0.8 ? "warn" : "accent", hatch: false, over: p.over, partial: p.partial,
          aria: p.label + ": " + usd(p.spent) + " used of " + usd(p.cap) + (p.reset ? ", resets " + p.reset : "") });
      }
      return rows;
    }
    const AMT_TONE = { accent: "", warn: " is-warn", danger: " is-bad" };
    function CapRowsBlock(props) {
      const rows = props.rows;
      return h("div", { className: "dshMh-caprows", children: rows.map((r) => hs("div", { key: r.key, className: "dshMh-hcrow", children: [
        hs("div", { className: "dshMh-caplab", children: [h("span", { children: r.label }), r.sub ? h("span", { className: "dshMh-capsub", children: r.sub }) : null] }),
        h(CapRunway, { frac: r.frac, est: r.est, tone: r.tone, hatch: r.hatch, pid: "dshMh-rw-" + props.pid + "-" + r.key.replace(/[^A-Za-z0-9_-]/g, "_"), label: r.aria }),
        hs("span", { className: "dshMh-capamt", children: [h("span", { className: "dshMh-capamt-n" + (AMT_TONE[r.tone] || ""), children: r.spent === null ? "—" : usd(r.spent) }), h("span", { className: "dshMh-soft2", children: " of " + usd(r.cap) })] }),
      ] })) });
    }

    function CostsPanel(props) {
      const [period, setPeriod] = react.useState("today");
      const [ledger, setLedger] = react.useState({ running: false, report: null, error: null });
      const verify = () => {
        setLedger((s) => ({ ...s, running: true, error: null }));
        getJson("/ledger/verify?since=all").then((r) => setLedger({ running: false, report: r, error: null }), (e) => setLedger({ running: false, report: null, error: String((e && e.message) || e) }));
      };
      const lline = ledgerLine(ledger.report, ledger.error, ledger.running);
      const ldetail = ledger.running ? [] : ledgerDetail(ledger.report);
      const today = props.today || { data: null, error: null };
      const week = props.week || { data: null, error: null };
      const capsView = usePoll("/caps", 15000);
      const capsProblem = capsProblemLine(capsView.data);
      const [editing, setEditing] = react.useState(false);
      const [saved, setSaved] = react.useState(false);
      const editBtn = react.useRef(null);
      const wasEditing = react.useRef(false);
      // focus goes back to the Edit button once the editor closes
      react.useEffect(() => { if (wasEditing.current && !editing && editBtn.current && editBtn.current.focus) editBtn.current.focus(); wasEditing.current = editing; }, [editing]);
      const onCapsSaved = () => { setEditing(false); setSaved(true); capsView.reload(); if (today.reload) today.reload(); if (props.onCapsSaved) props.onCapsSaved(); setTimeout(() => setSaved(false), 4000); };
      const declared = Array.isArray(props.declared) ? props.declared : [];
      const plans = planRows(today.data);
      const d = today.data;
      const caps = d && d.caps;
      const sv = spendView(d);
      const shown = period === "7d" ? week.data : d;
      const rows = spendRows(shown);
      const pur = purposeRows(shown);
      const hero = spendHeroModel(shown, period);
      const gline = guardLine(caps);
      const rsegs = reservedSegs(caps);
      const fcFresh = freshForecast(props.forecast);
      const fcl = forecastSpendLine(fcFresh && fcFresh.spend);
      const capRows = capRowsModel(d, plans, fcl);
      const facts = [];
      if (fcl) facts.push({ key: "est", tag: "est.", est: true, testid: "model-hub-forecast", title: fcl.title, segs: fcl.segs, sr: " (estimate)" });
      if (rsegs) facts.push({ key: "held", tag: "Held", title: "Each request in flight is held at its worst case until its spend row is written; this DSH process only.", segs: rsegs });
      if (gline) facts.push({ key: "guard", tag: "Guard", title: gline.title, segs: [gline.text] });
      const capPill = caps ? (caps.action === "block" ? h("span", { className: "dshMh-pill is-bad", title: caps.reason, children: "Cap reached" }) : caps.action === "warn" ? h("span", { className: "dshMh-pill is-warn", title: caps.reason, children: "Near a cap" }) : null) : null;
      const tab = (id, text) => h("button", { type: "button", role: "tab", "aria-selected": period === id ? "true" : "false", className: "dshMh-sg-b" + (period === id ? " is-on" : ""), onClick: () => setPeriod(id), children: text });
      const th = (cls, text, label) => h("th", { scope: "col", className: cls, "aria-label": label, children: text });
      const spendWord = period === "7d" ? "in the last 7 days" : "today";
      // one warning box under the card header, a line per problem
      const warns = [];
      if (capsProblem) warns.push({ key: "caps", testid: "caps-invalid", text: capsProblem });
      if (sv && sv.partial) warns.push({ key: "partial", text: sv.subLines[sv.subLines.length - 1] });
      if (d && d.totals && d.totals.unpricedCalls > 0) warns.push({ key: "unpriced", title: "These calls went to a metered provider whose price is unknown, so their spend is stored as $0 and does not count toward the caps. Add the model to prices.json in the plugin data dir.", text: d.totals.unpricedCalls + " unpriced call" + (d.totals.unpricedCalls === 1 ? "" : "s") + " today — not counted toward caps (add prices.json)" });
      return hs("section", {
        className: "dshMh-card",
        "aria-label": "Costs",
        children: [
          hs("div", { className: "dshMh-cardhead", children: [
            hs("div", { className: "dshMh-headl", children: [h("h3", { className: "dshMh-h3", children: "Costs" }), capPill] }),
            hs("div", { className: "dshMh-sg", role: "tablist", "aria-label": "Period", children: [tab("today", "Today"), tab("7d", "7 days")] }),
          ] }),
          today.error ? h("div", { className: "dshMh-err", children: "Spend unavailable: " + today.error }) : null,
          warns.length ? h("div", { className: "dshMh-warn dshMh-warns", role: "status", children: warns.map((w) => h("div", { key: w.key, "data-testid": w.testid, title: w.title, children: w.text })) }) : null,
          hero ? h(CostHero, { model: hero }) : null,
          hs("div", { className: "dshMh-cbody", children: [
            editing && capsView.data ? hs("section", { className: "dshMh-csec is-edit", "aria-label": "Edit caps", children: [
              h("div", { className: "dshMh-sechead", children: h("h4", { className: "dshMh-h4", children: "Edit caps" }) }),
              h(CapsEditor, { view: capsView.data, plan: props.plan, onSaved: onCapsSaved, onCancel: () => setEditing(false) }),
            ] }) : hs("section", { className: "dshMh-csec", "aria-label": "Caps and plan credits", children: [
              hs("div", { className: "dshMh-sechead", children: [
                h("h4", { className: "dshMh-h4", children: "Caps and plan credits" }),
                hs("div", { className: "dshMh-headr is-tight", children: [
                  saved ? h("span", { className: "dshMh-oktext", role: "status", children: "Caps saved." }) : null,
                  h("button", { type: "button", ref: editBtn, className: "dshMh-b", disabled: !capsView.data || editing || props.demo === true, title: props.demo === true ? "Demo mode is read-only: caps cannot be changed" : undefined, onClick: () => { setSaved(false); setEditing(true); }, children: "Edit caps" }),
                ] }),
              ] }),
              capRows.length ? h(CapRowsBlock, { rows: capRows, pid: "c" }) : d ? h("div", { className: "dshMh-soft dshMh-capnone", children: "No caps are set. Edit caps to add one." }) : null,
              capRows.filter((r) => r.over > 0 || r.partial).map((r) => hs("div", { key: "n:" + r.key, className: "dshMh-soft dshMh-capnote", children: [
                r.over > 0 ? r.label + ": over the included credits by " + usd(r.over) + ", billed as metered and counted toward caps. " : "",
                r.partial ? r.label + ": partial, the spend ledger could not be read in full." : "",
              ] })),
              facts.length ? h("div", { className: "dshMh-facts", children: facts.map((f) => hs("div", { key: f.key, className: "dshMh-fact", "data-testid": f.testid, title: f.title, role: f.key === "est" ? undefined : "status", children: [
                h("span", { className: "dshMh-tag is-w" + (f.est ? " is-est" : ""), children: f.tag }),
                hs("span", { children: [f.segs.map((x, i) => (typeof x === "string" ? x : h("b", { key: i, className: "dshMh-fact-b", children: x.b }))), f.sr ? h("span", { className: "dshMh-sr", children: f.sr }) : null] }),
              ] })) }) : null,
            ] }),
            shown ? hs("table", { className: "dshMh-ctable", "aria-label": "Spend by provider " + spendWord, children: [
              h("thead", { children: hs("tr", { children: [th("dshMh-c-first", "By provider"), th("dshMh-c-bill", "Billing"), th("dshMh-c-n dshMh-c-calls", "Calls"), th("dshMh-c-n dshMh-c-chg", "Charged"), th("dshMh-c-n dshMh-c-nc", "Not charged")] }) }),
              h("tbody", { children: rows.inDsh.length ? rows.inDsh.map((r) => { const bt = r.billing ? billingText(r.billing, r.k, declared) : null; const nc = Math.max(0, r.api - r.usd); return hs("tr", { key: "d:" + r.k, "data-provider-row": "1", children: [
                h("td", { children: hs("span", { className: "dshMh-c-route", children: [h(Swatch, { look: provLook(r) }), h("span", { className: "dshMh-c-prov-name", children: r.k })] }) }),
                h("td", { title: bt ? bt.title : undefined, children: bt ? bt.text : h("span", { className: "dshMh-soft", children: "—" }) }),
                h("td", { className: "dshMh-c-n", children: num(r.calls) }),
                h("td", { className: "dshMh-c-n" + (r.usd > 0 ? " is-strong" : " is-zero"), children: costMoney(r.usd) }),
                h("td", { className: "dshMh-c-n" + dim(nc), children: costMoney(nc) }),
              ] }); }) : h("tr", { children: h("td", { colSpan: 5, className: "dshMh-soft", children: "No spend recorded " + spendWord + ". Subscription, free and local usage count as $0." }) }) }),
            ] }) : null,
            rows.outside.length ? hs("table", { className: "dshMh-ctable", "aria-label": "Outside DSH", children: [
              h("thead", { children: hs("tr", { children: [th("dshMh-c-first", "Outside DSH"), th("dshMh-c-bill", "", "Billing"), th("dshMh-c-n dshMh-c-calls", "", "Calls"), th("dshMh-c-n dshMh-c-chg", "", "Charged"), th("dshMh-c-n dshMh-c-nc", "", "Cap")] }) }),
              h("tbody", { children: rows.outside.map((r) => hs("tr", { key: "m:" + r.k, title: "Metered outside DSH (an extra ledger from config.json extraLedgers; display only, never capped)", "data-outside-row": "1", children: [
                h("td", { children: h("span", { className: "dshMh-c-prov-name", children: r.k }) }),
                h("td", { children: "Metered" }),
                h("td", { className: "dshMh-c-n", children: num(r.calls) }),
                h("td", { className: "dshMh-c-n is-strong", children: costMoney(r.usd) }),
                h("td", { className: "dshMh-c-n is-zero", children: h("span", { className: "dshMh-c-small", children: "never capped" }) }),
              ] })) }),
            ] }) : null,
            pur.length ? hs("table", { className: "dshMh-ctable", "aria-label": "Spend by purpose " + spendWord, children: [
              h("thead", { children: hs("tr", { children: [th("dshMh-c-first", "By purpose"), th("dshMh-c-n dshMh-c-calls", "Calls"), th("dshMh-c-n dshMh-c-chg", "Charged"), th("dshMh-c-n dshMh-c-nc", "API value")] }) }),
              h("tbody", { children: pur.map((r) => hs("tr", { key: "p:" + r.key, "data-purpose-row": "1", children: [
                h("td", { className: "dshMh-ellipsis", children: r.label }),
                h("td", { className: "dshMh-c-n", children: num(r.calls) }),
                h("td", { className: "dshMh-c-n" + (r.usd > 0 ? " is-strong" : " is-zero"), children: costMoney(r.usd) }),
                h("td", { className: "dshMh-c-n", children: costMoney(r.api) }),
              ] })) }),
            ] }) : null,
            hs("div", { role: "group", "aria-label": "Ledger", className: "dshMh-ledger", children: [
              hs("div", { className: "dshMh-ledger-row", children: [
                hs("div", { className: "dshMh-ledger-txt", children: [
                  h("span", { className: "dshMh-ledger-t", children: "Spend ledger" }),
                  h("span", { role: "status", className: "dshMh-ledger-s is-" + lline.tone, title: lline.title, children: [lline.tone === "ok" || lline.tone === "bad" ? h(LedgerMark, { tone: lline.tone }) : null, lline.text] }),
                ] }),
                h("button", { type: "button", className: "dshMh-b", disabled: ledger.running, onClick: verify, children: ledger.running ? "Verifying…" : "Verify" }),
              ] }),
              ldetail.map((l, i) => h("div", { key: "l:" + i, className: "dshMh-soft dshMh-small dshMh-mono", children: l })),
            ] }),
          ] }),
        ],
      });
    }
    /** The 14 px round mark before the ledger status: a check when verified, an exclamation when it found a mismatch. */
    function LedgerMark(props) {
      return hs("svg", { className: "dshMh-lmark is-" + props.tone, width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true", focusable: "false", children: [
        h("circle", { key: "c", cx: 7, cy: 7, r: 7, className: "dshMh-lmark-bg" }),
        props.tone === "ok" ? h("path", { key: "p", d: CHECK_PATH, fill: "none", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", className: "dshMh-lmark-fg" }) : h("path", { key: "p", d: "M7 3.6v4M7 10.2h.01", fill: "none", strokeWidth: 1.7, strokeLinecap: "round", className: "dshMh-lmark-fg" }),
      ] });
    }

    /** The Prices card: what a million tokens cost per model (only the models this install knows about). */
    function PricesPanel(props) {
      const week = props.week || { data: null, error: null };
      const gcfgData = props.gcfg || null;
      const gOn = !!(gcfgData && gcfgData.configured);
      const gm = usePoll(gOn ? "/gpu/models" : null, 60000);
      // keep the last good list so the local price rows survive the GPU server being briefly unreachable
      const lastG = react.useRef([]);
      if (gm.data && Array.isArray(gm.data.models) && gm.data.models.length) lastG.current = gm.data.models;
      const local = gOn ? gpuPriceIds(lastG.current, gcfgData) : [];
      const hubCfg = props.hubCfg || { data: null };
      // always-shown rows come from config.json priceModels (GET /hub/config); none by default
      const priceModels = (hubCfg.data && Array.isArray(hubCfg.data.priceModels)) ? hubCfg.data.priceModels : [];
      const declared = (hubCfg.data && Array.isArray(hubCfg.data.subscriptions)) ? hubCfg.data.subscriptions : [];
      const seen = week.data ? Object.keys(week.data.groups || {}) : [];
      const models = priceList(local, priceModels, seen);
      // nothing to price yet (fresh install: no priceModels, no usage, no GPU server): do not call /prices at all
      const pr = usePoll(models.length ? "/prices?models=" + encodeURIComponent(models.join(",")) : null, 60000);
      const prices = pr.data ? priceTable(pr.data.models, pr.data.providerHealth || {}, gOn ? gcfgData.id : null) : null;
      const unpricedModels = prices ? prices.filter((r) => r.kind === "unpriced").length : 0;
      const th = (cls, text) => h("th", { scope: "col", className: cls, children: text });
      return hs("section", {
        className: "dshMh-card",
        "aria-label": "Prices",
        children: [
          hs("div", { className: "dshMh-cardhead", children: [h("div", { className: "dshMh-headl", children: h("h3", { className: "dshMh-h3", children: "Prices" }) }), h("div", { className: "dshMh-headr", children: h("span", { className: "dshMh-soft", children: "$ per million tokens" }) })] }),
          prices && prices.length ? hs("table", { className: "dshMh-ctable", "aria-label": "Prices", children: [
            h("thead", { children: hs("tr", { children: [th("dshMh-c-plain", "Model"), th("dshMh-c-bill", "Billing"), th("dshMh-c-n dshMh-c-px", "In"), th("dshMh-c-n dshMh-c-px", "Out"), th("dshMh-c-n dshMh-c-px", "Cache")] }) }),
            h("tbody", { children: prices.map((r) => { const bt = billingText(r.kind, r.provider, declared); const soft = r.kind === "unpriced" ? " is-zero" : ""; return hs("tr", { key: r.id, title: r.id, "data-price-row": "1", children: [
              h("td", { children: r.split ? hs("span", { className: "dshMh-c-name", children: [h("span", { className: "dshMh-c-prov", children: r.provider + " / " }), h("span", { className: "dshMh-c-model", children: r.model })] }) : h("span", { className: "dshMh-c-model", children: r.model }) }),
              h("td", { title: r.noCredit ? undefined : bt.title, children: r.noCredit
                ? h("span", { className: "dshMh-pill is-bad", title: (r.info && r.info.message) || "No credit", children: "No credit (" + (r.info && r.info.code != null ? r.info.code : "402") + ")" })
                : r.kind === "unpriced"
                  ? h("span", { className: "dshMh-pill is-warn", title: "No known price: calls are stored at $0 and do not count toward caps. Add it to prices.json in the plugin data dir.", children: "Add price" })
                  : bt.text }),
              h("td", { className: "dshMh-c-n" + soft, children: r.in }),
              h("td", { className: "dshMh-c-n" + soft, children: r.out }),
              h("td", { className: "dshMh-c-n" + soft, children: r.cache }),
            ] }); }) }),
          ] }) : null,
          unpricedModels ? h("div", { className: "dshMh-soft", children: unpricedModels + " model" + (unpricedModels === 1 ? " has" : "s have") + " no known price: " + (unpricedModels === 1 ? "its" : "their") + " calls count as $0 and not toward caps. Add " + (unpricedModels === 1 ? "it" : "them") + " to prices.json." }) : null,
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

    /** The hub's connection line (right of the title): the dot, and one sentence. */
    function hubStatusLine(st) {
      const up = st.reachable;
      return { tone: up ? "ok" : st.error ? "bad" : "off", text: up ? "Hub connected" + (st.spendGuard ? " · spend guard on" : "") : st.error ? "Hub not reachable" : "Connecting…" };
    }
    function HubSection() {
      const { st } = useStatus();
      const today = usePoll("/spend?since=today&by=provider", 8000);
      const week = usePoll("/spend?since=7d&by=model", 20000);
      const hubCfg = usePoll("/hub/config", 60000);
      const gcfg = usePoll("/gpu/config", 60000);
      const forecast = usePoll("/forecast", 15000);
      const hs0 = hubStatusLine(st);
      const declared = (hubCfg.data && Array.isArray(hubCfg.data.subscriptions)) ? hubCfg.data.subscriptions : [];
      return hs("div", {
        className: "dshMh-hub",
        children: [
          hs("div", { className: "dshMh-hubhead", children: [
            h("h2", { className: "dshMh-hubtitle", children: "Model hub" }),
            hs("div", { className: "dshMh-hubstatus", role: "status", children: [
              h("span", { className: "dshMh-dot " + (hs0.tone === "off" ? "" : "is-" + hs0.tone), "aria-hidden": "true" }),
              h("span", { children: hs0.text }),
            ] }),
          ] }),
          st.demo ? h(DemoBanner, { long: true }) : null,
          otherInstance(st.webOrigin) ? h("div", { className: "dshMh-warn", role: "status", "data-testid": "other-instance", children: OTHER_INSTANCE(st.webOrigin) }) : null,
          h("div", { className: "dshMh-grid", children: [h(CostsPanel, { key: "c", today, gcfg: gcfg.data, demo: st.demo, forecast, week, declared, plan: st.plan }), h(AccountsPanel, { key: "a" }), h(GpuPanel, { key: "r", cfg: gcfg.data }), h(PricesPanel, { key: "p", gcfg: gcfg.data, week, hubCfg })] }),
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
        className: "dshMh-ring", width: size, height: size, viewBox: "0 0 " + box + " " + box, ...(props.decorative ? { "aria-hidden": "true" } : { role: "img", "aria-label": props.label }), focusable: "false",
        children: [
          h("circle", { key: "t", className: "dshMh-ring-track", cx: box / 2, cy: box / 2, r, fill: "none", strokeWidth: props.stroke || 2.5 }),
          // nothing used: no arc at all (a zero-length dash with round caps would still draw a dot)
          typeof p === "number" && p > 0 ? h("circle", { key: "a", className: "dshMh-ring-arc is-" + state, cx: box / 2, cy: box / 2, r, fill: "none", strokeWidth: props.stroke || 2.5, strokeLinecap: "round", strokeDasharray: ringDash(r, p), transform: "rotate(-90 " + box / 2 + " " + box / 2 + ")" }) : null,
        ],
      });
    }
    const ringState = (t) => (t === "danger" ? "danger" : t === "warn" ? "warn" : "ok");
    const PLAN_CAPTION = "Usage % counts every Claude app on this account. Message counts are DSH only. Anthropic does not publish remaining messages.";
    // ---- Claude plan forecast (GET /forecast `plan`): ESTIMATES, one line per window, only when the fit has a result ----
    const FORECAST_PLAN_PREFIX = "At this pace:";
    /** w: plan.windows.fiveHour|sevenDay of the report; win: the plan's own window (the line is dropped when it was fitted to another reset). */
    function forecastPlanLine(w, win) {
      if (!w || (w.status !== "limit" && w.status !== "no-limit")) return null;
      if (!win || !win.resetsAt || typeof w.resetsAt !== "string") return null;
      if (!(Math.abs(Date.parse(win.resetsAt) - Date.parse(w.resetsAt)) <= 60000)) return null;
      const at = (ms) => fmtReset(new Date(ms).toISOString());
      if (w.status === "limit") {
        if (typeof w.limitAt !== "number" || typeof w.earliestAt !== "number") return null;
        const range = typeof w.latestAt === "number" ? "range " + at(w.earliestAt) + "–" + at(w.latestAt) : "range from " + at(w.earliestAt);
        return FORECAST_PLAN_PREFIX + " limit ~" + at(w.limitAt) + " (" + range + "), " + w.readings + " reading" + (w.readings === 1 ? "" : "s") + ", before the reset";
      }
      const reset = fmtReset(w.resetsAt);
      if (w.mayReach === true && typeof w.earliestAt === "number") return FORECAST_PLAN_PREFIX + " probably not before the reset at " + reset + " (could be ~" + at(w.earliestAt) + " at the fastest pace)";
      return FORECAST_PLAN_PREFIX + " won't reach 100% before the reset at " + reset;
    }
    const isForecastLine = (l) => typeof l === "string" && l.startsWith(FORECAST_PLAN_PREFIX);
    /** fc: the whole fresh /forecast report (or null). The title of every forecast row on the plan card. */
    function forecastPlanTitle(fc) {
      const age = fc && fc.plan && typeof fc.plan.ageMs === "number" ? Math.max(1, Math.round(fc.plan.ageMs / 60000)) : null;
      return "Estimate, not a limit. Fitted to the Claude usage % readings (whole percents) from the recent part of the window" + (age === null ? "" : "; the newest is " + age + " min old")
        + ". The range allows for the rounding and the scatter of the readings. The % counts every Claude app on this account, so usage outside DSH moves it too. Nothing is blocked by this.";
    }
    function windowLine(label, w) { return label + ": " + w.percent + "% used" + (w.resetsAt ? " · resets " + fmtReset(w.resetsAt) : ""); }
    /** 5-hour, weekly, weekly per model (Opus, Sonnet) and the labelled scoped weekly; only windows the endpoint reported. */
    function windowLines(plan, fc) {
      const out = [];
      const ok = (w) => w && typeof w.percent === "number";
      const wins = fc && fc.plan && fc.plan.windows ? fc.plan.windows : {};
      const fcLine = (key, win) => { const l = plan.mode === "plan" ? forecastPlanLine(wins[key], win) : null; if (l) out.push(l); };
      if (ok(plan.fiveHour)) { out.push(windowLine("5-hour window", plan.fiveHour)); fcLine("fiveHour", plan.fiveHour); }
      if (ok(plan.sevenDay)) { out.push(windowLine("Weekly", plan.sevenDay)); fcLine("sevenDay", plan.sevenDay); }
      if (ok(plan.sevenDayOpus)) out.push(windowLine("Weekly (Opus)", plan.sevenDayOpus));
      if (ok(plan.sevenDaySonnet)) out.push(windowLine("Weekly (Sonnet)", plan.sevenDaySonnet));
      if (ok(plan.scopedWeekly) && plan.scopedWeekly.label) out.push(windowLine(String(plan.scopedWeekly.label), plan.scopedWeekly));
      return out;
    }
    // A gauge older than this is not trusted for a "stopped" claim (the host's plan guard uses the same 10 minutes).
    const PLAN_FRESH_MS = 10 * 60 * 1000;
    /** The exhausted window that makes DSH refuse requests right now: { label, resetsAt, model } or null. Mirrors the host's windowsFor. */
    function exhaustedWindow(plan) {
      if (!plan || plan.mode !== "plan" || typeof plan.fetchedAt !== "number") return null;
      const age = Date.now() - plan.fetchedAt;
      if (age < 0 || age > PLAN_FRESH_MS) return null;
      const lbl = plan.scopedWeekly && typeof plan.scopedWeekly.label === "string" ? plan.scopedWeekly.label : "";
      const fam = /opus/i.test(lbl) ? "Opus" : /sonnet/i.test(lbl) ? "Sonnet" : null;
      const list = [
        ["5-hour window", plan.fiveHour, null], ["weekly window", plan.sevenDay, null],
        ["weekly Opus window", plan.sevenDayOpus, "Opus"], ["weekly Sonnet window", plan.sevenDaySonnet, "Sonnet"],
        ["weekly " + lbl + " window", fam ? plan.scopedWeekly : null, fam],
      ];
      for (const [label, w, model] of list) {
        if (!w || typeof w.percent !== "number" || w.percent < 100) continue;
        const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
        if (Number.isFinite(resets) && resets <= Date.now()) continue;
        return { label, resetsAt: w.resetsAt || null, model };
      }
      return null;
    }
    /** What happens beyond a full plan window, for the plan card and the tooltip. stop = the opt-in "stop at the plan limit" switch. */
    function extraUsageSentence(plan, stop) {
      if (stop === true) {
        const x = exhaustedWindow(plan);
        if (x) return "Stopped by DSH: your Claude " + x.label + " is at 100%" + (x.resetsAt ? " (resets " + fmtReset(x.resetsAt) + ")" : "") + ". " + (x.model ? x.model + " requests are" : "Claude requests are") + " refused until then.";
        return "DSH will stop Claude requests when a plan window (5-hour, weekly or per-model weekly) reaches 100%, so nothing is billed beyond your plan.";
      }
      if (!plan.extraKnown) return "DSH does not stop Claude requests at the plan limit. Whether Anthropic bills or refuses requests beyond a full plan window depends on your account's extra-usage setting, which was not reported.";
      return plan.extraEnabled
        ? "Extra usage is on for your Claude account: requests beyond a plan window are billed to your Anthropic balance."
        : "Extra usage is off for your Claude account: Anthropic refuses requests once a plan window is full.";
    }
    /** THE source of the plan card's text. The card (under the rings) and the Claude chip tooltip both render exactly these lines. */
    function planLines(plan, stop, fc) {
      if (!plan || plan.mode === "signed-out") return ["Not signed in. Use Model hub → Accounts below to sign in."];
      if (plan.mode === "expired") return ["Claude sign-in expired — Model hub → Accounts"];
      if (plan.mode === "api") return ["Using Anthropic API key (billed per token)"];
      const out = [];
      if (plan.mode === "unavailable") {
        const when = plan.fetchedAt ? new Date(plan.fetchedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;
        out.push("Plan usage unavailable (" + (plan.httpStatus ?? "?") + ")" + (when ? " · " + when : ""));
      }
      out.push(...windowLines(plan, fc));
      const counts = dshCountsLine(plan);
      if (counts) out.push(counts);
      out.push(PLAN_CAPTION);
      if (plan.mode === "plan") out.push(extraUsageSentence(plan, stop === true));
      if (plan.mode === "unavailable") out.push("The sign-in may need renewing: see Model hub → Accounts.");
      return out;
    }
    /** The tooltip's lines: the account identity first (the card shows it above the rings), then planLines. */
    function planCardLines(plan, identity, stop, fc) {
      const signedIn = plan && (plan.mode === "plan" || plan.mode === "unavailable");
      return (signedIn ? [identityLine(identity)] : []).concat(planLines(plan, stop, fc));
    }
    /** The signed-in account as one line: "<email> · <plan>" plus the organization when it is not the personal one.
     *  null identity (or one without an email/plan/org) -> "account not reported", never nothing. */
    function identityLine(id) {
      const parts = [];
      if (id && id.email) parts.push(id.email); else if (id && id.name) parts.push(id.name);
      if (id && id.plan) parts.push(id.plan);
      if (id && id.org) parts.push(id.org);
      return parts.length ? parts.join(" · ") : "account not reported";
    }
    /** Saves the switch through POST /caps (postJson runs the instance-ownership check); ui = { busy, error, reload } callbacks. */
    async function savePlanStop(next, post, ui) {
      ui.busy(true); ui.error("");
      try { await post("/caps", { set: { stopAtPlanLimit: next } }); ui.reload(); }
      catch (e) { ui.error(String((e && e.message) || e)); }
      finally { ui.busy(false); }
    }
    // ---- Claude plan card (design C): up to three rings, one est. line, what DSH sent, the plan-stop switch ----
    /** The state of a plan window's ring: ok under 80%, warn from 80%, full at 100% (the ring closes). */
    const planRingState = (p) => (p >= 100 ? "full" : p >= 80 ? "warn" : "ok");
    // geometry of the two ring sizes: a halo disc, a track and an arc (the arc has round caps)
    const PLAN_RING = { lg: { box: 124, r: 53, stroke: 9 }, sm: { box: 84, r: 35, stroke: 7 }, xs: { box: 72, r: 30.5, stroke: 6 } };
    const ringPoint = (box, r, deg) => ({ x: box / 2 + r * Math.sin((deg * Math.PI) / 180), y: box / 2 - r * Math.cos((deg * Math.PI) / 180) });
    const r2 = (x) => +x.toFixed(2);
    /** The dashed "est." arc of a ring: the part of the circle between the used arc and 100% (degrees clockwise from the top),
     *  with a gap after the used arc's round cap and before the top. { d, dash } for an SVG path + stroke-dasharray, or null when
     *  the stretch is too short for two dashes. Pure. */
    function estArc(box, r, stroke, percent) {
      const v = Math.max(0, Math.min(100, typeof percent === "number" ? percent : 0));
      if (!(v < 100)) return null;
      const from = v * 3.6, rest = 360 - from;
      const a = from + Math.min(0.21875 * rest, 20), b = 360 - Math.min(0.1875 * rest, 16);
      const len = (r * Math.PI * (b - a)) / 180;
      const dash = r2(stroke * 0.4), want = stroke * 0.64;
      const n = Math.round((len + want) / (dash + want));
      if (n < 2) return null;
      const gap = (len - n * dash) / (n - 1);
      if (!(gap > 0.5)) return null;
      const s = ringPoint(box, r, a), e = ringPoint(box, r, b);
      return { d: "M" + r2(s.x) + " " + r2(s.y) + " A" + r + " " + r + " 0 " + (b - a > 180 ? 1 : 0) + " 1 " + r2(e.x) + " " + r2(e.y), dash: dash + " " + r2(gap) };
    }
    /** The windows the card draws as rings, in order: { key, title, aria, size, win } for each the plan reported. */
    function planWindows(plan) {
      const ok = (w) => w && typeof w.percent === "number";
      const out = [];
      if (ok(plan.fiveHour)) out.push({ key: "fiveHour", title: "5-hour window", aria: "5-hour window", size: "lg", win: plan.fiveHour });
      // a live plan with no 5-hour reading has no window open yet: an empty ring that says so, never a missing one
      else if (plan.mode === "plan") out.push({ key: "fiveHour", title: "5-hour window", aria: "5-hour window", size: "lg", win: { percent: 0, resetsAt: null }, idle: true });
      if (ok(plan.sevenDay)) out.push({ key: "sevenDay", title: "Weekly, all models", aria: "Weekly window, all models", size: "lg", win: plan.sevenDay });
      if (ok(plan.sevenDayOpus)) out.push({ key: "sevenDayOpus", title: "Opus, weekly", aria: "Weekly Opus window", size: "sm", win: plan.sevenDayOpus });
      if (ok(plan.sevenDaySonnet)) out.push({ key: "sevenDaySonnet", title: "Sonnet, weekly", aria: "Weekly Sonnet window", size: "sm", win: plan.sevenDaySonnet });
      if (ok(plan.scopedWeekly) && plan.scopedWeekly.label) out.push({ key: "scoped", title: plan.scopedWeekly.label + ", weekly", aria: "Weekly " + plan.scopedWeekly.label + " window", size: "sm", win: plan.scopedWeekly });
      return out;
    }
    /** Ring rows: one row when at most one small ring follows the big ones (the card's width), else the small rings on a second row. */
    function ringRows(list) {
      const big = list.filter((x) => x.size === "lg"), small = list.filter((x) => x.size === "sm");
      return small.length <= 1 || !big.length ? [list] : [big, small];
    }
    /** "3:55–4:30 PM": the first time drops its AM/PM (and weekday) when the second one carries the same. */
    function fmtClockRange(a, b) {
      const sa = fmtReset(new Date(a).toISOString()), sb = fmtReset(new Date(b).toISOString());
      const m = /\s(AM|PM)$/.exec(sa), n = /\s(AM|PM)$/.exec(sb);
      const day = (s) => (/^[A-Za-z]{3}\s/.test(s) ? s.slice(0, 3) : "");
      return m && n && m[1] === n[1] && day(sa) === day(sb) ? sa.slice(0, m.index) + "–" + sb : sa + "–" + sb;
    }
    /**
     * What the est. row of the card says, from the plan and the fresh forecast (null: nothing to say). Estimates only:
     *   { kind: "est" | "insufficient", lines: [[string | { b: string }]], arcs: { fiveHour, sevenDay } }
     * arcs.<window> is true when the forecast says that window reaches 100% before its reset (the ring then draws the dashed est. arc).
     * Windows whose forecast was fitted to another reset, or that are full already, say nothing.
     */
    function planEstimate(plan, fc) {
      const wins = fc && fc.plan && fc.plan.windows ? fc.plan.windows : null;
      if (!plan || plan.mode !== "plan" || !wins) return null;
      const items = [];
      for (const [key, name] of [["fiveHour", "5-hour"], ["sevenDay", "Weekly"]]) {
        const win = plan[key], w = wins[key];
        if (!win || typeof win.percent !== "number" || !w) continue;
        if (w.status === "insufficient" || w.status === "none") { items.push({ key, name, st: "insufficient" }); continue; }
        if (w.status !== "limit" && w.status !== "no-limit") continue;
        if (!win.resetsAt || typeof w.resetsAt !== "string" || !(Math.abs(Date.parse(win.resetsAt) - Date.parse(w.resetsAt)) <= 60000)) continue;
        items.push({ key, name, st: w.status, w });
      }
      const arcs = { fiveHour: false, sevenDay: false };
      const usable = items.filter((x) => x.st !== "insufficient");
      if (!usable.length) return items.length ? { kind: "insufficient", lines: [["Not enough readings yet"]], arcs } : null;
      usable.forEach((x) => { if (x.st === "limit") arcs[x.key] = true; });
      if (usable.every((x) => x.st === "no-limit") && !usable.some((x) => x.w.mayReach === true)) {
        return { kind: "est", arcs, lines: [[usable.length === 2 ? "At this pace neither window fills before its reset." : "At this pace the " + usable[0].name.toLowerCase() + " window does not fill before its reset."]] };
      }
      const lines = usable.map((x) => {
        if (x.st === "limit") {
          if (typeof x.w.limitAt !== "number" || typeof x.w.earliestAt !== "number") { arcs[x.key] = false; return [x.name + " may fill before its reset."]; }
          const range = typeof x.w.latestAt === "number" ? "range " + fmtClockRange(x.w.earliestAt, x.w.latestAt) : "range from " + fmtReset(new Date(x.w.earliestAt).toISOString());
          return [x.name + " fills around ", { b: fmtReset(new Date(x.w.limitAt).toISOString()) }, " (" + range + "), before its reset."];
        }
        return [x.name + (x.w.mayReach === true ? " probably stays" : " stays") + " under 100% until its reset."];
      });
      return { kind: "est", arcs, lines };
    }
    /** "Plan usage unavailable (429). Last reading 12 min ago." The reading time comes from the forecast's plan history (null: left out). */
    function planUnavailableLine(plan, fc) {
      const at = fc && fc.plan && typeof fc.plan.lastReadingAt === "number" ? fc.plan.lastReadingAt : null;
      const mins = at === null ? null : Math.max(1, Math.round((Date.now() - at) / 60000));
      return "Plan usage unavailable (" + (plan && plan.httpStatus != null ? plan.httpStatus : "?") + ")." + (mins === null ? "" : " Last reading " + mins + " min ago.");
    }
    /** The line under the plan-stop switch: what happens past a full window. Never repeats a gauge. */
    function planFooter(plan, stop) {
      if (stop === true) {
        const x = exhaustedWindow(plan);
        if (x) return "Your " + x.label + " is full. DSH refuses " + (x.model ? x.model + " requests" : "Claude requests") + " until it resets" + (x.resetsAt ? " (" + fmtReset(x.resetsAt) + ")" : "") + ".";
        return "DSH refuses Claude requests in a full window until it resets." + (plan.extraKnown && plan.extraEnabled ? " Extra usage stays on for the account, but DSH will not draw on it." : "");
      }
      if (!plan.extraKnown) return "Whether Anthropic bills or refuses requests past a full window depends on your account's extra-usage setting, which was not reported.";
      return plan.extraEnabled
        ? "Extra usage is on for this account: past a full window, requests bill to your Anthropic balance."
        : "Extra usage is off for this account: Anthropic refuses requests once a window is full.";
    }

    function PlanRing(props) {
      const sz = props.size === "sm" || props.size === "xs" ? props.size : "lg";
      const g = PLAN_RING[sz], c = g.box / 2;
      const p = Math.max(0, Math.min(100, props.percent));
      const state = props.grey ? "grey" : planRingState(p);
      const est = props.est && !props.grey ? estArc(g.box, g.r, g.stroke, p) : null;
      const arc = { cx: c, cy: c, r: g.r, fill: "none", strokeWidth: g.stroke };
      return hs("div", { className: "dshMh-pr is-" + sz, children: [
        hs("svg", { className: "dshMh-pr-svg", width: g.box, height: g.box, viewBox: "0 0 " + g.box + " " + g.box, role: "img", "aria-label": props.label, focusable: "false", children: [
          h("circle", { key: "h", className: "dshMh-pr-halo", cx: c, cy: c, r: c }),
          h("circle", { key: "t", className: "dshMh-pr-track", ...arc }),
          est ? h("path", { key: "e", className: "dshMh-pr-est", d: est.d, fill: "none", strokeWidth: g.stroke, strokeDasharray: est.dash }) : null,
          // 100%: a closed ring (a dash as long as the circle would still show its round caps); nothing used: no arc at all
          p >= 100 ? h("circle", { key: "a", className: "dshMh-pr-arc is-" + state, ...arc })
            : p > 0 ? h("circle", { key: "a", className: "dshMh-pr-arc is-" + state, ...arc, strokeLinecap: "round", strokeDasharray: ringDash(g.r, p), transform: "rotate(-90 " + c + " " + c + ")" }) : null,
        ] }),
        hs("div", { className: "dshMh-pr-center", "aria-hidden": "true", children: [
          h("span", { className: "dshMh-pr-v is-" + state, children: Math.round(p) + "%" }),
          sz === "lg" ? h("span", { className: "dshMh-pr-u", children: "used" }) : null,
        ] }),
        est ? h("span", { className: "dshMh-tag is-est dshMh-pr-esttag", "aria-hidden": "true", children: "est." }) : null,
      ] });
    }
    function planRingsRow(list, est, grey, key) {
      const cols = list.map((x) => (x.size === "sm" ? "148px" : "176px")).join(" ");
      return hs("div", { key, className: "dshMh-pc-rings", style: { gridTemplateColumns: cols }, "data-testid": "model-hub-rings", children: [
        list.map((x) => h("div", { key: "r:" + x.key, className: "dshMh-pc-cell", children: h(PlanRing, {
          size: x.size, percent: x.win.percent, grey, est: !!(est && est.arcs[x.key]),
          label: x.idle ? x.aria + ": not started, it opens with the next Claude message"
            : x.aria + ": " + x.win.percent + "% used" + (x.win.resetsAt ? ", resets " + fmtReset(x.win.resetsAt) : "") + (grey ? " (last reading)" : "") + (est && est.arcs[x.key] ? ". Estimate: fills before the reset" : ""),
        }) })),
        list.map((x) => hs("div", { key: "c:" + x.key, className: "dshMh-pc-cap", children: [
          h("span", { className: "dshMh-pc-captitle", children: x.title }),
          x.idle ? h("span", { className: "dshMh-pc-capsub", children: "not started" })
            : x.win.resetsAt ? h("span", { className: "dshMh-pc-capsub", children: "resets " + fmtReset(x.win.resetsAt) }) : null,
        ] })),
      ] });
    }
    const segs = (list) => list.map((s, i) => (typeof s === "string" ? s : h("b", { key: i, className: "dshMh-pc-b", children: s.b })));

    /** The plan-stop row: the label, one line of what happens past a full window, and the switch (a real role=switch button). */
    function PlanStopSwitch(props) {
      const uid = typeof react.useId === "function" ? react.useId() : "x";
      const labelId = "dshMh-stoplabel-" + String(uid).replace(/[^A-Za-z0-9_-]/g, "");
      const on = props.stop === true;
      return hs("div", { className: "dshMh-pc-stop", "data-testid": "model-hub-plan-stop", children: [
        hs("div", { className: "dshMh-pc-stoptext", children: [
          h("span", { id: labelId, className: "dshMh-pc-stoplabel", children: "Stop Claude requests at 100% of a plan window" }),
          props.description ? h("span", { className: "dshMh-pc-quiet", children: props.description }) : null,
          props.error ? h("span", { className: "dshMh-err", role: "alert", children: props.error }) : null,
        ] }),
        h("button", { type: "button", role: "switch", "aria-checked": on ? "true" : "false", "aria-labelledby": labelId, className: "dshMh-switch" + (on ? " is-on" : ""), disabled: !!props.unavailable, "aria-busy": props.busy ? "true" : undefined, onClick: () => { if (!props.busy) props.onToggle(!on); }, children: h("span", { className: "dshMh-switch-knob", "aria-hidden": "true" }) }),
      ] });
    }
    function PlanCard() {
      const { st, reload } = useStatus();
      const fc = freshForecast(usePoll("/forecast", 15000));
      const [busy, setBusy] = react.useState(false);
      const [saveErr, setSaveErr] = react.useState("");
      const stop = st.caps && st.caps.stopAtPlanLimit === true;
      const onToggle = (next) => savePlanStop(next, postJson, { busy: setBusy, error: setSaveErr, reload });
      // a demo hub refuses every change (POST 409), so the demo card shows no switch
      const control = st.demo ? null : h(PlanStopSwitch, { stop, busy, unavailable: !st.caps, error: saveErr, onToggle, description: st.plan && (st.plan.mode === "plan" || st.plan.mode === "unavailable") ? planFooter(st.plan, stop) : "" });
      return planCardBody(st, stop, control, fc);
    }
    const ASTERISK = h("svg", { className: "dshMh-ico", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": "true", focusable: "false", children: h("path", { d: "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" }) });
    /** The card's element tree from the /status view, the stop control and the fresh forecast (pure, unit-tested).
     *  Not signed in / expired / API key: the title and one line, no rings, no switch. */
    function planCardBody(st, stop, control, fc) {
      const plan = st.plan || { mode: "signed-out" };
      const live = plan.mode === "plan" || plan.mode === "unavailable";
      const unavailable = plan.mode === "unavailable";
      const windows = live ? planWindows(plan) : [];
      const est = plan.mode === "plan" ? planEstimate(plan, fc) : null;
      const pill = plan.mode === "plan" ? h(Pill, { tone: "accent", children: "Subscription" }) : unavailable ? h(Pill, { tone: "outline", children: "Subscription" })
        : plan.mode === "api" ? h(Pill, { tone: "outline", children: "API key" }) : plan.mode === "expired" ? h(Pill, { tone: "bad", children: "Expired" }) : null;
      const oneLine = plan.mode === "expired" ? "The Claude sign-in expired. Sign in again under Model hub → Accounts."
        : plan.mode === "api" ? "Requests use an Anthropic API key and are billed per token." : "Not signed in. Use Model hub → Accounts below to sign in.";
      const counts = live && typeof plan.messages === "number" && typeof plan.modelCalls === "number";
      const tag = (kind, text) => h("span", { className: "dshMh-tag " + kind, children: text });
      const facts = [];
      if (unavailable) facts.push([tag("is-solid", "Usage"), h("span", { className: "dshMh-pc-warnline", children: planUnavailableLine(plan, fc) })]);
      else if (est) facts.push([tag("is-est", "est."), h("span", { className: "dshMh-pc-estlines", children: est.lines.map((l, i) => h("span", { key: i, children: segs(l) })) })]);
      if (windows.length) facts.push([tag("is-solid", "Rings"), h("span", { children: "Every Claude app on this account." })]);
      if (counts) facts.push([tag("is-solid", "DSH"), hs("span", { children: [h("b", { className: "dshMh-pc-b", children: plan.messages }), " " + (plan.messages === 1 ? "message" : "messages") + " · ", h("b", { className: "dshMh-pc-b", children: plan.modelCalls }), " " + (plan.modelCalls === 1 ? "model call" : "model calls") + " in this 5-hour window."] })]);
      return hs("section", { className: "dshMh-plancard", "aria-label": "Claude plan usage", children: [
        st.demo ? h(DemoBanner, {}) : null,
        hs("div", { className: "dshMh-pc-head", children: [
          hs("div", { className: "dshMh-pc-titles", children: [
            hs("div", { className: "dshMh-pc-title", children: [ASTERISK, h("span", { children: "Claude plan usage" })] }),
            live ? h("span", { className: "dshMh-pc-quiet", title: "The Claude account DSH is signed in with", "data-testid": "model-hub-identity", children: identityLine(st.identity) }) : null,
          ] }),
          pill,
        ] }),
        live ? null : h("div", { className: "dshMh-pc-one" + (plan.mode === "expired" ? " is-bad" : ""), "data-testid": "model-hub-planlines", children: oneLine }),
        windows.length ? ringRows(windows).map((row, i) => planRingsRow(row, est, unavailable, "rows" + i)) : null,
        facts.length ? h("div", { className: "dshMh-pc-facts", "data-testid": "model-hub-planlines", children: facts.map((f, i) => hs("div", { key: i, className: "dshMh-pc-fact", children: f })) }) : null,
        live && !st.demo && control ? control : null,
      ] });
    }
    function Card(props) {
      if (!props || !props.provider || props.provider.provider !== "anthropic") return null;
      return h(PlanCard, {});
    }

    let pluginCtx = null;

    // ---------------- dock chip (conversation composer) ----------------
    /**
     * The chip as plain data (unit-tested): three segments (Claude 5-hour window, DSH spend today against the daily cap, prompt cache on
     * the last step), one segment per plan with credits, the DEMO flag and the accessible label of the whole button. Every segment has
     * its words (text), its tone (ok | warn | danger | quiet) and what its mini ring draws.
     */
    function chipModel(plan, spend, cache, identity, stop, demo, fc) {
      let claude;
      if (plan && plan.mode === "expired") claude = { kind: "expired", text: "Sign-in expired", tone: "danger", bar: null, summary: "Claude plan usage: sign-in expired", sentence: "Claude sign-in expired." };
      else if (!plan || plan.mode === "signed-out") claude = { kind: "signedout", text: "Signed out", tone: "quiet", bar: null, summary: "Claude plan usage: not signed in", sentence: "Claude: not signed in." };
      else if (plan.mode === "api") claude = { kind: "api", text: "API key", tone: "ok", bar: null, summary: "Claude plan usage: API key (billed per token)", sentence: "Claude on an API key, billed per token." };
      else {
        const five = plan.fiveHour && typeof plan.fiveHour.percent === "number" ? plan.fiveHour.percent : null;
        const week = plan.sevenDay && typeof plan.sevenDay.percent === "number" ? plan.sevenDay.percent : null;
        const grey = plan.mode === "unavailable";
        const state = five === null ? "ok" : five >= 100 ? "danger" : five >= 80 ? "warn" : "ok";
        claude = {
          kind: "ring", grey, text: five === null ? "—" : five + "%", tone: grey ? "quiet" : state, bar: five,
          summary: grey ? "Claude plan usage: unavailable (" + (plan.httpStatus ?? "?") + ")" : "Claude plan usage: 5-hour window " + (five === null ? "—" : five + "%") + ", weekly " + (week === null ? "—" : week + "%"),
          sentence: grey ? "Claude plan usage unavailable" + (five === null ? "." : ", last reading " + five + "%.")
            : five === null ? "Claude 5-hour window: no reading." : five >= 100 ? "Claude 5-hour window full." : "Claude 5-hour window " + five + "% used" + (state === "warn" ? ", warning." : "."),
        };
      }
      claude.lines = planCardLines(plan, identity, stop === true, fc);
      const caps = spend && spend.caps;
      const partial = !!(spend && spend.complete === false);
      const ext = spend && spend.external && spend.external.totals ? spend.external.totals : null;
      const action = caps ? caps.action : null;
      const todayUsd = caps ? caps.todayUsd : spend && spend.totals ? spend.totals.usd : null;
      const cap = caps && caps.limits ? caps.limits.dailyUsd : 0;
      const fcSpendLine = fc && fc.spend ? forecastSpendLine(fc.spend) : null;
      const money = todayUsd === null || todayUsd === undefined ? "—" : (partial ? "≥" : "") + usd(todayUsd);
      const tstate = action === "block" ? "over" : action === "warn" || partial ? "warn" : "ok";
      const today = {
        text: action === "block" ? "Cap reached" : money,
        tone: action === "block" ? "danger" : action === "warn" || partial ? "warn" : "ok",
        ring: cap > 0 ? tstate : null,
        pct: cap && typeof todayUsd === "number" ? Math.min(100, (todayUsd / cap) * 100) : 0,
        ringLabel: action === "block" ? "DSH spend today: daily cap reached" : cap ? "DSH spend today: " + usd(todayUsd || 0) + " of the " + usd(cap) + " daily cap" : "DSH spend today: no daily cap",
        sentence: action === "block" ? "Daily cap reached." : cap > 0 ? "Charged today " + money + " of the " + usd(cap) + " daily cap" + (tstate === "warn" ? ", warning." : ".") : "Charged today " + money + ", no daily cap.",
        title: (spend && spend.totals ? "DSH today: " + usd(spend.totals.usd || 0) + " charged · " + num(spend.totals.calls || 0) + " calls. " : "")
          + (ext ? "Outside DSH (extra ledger, not capped): " + usd(ext.usd || 0) + " · " + num(ext.calls || 0) + " calls. " : "")
          + (caps ? "Caps: " + caps.reason + "." : "Model hub host API not reachable.")
          + (fcSpendLine ? " Estimate, not a limit: " + fcSpendLine.text : ""),
      };
      const latest = cache && cache.latest;
      const hit = latest && latest.steps > 1 && typeof latest.lastHit === "number" ? latest.lastHit : null;
      const cacheSeg = {
        text: hit === null ? "—" : pct(hit),
        tone: hit !== null && hit < 0.05 ? "warn" : hit === null ? "quiet" : "ok",
        sentence: hit === null ? "Prompt cache: no reading yet." : hit < 0.05 ? "Prompt cache dropped to " + pct(hit) + " on the last step." : "Prompt cache " + pct(hit) + (demo ? "." : " on the last step."),
        title: latest && latest.steps > 1 ? "Prompt-cache hit on the last step (token-weighted session average " + pct(latest.avgHit) + ")." : "The cache can only hit from the second step of a session.",
      };
      // one segment per plan (config.json plans): API value used of the included credits this cycle
      const plans = (spend && Array.isArray(spend.plans) ? spend.plans : []).map((p) => {
        const used = (p.usedUsd || 0) + (p.overageUsd || 0);
        const pctUsed = p.includedUsd > 0 ? Math.min(100, (used / p.includedUsd) * 100) : (used > 0 ? 100 : 0);
        return { key: p.provider, name: cap1(p.provider), text: Math.round(pctUsed) + "%", pct: pctUsed, ring: pctUsed >= 100 ? "over" : pctUsed >= 80 ? "warn" : "ok",
          title: cap1(p.provider) + " " + p.name + ": " + usd(used) + " of " + usd(p.includedUsd) + " plan credits, resets " + (p.resetsAt ? String(p.resetsAt).slice(0, 10) : "?") + "." };
      });
      const label = (demo ? DEMO_TEXT + ". " : "") + [claude.sentence, today.sentence, cacheSeg.sentence].concat(plans.map((p) => p.title)).join(" ");
      return { claude, today, cache: cacheSeg, plans, demo: Boolean(demo), label };
    }

    const CACHE_REASON = {
      "model-changed": "the model changed",
      "system-prompt-changed": "the system prompt changed",
      "tools-changed": "the tool list changed",
      compaction: "the conversation was compacted",
      unknown: "the provider cache probably expired",
    };

    // ---- the popover of the chip: the plan card's content, compact (header, two rings, model windows, est./stop rows) and the day's spend ----
    const PLAN_ONE_LINE = {
      "signed-out": "Not signed in. Use Model hub → Accounts to sign in.",
      expired: "The Claude sign-in expired. Sign in again under Model hub → Accounts.",
      api: "Requests use an Anthropic API key and are billed per token.",
    };
    const PLAN_PILL = (plan) => (plan.mode === "plan" ? h(Pill, { tone: "accent", children: "Subscription" }) : plan.mode === "unavailable" ? h(Pill, { tone: "outline", children: "Subscription" })
      : plan.mode === "api" ? h(Pill, { tone: "outline", children: "API key" }) : plan.mode === "expired" ? h(Pill, { tone: "bad", children: "Expired" }) : null);
    /** The est. row of "Charged today": the 15-minute pace and when it reaches the daily cap (null: no estimate). Pure. */
    function spendEstimate(fcSpend) {
      if (!forecastSpendLine(fcSpend)) return null;
      const rate = fcSpend.charged.ratePerHour.m15;
      const daily = (Array.isArray(fcSpend.caps) ? fcSpend.caps : []).find((e) => e.which === "daily");
      const at = daily && daily.state === "at-pace" && typeof daily.reachedAt === "number" ? daily.reachedAt : null;
      return { rate: usdRate(rate), at, atText: at === null ? null : fmtReset(new Date(at).toISOString()), notAtPace: !!daily && daily.state === "not-at-this-pace" };
    }
    /** What the popover shows (pure): the plan's windows, the est. lines of the windows that fill, the stop/extra sentence and the day's spend. */
    function popoverModel(props) {
      const plan = props.plan || { mode: "signed-out" };
      const live = plan.mode === "plan" || plan.mode === "unavailable";
      const wins = live ? planWindows(plan) : [];
      const est = plan.mode === "plan" ? planEstimate(plan, props.fc) : null;
      const flat = (l) => l.map((x) => (typeof x === "string" ? x : x.b)).join("");
      // one visual line per sentence part: "5-hour fills around 4:10 PM, before its reset" / "(range 3:55–4:30 PM)."
      const fills = [];
      if (est && est.kind === "est") {
        for (const l of est.lines) {
          if (!/fills around|may fill before/.test(flat(l))) continue;
          const last = l[l.length - 1];
          const m = typeof last === "string" ? /^ \((range [^)]*)\), before its reset\.$/.exec(last) : null;
          if (m) fills.push(l.slice(0, -1).concat([", before its reset"]), ["(" + m[1] + ")."]);
          else fills.push(l);
        }
      }
      let stopRow = null;
      if (live) {
        stopRow = props.stop === true
          ? { tag: "Stop", text: exhaustedWindow(plan) ? planFooter(plan, true) : "On: DSH refuses Claude requests in a full window." }
          : { tag: "Extra", text: planFooter(plan, false) };
      }
      const sp = props.spend;
      const caps = sp && sp.caps;
      const cap = caps && caps.limits ? caps.limits.dailyUsd : 0;
      const usedUsd = caps ? caps.todayUsd : sp && sp.totals ? sp.totals.usd : null;
      const today = typeof usedUsd === "number" ? { usd: usedUsd, cap: cap > 0 ? cap : 0, frac: cap > 0 ? usedUsd / cap : 0, action: caps ? caps.action : null, partial: !!(sp && sp.complete === false), est: cap > 0 && props.fc && props.fc.spend ? spendEstimate(props.fc.spend) : null } : null;
      return { plan, live, grey: plan.mode === "unavailable", wins, big: wins.filter((x) => x.size === "lg"), small: wins.filter((x) => x.size !== "lg"), est, fills, stopRow, today,
        // the row's tag already says "Usage"; "12 min ago" is bound with no-break spaces so a narrow popover never strands "ago"
        unavailable: plan.mode === "unavailable" ? "Unavailable (" + (plan.httpStatus != null ? plan.httpStatus : "?") + ")" + (props.fc && props.fc.plan && typeof props.fc.plan.lastReadingAt === "number" ? " · last reading " + Math.max(1, Math.round((Date.now() - props.fc.plan.lastReadingAt) / 60000)) + "\u00a0min\u00a0ago" : "") : null,
        oneLine: live ? null : PLAN_ONE_LINE[plan.mode] || PLAN_ONE_LINE["signed-out"] };
    }
    /** The hover/focus popover, fixed above the chip. Called as a function (no hooks); text children only. */
    function PlanPopover(props) {
      const vw = (typeof document !== "undefined" && document.documentElement && document.documentElement.clientWidth) || 1024;
      const vh = (typeof document !== "undefined" && document.documentElement && document.documentElement.clientHeight) || 768;
      const a = props.anchor;
      const left = Math.max(8, Math.min(Math.round(a.left), vw - 8 - Math.min(380, vw - 16)));
      const bottom = Math.max(8, Math.round(vh - a.top + 8));
      const m = popoverModel(props);
      const t = m.today;
      const pctRound = (x) => Math.round(x.win.percent);
      return hs("div", { className: "dshMh-pop", role: "tooltip", "aria-hidden": "true", "data-testid": "model-hub-pop", style: { position: "fixed", left, bottom }, children: [
        props.demo ? h(DemoBanner, { key: "demo" }) : null,
        hs("div", { key: "head", className: "dshMh-pc-head", children: [
          hs("div", { className: "dshMh-pc-titles", children: [
            hs("div", { className: "dshMh-pc-title", children: [ASTERISK, h("span", { children: "Claude plan usage" })] }),
            m.live ? h("span", { className: "dshMh-pc-quiet", children: identityLine(props.identity) }) : null,
          ] }),
          PLAN_PILL(m.plan),
        ] }),
        m.live ? hs("div", { key: "rings", className: "dshMh-pop-rings", children: m.big.map((x) => hs("div", { key: x.key, className: "dshMh-pop-ring", children: [
          h(PlanRing, { size: "xs", percent: x.win.percent, grey: m.grey, est: !!(m.est && m.est.arcs[x.key]), label: x.idle ? x.aria + ": not started" : x.aria + ": " + pctRound(x) + "% used" + (x.win.resetsAt ? ", resets " + fmtReset(x.win.resetsAt) : "") }),
          hs("span", { className: "dshMh-pc-cap", children: [h("span", { className: "dshMh-pc-captitle", children: x.title }), x.idle ? h("span", { className: "dshMh-pc-capsub", children: "not started" }) : x.win.resetsAt ? h("span", { className: "dshMh-pc-capsub", children: "resets " + fmtReset(x.win.resetsAt) }) : null] }),
        ] })) }) : h("div", { key: "one", className: "dshMh-pc-one" + (m.plan.mode === "expired" ? " is-bad" : ""), children: m.oneLine }),
        m.small.length ? h("div", { key: "models", className: "dshMh-pop-models", children: m.small.map((x) => hs("div", { key: x.key, className: "dshMh-pop-model", children: [
          h(Ring, { size: 20, r: 7.5, stroke: 3, pct: x.win.percent, state: m.grey ? "grey" : planRingState(x.win.percent) === "full" ? "over" : planRingState(x.win.percent), decorative: true }),
          h("span", { className: "dshMh-pc-captitle", children: x.title }),
          x.win.resetsAt ? h("span", { className: "dshMh-pc-capsub", children: "resets " + fmtReset(x.win.resetsAt) }) : null,
          h("span", { className: "dshMh-pop-grow" }),
          // a last reading (usage unavailable) is dimmed like the rings above it
          h("span", { className: "dshMh-pc-captitle" + (m.grey ? " is-stale" : ""), children: pctRound(x) + "%" }),
        ] })) }) : null,
        m.unavailable || m.fills.length || m.stopRow ? hs("div", { key: "facts", className: "dshMh-pop-facts", children: [
          m.unavailable ? [h("span", { key: "ut", className: "dshMh-tag is-solid", children: "Usage" }), h("span", { key: "uv", className: "dshMh-pc-warnline", children: m.unavailable })] : null,
          m.fills.length ? [h("span", { key: "et", className: "dshMh-tag is-est", children: "est." }), h("span", { key: "ev", className: "dshMh-pc-estlines", children: m.fills.map((l, i) => h("span", { key: i, children: segs(l) })) })] : null,
          m.stopRow ? [h("span", { key: "st", className: "dshMh-tag is-solid", children: m.stopRow.tag }), h("span", { key: "sv", children: m.stopRow.text })] : null,
        ] }) : null,
        t ? hs("div", { key: "today", className: "dshMh-pop-today", children: [
          hs("div", { className: "dshMh-pop-todayrow", children: [h("span", { children: "Charged today" }), t.cap > 0 ? hs("span", { children: [h("b", { className: "dshMh-pc-b", children: (t.partial ? "≥" : "") + usd(t.usd) }), h("span", { className: "dshMh-pop-of", children: " of " + usd(t.cap) })] }) : hs("span", { children: [h("b", { className: "dshMh-pc-b", children: (t.partial ? "≥" : "") + usd(t.usd) }), h("span", { className: "dshMh-pop-of", children: " · no daily cap" })] })] }),
          t.cap > 0 ? h(CapRunway, { wide: true, tone: t.action === "block" ? "danger" : t.action === "warn" ? "warn" : "accent", frac: t.action === "block" ? 1 : t.frac, estToCap: !!(t.est && t.est.at), pid: "dshMh-pop-hatch", label: "Daily cap: " + usd(t.usd) + " charged today of " + usd(t.cap) + ", " + Math.round(Math.min(100, t.frac * 100)) + "%." + (t.est ? " Estimate: " + t.est.rate + " an hour" + (t.est.atText ? ", reaches the cap around " + t.est.atText : "") : "") }) : null,
          t.est ? hs("div", { className: "dshMh-pop-estrow", children: [h("span", { className: "dshMh-tag is-est", children: "est." }), hs("span", { children: [h("b", { className: "dshMh-pc-b", children: t.est.rate }), " an hour", t.est.atText ? " · reaches the cap around " : t.est.notAtPace ? " · the cap is not reached at this pace" : "", t.est.atText ? h("b", { className: "dshMh-pc-b", children: t.est.atText }) : null] })] }) : null,
        ] }) : null,
      ] });
    }
    // the mini rings and marks of the chip's Claude segment (all decorative: the button carries the label)
    const CHIP_TRACK = h("circle", { key: "t", className: "dshMh-ring-track", cx: 8, cy: 8, r: 6, fill: "none", strokeWidth: 2.5 });
    const chipSvg = (kids) => h("svg", { className: "dshMh-ring", width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false", children: kids });
    const CHIP_ICON = {
      signedout: () => chipSvg([CHIP_TRACK, h("path", { key: "p", className: "dshMh-chip-ico", d: "M4.4 11.6L11.6 4.4", fill: "none", strokeWidth: 1.6, strokeLinecap: "round" })]),
      expired: () => chipSvg([h("circle", { key: "c", className: "dshMh-chip-bad", cx: 8, cy: 8, r: 6.4, fill: "none", strokeWidth: 1.6 }), h("path", { key: "p", className: "dshMh-chip-bad", d: "M8 4.6v4.2", fill: "none", strokeWidth: 1.8, strokeLinecap: "round" }), h("circle", { key: "d", className: "dshMh-chip-badfill", cx: 8, cy: 11.3, r: 1 })]),
      api: () => chipSvg([h("circle", { key: "c", className: "dshMh-chip-ico", cx: 5.4, cy: 10.6, r: 3, fill: "none", strokeWidth: 1.6 }), h("path", { key: "p", className: "dshMh-chip-ico", d: "M7.6 8.4l5.6-5.6M10.6 5.4l1.9 1.9M12.4 3.6l1.5 1.5", fill: "none", strokeWidth: 1.6, strokeLinecap: "round" })]),
    };
    const chipRing = (pctV, state) => h(Ring, { size: 16, r: 6, stroke: 2.5, pct: pctV, state, decorative: true });
    function DockChip(props) {
      const m = chipModel(props.plan, props.spend, props.cache, props.identity, props.stop === true, props.demo, props.forecast);
      const [anchor, setAnchor] = react.useState(null);
      const show = (e) => { const el = e && e.currentTarget; if (el && el.getBoundingClientRect) { const r = el.getBoundingClientRect(); setAnchor({ left: r.left, top: r.top, width: r.width, height: r.height }); } };
      const hide = () => setAnchor(null);
      react.useEffect(() => {
        if (!anchor) return undefined;
        const onKey = (e) => { if (e.key === "Escape") setAnchor(null); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [!!anchor]);
      const c = m.claude;
      const claudeMark = c.kind === "ring" ? (c.bar !== null ? chipRing(c.bar, c.grey ? "grey" : c.tone === "danger" ? "over" : c.tone) : chipSvg([CHIP_TRACK])) : c.kind === "signedout" || c.kind === "expired" || c.kind === "api" ? CHIP_ICON[c.kind]() : null;
      const seg = (key, tone, kids, extra) => hs("span", { key, className: "dshMh-chipseg is-" + tone + (extra ? " " + extra : ""), children: kids });
      const div = (k) => h("span", { key: "d" + k, className: "dshMh-chip-div", "aria-hidden": "true" });
      const tipLines = (m.demo ? [DEMO_TEXT] : []).concat(m.claude.lines);
      const t = m.today;
      return hs("div", { className: "dshAmPlan-chip", children: [
        hs("button", {
          type: "button", className: "dshMh-chip" + (props.spend ? "" : " is-dim"), "data-testid": "model-hub-chip", "aria-expanded": anchor ? "true" : "false", "aria-label": m.label, "aria-describedby": "dshMh-claude-tip",
          onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide, onKeyDown: (e) => { if (e.key === "Escape") hide(); },
          children: [
            m.demo ? h("span", { key: "demo", className: "dshMh-chip-demo", children: "DEMO" }) : null,
            seg("claude", c.tone, [claudeMark, h("span", { key: "k", className: "dshMh-chipk", children: c.kind === "ring" ? "5h" : "Claude" }), h("b", { key: "v", children: c.text })]),
            seg("today", t.tone, [div("t"), t.ring ? h(Ring, { key: "r", size: 16, r: 6, stroke: 2.5, pct: t.pct, state: t.ring, decorative: true }) : null, h("span", { key: "k", className: "dshMh-chipk", children: "Today" }), h("b", { key: "v", children: t.text })]),
            m.plans.map((p) => seg("p:" + p.key, p.ring === "ok" ? "ok" : p.ring === "warn" ? "warn" : "danger", [div("p" + p.key), h(Ring, { key: "r", size: 16, r: 6, stroke: 2.5, pct: p.pct, state: p.ring, decorative: true }), h("span", { key: "k", className: "dshMh-chipk", children: p.name }), h("b", { key: "v", children: p.text })])),
            seg("cache", m.cache.tone, [div("c"), h("span", { key: "k", className: "dshMh-chipk", children: "Cache" }), h("b", { key: "v", children: m.cache.text })]),
          ],
        }),
        h("span", { id: "dshMh-claude-tip", className: "dshMh-sr", children: tipLines.map((l, i) => h("div", { key: i, children: isForecastLine(l) ? l + " (estimate)" : l })) }),
        anchor ? reactDom.createPortal(PlanPopover({ plan: props.plan, spend: props.spend, identity: props.identity, stop: props.stop === true, demo: m.demo, fc: props.forecast, anchor }), document.body) : null,
      ] });
    }

    function DockWidget() {
      const { st } = useStatus();
      const sp = usePoll("/spend?since=today&by=provider", 8000);
      const ca = usePoll("/cache", 4000);
      const fc = freshForecast(usePoll("/forecast", 15000));
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
      if (!dockVisible(st.plan, sp.data, ca.data) && !otherInstance(st.webOrigin)) return null;
      return hs("div", {
        className: "dshAmPlan-wrap",
        children: [
          h("span", { className: "dshAmPlan-logo", title: "DeepSeek Harness", children: h(FishLogo, { size: 18 }) }),
          h(DockChip, { plan: st.plan, spend: sp.data, cache: ca.data, identity: st.identity, stop: st.caps && st.caps.stopAtPlanLimit === true, demo: st.demo, forecast: fc }),
          otherInstance(st.webOrigin) ? h(Pill, { tone: "warn", title: OTHER_INSTANCE(st.webOrigin), children: "other DSH's hub" }) : null,
          toast ? hs("div", { className: "dshMh-toast", role: "alert", "data-testid": "cache-toast", children: [
            h("b", { children: "Prompt cache dropped" }),
            "Hit rate fell from " + pct(toast.prev) + " to " + pct(toast.hit) + ": " + (CACHE_REASON[toast.reason] || toast.reason) + ". The next request is billed at the full input price.",
          ] }) : null,
        ],
      });
    }

    // ---------------- per-turn cost line (conversation.chat.turnTail) ----------------
    // One quiet line under every finished turn, from GET /spend/turns. Everything is a text child: ids, model names and
    // numbers come from the ledger and are never interpreted as markup.
    const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
    // pinned copy of lib/cost/money.mjs fmtUsdSmall (the client cannot import modules; lib/cost/money.test.mjs checks they agree)
    const fmtUsdSmall = (n) => (!(n > 0) ? "$0.00" : n < 0.0001 ? "<$0.0001" : "$" + n.toFixed(n >= 1 ? 2 : 4));
    // the turn line and its detail use the Cost tab's money rule: four decimals under 25 cents, whole cents from there ($0.0066, $0.1248, $0.40)
    const fmtMoney = (n) => (n >= 0.25 ? "$" + n.toFixed(2) : fmtUsdSmall(n));
    const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
    const callsText = (n) => n + (n === 1 ? " call" : " calls");
    const BILLING_WORD = { metered: "Metered", subscription: "Subscription", credits: "Credits", local: "Local", free: "Free" };
    const billingWord = (k) => BILLING_WORD[k] || String(k).charAt(0).toUpperCase() + String(k).slice(1);
    const secText = (ms) => (ms / 1000).toFixed(1) + " s";
    /**
     * The ONE line under a finished turn, as data (pure, unit-tested):
     *   { look, head, parts: [string | { prov, model }], text, label }
     * look = the swatch (solid: charged, tint: not charged, hatch: plan credits, outline: local or free); head = "Charged $X" | "Not charged" | "Price unknown";
     * parts = billing kind(s), the API value when nothing was charged, the route (provider and model, or a route count), the calls and
     * "+ Compaction" / "+ Review" for calls that ran while the turn did. text = the visible words, label = the button's accessible name.
     */
    function turnLine(t) {
      const billings = t.billings || {};
      const unpriced = t.unpricedCalls || 0;
      const pricedMetered = (billings.metered || 0) - unpriced;
      const charged = t.usd > 0 || pricedMetered > 0;
      const kinds = Object.keys(billings).sort((a, b) => (a === "metered" ? -1 : b === "metered" ? 1 : a < b ? -1 : 1));
      const head = charged ? "Charged " + fmtMoney(t.usd) : unpriced > 0 ? "Price unknown" : "Not charged";
      const kindText = kinds.map(billingWord).concat(charged && unpriced > 0 ? ["price unknown"] : []).join(" + ");
      const look = charged ? "solid" : unpriced > 0 ? "outline" : kinds.length === 1 && kinds[0] === "credits" ? "hatch" : kinds.length === 1 && (kinds[0] === "local" || kinds[0] === "free") ? "outline" : "tint";
      const parts = [];
      if (kindText) parts.push(kindText);
      if (!charged && t.notChargedUsd > 0) parts.push("API value " + fmtMoney(t.notChargedUsd));
      const routes = t.routes || [];
      if (routes.length === 1) parts.push({ prov: routes[0].provider, model: routes[0].model });
      else if (routes.length > 1) parts.push(routes.length + " routes");
      parts.push(callsText(t.calls));
      const during = t.during || [];
      if (during.length) parts.push(during.map((d) => "+ " + (PURPOSE_LABEL[d.purpose] || cap1(String(d.purpose)))).join(" "));
      const plain = parts.map((x) => (typeof x === "string" ? x : x.prov + " / " + x.model));
      const duringWords = during.map((d) => (d.purpose === "compaction" ? "a compaction call" : d.purpose === "auto-review" ? "a review call" : d.purpose === "session-title" ? "a title call" : "a " + d.purpose + " call"));
      const labelParts = [head.charAt(0).toLowerCase() + head.slice(1)].concat(plain.slice(0, during.length ? -1 : undefined), during.length ? ["plus " + duringWords.join(" and ") + " while this turn ran"] : []);
      return { look, head, parts, text: [head].concat(plain).join(" · "), label: "Turn " + t.turn + " cost: " + labelParts.join(", ") + ". Details" };
    }
    /** The expanded detail of one turn: tokens in (with the cache split), tokens out, timing and the calls that ran during the turn. Pure. */
    function turnDetail(t) {
      const input = (t.input || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
      return {
        input, readPct: typeof t.cacheReadShare === "number" ? Math.round(t.cacheReadShare * 100) : null,
        fresh: t.input || 0, cacheRead: t.cacheRead || 0, cacheWrite: t.cacheWrite || 0, output: t.output || 0,
        ttft: typeof t.ttftMs === "number" ? secText(t.ttftMs) : null, model: typeof t.durationMs === "number" ? secText(t.durationMs) : null,
        during: (t.during || []).map((d) => ({ label: PURPOSE_LABEL[d.purpose] || cap1(String(d.purpose)), calls: d.calls, usd: d.usd, api: d.apiEquivUsd })),
      };
    }
    /** One shared poll per visible session: every TurnCost of a session reads the same entry; the interval stops with the last subscriber. */
    function createTurnsStore(opts) {
      const o = opts || {};
      const fetchJson = o.fetchJson || getJson;
      const startTimer = o.setIntervalFn || ((fn, ms) => setInterval(fn, ms));
      const stopTimer = o.clearIntervalFn || ((id) => clearInterval(id));
      const visible = o.visible || (() => typeof document === "undefined" || document.visibilityState !== "hidden");
      const ms = o.ms || 5000;
      const entries = new Map();
      const publish = (e) => { const snap = { data: e.data, error: e.error }; e.subs.forEach((cb) => { try { cb(snap); } catch (err) { /* a subscriber must not stop the others */ } }); };
      const load = (id, e) => {
        if (e.busy || !visible()) return;
        e.busy = true;
        fetchJson("/spend/turns?session=" + encodeURIComponent(id)).then(
          (data) => { e.busy = false; e.data = data; e.error = null; publish(e); },
          (err) => { e.busy = false; e.error = String((err && err.message) || err); publish(e); },
        );
      };
      return {
        subscribe(id, cb) {
          if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return () => {};
          let e = entries.get(id);
          if (!e) {
            e = { data: null, error: null, subs: new Set(), timer: null, busy: false };
            entries.set(id, e);
            e.timer = startTimer(() => load(id, e), ms);
            load(id, e);
          }
          e.subs.add(cb);
          if (e.data) cb({ data: e.data, error: e.error });
          return () => {
            e.subs.delete(cb);
            if (e.subs.size === 0) { stopTimer(e.timer); entries.delete(id); }
          };
        },
        snapshot(id) { const e = entries.get(id); return e ? { data: e.data, error: e.error } : { data: null, error: null }; },
      };
    }
    const turnsStore = createTurnsStore({});
    function useTurns(sessionId) {
      const [snap, setSnap] = react.useState({ data: null, error: null });
      react.useEffect(() => (sessionId ? turnsStore.subscribe(sessionId, setSnap) : undefined), [sessionId]);
      return snap.data;
    }
    const CHEV = (open) => h("svg", { className: "dshMh-tl-chev", width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false", children: h("path", { d: open ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6" }) });
    const sep = (k) => [" ", h("span", { key: "s" + k, "aria-hidden": "true", children: "·" }), " "];
    /** The detail card of a turn: tokens on the left, the calls that ran while it did on the right (only then). Text children only. */
    function TurnDetail(props) {
      const d = props.detail;
      const b = (x) => h("span", { className: "dshMh-td-b", children: x });
      const tag = (x) => h("span", { className: "dshMh-tag", children: x });
      return hs("div", { id: props.id, className: "dshMh-td", role: "region", "aria-label": "Turn " + props.turn + " cost details", "data-testid": "model-hub-turn-detail", children: [
        hs("div", { className: "dshMh-td-grid", children: [
          tag("In"),
          hs("span", { className: "dshMh-td-col", children: [
            hs("span", { children: [b(num(d.input)), " tokens", d.readPct === null ? null : " · ", d.readPct === null ? null : b(d.readPct + "%"), d.readPct === null ? null : " read from cache"] }),
            h("span", { children: num(d.fresh) + " new · " + num(d.cacheRead) + " cache read · " + num(d.cacheWrite) + " cache write" }),
          ] }),
          tag("Out"), hs("span", { children: [b(num(d.output)), " tokens"] }),
          d.ttft === null && d.model === null ? null : tag("Time"),
          d.ttft === null && d.model === null ? null : hs("span", { children: [d.ttft === null ? null : "First token after ", d.ttft === null ? null : b(d.ttft), d.ttft !== null && d.model !== null ? " · " : null, d.model === null ? null : "model time ", d.model === null ? null : b(d.model)] }),
        ] }),
        d.during.length ? hs("div", { className: "dshMh-td-while", children: [
          hs("table", { className: "dshMh-ctable", children: [
            h("thead", { children: hs("tr", { children: [h("th", { scope: "col", className: "dshMh-c-first", children: "While this turn ran" }), h("th", { scope: "col", className: "dshMh-c-n dshMh-c-dcalls", children: "Calls" }), h("th", { scope: "col", className: "dshMh-c-n dshMh-c-dchg", children: "Charged" }), h("th", { scope: "col", className: "dshMh-c-n dshMh-c-dchg", children: "API value" })] }) }),
            h("tbody", { children: d.during.map((x, i) => hs("tr", { key: i, children: [h("td", { children: x.label }), h("td", { className: "dshMh-c-n", children: x.calls }), h("td", { className: "dshMh-c-n is-strong", children: costMoney(x.usd) }), h("td", { className: "dshMh-c-n", children: costMoney(x.api) })] })) }),
          ] }),
          h("span", { className: "dshMh-td-note", children: "Not part of this turn's charge. Matched to it by time." }),
        ] }) : null,
      ] });
    }
    function TurnCostView(props) {
      const [open, setOpen] = react.useState(false);
      const btn = react.useRef(null);
      const turn = props.turn;
      const entry = turn && turn.status === "closed" && props.data && Array.isArray(props.data.turns) ? props.data.turns.find((x) => x.turn === turn.turn) : null;
      if (!entry) return null;
      const line = turnLine(entry);
      const id = "dshMh-turn-" + String(props.sessionId || "s").replace(/[^A-Za-z0-9_-]/g, "") + "-" + entry.turn;
      const close = () => { setOpen(false); if (btn.current && typeof btn.current.focus === "function") btn.current.focus(); };
      return hs("div", {
        className: "dshMh-turn", "data-testid": "model-hub-turn-cost",
        onKeyDown: (e) => { if (open && e.key === "Escape") { e.stopPropagation(); close(); } },
        children: [
          hs("button", { type: "button", ref: btn, className: "dshMh-tl", "aria-expanded": open ? "true" : "false", "aria-controls": id, "aria-label": line.label, onClick: () => setOpen(!open), children: [
            h(Swatch, { look: line.look }),
            h("span", { className: "dshMh-tl-text", children: [h("span", { key: "h", className: "dshMh-tl-b", children: line.head })].concat(line.parts.map((x, i) => [sep(i), typeof x === "string" ? h("span", { key: "p" + i, children: x }) : h("span", { key: "p" + i, children: [h("span", { key: "a", className: "dshMh-tl-prov", children: x.prov + " / " }), h("span", { key: "b", className: "dshMh-tl-model", children: x.model })] })])) }),
            CHEV(open),
          ] }),
          open ? h(TurnDetail, { id, turn: entry.turn, detail: turnDetail(entry) }) : null,
        ],
      });
    }
    /** The conversation.chat.turnTail entry: DSH passes {turn, seq, openFile} plus the session scope's {sessionId}. */
    function TurnCost(props) {
      const data = useTurns(props.sessionId);
      return h(TurnCostView, { turn: props.turn, data, sessionId: props.sessionId });
    }

    // ---------------- Cost tab (conversation.view): one session's receipt (design B) ----------------
    const costMoney = fmtUsdSmall;
    const callsLabel = (n) => n + (n === 1 ? " call" : " calls");
    /** The big numbers of the Cost tab: 4 decimals under 25 cents (as everywhere), whole cents from 25 cents up ($0.29, $5.15). */
    const heroUsd = (n) => (n >= 0.25 ? "$" + n.toFixed(2) : fmtUsdSmall(n));
    const stampOf = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    /** "Nov 12, 7:26 PM" | "Nov 13, 9:02 AM – 11:14 AM" | "Nov 13, 9:02 AM – Nov 14, 1:10 AM" ("" without a first call). */
    function costSpan(firstTs, lastTs) {
      if (!firstTs) return "";
      const a = stampOf(firstTs);
      if (!lastTs) return a;
      const b = stampOf(lastTs);
      if (a === b) return a;
      const d1 = new Date(firstTs), d2 = new Date(lastTs);
      return a + " – " + (d1.toDateString() === d2.toDateString() ? d2.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : b);
    }
    // how a route is drawn (its swatch in the table and its segment in the bar): solid = charged, hatched = plan credits,
    // tinted = API value that was not charged, outline = nothing to show
    const ROUTE_LOOK = { metered: "solid", credits: "hatch", subscription: "tint", free: "outline", local: "outline" };
    /**
     * The one bar of the hero: [{ key, look: "solid" | "tint" | "hatch", value, label }] in order: the charged money first, then the
     * API value that was not charged, route by route (biggest first). Segments with nothing in them are left out.
     */
    function costBarSegments(rc) {
      const out = [];
      if (rc.usd > 0) out.push({ key: "charged", look: "solid", value: rc.usd, label: "charged" });
      const routes = (rc.byRoute || []).filter((r) => r.notChargedUsd > 0).sort((a, b) => b.notChargedUsd - a.notChargedUsd);
      for (const r of routes) out.push({ key: r.provider + "/" + r.model + "|" + r.billing, look: r.billing === "credits" ? "hatch" : "tint", value: r.notChargedUsd, label: r.provider + "/" + r.model + " (" + (BILLING_LABEL[r.billing] || r.billing) + ") not charged" });
      return out;
    }
    /** The look of one route's swatch: a charged route is solid, one with only API value follows its billing, the rest is an outline. */
    function routeLook(r) {
      if (r.usd > 0 || r.billing === "metered" && r.calls > 0 && r.apiEquivUsd > 0) return "solid";
      if (r.notChargedUsd > 0) return r.billing === "credits" ? "hatch" : "tint";
      return "outline";
    }
    /** GET /spend/session payload -> everything the header and the hero say, as plain data (unit-tested). */
    function costViewModel(rc, partial) {
      const calls = rc.calls || 0;
      const empty = calls === 0 && !(rc.subagents && rc.subagents.calls > 0);
      const ge = partial === true ? "≥" : "";
      const parts = [];
      if (!empty) {
        // calls recorded before ledger v2 carry no turn: say nothing about turns rather than "0 turns"
        if (rc.turns > 0) parts.push(rc.turns + (rc.turns === 1 ? " turn" : " turns"));
        parts.push(callsLabel(calls));
        if (rc.cache && typeof rc.cache.readShare === "number") parts.push("cache read " + Math.round(rc.cache.readShare * 100) + "%");
        const span = costSpan(rc.firstTs, rc.lastTs);
        if (span) parts.push(span);
      }
      return {
        empty, partial: partial === true,
        subtitle: parts.join(" · "),
        charged: ge + heroUsd(rc.usd),
        notCharged: ge + heroUsd(rc.notChargedUsd),
        // the total under the bar says something only when part of it was charged and part was not
        total: rc.usd > 0 && rc.notChargedUsd > 0 ? ge + heroUsd(rc.apiEquivUsd) : null,
        segments: empty ? [] : costBarSegments(rc),
      };
    }
    // ---- spend-cap runways: a track with ticks at 25/50/75% and a hatched, dark end at the cap; the dot is the spend ----
    const RUN = { w: 264, x0: 6, x1: 254, y: 9.5 };
    /** frac (spent / cap, may exceed 1) -> { x, line, ticks, tone, ghost } of one runway; pure. est (the forecast as a fraction of the cap, may exceed 1) adds the dashed ghost from the dot to where the estimate ends. Ticks under the filled part are left out. dx: extra track length (the chip popover's wide runway, which has no ticks). */
    function capRunway(frac, est, warnAt, dx) {
      const f = Math.max(0, Math.min(1, typeof frac === "number" && isFinite(frac) ? frac : 0));
      const x = r2(6.5 + f * (248 + (dx || 0)));
      const r = f > 0 ? 4.5 : 4;
      const w = 248 + (dx || 0);
      const ticks = dx ? [] : [68, 130, 192].filter((t) => !(f > 0 && t < x + r + 0.5));
      let ghost = null;
      if (typeof est === "number" && isFinite(est) && est > f) {
        const gx1 = r2(x + 9), gx2 = r2(Math.min(252 + (dx || 0), 6.5 + Math.min(1, est) * w - 0.5));
        if (gx2 > gx1 + 1) ghost = { x1: gx1, x2: gx2 };
      }
      const pc = frac * 100;
      return { x, hollow: !(f > 0), r, line: f > 0 && x - 6.5 > 5 ? { x1: 6.5, x2: x } : null, ticks, ghost, tone: pc >= 100 ? "danger" : pc >= (warnAt > 0 ? warnAt : 80) ? "warn" : "accent" };
    }
    /** The cap runway. wide: the 346 px version of the chip's popover (no ticks); est: the dashed stretch from the spend to the cap (an estimate). */
    function CapRunway(props) {
      const dx = props.wide ? 82 : 0, W = RUN.w + dx;
      const g = capRunway(props.frac, props.est, props.warnAt, dx), id = props.pid;
      const tone = props.tone || g.tone;
      const stroke = tone === "danger" ? "dshMh-rw-bad" : tone === "warn" ? "dshMh-rw-warn" : "dshMh-rw-acc";
      const hatch = props.hatch !== false;
      return hs("svg", { className: "dshMh-runway", width: W, height: 22, viewBox: "0 0 " + W + " 22", role: "img", "aria-label": props.label, focusable: "false", children: [
        hatch ? h("defs", { key: "d", children: h("pattern", { id, patternUnits: "userSpaceOnUse", width: 4, height: 4, children: h("path", { className: "dshMh-rw-hatch", d: "M0 4L4 0", fill: "none", strokeWidth: 1 }) }) }) : null,
        h("line", { key: "t", className: "dshMh-rw-track", x1: RUN.x0, y1: RUN.y, x2: RUN.x1 + dx, y2: RUN.y, strokeWidth: 1 }),
        g.ticks.length ? h("path", { key: "k", className: "dshMh-rw-track", d: g.ticks.map((t) => "M" + t + " 9.5v5").join(""), fill: "none", strokeWidth: 1 }) : null,
        hatch ? h("rect", { key: "e", x: 256 + dx, y: 2, width: 6, height: 15, fill: "url(#" + id + ")" }) : null,
        h("line", { key: "c", className: "dshMh-rw-cap", x1: 255 + dx, y1: 1, x2: 255 + dx, y2: 18, strokeWidth: 2 }),
        // est (a number): the Settings ghost to where the forecast ends; estToCap (a flag): the popover's dashed stretch to the cap
        g.ghost ? h("line", { key: "g", className: "dshMh-rw-ghost", x1: g.ghost.x1, y1: RUN.y, x2: g.ghost.x2, y2: RUN.y, strokeWidth: 4, strokeDasharray: "2 4" }) : null,
        props.estToCap && g.x + 8 < 251 + dx ? h("line", { key: "s", className: "dshMh-rw-est", x1: r2(g.x + 8), y1: RUN.y, x2: 251 + dx, y2: RUN.y, strokeWidth: 3, strokeDasharray: "2.2 3.4" }) : null,
        g.line ? h("line", { key: "f", className: stroke + "-s", x1: g.line.x1, y1: RUN.y, x2: g.line.x2, y2: RUN.y, strokeWidth: 4, strokeLinecap: "round" }) : null,
        g.hollow ? h("circle", { key: "p", className: "dshMh-rw-hollow " + stroke + "-s", cx: g.x, cy: RUN.y, r: g.r, strokeWidth: 2 })
          : h("circle", { key: "p", className: "dshMh-rw-dot " + stroke + "-f", cx: g.x, cy: RUN.y, r: g.r, strokeWidth: 2 }),
      ] });
    }
    // ---- API value per turn: one bar per turn, the charged part solid; a gridline at the largest round value that fits ----
    const TURNS_SHOWN = 60;
    /** The largest 1, 2 or 5 times a power of ten that is <= v (0 for v <= 0). */
    function niceFloor(v) {
      if (!(v > 0)) return 0;
      const p = Math.pow(10, Math.floor(Math.log10(v)));
      const m = v / p;
      return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
    }
    /** "$0.50", "$5", "$0.005": a round axis value without padding zeros (at least two decimals under $1). */
    function axisUsd(v) {
      if (v >= 1) return "$" + String(+v.toFixed(2));
      const s = v.toFixed(6).replace(/0+$/, "");
      return "$" + (s.split(".")[1].length < 2 ? v.toFixed(2) : s);
    }
    /**
     * GET /spend/turns `turns` -> the bars of the per-turn strip (264 x 98 box, baseline y 78), or null when there is nothing worth drawing
     * (fewer than two turns, or no API value at all). Pure. { bars: [{ turn, x, w, y, h, ch, value, charged }], grid: { y, label }, first, last, max }
     */
    function turnBars(turns) {
      const list = (Array.isArray(turns) ? turns : []).filter((t) => t && typeof t.apiEquivUsd === "number").slice(-TURNS_SHOWN);
      if (list.length < 2) return null;
      const max = list.reduce((m, t) => Math.max(m, t.apiEquivUsd), 0);
      if (!(max > 0)) return null;
      const BASE = 78, TALL = 56.6, scale = TALL / max, n = list.length;
      const pitch = n <= 14 ? 18.86 : 245.2 / (n - 1);
      const w = n <= 14 ? 12 : Math.max(1.5, +(pitch * 0.636).toFixed(2));
      const bars = list.map((t, i) => {
        const hgt = t.apiEquivUsd > 0 ? Math.max(1.5, t.apiEquivUsd * scale) : 0;
        const ch = t.usd > 0 ? Math.min(hgt, Math.max(1, t.usd * scale)) : 0;
        return { turn: t.turn, x: r2(3.4 + i * pitch), w, y: r2(BASE - hgt), h: r2(hgt), ch: r2(ch), value: t.apiEquivUsd, charged: t.usd };
      });
      const g = niceFloor(max);
      const big = bars.reduce((a, b) => (b.value > a.value ? b : a), bars[0]);
      return { bars, max, grid: { y: Math.floor(BASE - g * scale) + 0.5, label: axisUsd(g), value: g }, first: list[0].turn, last: list[n - 1].turn, biggest: big.turn, right: r2(bars[n - 1].x + w) };
    }
    function TurnStrip(props) {
      const m = props.model;
      const d = (b) => { const r = Math.min(2, b.w / 2, b.h); return "M" + b.x + " 78V" + r2(b.y + r) + "Q" + b.x + " " + b.y + " " + r2(b.x + r) + " " + b.y + "H" + r2(b.x + b.w - r) + "Q" + r2(b.x + b.w) + " " + b.y + " " + r2(b.x + b.w) + " " + r2(b.y + r) + "V78Z"; };
      return hs("svg", { className: "dshMh-strip", width: 264, height: 98, viewBox: "0 0 264 98", role: "img", "aria-label": "API value of each of the " + m.bars.length + " turns, the charged part solid. The largest turn is turn " + m.biggest + ".", focusable: "false", children: [
        h("line", { key: "g", className: "dshMh-st-grid", x1: 0, y1: m.grid.y, x2: 264, y2: m.grid.y, strokeWidth: 1 }),
        h("line", { key: "b", className: "dshMh-st-base", x1: 0, y1: 78.5, x2: 264, y2: 78.5, strokeWidth: 1 }),
        h("text", { key: "gl", className: "dshMh-st-text", x: 264, y: r2(m.grid.y - 5.5), textAnchor: "end", children: m.grid.label }),
        h("g", { key: "v", className: "dshMh-st-bar", children: m.bars.map((b) => (b.h > 0 ? h("path", { key: "v" + b.turn, d: d(b), children: h("title", { children: "Turn " + b.turn + ": API value " + costMoney(b.value) + (b.charged > 0 ? ", charged " + costMoney(b.charged) : "") }) }) : null)) }),
        h("g", { key: "c", className: "dshMh-st-charged", children: m.bars.map((b) => (b.ch > 0 ? h("rect", { key: "c" + b.turn, x: b.x, y: r2(78 - b.ch), width: b.w, height: b.ch }) : null)) }),
        h("text", { key: "t1", className: "dshMh-st-text", x: m.bars[0].x, y: 94, children: "turn " + m.first }),
        h("text", { key: "t2", className: "dshMh-st-text", x: m.right, y: 94, textAnchor: "end", children: "turn " + m.last }),
      ] });
    }

    /** Writes the server-built Markdown to the clipboard; reports "Copied" or "Copy failed: ..." through setStatus. Called only from the button's click. */
    function copyMarkdown(markdown, nav, setStatus) {
      const fail = (e) => setStatus("Copy failed: " + String((e && e.message) || e || "clipboard unavailable"));
      try {
        if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== "function") throw new Error("clipboard unavailable");
        return Promise.resolve(nav.clipboard.writeText(markdown)).then(() => setStatus("Copied"), fail);
      } catch (e) {
        fail(e);
        return Promise.resolve();
      }
    }
    const COPY_ICON = h("svg", { className: "dshMh-ico", width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinejoin: "round", "aria-hidden": "true", focusable: "false", children: [h("rect", { key: "a", x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }), h("path", { key: "b", d: "M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" })] });
    const BILLING_HINT = { credits: "Covered by the plan's prepaid credits: charged $0 until they run out" };
    function Swatch(props) { return h("span", { className: "dshMh-sw is-" + props.look, "aria-hidden": "true" }); }
    const dim = (n) => (n > 0 ? "" : " is-zero");
    function costRouteTable(list, attr) {
      return hs("table", { className: "dshMh-ctable", "aria-label": "Cost by model and route", children: [
        h("thead", { children: hs("tr", { children: [
          h("th", { scope: "col", className: "dshMh-c-first", children: "By route" }), h("th", { scope: "col", className: "dshMh-c-bill", children: "Billing" }),
          h("th", { scope: "col", className: "dshMh-c-n dshMh-c-calls", children: "Calls" }), h("th", { scope: "col", className: "dshMh-c-n dshMh-c-chg", children: "Charged" }),
          h("th", { scope: "col", className: "dshMh-c-n dshMh-c-nc", children: "Not charged" }),
        ] }) }),
        h("tbody", { children: list.map((r) => hs("tr", { key: attr + ":" + r.provider + "/" + r.model + "|" + r.billing, [attr]: "1", children: [
          h("td", { children: hs("span", { className: "dshMh-c-route", title: r.provider + "/" + r.model, children: [h(Swatch, { look: routeLook(r) }), hs("span", { className: "dshMh-c-name", children: [h("span", { className: "dshMh-c-prov", children: r.provider + " / " }), h("span", { className: "dshMh-c-model", children: r.model })] })] }) }),
          h("td", { title: BILLING_HINT[r.billing], children: BILLING_LABEL[r.billing] || cap1(r.billing) }),
          h("td", { className: "dshMh-c-n", children: num(r.calls) }),
          h("td", { className: "dshMh-c-n" + (r.usd > 0 ? " is-strong" : " is-zero"), children: costMoney(r.usd) }),
          h("td", { className: "dshMh-c-n" + dim(r.notChargedUsd), children: costMoney(r.notChargedUsd) }),
        ] })) }),
      ] });
    }
    function costPurposeTable(s, attr, label) {
      const rows = Object.entries(s.byPurpose || {}).map(([k, v]) => ({ key: k, label: PURPOSE_LABEL[k] || cap1(k), calls: v.calls, usd: v.usd, api: v.apiEquivUsd }))
        .sort((a, b) => b.api - a.api || b.calls - a.calls);
      if (s.notAttributed && s.notAttributed.calls > 0) rows.push({ key: "~v1", label: "Not attributed (before ledger v2)", calls: s.notAttributed.calls, usd: s.notAttributed.usd, api: s.notAttributed.apiEquivUsd });
      if (!rows.length) return null;
      return hs("table", { className: "dshMh-ctable", "aria-label": label, children: [
        h("thead", { children: hs("tr", { children: [
          h("th", { scope: "col", className: "dshMh-c-first", children: "By purpose" }), h("th", { scope: "col", className: "dshMh-c-n dshMh-c-calls", children: "Calls" }),
          h("th", { scope: "col", className: "dshMh-c-n dshMh-c-chg", children: "Charged" }), h("th", { scope: "col", className: "dshMh-c-n dshMh-c-api", children: "API value" }),
        ] }) }),
        h("tbody", { children: rows.map((r) => hs("tr", { key: attr + ":" + r.key, [attr]: "1", children: [
          h("td", { className: "dshMh-ellipsis", children: r.label }),
          h("td", { className: "dshMh-c-n", children: num(r.calls) }),
          h("td", { className: "dshMh-c-n" + (r.usd > 0 ? " is-strong" : " is-zero"), children: costMoney(r.usd) }),
          h("td", { className: "dshMh-c-n", children: costMoney(r.api) }),
        ] })) }),
      ] });
    }
    function CostHero(props) {
      const m = props.model, segs = m.segments, segTotal = segs.reduce((a, x) => a + x.value, 0) || 1;
      // the Cost tab's hero says "Charged" and speaks of one session; the hub's says what period it covers and how many calls are in it
      const total = m.total ? hs("span", { className: "dshMh-chero-total", children: [h("b", { children: m.total }), " API value in total"] }) : null;
      return hs("section", { className: "dshMh-chero" + (m.total ? " has-total" : ""), "aria-label": "Charged and API value", "data-testid": "model-hub-cost-hero", children: [
        hs("div", { className: "dshMh-chero-top", children: [
          hs("div", { className: "dshMh-chero-col", children: [
            hs("span", { className: "dshMh-chero-key", children: [h("span", { className: "dshMh-sw is-solid is-key", "aria-hidden": "true" }), m.chargedLabel || "Charged"] }),
            h("span", { className: "dshMh-chero-big", children: m.charged }),
          ] }),
          m.empty ? h("span", { className: "dshMh-chero-none", children: m.emptyText || (m.partial ? "Calls not known" : "No model calls yet") }) : hs("div", { className: "dshMh-chero-col is-end", children: [
            hs("span", { className: "dshMh-chero-key", children: [h("span", { className: "dshMh-sw is-tint is-key", "aria-hidden": "true" }), "API value, not charged"] }),
            h("span", { className: "dshMh-chero-mid", children: m.notCharged }),
          ] }),
        ] }),
        segs.length ? hs("div", { className: "dshMh-chero-bar", children: [
          h("div", { className: "dshMh-bar2" + (segs.length === 1 ? " is-one" : ""), role: "img", "aria-label": (m.barLabel || "Session API value by route and billing: ") + segs.map((s) => s.label).join("; ") + ".", children: segs.map((s) => h("span", { key: s.key, className: "dshMh-bar2-seg is-" + s.look, style: { flexGrow: Math.round((s.value / segTotal) * 1e6) } })) }),
          m.callsText ? hs("div", { className: "dshMh-chero-foot", children: [h("span", { children: m.callsText }), total] }) : total,
        ] }) : null,
      ] });
    }
    function CostCaps(props) {
      const caps = props.caps, rows = [];
      if (caps && caps.sessionUsd > 0) rows.push({ key: "s", label: "This session", spent: props.usd, cap: caps.sessionUsd, aria: "Session cap: " });
      if (caps && caps.dailyUsd > 0) rows.push({ key: "d", label: "Today", spent: caps.todayUsd, cap: caps.dailyUsd, aria: "Daily cap: " });
      if (!rows.length) return null;
      return hs("section", { className: "dshMh-cside is-caps", "aria-label": "Spend caps", "data-testid": "model-hub-cost-caps", children: [
        h("h2", { className: "dshMh-ch2", children: "Spend caps" }),
        rows.map((r) => {
          const frac = r.spent / r.cap, p = Math.round(frac * 100);
          return hs("div", { key: r.key, className: "dshMh-caprow2", children: [
            hs("div", { className: "dshMh-caprow2-top", children: [h("span", { children: r.label }), hs("span", { children: [h("b", { className: "dshMh-c-strong", children: usd(r.spent) }), h("span", { className: "dshMh-soft2", children: " of " + usd(r.cap) })] })] }),
            h(CapRunway, { frac, pid: "dshMh-rw-" + r.key, label: r.aria + usd(r.spent) + " spent of " + usd(r.cap) + (r.spent > 0 ? ", " + p + "%" : "") }),
          ] });
        }),
      ] });
    }
    /** The Cost tab body for one GET /spend/session payload (and, optionally, GET /spend/turns). Everything is a text node. */
    function CostViewBody(props) {
      const [copy, setCopy] = react.useState("");
      const data = props.data;
      const root = (kids) => hs("div", { className: "dshMh-hub dshMh-costview", "data-testid": "model-hub-cost", children: kids });
      if (!props.sessionId) return root([h("div", { key: "m", className: "dshMh-soft", children: "No session selected." })]);
      if (!data) return root([h("div", { key: "m", className: "dshMh-soft", role: "status", children: props.error ? "Cost is unavailable: " + props.error : "Loading the session cost…" })]);
      const partial = data.complete === false || data.unreadable === true;
      const m = costViewModel(data, partial);
      const sub = data.subagents;
      const strip = turnBars(props.turns && props.turns.turns);
      const left = [
        data.byRoute.length ? costRouteTable(data.byRoute, "data-route") : null,
        costPurposeTable(data, "data-purpose", "Cost by purpose"),
      ].filter(Boolean);
      const caps = h(CostCaps, { key: "caps", caps: data.caps, usd: data.usd });
      return root([
        data.demo ? h(DemoBanner, { key: "demo" }) : null,
        hs("div", { key: "head", className: "dshMh-chead", children: [
          hs("div", { className: "dshMh-chead-l", children: [
            hs("div", { className: "dshMh-chead-t", children: [h("h1", { className: "dshMh-ch1", children: "Session cost" }), h("span", { className: "dshMh-mono dshMh-soft", title: data.sessionId, children: data.sessionId })] }),
            m.subtitle ? h("span", { className: "dshMh-chead-sub", children: m.subtitle }) : null,
          ] }),
          hs("span", { className: "dshMh-row dshMh-nowrap", children: [
            h("span", { "aria-live": "polite", className: "dshMh-soft", children: copy }),
            data.markdown ? hs("button", { type: "button", className: "dshMh-btn", title: "Copies this receipt. It never contains prompt text, paths or emails.", onClick: () => copyMarkdown(data.markdown, typeof navigator === "undefined" ? null : navigator, setCopy), children: [COPY_ICON, "Copy as Markdown"] }) : null,
          ] }),
        ] }),
        partial ? h("div", { key: "partial", className: "dshMh-warn", role: "status", children: m.empty ? "The spend ledger could not be read in full, so the calls of this session are not known." : "The spend ledger could not be read in full, so these totals may be low." }) : null,
        h(CostHero, { key: "hero", model: m }),
        hs("div", { key: "grid", className: "dshMh-cgrid", children: [
          left.length ? h("div", { className: "dshMh-cmain", children: left }) : null,
          hs("div", { className: "dshMh-cside-col", children: [
            caps,
            strip ? hs("section", { key: "turns", className: "dshMh-cside is-turns", "aria-label": "API value per turn", "data-testid": "model-hub-cost-turns", children: [h("h2", { className: "dshMh-ch2", children: "API value per turn" }), h(TurnStrip, { model: strip })] }) : null,
            sub.calls > 0 ? hs("section", { key: "sub", className: "dshMh-cside", "aria-label": "Subagents", "data-testid": "model-hub-cost-subagents", children: [
              hs("div", { className: "dshMh-ch2 is-split", children: [hs("h2", { className: "dshMh-ch2-h", children: ["Subagents ", h("span", { className: "dshMh-soft2", children: "(one level)" })] }), h("span", { className: "dshMh-soft2 dshMh-num", children: sub.sessionCount + (sub.sessionCount === 1 ? " session · " : " sessions · ") + callsLabel(sub.calls) })] }),
              hs("div", { className: "dshMh-sub-row", children: [h("span", { children: "Charged" }), h("b", { className: "dshMh-c-strong", children: costMoney(sub.usd) })] }),
              hs("div", { className: "dshMh-sub-row", children: [h("span", { children: "Not charged" }), h("span", { children: costMoney(sub.notChargedUsd) })] }),
            ] }) : null,
          ] }),
        ] }),
        h("p", { key: "foot", className: "dshMh-cfoot", children: "From the local spend ledger. API value is the list price; plan, credit, free and local routes are not charged." }),
      ]);
    }
    /** The conversation.view tab: DSH passes the session scope's {sessionId}. */
    function CostView(props) {
      const r = usePoll(props.sessionId ? "/spend/session?id=" + encodeURIComponent(props.sessionId) : null, 10000);
      const turns = useTurns(props.sessionId);
      return h(CostViewBody, { data: r.data, error: r.error, sessionId: props.sessionId, turns });
    }

    // ---------------- styles: every color is a DSH token (light and dark follow DSH's theme) ----------------
    const HUB_CSS = [
      // semantic aliases, scoped to the plugin's own surfaces
      ".dshMh-hub,.dshMh-plancard,.dshAmPlan-wrap,.dshMh-toast,.dshMh-pop,.dshMh-turn{--mh-card:var(--dsw-alias-bg-layer-1,Canvas);--mh-sub:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--mh-card));--mh-line:var(--dsw-alias-border-l2);--mh-line2:var(--dsw-alias-border-l1);--mh-text:var(--dsw-alias-label-primary);--mh-text2:var(--dsw-alias-label-secondary);--mh-track:var(--dsw-alias-border-l2);--mh-accent:var(--dsw-alias-state-business-primary);--mh-accent-soft:var(--dsw-alias-state-business-tertiary);--mh-accent-text:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,var(--dsw-alias-label-primary));--mh-ok:var(--dsw-alias-state-success-primary);--mh-ok-soft:var(--dsw-alias-state-success-tertiary);--mh-ok-text:color-mix(in srgb,var(--dsw-alias-state-success-primary) 58%,var(--dsw-alias-label-primary));--mh-warn:var(--dsw-alias-state-warn-primary);--mh-warn-soft:var(--dsw-alias-state-warn-tertiary);--mh-warn-text:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-label-primary));--mh-bad:var(--dsw-alias-state-error-primary);--mh-bad-soft:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--mh-card));--mh-bad-text:color-mix(in srgb,var(--dsw-alias-state-error-primary) 80%,var(--dsw-alias-label-primary));--mh-primary:var(--dsw-alias-label-primary);--mh-primary-fg:var(--dsw-alias-label-primary-foreground)}",
      ".dshMh-hub{margin:16px 0;color:var(--mh-text);font-size:13px;line-height:20px;min-width:0;display:flex;flex-direction:column;gap:12px}",
      ".dshMh-hub *,.dshMh-plancard *{box-sizing:border-box}",
      ".dshMh-oktext{color:var(--mh-ok-text);font-size:12px}.dshMh-warntext{color:var(--mh-warn-text)}.dshMh-dangertext,.dshMh-badtext{color:var(--mh-bad-text)}",
      ".dshMh-err{color:var(--mh-bad-text);font-size:12px;line-height:16px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
      ".dshMh-demo{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:10px;font-size:12px;line-height:16px;font-weight:500;color:var(--mh-warn-text);background:var(--mh-warn-soft);overflow-wrap:anywhere}",
      ".dshMh-warn{font-size:12px;line-height:16px;padding:10px 12px;border-radius:10px;color:var(--mh-warn-text);background:var(--mh-warn-soft);overflow-wrap:anywhere}",
      ".dshMh-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:12px;line-height:16px;font-weight:500;white-space:nowrap;color:var(--mh-text2);background:var(--mh-sub)}",
      ".dshMh-pill.is-accent{color:var(--mh-accent-text);background:var(--mh-accent-soft)}.dshMh-pill.is-ok{color:var(--mh-ok-text);background:var(--mh-ok-soft)}",
      ".dshMh-pill.is-warn{color:var(--mh-warn-text);background:var(--mh-warn-soft)}.dshMh-pill.is-bad{color:var(--mh-bad-text);background:var(--mh-bad-soft)}",
      ".dshMh-pill.is-outline{background:transparent;border:1px solid var(--mh-line)}",
      ".dshMh-ctable{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px;line-height:20px;font-variant-numeric:tabular-nums}",
      ".dshMh-ctable th{padding:0 0 8px;border-bottom:1px solid var(--mh-line);text-align:left;font-size:12px;line-height:20px;font-weight:500;color:var(--mh-text2)}",
      ".dshMh-ctable th.dshMh-c-first{font-size:13px;font-weight:600;color:var(--mh-text)}",
      ".dshMh-ctable td{padding:9px 0;border-bottom:1px solid var(--mh-line)}.dshMh-ctable tbody tr:last-child td{border-bottom:0}",
      ".dshMh-ctable .dshMh-c-n{text-align:right}.dshMh-ctable .is-zero{color:var(--mh-text2)}.dshMh-ctable .is-strong{font-weight:600}",
      ".dshMh-c-bill{width:104px}.dshMh-c-calls{width:52px}.dshMh-c-chg{width:88px}.dshMh-c-nc,.dshMh-c-api{width:104px}",
      ".dshMh-c-route{display:flex;align-items:center;gap:8px;min-width:0}.dshMh-c-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshMh-c-prov{color:var(--mh-text2)}.dshMh-c-model{font-weight:500}",
      ".dshMh-cside{display:flex;flex-direction:column}.dshMh-cside.is-caps{gap:14px}.dshMh-cside.is-turns{gap:10px}",
      ".dshMh-caprow2{display:flex;flex-direction:column;gap:4px}.dshMh-caprow2-top{display:flex;align-items:baseline;justify-content:space-between;font-variant-numeric:tabular-nums}",
      ".dshMh-rw-acc-s{stroke:var(--mh-accent)}.dshMh-rw-warn-s{stroke:var(--mh-warn)}.dshMh-rw-bad-s{stroke:var(--mh-bad)}",
      ".dshMh-rw-acc-f{fill:var(--mh-accent)}.dshMh-rw-warn-f{fill:var(--mh-warn)}.dshMh-rw-bad-f{fill:var(--mh-bad)}",

      // ---- the Model hub section (boards S1-S4): header, cards, buttons, segmented control ----
      ".dshMh-hubhead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0 0}",
      ".dshMh-hubtitle{margin:0;font-size:18px;line-height:24px;font-weight:600}",
      ".dshMh-hubstatus{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-cardhead{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:30px}",
      ".dshMh-headl{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dshMh-headr{display:flex;align-items:center;gap:10px;flex:none}.dshMh-headr.is-tight{gap:8px}",
      ".dshMh-h3-ico{display:inline-flex;align-items:center;gap:8px}",
      ".dshMh-hub{--mh-on:var(--mh-card);--mh-btn:var(--mh-card);--mh-shadow:rgba(0,0,0,.08)}",
      "body[data-ds-dark-theme] .dshMh-hub{--mh-on:var(--mh-halo);--mh-btn:transparent;--mh-sub:var(--dsw-alias-bg-layer-1,var(--mh-card));--mh-shadow:rgba(0,0,0,.3)}",
      ".dshMh-capsbox,.dshMh-flow{--mh-btn:var(--mh-on)}",
      ".dshMh-b{box-sizing:border-box;height:30px;flex:none;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;text-decoration:none;border:1px solid var(--mh-line);background:var(--mh-btn);color:var(--mh-text)}",
      ".dshMh-b:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--mh-sub))}",
      ".dshMh-b:disabled{opacity:.45;cursor:default}",
      ".dshMh-b.is-primary{border:0;background:var(--mh-primary);color:var(--mh-primary-fg);font-weight:500}",
      ".dshMh-b.is-primary:hover:not(:disabled){background:var(--mh-primary);opacity:.88}",
      ".dshMh-b.is-field{height:32px}",
      ".dshMh-b:focus-visible,.dshMh-sg-b:focus-visible,.dshMh-choice:focus-visible,.dshMh-iconbtn:focus-visible{outline:2px solid var(--mh-accent);outline-offset:1px}",
      ".dshMh-inbox:focus-within{outline:2px solid var(--mh-accent);outline-offset:1px}.dshMh-inbox.is-bad:focus-within{outline:0}",
      ".dshMh-sg{display:inline-flex;flex:none;padding:2px;gap:2px;border-radius:8px;background:var(--mh-sub)}.dshMh-sg.is-off{opacity:.45}",
      ".dshMh-sg-b{height:26px;min-width:28px;padding:0 10px;border:0;border-radius:6px;font:inherit;font-size:12px;line-height:16px;cursor:pointer;background:transparent;color:var(--mh-text2)}",
      ".dshMh-sg-b.is-on{background:var(--mh-on);color:var(--mh-text);font-weight:500;box-shadow:0 0 0 1px var(--mh-line),0 1px 2px var(--mh-shadow)}",
      ".dshMh-sg-b:disabled{cursor:default}",
      ".dshMh-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--mh-text2);white-space:nowrap}.dshMh-status.is-live{color:var(--mh-text)}",
      ".dshMh-tag.is-w{width:44px}.dshMh-tag.is-pad{padding:0 6px;flex:none}",
      ".dshMh-oktext{color:var(--mh-ok-text);font-size:12px;line-height:16px}",
      ".dshMh-rspin{display:block;flex:none;animation:dshMhSpin .8s linear infinite}.dshMh-rspin-t{stroke:var(--mh-rtrack)}.dshMh-rspin-a{stroke:var(--mh-accent)}",
      ".dshMh-ferr{display:flex;align-items:flex-start;gap:5px;font-size:12px;line-height:16px;color:var(--mh-bad-text)}.dshMh-ferr>svg{margin-top:1px}",
      // costs
      ".dshMh-chero-foot{display:flex;align-items:baseline;justify-content:space-between;font-size:12px;line-height:16px;color:var(--mh-text2);font-variant-numeric:tabular-nums}.dshMh-chero-foot .dshMh-chero-total{align-self:auto}.dshMh-chero-foot b{color:var(--mh-text);font-weight:600}",
      ".dshMh-cbody{display:flex;flex-direction:column;gap:24px;padding:6px 0 0}",
      ".dshMh-csec{display:flex;flex-direction:column}.dshMh-csec.is-edit{gap:12px}",
      ".dshMh-sechead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:0 0 8px;border-bottom:1px solid var(--mh-line)}.dshMh-sechead.is-gpu{align-items:center}",
      ".dshMh-caprows{display:flex;flex-direction:column;gap:4px;padding:10px 0 0}",
      ".dshMh-hcrow{display:grid;grid-template-columns:130px 264px minmax(0,1fr);align-items:center;min-height:30px}",
      ".dshMh-caplab{display:flex;flex-direction:column;min-width:0}.dshMh-capsub{font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-capamt{text-align:right;white-space:nowrap}.dshMh-capamt-n{font-weight:600}.dshMh-capamt-n.is-warn{color:var(--mh-warn-text)}.dshMh-capamt-n.is-bad{color:var(--mh-bad-text)}",
      ".dshMh-capnote,.dshMh-capnone{padding:8px 0 0}",
      ".dshMh-warns{display:flex;flex-direction:column;gap:4px}",
      ".dshMh-rw-ghost{stroke:var(--mh-text2)}",
      ".dshMh-facts{padding:12px 0 0;display:grid;grid-template-columns:44px minmax(0,1fr);column-gap:10px;row-gap:6px;align-items:start;font-size:12px;line-height:16px;color:var(--mh-text2);font-variant-numeric:tabular-nums}",
      ".dshMh-fact{display:contents}.dshMh-fact-b{color:var(--mh-text);font-weight:500}",
      ".dshMh-ctable th.dshMh-c-plain{font-size:12px;font-weight:500;color:var(--mh-text2)}.dshMh-c-px{width:60px}",
      ".dshMh-c-prov-name{font-weight:500}.dshMh-c-small{font-size:12px}",
      ".dshMh-ledger{border-top:1px solid var(--mh-line);padding:12px 0 0;display:flex;flex-direction:column;gap:6px}",
      ".dshMh-ledger-row{display:flex;align-items:center;justify-content:space-between;gap:16px}",
      ".dshMh-ledger-txt{display:flex;flex-direction:column;gap:2px;min-width:0}.dshMh-ledger-t{font-size:13px;line-height:20px;font-weight:500}",
      ".dshMh-ledger-s{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-lmark{display:block;flex:none}.dshMh-lmark-bg{fill:var(--mh-ok)}.dshMh-lmark.is-bad .dshMh-lmark-bg{fill:var(--mh-bad)}.dshMh-lmark-fg{stroke:var(--dsw-alias-bg-base,Canvas)}",
      // caps editor
      ".dshMh-capsform{margin:0;display:flex;flex-direction:column;gap:12px}",
      ".dshMh-capsform fieldset{border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:12px}",
      ".dshMh-capsbox{background:var(--mh-sub);border-radius:10px;display:flex;flex-direction:column}",
      ".dshMh-capsbody{padding:14px 16px 16px;display:flex;flex-direction:column;gap:14px}",
      ".dshMh-capsgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));column-gap:12px;align-items:start}",
      ".dshMh-capfield,.dshMh-capcell,.dshMh-capgroup{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".dshMh-caprowform{display:grid;grid-template-columns:minmax(0,1fr) 160px auto;column-gap:12px;align-items:start}.dshMh-caprowform>.dshMh-b{margin-top:0}",
      ".dshMh-capadd{padding:2px 0 0}",
      ".dshMh-capsact{display:flex;align-items:center;justify-content:flex-end;gap:8px}",
      ".dshMh-lbl{font-size:12px;line-height:16px;font-weight:500;color:var(--mh-text)}",
      ".dshMh-inbox{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--mh-line);background:var(--mh-btn)}",
      ".dshMh-inbox.is-bad{border-color:var(--mh-bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--mh-bad) 10%,transparent)}",
      ".dshMh-in{flex:1;min-width:0;width:100%;height:30px;margin:0;padding:0;border:0;outline:0;background:transparent;color:var(--mh-text);font:inherit;font-variant-numeric:tabular-nums}",
      ".dshMh-inpre{color:var(--mh-text2)}.dshMh-inunit{flex:none;font-size:12px;line-height:16px;color:var(--mh-text2)}",
      // accounts
      ".dshMh-acctwrap{display:flex;flex-direction:column}.dshMh-acctlist{display:flex;flex-direction:column}",
      ".dshMh-acct{display:grid;grid-template-columns:32px minmax(0,1fr) 116px 104px;column-gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--mh-line)}",
      ".dshMh-mark{width:32px;height:32px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;background:var(--mh-sub);color:var(--mh-text)}",
      ".dshMh-acct-main{display:flex;flex-direction:column;min-width:0}",
      ".dshMh-acct-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dshMh-acct-plan{font-weight:400;color:var(--mh-text2)}",
      ".dshMh-acct-ident{font-size:12px;line-height:16px;color:var(--mh-text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshMh-acct-state{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0}.dshMh-acct-state .dshMh-pill{flex:none}",
      ".dshMh-acct-word{display:inline-flex;align-items:center;gap:6px}.dshMh-acct-off{color:var(--mh-text2)}.dshMh-acct-sub{font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-acct-act{display:flex;justify-content:flex-end}",
      ".dshMh-acct-line{grid-column:2/-1;display:flex;align-items:flex-start;gap:6px;margin:8px 0 0;font-size:12px;line-height:16px;color:var(--mh-text2)}.dshMh-acct-line>svg{margin-top:1px;flex:none}.dshMh-acct-line.is-bad{color:var(--mh-bad-text)}",
      ".dshMh-acct-word.is-fresh{font-weight:500}.dshMh-acct-line.is-fail>svg{color:var(--mh-bad-text)}.dshMh-acct-fail{color:var(--mh-bad-text);font-weight:600}",
      ".dshMh-addblock{display:flex;align-items:center;gap:12px;padding:0}.dshMh-addblock.has-rule{border-top:1px solid var(--mh-line);padding:12px 0 0}",
      ".dshMh-addlabel{flex:none}.dshMh-addrow{display:flex;flex-wrap:wrap;gap:8px}",
      ".dshMh-flow{grid-column:1/-1;margin:12px 0 0;background:var(--mh-sub);border-radius:10px;padding:14px 16px 16px;display:flex;flex-direction:column;gap:12px}",
      ".dshMh-flowtitle{font-size:13px;line-height:20px;font-weight:600}",
      ".dshMh-flowhead{display:flex;flex-direction:column;gap:2px}.dshMh-prompt{display:flex;flex-direction:column;gap:12px}",
      ".dshMh-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
      ".dshMh-choice{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px;border-radius:8px;border:1px solid var(--mh-line);background:var(--mh-btn);color:var(--mh-text);font:inherit;text-align:left;cursor:pointer}",
      ".dshMh-choice:hover{background:var(--dsw-alias-interactive-bg-hover-solid,var(--mh-sub))}",
      ".dshMh-wait{display:flex;align-items:flex-start;gap:10px}.dshMh-wait-ico{margin-top:2px;display:inline-flex}.dshMh-wait-text{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dshMh-flowrow{display:flex;align-items:center;gap:10px;padding:0 0 0 26px}.dshMh-flowrow .dshMh-flowrow{padding:0}",
      ".dshMh-flowfield{padding:0 0 0 26px}.dshMh-flowform{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;align-items:end}",
      ".dshMh-codechip{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 4px 0 12px;border-radius:8px;border:1px solid var(--mh-line);background:var(--mh-btn)}",
      ".dshMh-codetext{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;line-height:20px;font-weight:600;letter-spacing:.08em}",
      ".dshMh-iconbtn{width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--mh-text);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}",
      // GPU server
      ".dshMh-gpus{display:grid;gap:12px;padding:2px 0 0}",
      ".dshMh-gpu{display:flex;align-items:flex-start;gap:10px;min-width:0}.dshMh-gpu-ring{display:block;flex:none;margin-top:2px}",
      ".dshMh-gpu-track{stroke:var(--mh-rtrack)}.dshMh-gpu-arc.is-ok{stroke:var(--mh-accent)}.dshMh-gpu-arc.is-warn{stroke:var(--mh-warn)}",
      ".dshMh-gpu-txt{display:flex;flex-direction:column;min-width:0}.dshMh-gpu-name{font-size:13px;line-height:20px;font-weight:600}.dshMh-gpu-sub{font-size:12px;line-height:16px;color:var(--mh-text2);white-space:nowrap}",
      ".dshMh-mlist{display:flex;flex-direction:column;padding:8px 0 0}",
      ".dshMh-mrows{display:flex;flex-direction:column}",
      ".dshMh-mrow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:38px;padding:4px 0;border-bottom:1px solid var(--mh-line)}.dshMh-mrow:last-child{border-bottom:0}",
      ".dshMh-mname{display:flex;align-items:center;gap:8px;min-width:0}.dshMh-mname-t{font-weight:500;overflow-wrap:anywhere}",
      ".dshMh-mact{display:flex;align-items:center;gap:12px;flex:none}",
      ".dshMh-mfoot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0 0}.dshMh-mfoot:empty{display:none}.dshMh-mnote{padding:6px 0 0}",
      ".dshMh-grid{display:flex;flex-direction:column;gap:12px;min-width:0}",
      ".dshMh-card{min-width:0;padding:16px;border:1px solid var(--mh-line);border-radius:12px;background:transparent;display:flex;flex-direction:column;gap:14px}",
      ".dshMh-h3{margin:0;font-size:14px;line-height:20px;font-weight:600}",
      ".dshMh-h4{margin:0;font-size:13px;line-height:20px;font-weight:600}",
      ".dshMh-soft{color:var(--mh-text2);font-size:12px;line-height:16px;overflow-wrap:anywhere}",
      ".dshMh-soft.is-bad{color:var(--mh-bad-text)}",
      ".dshMh-small{font-size:11px;line-height:14px}",
      ".dshMh-num{font-variant-numeric:tabular-nums}",
      ".dshMh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
      ".dshMh-ellipsis{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshMh-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshMh-nowrap{flex-wrap:nowrap}.dshMh-end{justify-content:flex-end}.dshMh-grow{flex:1 1 auto;min-width:0}.dshMh-r{text-align:right}.dshMh-pad{padding:8px 0}",
      ".dshMh-btn{font:inherit;font-size:13px;line-height:18px;font-weight:500;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--mh-line);background:var(--mh-card);color:var(--mh-text);cursor:pointer;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}",
      ".dshMh-btn.is-tall{height:36px;padding:0 14px}",
      ".dshMh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--mh-sub))}",
      ".dshMh-btn:disabled{opacity:.45;cursor:default}",
      ".dshMh-btn.is-primary{background:var(--mh-primary);color:var(--mh-primary-fg);border-color:transparent}",
      ".dshMh-btn.is-primary:hover:not(:disabled){background:var(--mh-primary);opacity:.88}",
      ".dshMh-btn:focus-visible{outline:2px solid var(--mh-accent);outline-offset:1px}",
      ".dshMh-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,var(--mh-line))}",
      ".dshMh-dot.is-ok{background:var(--mh-ok)}.dshMh-dot.is-warn{background:var(--mh-warn)}.dshMh-dot.is-bad{background:var(--mh-bad)}",
      // accounts
      // sign-in flow
      // GPU server
      "@keyframes dshMhSpin{to{transform:rotate(360deg)}}",
      // costs
      ".dshMh-costview{box-sizing:border-box;width:100%;max-width:912px;margin:0 auto;padding:28px 16px 32px;gap:24px}",
      ".dshMh-hub,.dshMh-costview,.dshMh-turn{--mh-tint:color-mix(in srgb,var(--mh-accent) 28%,transparent);--mh-tint-line:color-mix(in srgb,var(--mh-accent) 55%,transparent)}",
      "body[data-ds-dark-theme] .dshMh-hub,body[data-ds-dark-theme] .dshMh-costview,body[data-ds-dark-theme] .dshMh-turn{--mh-tint:color-mix(in srgb,var(--mh-accent) 30%,transparent);--mh-tint-line:color-mix(in srgb,var(--mh-accent) 60%,transparent)}",
      ".dshMh-chead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}",
      ".dshMh-chead-l{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dshMh-chead-t{display:flex;align-items:baseline;gap:10px;min-width:0;flex-wrap:wrap}",
      ".dshMh-ch1{margin:0;font-size:18px;line-height:24px;font-weight:600}",
      ".dshMh-chead-sub{font-size:13px;line-height:20px;color:var(--mh-text2);font-variant-numeric:tabular-nums}",
      ".dshMh-chero{background:var(--mh-well);border-radius:12px;padding:22px 24px 24px;display:flex;flex-direction:column;gap:16px}.dshMh-chero.has-total{padding-bottom:18px}",
      ".dshMh-chero-top{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}",
      ".dshMh-chero-col{display:flex;flex-direction:column;gap:2px}.dshMh-chero-col.is-end{align-items:flex-end}",
      ".dshMh-chero-key{display:inline-flex;align-items:center;gap:7px;font-size:13px;line-height:20px;color:var(--mh-text2)}",
      ".dshMh-chero-big{font-size:44px;line-height:48px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}",
      ".dshMh-chero-mid{font-size:28px;line-height:34px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}",
      ".dshMh-chero-none{font-size:13px;line-height:20px;color:var(--mh-text2);padding-bottom:6px}",
      ".dshMh-chero-bar{display:flex;flex-direction:column;gap:8px}",
      ".dshMh-chero-total{align-self:flex-end;font-size:12px;line-height:16px;color:var(--mh-text2);font-variant-numeric:tabular-nums}.dshMh-chero-total b{color:var(--mh-text);font-weight:600}",
      ".dshMh-bar2{display:flex;gap:2px;height:24px;border-radius:6px;overflow:hidden}.dshMh-bar2.is-one{border:1px solid var(--mh-tint-line)}",
      ".dshMh-bar2-seg{flex-basis:0;min-width:3px}.dshMh-bar2-seg.is-solid{background:var(--mh-accent)}.dshMh-bar2-seg.is-tint{background:var(--mh-tint)}",
      ".dshMh-bar2-seg.is-hatch{background-color:color-mix(in srgb,var(--mh-accent) 12%,transparent);background-image:repeating-linear-gradient(135deg,color-mix(in srgb,var(--mh-accent) 85%,transparent) 0 1.2px,transparent 1.2px 4.243px)}",
      ".dshMh-sw{flex:none;display:inline-block;box-sizing:border-box;width:10px;height:10px;border-radius:3px;corner-shape:round}",
      ".dshMh-sw.is-solid{background:var(--mh-accent)}.dshMh-sw.is-tint{background:var(--mh-tint);box-shadow:inset 0 0 0 1px var(--mh-tint-line)}",
      ".dshMh-sw.is-hatch{background-color:color-mix(in srgb,var(--mh-accent) 12%,transparent);background-image:repeating-linear-gradient(135deg,var(--mh-accent) 0 1.1px,transparent 1.1px 2.83px);box-shadow:inset 0 0 0 1px var(--mh-tint-line)}",
      ".dshMh-sw.is-outline{box-shadow:inset 0 0 0 1px var(--mh-text2)}",
      ".dshMh-cgrid{display:flex;flex-wrap:wrap;align-items:flex-start;gap:28px 32px}",
      ".dshMh-cmain{flex:1 1 400px;min-width:0;display:flex;flex-direction:column;gap:28px}",
      ".dshMh-cside-col{flex:0 0 264px;min-width:0;display:flex;flex-direction:column;gap:28px}.dshMh-cgrid>.dshMh-cside-col:first-child{margin-left:auto}",
      ".dshMh-ch2{margin:0;padding:0 0 8px;border-bottom:1px solid var(--mh-line);font-size:13px;line-height:20px;font-weight:600}",
      ".dshMh-ch2.is-split{display:flex;align-items:baseline;justify-content:space-between}.dshMh-ch2-h{margin:0;font-size:13px;line-height:20px;font-weight:600}",
      ".dshMh-soft2{font-weight:400;color:var(--mh-text2)}.dshMh-ch2.is-split>.dshMh-soft2{font-size:12px;line-height:20px}",
      ".dshMh-c-strong{font-weight:600}",
      ".dshMh-runway,.dshMh-strip{display:block;font-variant-numeric:tabular-nums}",
      ".dshMh-rw-track{stroke:color-mix(in srgb,var(--mh-text) 30%,transparent)}.dshMh-rw-cap{stroke:var(--mh-text)}.dshMh-rw-hatch{stroke:var(--mh-text2)}",
      ".dshMh-rw-hollow{fill:var(--dsw-alias-bg-base,var(--mh-card))}.dshMh-rw-dot{stroke:var(--dsw-alias-bg-base,var(--mh-card))}",
      ".dshMh-st-grid{stroke:color-mix(in srgb,var(--mh-text) 14%,transparent)}.dshMh-st-base{stroke:color-mix(in srgb,var(--mh-text) 30%,transparent)}",
      ".dshMh-st-text{fill:var(--mh-text2);font-size:11px}.dshMh-st-bar{fill:var(--mh-tint)}.dshMh-st-charged{fill:var(--mh-accent)}",
      ".dshMh-sub-row{display:flex;align-items:baseline;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--mh-line);font-variant-numeric:tabular-nums}.dshMh-sub-row:last-child{border-bottom:0}",
      ".dshMh-cfoot{margin:0;font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-trow.is-dead .dshMh-mono,.dshMh-trow.is-dead .dshMh-num{opacity:.55}",
      // plan card
      ".dshMh-ring{display:block;flex:none}.dshMh-ring-track{stroke:var(--mh-track)}",
      ".dshMh-ring-arc.is-ok{stroke:var(--mh-accent)}.dshMh-ring-arc.is-warn{stroke:var(--mh-warn)}.dshMh-ring-arc.is-danger,.dshMh-ring-arc.is-over{stroke:var(--mh-bad)}.dshMh-ring-arc.is-grey{stroke:var(--mh-text2)}",
      // plan card (design C): the well, three rings, the est. row, the plan-stop switch
      ".dshMh-plancard,.dshMh-hub,.dshMh-costview,.dshMh-turn,.dshMh-pop,.dshAmPlan-wrap{--mh-well:var(--dsw-alias-bg-multi-select,var(--mh-sub));--mh-halo:var(--dsw-alias-bg-layer-2,var(--mh-card));--mh-rtrack:var(--dsw-alias-scrollbar-bg-l1,var(--mh-track))}",
      "body[data-ds-dark-theme] .dshMh-plancard,body[data-ds-dark-theme] .dshMh-hub,body[data-ds-dark-theme] .dshMh-costview,body[data-ds-dark-theme] .dshMh-turn,body[data-ds-dark-theme] .dshMh-pop,body[data-ds-dark-theme] .dshAmPlan-wrap{--mh-text2:color-mix(in srgb,var(--dsw-alias-label-secondary) 74%,var(--mh-well));--mh-accent-text:var(--mh-accent);--mh-accent-soft:color-mix(in srgb,var(--mh-accent) 16%,transparent);--mh-warn-text:var(--mh-warn)}",
      "body[data-ds-dark-theme] .dshMh-switch-knob{box-shadow:0 1px 2px rgba(0,0,0,.35)}",
      ".dshMh-plancard{margin:0;border-radius:10px;overflow:hidden;background:var(--mh-well);color:var(--mh-text);font-size:13px;line-height:20px;display:flex;flex-direction:column}",
      ".dshMh-plancard>.dshMh-demo{border-radius:0;padding:8px 16px}",
      ".dshMh-pc-head{padding:14px 16px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}",
      ".dshMh-pc-head .dshMh-pill{flex:none}",
      ".dshMh-pc-titles{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dshMh-pc-title{display:flex;align-items:center;gap:8px;font-size:14px;line-height:20px;font-weight:600}",
      ".dshMh-pc-quiet{font-size:12px;line-height:16px;color:var(--mh-text2);overflow-wrap:anywhere}",
      ".dshMh-pc-one{padding:6px 16px 14px;font-size:12px;line-height:16px;color:var(--mh-text2)}.dshMh-pc-one.is-bad{color:var(--mh-bad-text)}",
      ".dshMh-pc-rings{padding:20px 16px 0;display:grid;grid-template-rows:124px auto;row-gap:10px;align-items:center;justify-items:center}",
      ".dshMh-pc-rings+.dshMh-pc-rings{padding-top:16px}",
      ".dshMh-pc-cell{display:flex;align-items:center;justify-content:center}",
      ".dshMh-pc-cap{align-self:start;display:flex;flex-direction:column;align-items:center;text-align:center}",
      ".dshMh-pc-captitle{font-size:13px;line-height:20px;font-weight:600}",
      ".dshMh-pc-capsub{font-size:12px;line-height:16px;color:var(--mh-text2);font-variant-numeric:tabular-nums}",
      ".dshMh-pr{position:relative;flex:none}.dshMh-pr.is-lg{width:124px;height:124px}.dshMh-pr.is-sm{width:84px;height:84px}",
      ".dshMh-pr-svg{display:block}.dshMh-pr-halo{fill:var(--mh-halo)}.dshMh-pr-track{stroke:var(--mh-rtrack)}.dshMh-pr-est{stroke:var(--mh-text2)}",
      ".dshMh-pr-arc.is-ok{stroke:var(--mh-accent)}.dshMh-pr-arc.is-warn{stroke:var(--mh-warn)}.dshMh-pr-arc.is-full{stroke:var(--mh-bad)}.dshMh-pr-arc.is-grey{stroke:var(--mh-text2)}",
      ".dshMh-pr-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}",
      ".dshMh-pr-v{font-size:28px;line-height:32px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}",
      ".dshMh-pr.is-sm .dshMh-pr-v{font-size:18px;line-height:22px;letter-spacing:-.01em}",
      ".dshMh-pr-v.is-warn{color:var(--mh-warn-text)}.dshMh-pr-v.is-full{color:var(--mh-bad-text)}.dshMh-pr-v.is-grey{color:var(--mh-text2)}",
      ".dshMh-pr-u{font-size:11px;line-height:14px;color:var(--mh-text2)}",
      ".dshMh-tag.dshMh-pr-esttag{position:absolute;top:-6px;left:-14px;padding:0 6px;background:var(--mh-well)}",
      ".dshMh-tag{box-sizing:border-box;text-align:center;font-size:11px;line-height:14px;font-weight:600;color:var(--mh-text2);border:1px solid var(--mh-line);border-radius:999px;padding:0;white-space:nowrap}",
      ".dshMh-tag.is-est{border-style:dashed;border-color:var(--mh-text2)}",
      ".dshMh-pc-facts{padding:18px 16px 14px;display:grid;grid-template-columns:44px minmax(0,1fr);column-gap:10px;row-gap:6px;align-items:start;font-size:12px;line-height:16px;color:var(--mh-text2);font-variant-numeric:tabular-nums}",
      ".dshMh-pc-fact{display:contents}.dshMh-pc-facts .dshMh-tag{width:44px}",
      ".dshMh-pc-estlines{display:flex;flex-direction:column}.dshMh-pc-warnline{color:var(--mh-warn-text)}",
      ".dshMh-pc-b{color:var(--mh-text);font-weight:500}",
      ".dshMh-pc-stop{border-top:1px solid var(--mh-line);padding:12px 16px 14px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px}",
      ".dshMh-pc-stoptext{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dshMh-pc-stoplabel{font-size:13px;line-height:20px;font-weight:500}",
      ".dshMh-switch{flex:none;position:relative;width:36px;height:20px;margin-top:1px;padding:0;border:0;border-radius:999px;corner-shape:round;background:var(--mh-rtrack);box-shadow:inset 0 0 0 1px var(--mh-line);cursor:pointer;transition:background .15s}",
      ".dshMh-switch.is-on{background:var(--mh-accent);box-shadow:none}",
      ".dshMh-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-static-neutral-bluish-00,Canvas);box-shadow:0 1px 2px rgba(0,0,0,.25),0 0 0 .5px var(--mh-line);transition:left .15s}",
      ".dshMh-switch.is-on .dshMh-switch-knob{left:18px}",
      ".dshMh-switch:disabled,.dshMh-switch[aria-busy=\"true\"]{opacity:.55;cursor:default}",
      ".dshMh-switch:focus-visible{outline:2px solid var(--mh-accent);outline-offset:2px}",
      // dock chip
      // dock chip: one button of three hairline-separated segments (styled like the Cost tab's Copy button), and its popover
      ".dshAmPlan-chip{display:contents}",
      ".dshMh-chip{box-sizing:border-box;height:28px;display:inline-flex;align-items:center;flex:0 1 auto;min-width:0;max-width:100%;overflow:hidden;pointer-events:auto;padding:0 0 0 10px;margin:0;border-radius:8px;border:1px solid var(--mh-line);background:var(--mh-card);color:var(--mh-text2);font:inherit;font-size:12px;line-height:16px;white-space:nowrap;cursor:pointer}",
      ".dshMh-chip:hover,.dshMh-chip[aria-expanded=\"true\"]{background:var(--dsw-alias-interactive-bg-hover-solid,var(--mh-sub))}",
      ".dshMh-chip[aria-expanded=\"true\"]{background:var(--mh-well)}",
      ".dshMh-chip:focus-visible{outline:2px solid var(--mh-accent);outline-offset:1px}",
      ".dshMh-chip.is-dim{opacity:.75}",
      ".dshMh-chipseg{flex:none;display:inline-flex;align-items:center;gap:6px;padding-right:10px}",
      ".dshMh-chip-div{flex:none;width:1px;height:14px;margin-right:10px;background:var(--mh-line)}",
      ".dshMh-chipseg b{color:var(--mh-text);font-weight:600}.dshMh-chipk{color:var(--mh-text2)}",
      ".dshMh-chipseg.is-warn b{color:var(--mh-warn-text)}.dshMh-chipseg.is-danger b{color:var(--mh-bad-text)}.dshMh-chipseg.is-quiet b{color:var(--mh-text2);font-weight:500}",
      ".dshMh-chip-demo{flex:none;align-self:center;margin-right:10px;padding:1px 6px;border-radius:5px;background:var(--mh-warn-soft);color:var(--mh-warn-text);font-size:11px;line-height:14px;font-weight:600}",
      "body[data-ds-dark-theme] .dshMh-chip-demo{background:color-mix(in srgb,var(--mh-warn) 16%,transparent)}",
      ".dshMh-chip-ico{stroke:var(--mh-text2)}.dshMh-chip-bad{stroke:var(--mh-bad)}.dshMh-chip-badfill{fill:var(--mh-bad)}",
      ".dshMh-pop{box-sizing:border-box;z-index:2147483000;width:380px;max-width:calc(100vw - 16px);border:1px solid var(--mh-line);border-radius:12px;background:var(--mh-card);color:var(--mh-text);box-shadow:0 16px 40px rgba(0,0,0,.18);font-size:13px;line-height:20px;white-space:normal;pointer-events:none;display:flex;flex-direction:column;overflow:hidden}",
      "body[data-ds-dark-theme] .dshMh-pop{box-shadow:0 16px 40px rgba(0,0,0,.55)}",
      ".dshMh-pop>.dshMh-demo{border-radius:0;padding:8px 16px}",
      ".dshMh-pop-rings{padding:20px 16px 0;display:grid;grid-template-columns:1fr 1fr;row-gap:8px;justify-items:center}",
      ".dshMh-pop-model .is-stale{color:var(--mh-text2)}",
      ".dshMh-pop-ring{display:flex;flex-direction:column;align-items:center;gap:8px}.dshMh-pr.is-xs{width:72px;height:72px}.dshMh-pr.is-xs .dshMh-pr-v{font-size:18px;line-height:22px;letter-spacing:-.01em}",
      ".dshMh-pr.is-xs .dshMh-pr-esttag{top:-8px;left:-24px}",
      ".dshMh-pop-models{margin:14px 16px 0;padding:10px 0 0;border-top:1px solid var(--mh-line);display:flex;flex-direction:column;gap:8px;font-variant-numeric:tabular-nums}",
      ".dshMh-pop-model{display:flex;align-items:center;gap:10px}.dshMh-pop-grow{flex:1}",
      ".dshMh-pop-facts{padding:14px 16px;display:grid;grid-template-columns:44px minmax(0,1fr);column-gap:10px;row-gap:6px;align-items:start;font-size:12px;line-height:16px;color:var(--mh-text2);font-variant-numeric:tabular-nums}.dshMh-pop-facts .dshMh-tag,.dshMh-pop-estrow .dshMh-tag{width:44px}",
      ".dshMh-pop-today{border-top:1px solid var(--mh-line);padding:12px 16px 14px;display:flex;flex-direction:column;gap:4px;font-variant-numeric:tabular-nums}",
      ".dshMh-pop-todayrow{display:flex;align-items:baseline;justify-content:space-between}.dshMh-pop-of{color:var(--mh-text2)}",
      ".dshMh-pop-estrow{margin-top:4px;display:grid;grid-template-columns:44px minmax(0,1fr);column-gap:10px;align-items:start;font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-rw-est{stroke:var(--mh-text2)}",
      // the turn cost line (one line, no pill) and its detail card
      ".dshMh-turn{margin:12px 0 0;min-width:0;max-width:100%;display:flex;flex-direction:column;align-items:flex-start}",
      ".dshMh-tl{display:inline-flex;align-items:center;gap:8px;height:20px;max-width:100%;padding:0;border:0;border-radius:4px;background:transparent;font:inherit;font-size:12px;line-height:16px;color:var(--mh-text2);text-align:left;white-space:nowrap;cursor:pointer}",
      ".dshMh-tl-text{min-width:0;overflow:hidden;text-overflow:ellipsis}.dshMh-tl-chev{flex:none;display:block}",
      ".dshMh-tl-b{color:var(--mh-text);font-weight:600}.dshMh-tl-prov{color:var(--mh-text2)}.dshMh-tl-model{color:var(--mh-text);font-weight:500}",
      ".dshMh-tl:focus-visible{outline:2px solid var(--mh-accent);outline-offset:2px}",
      ".dshMh-td{box-sizing:border-box;max-width:100%;margin-top:8px;padding:14px 16px;border-radius:10px;background:var(--mh-well);display:flex;flex-wrap:wrap;align-items:flex-start;row-gap:14px}",
      ".dshMh-td-grid{display:grid;grid-template-columns:44px max-content;column-gap:10px;row-gap:6px;align-items:start;font-size:12px;line-height:16px;color:var(--mh-text2);font-variant-numeric:tabular-nums}.dshMh-td-grid .dshMh-tag{width:44px}",
      ".dshMh-td-col{display:flex;flex-direction:column}.dshMh-td-b{color:var(--mh-text);font-weight:500}",
      ".dshMh-td-while{margin-left:20px;padding-left:20px;border-left:1px solid var(--mh-line);display:flex;flex-direction:column;gap:8px}",
      ".dshMh-td-while .dshMh-ctable{width:314px;max-width:100%}.dshMh-c-dcalls{width:42px}.dshMh-c-dchg{width:72px}",
      ".dshMh-td-note{font-size:12px;line-height:16px;color:var(--mh-text2)}",
      ".dshMh-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}",
      ".dshAmPlan-wrap{display:flex;justify-content:center;align-items:center;flex-wrap:nowrap;gap:8px;flex:0 1 auto;min-width:0;max-width:100%;height:auto;align-self:stretch;box-sizing:border-box;padding:6px 0 2px}",
      "@media (max-width:639px){[data-composer-dock]{flex-wrap:wrap}.dshAmPlan-wrap{flex:1 0 100%;order:1}}",
      ".dshAmPlan-logo{display:inline-flex;align-items:center;color:var(--dsw-alias-label-primary);flex:none;line-height:0}",
      // toast
      ".dshMh-toast{position:fixed;right:16px;bottom:150px;z-index:2147483000;max-width:min(360px,calc(100vw - 32px));padding:12px 14px;border-radius:12px;border:1px solid var(--mh-line);background:var(--mh-card);color:var(--mh-text);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:16px}",
      ".dshMh-toast b{display:block;margin-bottom:2px;color:var(--mh-warn-text)}",
      // icons and tiles
      ".dshMh-ico{flex:none;display:inline-block;vertical-align:middle}",
      ".dshMh-mono-ico{flex:none;display:inline-block;text-align:center;font-weight:700;color:var(--mh-text2)}",
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
      // no dsh.client.inject entry is needed: ctx.slots.inject runs the callback as soon as DSH declares the slot, in any order
      ctx.slots.inject("conversation.chat.turnTail", () =>
        ctx.slots.register({ name: "conversation.chat.turnTail", id: "model-hub-turn-cost", order: 50 }, TurnCost),
      );
      // the Cost tab next to Chat (order 0) and DSH's Stats: conversation.view entries are the session header's tabs
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register({ name: "conversation.view", id: "cost", order: 20, label: "Cost" }, CostView),
      );
    }

    exports._test = { visibleModelRows, MODEL_ROWS_MAX, CostView, CostViewBody, costViewModel, copyMarkdown, turnLine, createTurnsStore, TurnCostView, TurnCost, extraUsageSentence, PlanStopSwitch, savePlanStop, planLines, planCardLines, PlanPopover, DockChip, dockVisible, GpuPanel, GpuServerPanel, ICONS, iconKey, gpuIconKey, gpuTitle, gpuLabel, gpuServerModels, gpuPriceIds, defaultGpuModel, humanizeError, acctState, hasIdentity, AccountRow, AvailableChip, useSignIns, RingSpin, gpuRingModel, gpuModelRows, GpuCard, PricesPanel, HubSection, hubStatusLine, billingText, provLook, spendHeroModel, capRowsModel, CapRowsBlock, stopDescription, reservedSegs, fcClock, fcRange, InBox, gpuIdle, staleLine, isLeaseError, fmtPm, normPriceId, priceList, sameInstance, postJson, PRICE_ID_SRC, groupPrices, spendView, errStr, isAvailable, signInUrl, dshCountsLine, spendRows, priceTable, capsProblemLine, capsDraft, capsChanges, submitCapsDraft, CapsForm, CapsEditor, chipModel, identityLine, planRows, splitLabel, AccountsPanel, CostsPanel, ringDash, DemoBanner, DEMO_TEXT, planCardBody, purposeRows, ledgerLine, ledgerDetail, guardLine, reservedLine, forecastSpendLine, usdRate, freshForecast, forecastPlanLine, forecastPlanTitle, heroUsd, costSpan, costBarSegments, routeLook, capRunway, niceFloor, axisUsd, turnBars, CostHero, CostCaps, TurnStrip, CapRunway, PlanRing, estArc, planEstimate, planFooter, planWindows, ringRows, fmtClockRange, planRingState, planUnavailableLine, PLAN_RING, turnDetail, TurnDetail, popoverModel, spendEstimate };
    exports.apply = apply;
    exports.inject = ["slots", "sessions"];
    return module.exports;
  },
});
