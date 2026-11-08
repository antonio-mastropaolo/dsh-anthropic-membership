# dsh-model-hub

A plugin for DSH (DeepSeek Harness 0.2.2-rc.1) that turns it into a model hub: provider sign-ins, extra model
routes, rocco GPU dispatch, per-model cost and spend caps, prompt-cache checks, and a `dsh-hub` CLI.
(Formerly `dsh-anthropic-membership`; the Claude Pro/Max pieces are still here.)

Public copy (DSH `dsh-plugin` topic): https://github.com/antonio-mastropaolo/dsh-model-hub — the old
`dsh-anthropic-membership` URL redirects there. DSH's `node_modules` are found portably (`lib/dsh-nm.mjs`):
set `DSH_NODE_MODULES` if your dsh is not a Homebrew/`/usr/local` npm global.

## What it does

- **Accounts** for Claude (Pro/Max), Codex (ChatGPT), GitHub Copilot, Kimi, OpenRouter and xAI: health, expiry,
  and a watchdog that refreshes grants ahead of expiry through DSH's own credential seam.
- **Routes** in the live settings: Google, DashScope, rocco (OrcaRouter `rocco-qwen38-q4` first, Mac static
  `mac-qwen38-q4`, plus roster models). Default model: `rocco` / `rocco-qwen38-q4`.
- **rocco GPU dispatch**: see which of the 4 L40S are busy and who owns them, load a model on chosen GPUs, unload,
  return to automatic placement. If OrcaRouter is unreachable or starved, the shim serves the same model from the
  Mac (`x-rocco-failover: mac-qwen38-q4`).
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
dsh-hub unload                      unload the rocco model now
dsh-hub spend [--since today|7d|30d|all] [--by provider|model|session|day]
dsh-hub prices <provider/model>...  price rows (litellm / override / unpriced)
dsh-hub cache [--session <id>]      prompt-cache hit ratios
dsh-hub doctor                      end-to-end health check
```

## GPU dispatch

- `switch <model>` loads a model and lets the manager choose GPUs. `--gpus 2,3` pins it to exactly those GPUs
  (the count must match the model's profile; the pin is refused, not guessed, if they are not free).
- A pin survives chat-triggered reloads of the same model. `switch <model> --auto` clears the pin (the loaded
  model keeps running where it is until you unload); the UI has the same *Return to auto* button.
- The shim holds a 300 s lease after any request, so a switch right after a chat answers `409`. Wait, or pass
  `--force`.
- `unload` stops the model now; nothing reloads until the next request.
- A stale reservation (for example `study-dsv41-hold`) is shown with a `stale` tag. The plugin never deletes it.
- Other users' GPU processes are shown but never touched.

## Caps file and ledger

- **Ledger**: `~/.dsh/model-hub/spend.jsonl` (0600, append-only, rotated at 20 MB). One row per model step with
  tokens, `usd` (what you are charged), `apiEquivUsd` (what the API would cost), price source and billing kind.
  No prompt or completion text is stored.
- **Caps**: `~/.dsh/model-hub/caps.json`, defaults `{"dailyUsd":40,"sessionUsd":15,"perProviderDailyUsd":{},"warnPct":50}`.
  A cap of 0 turns that cap off. Only **metered** providers (Google, OpenRouter, xAI, Ollama) are ever blocked;
  Claude/Codex/Copilot/Kimi (subscription), DashScope (free) and rocco/Mac (local) are never blocked. A metered
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
| `GET /rocco/gpus`, `/rocco/models`, `POST /rocco/switch {model, gpus? | auto?, force?}`, `POST /rocco/unload` | proxied to the shim on `:4010` |
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
`gpus`, `switch`, `unload` talk to the shim directly. Tests: `npm test`.

## UI

The client bundle is `lib/client.js` (module id `@local/dsh-model-hub`, must equal the package name). It talks only to the host API on `127.0.0.1:8185` with the header `x-dsh-model-hub: 1`.

- **Settings -> Models -> "Model hub"** (slot `settings.models.footer`): Accounts (status dot, expiry, watchdog error, *Sign in* / *Sign in again* via DSH's native flow through `POST /accounts/signin*`, which opens the provider link, shows device codes, accepts a pasted code, and can be cancelled), rocco GPUs (per-GPU cards with owners and a stale-reservation tag, model select, GPU checkboxes, Load / Unload with 2 s progress polling), Costs (today / API-equivalent / 7 days, daily cap meter, price rows).
- **Composer dock** (slot `conversation.composer.dock`): existing Claude and Codex chips plus `COST TODAY $X.XX · CACHE N%`. Colour follows `caps.action` (warn = amber, block = red); a cache-drop alert from `/cache` raises a toast with the reason.
- Claude's provider card is a read-only plan-usage card. When a GPU pin is active the rocco panel shows a *Return to auto* button.
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
- `/rocco/*` error replies are always `{ error: <string> }`.

## License and attribution

MIT © 2026 Antonio Mastropaolo — see [`LICENSE`](LICENSE). Source: https://github.com/antonio-mastropaolo/dsh-model-hub.
If you reuse or index this code, keep the copyright notice and attribute it to Antonio Mastropaolo and
`antonio-mastropaolo/dsh-model-hub`. Embedded provider icons come from LobeHub Icons (MIT); see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

