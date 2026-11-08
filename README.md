# dsh-model-hub

A plugin for DSH (DeepSeek Harness 0.2.2-rc.1) that turns it into a model hub: provider sign-ins, extra model
routes, optional GPU-server dispatch, per-model cost and spend caps, prompt-cache checks, and a `dsh-hub` CLI.
(Formerly `dsh-anthropic-membership`; the Claude Pro/Max pieces are still here.)

Public copy (DSH `dsh-plugin` topic): https://github.com/antonio-mastropaolo/dsh-model-hub — the old
`dsh-anthropic-membership` URL redirects there. DSH's `node_modules` are found portably (`lib/dsh-nm.mjs`):
set `DSH_NODE_MODULES` if your dsh is not a Homebrew/`/usr/local` npm global.

## What it does

- **Accounts** for Claude (Pro/Max), Codex (ChatGPT), GitHub Copilot, Kimi, OpenRouter and xAI: health, expiry,
  and a watchdog that refreshes grants ahead of expiry through DSH's own credential seam.
- **Routes** in the live settings: Google, DashScope and any OpenAI-compatible route you add (including your own
  GPU server).
- **GPU server dispatch** (optional, off until configured; see [GPU server (optional)](#gpu-server-optional)): see
  which GPUs are busy and who owns them, load a model on chosen GPUs, unload, return to automatic placement.
- **Cost + caps**: every model step is priced and appended to a ledger; metered requests over a cap are stopped
  before they are sent.
- **Cache check**: tracks prompt-cache hit ratio per session and alerts when it collapses.

## Sign in to Claude and Codex (DSH native flow)

1. Open DSH, Settings -> Models -> *Model hub* -> Accounts.
2. Click **Sign in** (or **Sign in again**) next to Claude or Codex. The panel opens the provider link, shows a
   device code or a paste box if the provider asks for one, and can be cancelled. The grant is stored by DSH
   itself at `llm-pi-ai/<provider>` in `~/.dsh/.credentials.yaml` and refreshed under DSH's cross-process lock.
3. The dot turns green once the watchdog confirms the grant.

Why the Codex CLI login is **not** imported: OpenAI refresh tokens rotate. If DSH and the Codex CLI shared one
grant (`~/.codex/auth.json`), whichever refreshed first would invalidate the other's token and log it out. DSH holds
its own, separate Codex grant, and this plugin never reads `~/.codex/auth.json`. The same goes for Claude: DSH has
its own grant. The old `login.mjs` / `logout.mjs` scripts and the `/login` / `/logout` routes were removed because
they wrote the credentials file without DSH's lock and could lose a rotated refresh token; sign-in and sign-out now
exist only through the native flow. This plugin never writes `llm-pi-ai/*` records.

## `dsh-hub` CLI

Install: `~/.local/bin/dsh-hub` -> `bin/dsh-hub.mjs`. Every command takes `--json`.

```
dsh-hub status                      host API health, plugin features, plan
dsh-hub accounts                    sign-in / expiry / watchdog state (exit 1 if a refresh failed)
dsh-hub gpus                        GPU cards, owners, loaded model, stale reservations, last failover
dsh-hub switch <model> [--gpus 2,3 | --auto] [--force]
dsh-hub unload                      unload the GPU server's model now
dsh-hub spend [--since today|7d|30d|all] [--by provider|model|session|day]
dsh-hub prices <provider/model>...  price rows (litellm / override / unpriced)
dsh-hub cache [--session <id>]      prompt-cache hit ratios
dsh-hub doctor                      end-to-end health check
```

## GPU dispatch (when a GPU server is configured)

- `switch <model>` loads a model and lets the manager choose GPUs. `--gpus 2,3` pins it to exactly those GPUs
  (the count must match the model's profile; the pin is refused, not guessed, if they are not free).
- A pin survives chat-triggered reloads of the same model. `switch <model> --auto` clears the pin (the loaded
  model keeps running where it is until you unload); the UI has the same *Return to auto* button.
- A server that implements the lease (the reference one does) holds a 300 s lease after any request, so a switch right after a chat answers `409`. Wait, or pass
  `--force`.
- `unload` stops the model now; nothing reloads until the next request.
- A stale reservation (for example `some-job-hold`) is shown with a `stale` tag. The plugin never deletes it.
- Other users' GPU processes are shown but never touched.

## GPU server (optional)

The GPU panel, the `gpus` / `switch` / `unload` commands and the `/gpu/*` host routes are **off** until you point
the plugin at a GPU server. With nothing configured nothing errors: the panel is hidden, `dsh-hub doctor` reports
the GPU server as "not configured" (OK), and the GPU commands exit 2 with a one-line hint.

Create `~/.dsh/model-hub/config.json` (or `$DSH_HUB_DATA_DIR/config.json`; it is re-read whenever the file changes):

```json
{
  "gpuServer": { "id": "mybox", "name": "My GPU box", "url": "http://127.0.0.1:8000", "icon": "nvidia",
                 "hideModels": ["flash-next"], "defaultModel": "my-model" },
  "localProviders": ["mybox", "mac"]
}
```

- `gpuServer` (or `null`): `url` must be http(s); `id` and `icon` match `[a-z0-9][a-z0-9-]{0,39}`; `name` is at most
  40 printable characters (default: the `id`). `icon` must be one of the embedded provider marks, else the UI
  falls back to `nvidia`. The panel title is `<name> GPUs`. Optional `hideModels`: up to 20 plain substrings
  (not regexes); models whose id contains one are left out of the panel's model list (e.g. dedicated containers
  the server cannot load or unload).
- `localProviders`: DSH provider ids billed as local ($0, never blocked by caps). The `gpuServer.id` is always
  included. List every self-hosted route here: DSH does not expose a route's base URL to plugins today, so
  loopback/private auto-detection (`localhost`, `127/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`,
  `*.local`) exists in `priceFor` but is not wired yet.
- Optional `defaultModel`: the model the panel preselects when nothing is loaded (else the first listed).
- `url` is a base URL: http(s), an optional path prefix, and no credentials, query or fragment.
- Env overrides: `DSH_HUB_GPU_URL`, `DSH_HUB_GPU_NAME` (`ROCCO_SHIM_URL` is accepted for back-compat). With env
  only, the server gets id `gpu`. An invalid env URL falls back to the file's URL and `dsh-hub doctor` says so.
- A provider that `prices.mjs` knows as metered or subscription (e.g. `google`, `anthropic`) is never treated as
  local, even if listed in `localProviders`.
- An invalid value never throws: the GPU server is turned off and the reason is shown by `dsh-hub doctor`.
- The config file is the only way to set the URL. Nothing in the host API can change it.

### What a GPU server must implement

The plugin only does server-to-server HTTP (no `Origin` header). All bodies are JSON; every reply must be JSON.

| Call | Timeout | Reply the plugin reads |
|---|---|---|
| `GET /v1/models` | 10 s | `{"data":[{"id","loaded","owned_by"}]}` (the UI lists models whose `owned_by` equals the server `id`, else every model not owned by `mac`) |
| `GET /v1/gpus` | 20 s | `{ok?, manager:{active}, tier, loaded_model, state_age_s, stale, gpus:[{index, used_mib, total_mib, util_pct, processes:[{user, cmd, used_mib}], reserved_by:[owner], reservation_stale}], reservations:[{owner, gpus, stale}], failover?, pin?:{gpus, error}}` |
| `POST /v1/switch` `{model, gpus?, force?, auto?}` | 30 s | `200` loaded, `202` switching (`{status, gpus?, was_pinned?}`), `400` bad request, `409` lease held (retry later or send `force:true`), `503` starved. Errors as `{error:"..."}`, `{error:{message}}` or `{detail:...}` |
| `POST /v1/unload` `{}` | 30 s | `200` `{status}` |
| `GET /health` | 5 s | `200` when up (used by `dsh-hub doctor`) |

`gpus` pins are unique GPU indices (`0..63`, at most 64; the server rejects indices it does not have); `model` matches `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`. Chat itself does **not**
go through the plugin: add the server's OpenAI-compatible `/v1/chat/completions` as a normal DSH route.

The author's own server is a private reference implementation and is not published. Any server that follows the
table above works.

## Caps file and ledger

- **Ledger**: `~/.dsh/model-hub/spend.jsonl` (0600, append-only, rotated at 20 MB). One row per model step with
  tokens, `usd` (what you are charged), `apiEquivUsd` (what the API would cost), price source and billing kind.
  No prompt or completion text is stored.
- **Caps**: `~/.dsh/model-hub/caps.json`, defaults `{"dailyUsd":40,"sessionUsd":15,"perProviderDailyUsd":{},"warnPct":50}`.
  A cap of 0 turns that cap off. Only **metered** providers (Google, OpenRouter, xAI, Ollama) are ever blocked;
  Claude/Codex/Copilot/Kimi (subscription), DashScope (free) and local providers (see `localProviders` above) are never blocked. A metered
  model with no known price adds $0 to the ledger, so it warns; if you set a `perProviderDailyUsd` cap for that
  provider, its unpriced requests are blocked instead (their spend cannot be counted). Fix by adding the price to
  `~/.dsh/model-hub/prices.json` (`{"provider/model": {"inPerM":..,"outPerM":..,"cacheReadPerM":..}}`).
- **Prices**: LiteLLM table cached 24 h in `prices.litellm.json`; offline fallback is discovered from a pip-installed
  litellm (or `DSH_HUB_PRICE_FALLBACK`). Overrides in `prices.json` win. Unknown models are `unpriced`, never guessed.
- The cap check reads the ledger fresh for every metered request, so a second DSH process's spend counts at once.
  Steps already in flight when a cap trips can still finish, so a cap can be overshot by those.

## macOS app window (Helixboard-style)

`/Applications/DSH v2.app` (pinned in the Dock) opens DeepSeek Harness in a chromeless Chrome `--app` window (same pattern as Helixcode Dashboard v1). It starts `dsh web` if needed (log: `~/Library/Logs/DSH/dsh-web.log`, 0600) and opens it with a launch token the server accepts (dsh mints a new one each boot). Build: copy `macos/Info.plist` → `Contents/`, `macos/launcher` → `Contents/MacOS/`, `DSH.icns` → `Contents/Resources/`.

The composer dock shows **Claude** 5h/weekly %, a **Full access** switch (sets `permission.defaultPreset` and `/permission danger-full-access` on the live session). The Codex chip was removed on 2026-11-08: nothing fetches Codex usage, so it could only ever say on/off (sign in to Codex under Model hub → Accounts).

## Host API + CLI

Host API on `127.0.0.1:8185` (Host header must be loopback:8185). Rules: any request carrying a
disallowed `Origin` gets 403 (GETs too); a POST needs an allowed Origin (`http://127.0.0.1:3080`,
`http://localhost:3080`) **and** header `x-dsh-model-hub: 1`, JSON body only (max 16 KB). CORS headers
are sent only for an allowed Origin. There is no legacy header and no `/login` or `/logout`: sign-in and sign-out go only through DSH's native flow. Responses never contain secrets.

| Route | What |
|---|---|
| `GET /status`, `/healthz` | features (imageCap, compactionSlim, spendGuard), plan usage, access |
| `GET /accounts` | provider health, expiry, watchdog state (`reportOnly` when no refresh seam). Each row has `errorKind` (`revoked` / `rejected` / `unreachable` / `other` / null) and `terminal`; `lastError` is a short URL-free string |
| `GET /accounts/flows`, `POST /accounts/signin {provider}`, `GET /accounts/signin/<p>`, `POST .../answer {text}`, `POST .../cancel` | DSH-native sign-in driven through `ctx.authorization` |
| `POST /accounts/refresh` | run the watchdog tick now, forced: also retries terminal (revoked) and backed-off grants |
| `GET /gpu/config` | `{configured, id, name, icon}` or `{configured:false}` (the URL is never exposed and cannot be set through the API) |
| `GET /gpu/gpus`, `/gpu/models`, `POST /gpu/switch {model, gpus? | auto?, force?}`, `POST /gpu/unload` | proxied to the configured GPU server. Unconfigured: GETs return 200 `{ok:false, configured:false}`, POSTs return 409 `{error:"no GPU server configured"}`. `/rocco/gpus`, `/rocco/models`, `/rocco/switch`, `/rocco/unload` remain as aliases |
| `GET /spend?since=today|7d|30d|all&by=provider|model|session|day` | ledger totals + caps status + `external` (meter ledger, display only; `null` when the file is missing) |
| `GET /prices?models=provider/model,...` | price rows (litellm / override / unpriced) + `providerHealth` |
| `GET /cache[?session=<id>]` | prompt-cache hit ratios |

Every completed model step is normalised, priced, appended to `~/.dsh/model-hub/spend.jsonl`, and fed to the
cache tracker. A metered request over a cap (`~/.dsh/model-hub/caps.json`) is stopped before it is sent, with a
`SPEND_CAP` error. Subscription, free and local routes are never blocked. `DSH_HUB_REFRESH=0` makes the account
watchdog report-only.

CLI (`~/.local/bin/dsh-hub`, every command takes `--json`):
`status | accounts | gpus | switch <model> [--gpus 2,3 | --auto] [--force] | unload | spend [--since] [--by] | prices <provider/model…> | cache [--session] | doctor`.
`accounts`, `spend`, `prices` read the data dir and work with DSH down; `status` and `cache` need the host API;
`gpus`, `switch`, `unload` talk to the configured GPU server directly (with none configured they print `no GPU server configured (see README: GPU server)` and exit 2). Tests: `npm test`.

## UI

The client bundle is `lib/client.js` (module id `@local/dsh-model-hub`, must equal the package name). It talks only to the host API on `127.0.0.1:8185` with the header `x-dsh-model-hub: 1`.

- **Settings -> Models -> "Model hub"** (slot `settings.models.footer`): Accounts (status dot, expiry, watchdog error, *Sign in* / *Sign in again* via DSH's native flow through `POST /accounts/signin*`, which opens the provider link, shows device codes, accepts a pasted code, and can be cancelled), `<name> GPUs` (shown only when a GPU server is configured; per-GPU cards with owners and a stale-reservation tag, model select, GPU checkboxes, Load / Unload with 2 s progress polling), Costs (today / API-equivalent / 7 days, daily cap meter, price rows).
- **Composer dock** (slot `conversation.composer.dock`): existing Claude and Codex chips plus `COST TODAY $X.XX · CACHE N%`. Colour follows `caps.action` (warn = amber, block = red); a cache-drop alert from `/cache` raises a toast with the reason.
- Claude's provider card is a read-only plan-usage card. When a GPU pin is active the GPU panel shows a *Return to auto* button.
- Screenshots (headless Chromium, 1400 px and 900 px): `docs/specs/screens/`.
- Deploy: `cd ~ && dsh plugin --profile web install` (client.js changes load on page refresh; no DSH restart needed).

## Account errors, external spend, provider health

- **Terminal refresh failures.** When a refresh fails with `invalid_grant` / `unauthorized_client` (`errorKind: "revoked"`), the
  watchdog stops retrying (`terminal: true`) until the stored credential's expiry changes (a new sign-in) or
  `POST /accounts/refresh` forces a tick. Other kinds (`rejected` 401/403, `unreachable` timeouts/5xx, `other`) keep the 15 min backoff.
  `/status` does not call the usage API for an expired Anthropic grant (`plan: {mode:"expired", expiresAt}`); `codex.available` is true
  only for an unexpired openai-codex grant.
- **External spend is DISPLAY ONLY.** `GET /spend` adds `external` from the agent-patcher meter ledger
  (`~/.claude/abliteration/spend.jsonl`, override with env `DSH_HUB_EXTRA_LEDGERS`, a single path; rows without `provider` count as
  `abliteration`). It is never read by the caps or the spend guard: caps still see only `~/.dsh/model-hub/spend.jsonl`.
- **providerHealth.** The `llm/stream` listener watches each request's terminal `finish` chunk; a provider failure with HTTP 402,
  `insufficient_quota` or a "credit" message is recorded in `~/.dsh/model-hub/provider-health.json` (0600) and shown in
  `GET /prices` as `providerHealth[provider] = {code, message, at}`. The next successful step from that provider clears it.
  The hub's own `SPEND_CAP` blocks are never recorded.
- `/gpu/*` (and `/rocco/*`) error replies are always `{ error: <string> }`.

## License and attribution

MIT © 2026 Antonio Mastropaolo — see [`LICENSE`](LICENSE). Source: https://github.com/antonio-mastropaolo/dsh-model-hub.
If you reuse or index this code, keep the copyright notice and attribute it to Antonio Mastropaolo and
`antonio-mastropaolo/dsh-model-hub`. Embedded provider icons come from LobeHub Icons (MIT); see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

