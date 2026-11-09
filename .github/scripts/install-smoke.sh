#!/usr/bin/env bash
# CI smoke test: install this checkout exactly as README "Install" says, in a throwaway DSH_HOME; start `dsh web`;
# check the plugin's host API from the outside; then uninstall as README "Uninstall" says and check it is gone.
# Needs: dsh on PATH, curl, node. Uses ports 3080 (DSH web) and 8185 (the plugin), so run it on a clean machine.
set -euo pipefail

REPO="$PWD"
WORK="${RUNNER_TEMP:-$(mktemp -d)}/dsh-smoke"
rm -rf "$WORK" && mkdir -p "$WORK"
export DSH_HOME="$WORK/dsh-home"
LOG="$WORK/dsh-web.log"
HUB="http://127.0.0.1:8185"
UI="http://127.0.0.1:3080"
WEB=""

redact() { sed -E 's/(token=)[^ &"]+/\1[redacted]/g'; }
step() { printf '\n=== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
stop_web() {
  if [ -n "$WEB" ] && kill -0 "$WEB" 2>/dev/null; then
    kill "$WEB" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$WEB" 2>/dev/null || break; sleep 0.5; done
  fi
  WEB=""
}
on_exit() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$LOG" ]; then echo "--- dsh web log (last 60 lines, tokens redacted)"; tail -n 60 "$LOG" | redact; fi
  stop_web
  exit "$status"
}
trap on_exit EXIT

start_web() {
  : > "$LOG"
  dsh web --no-open >"$LOG" 2>&1 &
  WEB=$!
  for _ in $(seq 1 120); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$UI/" || true)
    [ "$code" != "000" ] && return 0
    kill -0 "$WEB" 2>/dev/null || fail "dsh web exited during startup"
    sleep 1
  done
  fail "dsh web did not answer on $UI within 120 s"
}

json_get() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));process.stdout.write(v===undefined?"undefined":JSON.stringify(v))})' "$1"; }

step "README Install (DSH_HOME=$DSH_HOME)"
dsh --profile web --dump-config > /dev/null
dsh plugin --profile web add -w "file:$PWD"
F="${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"
sed -i.bak '/^\[\]$/d' "$F" && cat cordis.patch.yml >> "$F"
echo "--- $F"; cat "$F"

step "start dsh web"
start_web
for _ in $(seq 1 60); do
  H=$(curl -fsS "$HUB/healthz" 2>/dev/null || true)
  [ -n "$H" ] && [ "$(printf '%s' "$H" | json_get webOrigin)" = "\"$UI\"" ] && break
  sleep 1
done
echo "healthz: ${H:-<none>}"
[ "$(printf '%s' "$H" | json_get ok)" = "true" ] || fail "host API /healthz not ok"
[ "$(printf '%s' "$H" | json_get webOrigin)" = "\"$UI\"" ] || fail "webOrigin is not $UI"

step "host API from the outside"
HH='x-dsh-model-hub: 1' # every read but /healthz needs it (what the UI and the CLI send)
code=$(curl -s -o /dev/null -w '%{http_code}' "$HUB/status")
[ "$code" = "403" ] || fail "a GET without the hub header returned $code (an <img> tag could trigger it)"
S=$(curl -fsS -H "$HH" "$HUB/status")
echo "status: $(printf '%s' "$S" | json_get imageCap) imageCap, $(printf '%s' "$S" | json_get compactionSlim) compactionSlim, $(printf '%s' "$S" | json_get spendGuard) spendGuard"
for k in imageCap compactionSlim spendGuard; do
  [ "$(printf '%s' "$S" | json_get "$k")" = "true" ] || fail "/status $k is not true"
done
[ "$(printf '%s' "$S" | json_get access)" = "undefined" ] || fail "/status still has an access field"
# subscription billing needs DSH's route config: the plugin must be able to read it in a real DSH
[ "$(printf '%s' "$S" | json_get routeAuth.known)" = "true" ] || fail "route auth unknown: DSH's route config could not be read"
echo "API-key routes: $(printf '%s' "$S" | json_get routeAuth.apiKeyRoutes)"
[ "$(curl -fsS -H "$HH" "$HUB/gpu/config" | json_get configured)" = "false" ] || fail "GPU server should be off by default"
[ "$(curl -fsS -H "$HH" "$HUB/hub/config" | json_get priceModels)" = "[]" ] || fail "priceModels should be empty by default"
[ "$(curl -fsS -H "$HH" "$HUB/spend?since=today" | json_get totals.calls)" = "0" ] || fail "a fresh ledger should be empty"

# CORS: the UI origin is echoed, a hostile one gets nothing
acao=$(curl -s -D - -o /dev/null -H "Origin: $UI" -H "$HH" "$HUB/status" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
[ "$acao" = "$UI" ] || fail "UI origin not allowed (got '$acao')"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: http://evil.example' "$HUB/status")
[ "$code" = "403" ] || fail "hostile origin GET returned $code"
# CSRF: a write needs the allowed Origin, the header and a JSON body
post() { curl -s -o /dev/null -w '%{http_code}' -X POST "$@" "$HUB/accounts/refresh"; }
[ "$(post -H 'Origin: http://evil.example' -H 'x-dsh-model-hub: 1' -H 'content-type: application/json' -d '{}')" = "403" ] || fail "hostile origin POST not refused"
[ "$(post -H "Origin: $UI" -H 'content-type: application/json' -d '{}')" = "403" ] || fail "POST without the hub header not refused"
[ "$(post -H "Origin: $UI" -H 'x-dsh-model-hub: 1')" = "415" ] || fail "POST without a JSON body not refused"
[ "$(post -H "Origin: $UI" -H 'x-dsh-model-hub: 1' -H 'content-type: application/json' -d '{}')" = "200" ] || fail "valid POST refused"
# DNS rebinding: a foreign Host header is refused
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:8185' "$HUB/healthz")
[ "$code" != "200" ] || fail "foreign Host header accepted"

step "data dir"
[ -d "$DSH_HOME/model-hub" ] || fail "data dir not under DSH_HOME"
mode=$(node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$DSH_HOME/model-hub")
[ "$mode" = "700" ] || fail "data dir mode $mode, expected 700"

step "CLI against the running hub"
node bin/dsh-hub.mjs status
node bin/dsh-hub.mjs status --json | json_get hub.reachable | grep -q true || fail "CLI status: hub not reachable"
node bin/dsh-hub.mjs doctor || fail "doctor reported a failed check on a fresh install"
[ "$(node bin/dsh-hub.mjs doctor --json | json_get ok)" = "true" ] || fail "doctor --json: ok is not true"

step "README Uninstall"
# "delete the three insert lines from cordis.patch.yml (if no entry is left, put back a line [])"
node -e '
const fs = require("fs"); const f = process.argv[1];
let t = fs.readFileSync(f, "utf8").replace(/^- insert:\n {4}- id: model-hub\n {6}name: .@local\/dsh-model-hub.\n?/m, "");
if (!/^- /m.test(t)) t = t.replace(/\s*$/, "\n[]\n");
fs.writeFileSync(f, t);' "$F"
echo "--- $F"; cat "$F"
grep -q 'model-hub' "$F" && fail "insert lines still present"
dsh plugin --profile web remove -w @local/dsh-model-hub
stop_web
start_web
sleep 5
code=$(curl -s -o /dev/null -w '%{http_code}' "$HUB/healthz" || true)
[ "$code" = "000" ] || fail "host API still answering after uninstall (HTTP $code)"
echo "dsh web is up and the plugin is gone"

step "OK"
