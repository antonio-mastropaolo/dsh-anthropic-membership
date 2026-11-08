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
    function getJson(path) {
      return fetch(API + path, { headers: HEADER }).then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw httpError(r, j);
        return j;
      });
    }
    function postJson(path, body) {
      return fetch(API + path, {
        method: "POST",
        headers: { ...HEADER, "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw httpError(r, j);
        return j;
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
    const normPriceId = (id) => String(id || "").replace(/^rocco\/(mac-)/, "mac/$1");
    const priceModelPart = (id) => String(id || "").split("/").slice(1).join("/") || String(id || "");
    const isRetired = (id) => /^claude-opus-5$/.test(String(id || "").split("/").pop());
    /** Normalize, de-duplicate and group the /prices payload for display. */
    function groupPrices(models, providerHealth) {
      const seen = new Map();
      for (const [rawId, v] of Object.entries(models || {})) {
        if (isRetired(rawId)) continue;
        const id = normPriceId(rawId);
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
    function spendView(d) {
      if (!d || !d.totals) return null;
      const ext = d.external && d.external.totals ? d.external : null;
      const dshUsd = d.totals.usd || 0;
      const dshCalls = d.totals.calls || 0;
      const rows = Object.entries(d.byProvider || {}).map(([k, v]) => ({ k, usd: v.usd || 0, calls: v.calls || 0, meter: false }));
      if (ext) for (const [k, v] of Object.entries(ext.byProvider || {})) rows.push({ k, usd: v.usd || 0, calls: v.calls || 0, meter: true });
      rows.sort((a, b) => b.usd - a.usd);
      return {
        usd: dshUsd + (ext ? ext.totals.usd || 0 : 0),
        calls: dshCalls + (ext ? ext.totals.calls || 0 : 0),
        sub: ext ? "DSH " + usd(dshUsd) + " · " + num(dshCalls) + " calls · Meter " + usd(ext.totals.usd) + " · " + num(ext.totals.calls) + " calls" : "",
        subLines: ext ? ["DSH " + usd(dshUsd) + " · " + num(dshCalls) + " calls", "Meter " + usd(ext.totals.usd) + " · " + num(ext.totals.calls) + " calls"] : [],
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
        access: data?.access || null,
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

    // ---------------- Accounts panel (DSH native sign-in via the host) ----------------
    function SignInFlow(props) {
      const provider = props.provider;
      const [text, setText] = react.useState("");
      const [err, setErr] = react.useState(null);
      const { data } = usePoll("/accounts/signin/" + provider, 1000, props.active);
      const s = data || { state: "running", notices: [], prompt: null };
      const opened = react.useRef(null);
      const url = (s.notices || []).map((n) => n && n.url).filter(Boolean).pop();
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
        children: [
          h("div", { className: "dshMh-muted", children: "Signing in through DSH’s own flow. Finish it in the browser tab that opened." }),
          url ? hs("div", { className: "dshMh-row", children: [
            h("a", { className: "dshMh-btn", href: url, target: "_blank", rel: "noopener noreferrer", children: "Open sign-in page" }),
            code ? hs("span", { className: "dshMh-code", children: ["Code ", h("b", { children: code })] }) : null,
          ] }) : choices ? null : h("div", { className: "dshMh-muted", children: "Waiting for DSH to produce the sign-in link…" }),
          choices ? hs("div", { className: "dshMh-prompt", children: [
            h("label", { className: "dshMh-muted", children: s.prompt.message || "Choose how to sign in" }),
            hs("div", { className: "dshMh-row", children: choices.map((o, i) => h("button", {
              key: String(o.id ?? i),
              type: "button",
              className: "dshMh-btn" + (i === 0 ? " is-primary" : ""),
              onClick: () => answer(String(o.id ?? o.value ?? o.label ?? "")),
              children: o.label || String(o.id),
            })) }),
          ] }) : s.prompt ? hs("div", { className: "dshMh-prompt", children: [
            h("label", { className: "dshMh-muted", children: s.prompt.message || "Paste the code" }),
            hs("div", { className: "dshMh-row", children: [
              h("input", {
                className: "dshMh-input",
                type: s.prompt.kind === "secret" ? "password" : "text",
                value: text,
                placeholder: s.prompt.placeholder || "",
                autoComplete: "off",
                onChange: (e) => setText(e.target.value),
              }),
              h("button", { type: "button", className: "dshMh-btn is-primary", disabled: !text, onClick: answer, children: "Submit" }),
            ] }),
          ] }) : null,
          err ? h("div", { className: "dshMh-err", children: err }) : null,
          h("div", { className: "dshMh-row", children: h("button", { type: "button", className: "dshMh-btn", onClick: cancel, children: "Cancel" }) }),
        ],
      });
    }

    function AccountRow(props) {
      const a = props.account;
      const compact = !!props.compact;
      const [flowing, setFlowing] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const flow = (props.flows || []).find((f) => f.provider === a.provider);
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
        props.onChange && props.onChange();
      };
      const broken = isBroken(a);
      const missing = isAvailable(a) || !a.signedIn;
      const label = broken ? "Sign in again" : missing ? "Sign in" : "Reconnect";
      const btnCls = broken ? " is-primary" : missing ? "" : " is-ghost";
      const badge = a.health === "ok" ? "ok" : a.health === "expiring" ? "warn" : a.health === "expired" || a.health === "refresh-failed" ? "bad" : null;
      const errLine = compact ? "" : humanizeError(a);
      const button = flowing ? null : h("button", { type: "button", className: "dshMh-btn" + btnCls, onClick: start, children: label });
      const tile = h(ProviderTile, { provider: a.provider, badge, dim: missing && !broken });
      const fullName = PROVIDER_LABEL[a.provider] || a.provider;
      const name = compact ? fullName.replace(/\s*\([^)]*\)\s*$/, "") : fullName; // compact tiles drop the "(ChatGPT)" qualifier; full name stays in title
      return hs("div", {
        className: (compact ? "dshMh-avail-item" : "dshMh-acct") + (flowing ? " is-flowing" : ""),
        children: [
          hs("div", { className: "dshMh-acct-head", children: [
            tile,
            hs("div", { className: "dshMh-acct-main", children: [
              h("div", { className: "dshMh-acct-name", title: fullName, children: name }),
              compact ? null : h("div", { className: "dshMh-muted", children: acctSubline(a) }),
            ] }),
            button,
          ] }),
          errLine ? h("div", { className: "dshMh-err", title: a.lastError, children: errLine }) : null,
          msg ? h("div", { className: "dshMh-muted", children: msg }) : null,
          flowing ? h(SignInFlow, { provider: a.provider, active: true, onDone: done }) : null,
        ],
      });
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
        children: [
          hs("div", { className: "dshMh-title", children: [
            "Accounts",
            acc.data ? h("span", { className: "dshMh-tag" + (need ? " is-bad" : ""), children: need ? need + " need sign-in" : connected + " connected" }) : null,
            acc.data ? h("span", { className: "dshMh-tag", title: "Background token watchdog", children: acc.data.reportOnly ? "auto-refresh: report only" : "auto-refresh on" }) : null,
            acc.data ? h("button", { type: "button", className: "dshMh-btn is-small dshMh-push", disabled: checking, onClick: check, children: checking ? "Checking…" : "Check now" }) : null,
          ] }),
          acc.error ? h("div", { className: "dshMh-err", children: "Host API unreachable: " + acc.error }) : null,
          full.length ? h("div", { className: "dshMh-acctlist", children: full.map((a) => h(AccountRow, { key: a.provider, account: a, flows, onChange: acc.reload })) }) : null,
          avail.length ? h("div", { className: "dshMh-subtitle", children: "Available" }) : null,
          avail.length ? h("div", { className: "dshMh-availgrid", children: avail.map((a) => h(AccountRow, { key: a.provider, account: a, flows, compact: true, onChange: acc.reload })) }) : null,
        ],
      });
    }

    // ---------------- rocco panel ----------------
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
            h("span", { className: "dshMh-muted", children: idle ? "Idle" : g.util_pct + "% util" }),
          ] }),
          h("div", { className: "dshMh-bar", children: h("span", { className: "dshMh-bar-fill" + (used > 85 ? " is-hot" : ""), style: { width: (idle ? 0 : Math.max(2, used)) + "%" } }) }),
          h("div", { className: "dshMh-muted", title: idle ? "driver baseline " + ((g.used_mib || 0) / 1024).toFixed(1) + " GiB, no processes" : undefined, children: (idle ? "0" : (g.used_mib / 1024).toFixed(1)) + " / " + total + " GiB" }),
          owners.length ? h("div", { className: "dshMh-owner", children: owners.map((o, i) => h("div", { key: i, children: o })) }) : null,
          res.map((r) => h("span", { key: r, className: "dshMh-tag", title: "Reserved", children: "reserved · " + r })),
        ],
      });
    }

    const DEFAULT_ROCCO = "rocco-qwen38-q4"; // OrcaRouter default route (dsh-model-hub README)
    function RoccoPanel() {
      const [busy, setBusy] = react.useState(null); // {target, started}
      const [err, setErr] = react.useState(null);
      const [forceable, setForceable] = react.useState(false);
      const lastReq = react.useRef(null);
      const [model, setModel] = react.useState("");
      const [pins, setPins] = react.useState([]);
      const fast = busy ? 2000 : 6000;
      const gp = usePoll("/rocco/gpus", fast);
      const md = usePoll("/rocco/models", fast);
      const g = gp.data;
      const models = ((md.data && md.data.models) || []).filter((m) => m.owner === "rocco" && !/flash-next/.test(m.id));
      // Truth for "loaded" is the GPU endpoint (the shim's per-model flag is stale).
      const loadedModel = g && g.loaded_model ? String(g.loaded_model) : null;
      const mac = ((md.data && md.data.models) || []).filter((m) => m.owner === "mac");
      react.useEffect(() => { if (!model && models.length) setModel(loadedModel && models.some((m) => m.id === loadedModel) ? loadedModel : models.some((m) => m.id === DEFAULT_ROCCO) ? DEFAULT_ROCCO : models[0].id); }, [models.length, loadedModel]);
      react.useEffect(() => {
        if (busy && busy.target === "unload" && !loadedModel) setBusy(null);
        if (busy && busy.target !== "unload" && loadedModel === busy.target) setBusy(null);
        if (busy && Date.now() - busy.started > 15 * 60000) setBusy(null);
      }, [md.data, gp.data]);
      const togglePin = (i) => setPins((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort()));
      const send = (body, track) => {
        setErr(null);
        setForceable(false);
        lastReq.current = body;
        postJson("/rocco/switch", body).then(
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
        postJson("/rocco/unload", {}).then(
          () => { setBusy({ target: "unload", started: Date.now() }); gp.reload(); md.reload(); },
          (e) => setErr(String(e.message || e)),
        );
      };
      const mgr = g && g.manager ? (g.manager.active ? "manager active" : "manager stopped") : "";
      const stale = staleLine((g && g.reservations) || [], g && g.gpus ? g.gpus.length : null);
      const failover = g && g.failover ? typeof g.failover === "string" ? g.failover : errStr(g.failover) || JSON.stringify(g.failover) : "";
      return hs("section", {
        className: "dshMh-card",
        children: [
          hs("div", { className: "dshMh-title", children: [
            h(ProviderIcon, { provider: "rocco", size: 16 }),
            "rocco GPUs",
            mgr ? h("span", { className: "dshMh-tag" + (g.manager.active ? "" : " is-bad"), children: mgr }) : null,
            g && g.stale ? h("span", { className: "dshMh-tag is-warn", children: "state stale" }) : null,
          ] }),
          gp.error ? h("div", { className: "dshMh-err", children: "rocco unreachable: " + gp.error }) : null,
          g && g.ok === false ? h("div", { className: "dshMh-err", children: "rocco: " + (g.error || "unavailable") }) : null,
          g && g.gpus ? h("div", { className: "dshMh-gpus", children: g.gpus.map((x) => h(GpuCard, { key: x.index, gpu: x })) }) : null,
          stale ? h("div", { className: "dshMh-muted", children: stale }) : null,
          failover ? h("div", { className: "dshMh-muted", children: "Failover: " + failover }) : null,
          loadedModel
            ? hs("div", { className: "dshMh-muted", children: ["Loaded: ", h("b", { children: loadedModel })] })
            : h("div", { className: "dshMh-muted", children: "Nothing loaded on the GPUs · models load on demand" }),
          mac.length ? hs("div", { className: "dshMh-row dshMh-muted", children: [
            h(ProviderIcon, { provider: "mac", size: 14 }),
            "Local Mac: " + mac.map((m) => m.id + (m.loaded ? " (up)" : " (down)")).join(", "),
          ] }) : null,
          g && g.pin && g.pin.error ? h("div", { className: "dshMh-err", children: "Pin error: " + g.pin.error }) : null,
          hs("div", { className: "dshMh-controls", children: [
            hs("label", { className: "dshMh-field", children: [
              h("span", { className: "dshMh-muted", children: "Model" }),
              h("select", { className: "dshMh-input", value: model, disabled: !!busy, onChange: (e) => setModel(e.target.value), children: models.map((m) => h("option", { key: m.id, value: m.id, children: m.id + (m.id === loadedModel ? " (loaded)" : "") })) }),
            ] }),
            hs("fieldset", { className: "dshMh-field dshMh-pins", disabled: !!busy, children: [
              h("legend", { className: "dshMh-muted", children: "GPUs (none = automatic)" }),
              (g && g.gpus ? g.gpus : []).map((x) => hs("label", { key: x.index, className: "dshMh-check", children: [
                h("input", { type: "checkbox", checked: pins.includes(x.index), onChange: () => togglePin(x.index) }),
                String(x.index),
              ] })),
            ] }),
            hs("div", { className: "dshMh-row", children: [
              h("button", { type: "button", className: "dshMh-btn is-primary", disabled: !!busy || !model, onClick: load, children: pins.length ? "Load on GPU " + pins.join(",") : "Load" }),
              h("button", { type: "button", className: "dshMh-btn", disabled: !!busy || !loadedModel, onClick: unload, children: "Unload" }),
              forceable ? h("button", { type: "button", className: "dshMh-btn", disabled: !!busy, title: "Switch even though another session holds the lease", onClick: forceSwitch, children: "Force switch" }) : null,
              pinned ? h("button", { type: "button", className: "dshMh-btn", disabled: !!busy || !(loadedModel || model), onClick: unpin, children: "Return to auto (pinned to GPU " + pinned.join(",") + ")" }) : null,
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
    const PRICE_MODELS = [
      "rocco/rocco-qwen38-q4",
      "mac/mac-qwen38-q4",
      "google/gemini-3.8-flash",
      "google/gemini-4-argon",
      "dashscope/deepseek-v4-flash",
      "dashscope/qwen3.8-max",
    ];
    function Meter(props) {
      const p = Math.min(100, props.pct || 0);
      return hs("div", { className: "dshMh-meter", children: [
        hs("div", { className: "dshMh-row dshMh-between", children: [h("span", { children: props.label }), h("span", { className: "dshMh-muted", children: props.value })] }),
        h("div", { className: "dshMh-bar", children: h("span", { className: "dshMh-bar-fill" + (p >= 100 ? " is-bad" : p >= 50 ? " is-hot" : ""), style: { width: Math.max(2, p) + "%" } }) }),
      ] });
    }
    function PriceRow(props) {
      const r = props.row;
      const known = !!iconKey(r.provider);
      return hs("div", { className: "dshMh-prow" + (r.noCredit ? " is-dead" : ""), title: r.id, children: [
        hs("span", { className: "dshMh-pname", children: [
          h("span", { className: "dshMh-slot", children: h(ProviderIcon, { provider: r.provider, size: 14 }) }),
          h("span", { className: "dshMh-mono", children: known ? priceModelPart(r.id) : r.id }),
        ] }),
        r.kind === "metered"
          ? h("span", { className: "dshMh-price", children: r.line })
          : h("span", { className: "dshMh-muted", children: "price unknown · set in prices.json" }),
        r.noCredit ? h("span", { className: "dshMh-tag is-bad", title: (r.info && r.info.message) || "No credit", children: "no credit (" + (r.info && r.info.code != null ? r.info.code : "402") + ")" }) : null,
      ] });
    }
    function CostsPanel() {
      const today = usePoll("/spend?since=today&by=provider", 8000);
      const week = usePoll("/spend?since=7d&by=model", 20000);
      const seen = week.data ? Object.keys(week.data.groups || {}) : [];
      const models = Array.from(new Set([...PRICE_MODELS, ...seen])).filter((m) => !isRetired(m)).slice(0, 20);
      const pr = usePoll("/prices?models=" + encodeURIComponent(models.join(",")), 60000);
      const d = today.data;
      const caps = d && d.caps;
      const lim = caps && caps.limits;
      const sv = spendView(d);
      const pg = pr.data ? groupPrices(pr.data.models, pr.data.providerHealth || {}) : null;
      return hs("section", {
        className: "dshMh-card",
        children: [
          hs("div", { className: "dshMh-title", children: [
            "Costs",
            caps ? h("span", { className: "dshMh-tag" + (caps.action === "block" ? " is-bad" : caps.action === "warn" ? " is-warn" : ""), title: caps.reason, children: caps.action === "ok" ? "within caps" : caps.action }) : null,
          ] }),
          today.error ? h("div", { className: "dshMh-err", children: "Spend unavailable: " + today.error }) : null,
          sv ? hs("div", { className: "dshMh-stats", children: [
            hs("div", { children: [
              h("div", { className: "dshMh-big", children: usd(sv.usd) }),
              h("div", { className: "dshMh-muted", children: "charged today · " + num(sv.calls) + " calls" }),
              ...sv.subLines.map((t, i) => h("div", { key: "s" + i, className: "dshMh-muted", children: t })),
            ] }),
            hs("div", { children: [h("div", { className: "dshMh-big", children: usd((d.totals.apiEquivUsd || 0) + sv.extUsd) }), h("div", { className: "dshMh-muted", children: "API-list equivalent" })] }),
            hs("div", { children: [h("div", { className: "dshMh-big", children: week.data ? usd((week.data.totals.usd || 0) + (week.data.external && week.data.external.totals ? week.data.external.totals.usd || 0 : 0)) : "—" }), h("div", { className: "dshMh-muted", children: "last 7 days" })] }),
          ] }) : null,
          lim ? h(Meter, { label: "DSH daily cap", value: usd(caps.todayUsd) + " of " + usd(lim.dailyUsd), pct: lim.dailyUsd ? (caps.todayUsd / lim.dailyUsd) * 100 : 0 }) : null,
          sv && sv.rows.length
            ? h("div", { className: "dshMh-table", children: sv.rows.map((r) => hs("div", { key: (r.meter ? "m:" : "d:") + r.k, className: "dshMh-trow", children: [
                hs("span", { className: "dshMh-pname", children: [
                  h("span", { className: "dshMh-slot", children: h(ProviderIcon, { provider: r.k, size: 14 }) }),
                  r.k,
                  r.meter ? h("span", { className: "dshMh-tag", title: "Metered outside DSH (agent-patcher meter)", children: "meter" }) : null,
                ] }),
                h("span", { className: "dshMh-muted", children: num(r.calls) + " calls" }),
                h("b", { children: usd(r.usd) }),
              ] })) })
            : (d ? h("div", { className: "dshMh-muted", children: "No spend recorded today. Subscription, free and local usage count as $0." }) : null),
          h("div", { className: "dshMh-subtitle", children: "Prices ($ per million tokens)" }),
          pg ? hs("div", { className: "dshMh-table", children: [
            pg.rows.map((r) => h(PriceRow, { key: r.id, row: r })),
            pg.groups.map((gr) => h("div", { key: gr.label, className: "dshMh-muted", children: gr.label + ": " + gr.items.join(" · ") })),
            pr.data.warnings && pr.data.warnings.length ? h("div", { className: "dshMh-muted", children: pr.data.warnings.join("; ") }) : null,
          ] }) : null,
          pr.error ? h("div", { className: "dshMh-err", children: pr.error }) : null,
        ],
      });
    }

    function HubSection() {
      return hs("div", {
        className: "dshMh-hub",
        children: [
          h("div", { className: "dshMh-hubtitle", children: "Model hub" }),
          h("div", { className: "dshMh-grid", children: [h(AccountsPanel, { key: "a" }), h(RoccoPanel, { key: "r" }), h(CostsPanel, { key: "c" })] }),
        ],
      });
    }

    // ---------------- Claude plan card (existing provider card, now read-only) ----------------
    function pctColor(p) {
      if (typeof p !== "number") return undefined;
      if (p >= 95) return "var(--dsw-alias-state-error-primary,#b42318)";
      if (p >= 80) return "#b54708";
      return undefined;
    }
    function windowLine(label, win) {
      if (!win || typeof win.percent !== "number") return null;
      return h("div", { style: { fontSize: 13, marginBottom: 4, color: pctColor(win.percent) }, children: label + ": " + win.percent + "% used · resets " + fmtReset(win.resetsAt) });
    }
    function PlanCard() {
      const { st } = useStatus();
      const plan = st.plan;
      let body;
      if (!plan || plan.mode === "signed-out") body = h("div", { children: "Not signed in. Use Model hub → Accounts below to sign in." });
      else if (plan.mode === "expired") body = h("div", { children: "Claude sign-in expired — Model hub → Accounts" });
      else if (plan.mode === "unavailable") body = h("div", { children: "Plan usage unavailable (" + (plan.httpStatus ?? "?") + "). The sign-in may need renewing: see Model hub → Accounts." });
      else if (plan.mode === "api") body = h("div", { children: "Using Anthropic API key (billed per token)" });
      else body = hs("div", { children: [windowLine("5-hour window", plan.fiveHour), windowLine("Weekly", plan.sevenDay), h("div", { className: "dshMh-muted", children: "Usage % counts every Claude app on this account." })] });
      return hs("div", { className: "dshMh-plancard", children: [hs("div", { className: "dshMh-subtitle dshMh-row", children: [h(ProviderIcon, { provider: "anthropic", size: 14 }), "Claude plan usage"] }), body] });
    }
    function Card(props) {
      if (!props || !props.provider || props.provider.provider !== "anthropic") return null;
      return h(PlanCard, {});
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
      ".dshAmPlan-cell.is-warn{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b54708) 72%,var(--dsw-alias-label-primary));background:color-mix(in srgb,#b54708 14%, transparent)}",
      ".dshAmPlan-cell.is-warn .dshAmPlan-v{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b54708) 72%,var(--dsw-alias-label-primary))}",
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

    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css='dsh-model-hub-plan']")) {
      const tag = document.createElement("style");
      tag.dataset.pluginCss = "dsh-model-hub-plan";
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

    function ChipMark(props) {
      return hs("span", { className: "dshAmPlan-mark", children: [h(ProviderIcon, { provider: props.provider, size: 12 }), props.label] });
    }

    function ClaudeChip(plan) {
      if (plan && plan.mode === "expired") {
        return jsx.jsxs("div", {
          className: "dshAmPlan",
          title: "Claude sign-in expired — Model hub → Accounts",
          children: [
            jsx.jsx(ChipMark, { provider: "anthropic", label: "Claude" }),
            jsx.jsx(PlanCell, { k: "sign-in", v: "expired", tone: "danger" }),
          ],
        });
      }
      if (!plan || plan.mode === "signed-out") {
        return jsx.jsxs("div", {
          className: "dshAmPlan is-dim",
          title: "Sign in with Claude Pro/Max in Settings → Models",
          children: [
            jsx.jsx(ChipMark, { provider: "anthropic", label: "Claude" }),
            jsx.jsx(PlanCell, { k: "plan", v: "off" }),
          ],
        });
      }
      if (plan.mode === "api") {
        return jsx.jsxs("div", {
          className: "dshAmPlan",
          title: "Using Anthropic API key (billed per token)",
          children: [
            jsx.jsx(ChipMark, { provider: "anthropic", label: "Claude" }),
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
          jsx.jsx(ChipMark, { provider: "anthropic", label: "Claude" }),
          jsx.jsx(PlanCell, { k: "5h", v: five !== null ? five + "%" : "—", bar: five, tone: tone(five) }),
          jsx.jsx(PlanCell, { k: "wk", v: week !== null ? week + "%" : "—", bar: week, tone: tone(week) }),
        ],
      });
    }

    const HUB_CSS = [
      ".dshMh-hub{margin:16px 0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;min-width:0}",
      ".dshMh-hub *{box-sizing:border-box}",
      ".dshMh-hubtitle{font-size:15px;font-weight:600;margin-bottom:10px}",
      ".dshMh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px;min-width:0;align-items:start}",
      ".dshMh-card{min-width:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:10px;background:var(--dsw-specific-tip,transparent);display:flex;flex-direction:column;gap:10px}",
      ".dshMh-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-weight:600;font-size:14px}",
      ".dshMh-subtitle{font-weight:600;font-size:12px;margin-top:4px}",
      ".dshMh-muted{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));font-size:12px;overflow-wrap:anywhere}",
      ".dshMh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}",
      ".dshMh-err{color:var(--dsw-alias-state-error-primary,#b42318);font-size:12px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
      ".dshMh-warn{font-size:12px;padding:8px 10px;border-radius:8px;color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b54708) 72%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b54708) 14%,transparent);overflow-wrap:anywhere}",
      ".dshMh-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshMh-between{justify-content:space-between;flex-wrap:nowrap}",
      ".dshMh-tag{display:inline-flex;align-items:center;padding:1px 8px;border-radius:99px;font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);max-width:100%;overflow-wrap:anywhere}",
      ".dshMh-tag.is-warn{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b54708) 72%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b54708) 16%,transparent)}",
      ".dshMh-tag.is-bad{color:var(--dsw-alias-state-error-primary,#b42318);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b42318) 14%,transparent)}",
      ".dshMh-btn{font:inherit;font-size:12px;font-weight:600;padding:5px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.4));background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-decoration:none;white-space:nowrap}",
      ".dshMh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
      ".dshMh-btn:disabled{opacity:.45;cursor:default}",
      ".dshMh-btn.is-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent}",
      ".dshMh-input{font:inherit;font-size:12px;padding:5px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.4));background:transparent;color:var(--dsw-alias-label-primary);min-width:0;max-width:100%}",
      ".dshMh-acctlist{display:flex;flex-direction:column;gap:8px}",
      ".dshMh-acct{display:flex;flex-direction:column;gap:6px;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}",
      ".dshMh-acct:first-child{border-top:0;padding-top:0}",
      ".dshMh-acct-head{display:flex;align-items:center;gap:10px}",
      ".dshMh-acct-main{flex:1;min-width:0}",
      ".dshMh-acct-name{font-weight:600;overflow-wrap:anywhere}",
      ".dshMh-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}",
      ".dshMh-dot.is-ok{background:var(--dsw-alias-state-business-primary,#1a7f4b)}.dshMh-dot.is-warn{background:var(--dsw-alias-state-warn-primary,#b54708)}.dshMh-dot.is-bad{background:var(--dsw-alias-state-error-primary,#b42318)}",
      ".dshMh-flow,.dshMh-prompt{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}",
      ".dshMh-code{font-size:12px}",
      ".dshMh-gpus{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px}",
      ".dshMh-gpu{min-width:0;display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;align-items:flex-start}",
      ".dshMh-gpu-head{display:flex;justify-content:space-between;gap:8px;width:100%}",
      ".dshMh-owner{font-size:11px;overflow-wrap:anywhere;width:100%}",
      ".dshMh-bar{width:100%;height:5px;border-radius:99px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.28));overflow:hidden}",
      ".dshMh-bar-fill{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary,#1a7f4b)}",
      ".dshMh-bar-fill.is-hot{background:var(--dsw-alias-state-warn-primary,#b54708)}.dshMh-bar-fill.is-bad{background:var(--dsw-alias-state-error-primary,#b42318)}",
      ".dshMh-controls{display:flex;flex-direction:column;gap:10px;align-items:flex-start}",
      ".dshMh-field{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;border:0;min-width:0;max-width:100%}",
      ".dshMh-pins{flex-direction:row;flex-wrap:wrap;align-items:center;gap:10px}",
      ".dshMh-check{display:inline-flex;align-items:center;gap:4px;font-size:12px}",
      ".dshMh-progress{display:flex;align-items:center;gap:8px;font-size:12px}",
      "@keyframes dshMhSpin{to{transform:rotate(360deg)}}",
      ".dshMh-spin{width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-top-color:var(--dsw-alias-label-primary);animation:dshMhSpin .8s linear infinite}",
      ".dshMh-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}",
      ".dshMh-big{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}",
      ".dshMh-meter{display:flex;flex-direction:column;gap:4px;font-size:12px}",
      ".dshMh-table{display:flex;flex-direction:column;gap:4px}",
      ".dshMh-trow{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px}",
      ".dshMh-plancard{margin:8px 0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:10px;font-size:13px}",
            ".dshAmPlan-cell.is-block{color:var(--dsw-alias-state-error-primary,#b42318);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b42318) 16%,transparent)}",
      ".dshAmPlan-cell.is-block .dshAmPlan-v{color:var(--dsw-alias-state-error-primary,#b42318)}",
      ".dshMh-toast{position:fixed;right:16px;bottom:150px;z-index:2147483000;max-width:min(360px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.4));background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 6px 24px rgba(0,0,0,.2);font-size:12px;line-height:1.4}",
      ".dshMh-toast b{display:block;margin-bottom:2px;color:var(--dsw-alias-state-warn-primary,#b54708)}",
      ".dshMh-ico{flex:none;display:inline-block;vertical-align:middle}",
      ".dshMh-mono-ico{flex:none;display:inline-block;text-align:center;font-weight:700;color:var(--dsw-alias-label-secondary)}",
      ".dshMh-tile{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary)}",
      ".dshMh-tile.is-dim{opacity:.55}",
      ".dshMh-badge{position:absolute;right:-4px;bottom:-4px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7));box-shadow:0 0 0 2px var(--dsw-specific-tip,var(--dsw-alias-bg-primary,Canvas))}",
      // DSH sets a global corner-shape: superellipse(1.5) (measured 2026-11-08), which turns border-radius:50% dots into squircles.
      ".dshMh-badge,.dshMh-dot,.dshMh-spin,.dshAmPlan-knob,.dshAmPlan-knob:after{corner-shape:round}",
      ".dshMh-badge.is-ok{background:var(--dsw-alias-state-business-primary,#1a7f4b)}.dshMh-badge.is-warn{background:var(--dsw-alias-state-warn-primary,#b54708)}.dshMh-badge.is-bad{background:var(--dsw-alias-state-error-primary,#b42318)}",
      ".dshMh-btn.is-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}",
      ".dshMh-btn.is-small{padding:2px 10px;font-weight:500}",
      ".dshMh-push{margin-left:auto}",
      ".dshMh-availgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}",
      ".dshMh-avail-item{min-width:0;display:flex;flex-direction:column;gap:6px;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px}",
      ".dshMh-avail-item.is-flowing{grid-column:1/-1}",
      ".dshMh-avail-item .dshMh-acct-name{font-weight:500;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}",
      ".dshMh-pname{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow-wrap:anywhere}",
      ".dshMh-slot{flex:none;display:inline-flex;width:16px;justify-content:center;color:var(--dsw-alias-label-secondary)}",
      ".dshMh-prow{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;justify-content:space-between;font-size:12px}",
      ".dshMh-prow.is-dead .dshMh-price,.dshMh-prow.is-dead .dshMh-mono{opacity:.55}",
      ".dshMh-price{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px}",
      ".dshMh-title .dshMh-ico{align-self:center}",
      ".dshAmPlan-mark{display:inline-flex;align-items:center;gap:4px}",
      ".dshAmPlan-sw:disabled{opacity:.6;cursor:default}",
    ].join("");
    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css='dsh-model-hub-ui']")) {
      const tag = document.createElement("style");
      tag.dataset.pluginCss = "dsh-model-hub-ui";
      tag.textContent = HUB_CSS;
      document.head.appendChild(tag);
    }

    const CACHE_REASON = {
      "model-changed": "the model changed",
      "system-prompt-changed": "the system prompt changed",
      "tools-changed": "the tool list changed",
      compaction: "the conversation was compacted",
      unknown: "the provider cache probably expired",
    };

    function CostChip(props) {
      const caps = props.spend && props.spend.caps;
      const action = caps ? caps.action : "ok";
      // Same number as the Costs card headline: DSH ledger + the external per-token meter.
      const sv = props.spend ? spendView(props.spend) : null;
      const today = sv ? sv.usd : null;
      const latest = props.cache && props.cache.latest;
      const hit = latest && latest.steps ? latest.lastHit : null;
      const tn = action === "block" ? "block" : action === "warn" ? "warn" : "ok";
      return hs("div", {
        className: "dshAmPlan" + (props.spend ? "" : " is-dim"),
        "data-testid": "model-hub-chip",
        title: (sv && sv.subLines.length ? "Today: " + sv.subLines.join(" · ") + ". " : "") + (caps ? "DSH spend caps: " + caps.reason + ". " : "Model hub host API not reachable. ") + (latest ? "Cache hit on the last step (token-weighted session average " + pct(latest.avgHit) + ")." : "No cached steps observed yet."),
        children: [
          h("span", { className: "dshAmPlan-mark", children: "Cost" }),
          h(PlanCell, { k: "today", v: today === null ? "—" : usd(today), tone: tn }),
          h(PlanCell, { k: "cache", v: hit === null ? "—" : pct(hit), tone: hit !== null && latest.steps > 1 && hit < 0.05 ? "warn" : "ok" }),
        ],
      });
    }

    function AccessSwitch(props) {
      const [busy, setBusy] = react.useState(false);
      const [err, setErr] = react.useState(null);
      const full = !!(props.access && props.access.full);
      const toggle = () => {
        setBusy(true);
        setErr(null);
        postJson("/access", { full: !full }).then(
          () => props.reload && props.reload(),
          (e) => setErr(String(e.message || e)),
        ).then(() => setBusy(false));
      };
      return hs("button", {
        type: "button",
        className: "dshAmPlan-sw" + (full ? " is-on" : ""),
        role: "switch",
        "aria-checked": full ? "true" : "false",
        disabled: busy,
        title: err ? "Could not change access: " + err : full ? "Full access is on (danger-full-access). Click to return to the default preset." : "Click to allow full access (danger-full-access) for this session.",
        onClick: toggle,
        children: [h("span", { children: "Full access" }), h("span", { className: "dshAmPlan-knob", "aria-hidden": "true" })],
      });
    }

    function DockWidget() {
      const { st, reload: reloadStatus } = useStatus();
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
          ClaudeChip(st.plan),
          st.access ? h(AccessSwitch, { access: st.access, reload: reloadStatus }) : null,
          h(CostChip, { spend: sp.data, cache: ca.data }),
          toast ? hs("div", { className: "dshMh-toast", role: "alert", "data-testid": "cache-toast", children: [
            h("b", { children: "Prompt cache dropped" }),
            "Hit rate fell from " + pct(toast.prev) + " to " + pct(toast.hit) + ": " + (CACHE_REASON[toast.reason] || toast.reason) + ". The next request is billed at the full input price.",
          ] }) : null,
        ],
      });
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

    exports._test = { ICONS, iconKey, humanizeError, acctSubline, gpuIdle, staleLine, isLeaseError, fmtPm, normPriceId, isRetired, groupPrices, spendView, errStr, isAvailable };
    exports.apply = apply;
    exports.inject = ["slots", "sessions"];
    return module.exports;
  },
});
