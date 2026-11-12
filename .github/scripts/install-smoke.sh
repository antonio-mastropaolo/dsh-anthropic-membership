#!/usr/bin/env bash
# CI smoke test: follow README "Install", "Uninstall" and "Upgrading from @local/dsh-model-hub (v2)" in throwaway
# DSH_HOMEs, with the packed tarball (what will be published) as the package, and check the plugin's host API from the
# outside while `dsh web` runs. Needs: dsh on PATH, pnpm, node, curl, npm, git, and a clean machine (ports 3080 and 8185).
#   --no-web   run only the config-level steps (install, uninstall, upgrade, row counts, data marker). Starts nothing,
#              binds no port, calls no curl.
#   PLUGIN_SPEC  what `dsh plugin add` installs (default: the packed tarball; `dsh-model-hub` = the registry)
#   V2_DIR       an unpacked v2 tree (default: a git worktree of V2_REF)
#   V2_REF       the last v2 commit (default a5b00d2)
set -euo pipefail

NO_WEB=0
[ "${1:-}" = "--no-web" ] && NO_WEB=1
PLUGIN_SPEC="${PLUGIN_SPEC:-}"
V2_DIR="${V2_DIR:-}"
V2_REF="${V2_REF:-a5b00d2}"
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

profile_dir() { printf '%s/profiles/web' "$DSH_HOME"; }
readme_has() { # readme_has <file> ; commands on stdin, each must appear verbatim in that README (drift guard)
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    grep -Fq -- "$c" "$1" || fail "$1 no longer contains the command the smoke runs: $c"
  done
}
count_rows() { # count_rows <name line regexp> : rows of that name in the composed web profile
  dsh --profile web --dump-config 2>/dev/null | grep -Ec "$1" || true
}
expect_rows() { # expect_rows <name line regexp> <n> <what> : the web profile holds exactly n such rows
  got=$(count_rows "$1")
  echo "rows $3: $got (want $2)"
  [ "$got" = "$2" ] || fail "$3: expected $2 row(s) matching $1, found $got"
}
web_up() { [ "$NO_WEB" = 1 ] || start_web; }
web_down() { [ "$NO_WEB" = 1 ] || stop_web; }
healthz_ok() { # wait for the plugin's host API on the web origin, then assert it
  for _ in $(seq 1 60); do
    H=$(curl -fsS "$HUB/healthz" 2>/dev/null || true)
    [ -n "$H" ] && [ "$(printf '%s' "$H" | json_get webOrigin)" = "\"$UI\"" ] && break
    sleep 1
  done
  echo "healthz: ${H:-<none>}"
  [ "$(printf '%s' "$H" | json_get ok)" = "true" ] || fail "host API /healthz not ok"
  [ "$(printf '%s' "$H" | json_get webOrigin)" = "\"$UI\"" ] || fail "webOrigin is not $UI"
}

step "pack (the tarball that will be published)"
TGZ=$(cd "$REPO" && npm pack --ignore-scripts --pack-destination "$WORK" | tail -n 1)
: "${PLUGIN_SPEC:=file:$WORK/$TGZ}"
tar -tzf "$WORK/$TGZ" > "$WORK/tarball.lst"
grep -qx 'package/cordis.patch.yml' "$WORK/tarball.lst" || fail "the tarball has no cordis.patch.yml (dsh.bundle.patch points at it)"
grep -Eq '^package/(docs|macos)/' "$WORK/tarball.lst" && fail "the tarball ships docs/ or macos/"
echo "package: $TGZ, install spec: $PLUGIN_SPEC"

step "README Install (DSH_HOME=$DSH_HOME)"
readme_has README.md <<'EOF'
dsh plugin --profile web add -w dsh-model-hub
dsh plugin --profile web add -w "file:$PWD"
EOF
dsh plugin --profile web add -w "$PLUGIN_SPEC"
expect_rows '^  name: dsh-model-hub$' 1 "install, dsh-model-hub"
expect_rows "^  name: '@local/" 0 "install, @local"
if grep -q '^- ' "$(profile_dir)/cordis.patch.yml"; then fail "the install added an entry to the profile's cordis.patch.yml"; fi
HUB_CLI="$(profile_dir)/node_modules/dsh-model-hub/bin/dsh-hub.mjs"
DSH_HUB_DATA_DIR="$WORK/cli-data" DSH_HUB_URL="http://127.0.0.1:9" node "$HUB_CLI" --help | grep -q 'usage: dsh-hub' || fail "the installed dsh-hub CLI does not answer"
[ "$(node -e 'process.stdout.write(require(process.argv[1]).name)' "$(profile_dir)/node_modules/dsh-model-hub/package.json")" = "dsh-model-hub" ] || fail "the installed package is not dsh-model-hub"

step "start dsh web"
web_up
if [ "$NO_WEB" = 0 ]; then
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
fi

step "README Uninstall"
readme_has README.md <<'EOF'
dsh plugin --profile web remove -w dsh-model-hub
EOF
web_down
dsh plugin --profile web remove -w dsh-model-hub
expect_rows '^  name: dsh-model-hub$' 0 "uninstall, dsh-model-hub"
if grep -q 'model-hub' "$(profile_dir)/package.json"; then fail "uninstall: package.json still names model-hub"; fi
web_up
if [ "$NO_WEB" = 0 ]; then
  sleep 5
  code=$(curl -s -o /dev/null -w '%{http_code}' "$HUB/healthz" || true)
  [ "$code" = "000" ] || fail "host API still answering after uninstall (HTTP $code)"
  echo "dsh web is up and the plugin is gone"
fi
web_down

step "README: Upgrading from v2 (DSH_HOME=$WORK/dsh-home-v2)"
export DSH_HOME="$WORK/dsh-home-v2"
if [ -z "$V2_DIR" ]; then
  git -C "$REPO" worktree add --detach "$WORK/v2" "$V2_REF" > /dev/null
  V2_DIR="$WORK/v2"
fi
readme_has "$V2_DIR/README.md" <<'EOF'
dsh --profile web --dump-config > /dev/null
dsh plugin --profile web add -w "file:$PWD"
sed -i.bak '/^\[\]$/d' "$F" && cat cordis.patch.yml >> "$F"
EOF
(
  cd "$V2_DIR"
  dsh --profile web --dump-config > /dev/null
  dsh plugin --profile web add -w "file:$PWD"
  F="${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"
  sed -i.bak '/^\[\]$/d' "$F" && cat cordis.patch.yml >> "$F"
)
expect_rows "^  name: '@local/dsh-model-hub'$" 1 "v2 install, @local/dsh-model-hub"
web_up
[ "$NO_WEB" = 1 ] || healthz_ok
web_down
# shellcheck disable=SC2174 # -m is meant for the deepest directory only; $DSH_HOME already exists
mkdir -p -m 700 "$DSH_HOME/model-hub" && echo keep > "$DSH_HOME/model-hub/upgrade-marker"
readme_has README.md <<'EOF'
F="${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"
sed -i.bak '/^- insert:$/{N;N;/@local\/dsh-model-hub/d;}' "$F"
grep -q -e '^- ' -e '^\[\]$' "$F" || printf '[]\n' >> "$F"
dsh plugin --profile web remove -w @local/dsh-model-hub
dsh plugin --profile web add -w dsh-model-hub
EOF
upgrade_block() { # the README block, run in a v2 home; $1 = remove | skip-remove (a second run: pnpm rejects the remove)
  F="${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"
  sed -i.bak '/^- insert:$/{N;N;/@local\/dsh-model-hub/d;}' "$F"
  grep -q -e '^- ' -e '^\[\]$' "$F" || printf '[]\n' >> "$F"
  if [ "$1" = remove ]; then dsh plugin --profile web remove -w @local/dsh-model-hub; fi
  dsh plugin --profile web add -w "$PLUGIN_SPEC"
}
upgrade_asserts() {
  expect_rows "^  name: '@local/" 0 "upgrade, @local"
  expect_rows '^  name: dsh-model-hub$' 1 "upgrade, dsh-model-hub"
  if grep -q '@local' "$(profile_dir)/package.json"; then fail "upgrade: package.json still names @local/"; fi
  [ "$(cat "$DSH_HOME/model-hub/upgrade-marker")" = "keep" ] || fail "upgrade: the data marker in model-hub is gone"
}
upgrade_block remove
upgrade_asserts
web_up
[ "$NO_WEB" = 1 ] || healthz_ok
web_down
step "README: the upgrade block run twice is harmless"
upgrade_block skip-remove
upgrade_asserts

step "OK"
