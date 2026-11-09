# dsh-model-hub

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH ≥ 0.2.2) that adds a
**Model hub** to Settings → Models: provider accounts with DSH-native sign-in and a refresh watchdog, a per-model
cost ledger with spend caps, prompt-cache checks, an optional GPU-server panel, and a `dsh-hub` CLI.
(Formerly `dsh-anthropic-membership`; that URL redirects here.)

## Install

Requirements: Node ≥ 22.12 and DSH ≥ 0.2.2 (`npm i -g @deepseek-ai/dsh`). macOS or Linux.

```sh
git clone https://github.com/antonio-mastropaolo/dsh-model-hub.git
cd dsh-model-hub
dsh --profile web --dump-config > /dev/null        # creates the web profile on first use
dsh plugin --profile web add -w "file:$PWD"        # -w: pnpm adds it at the profile root
```

Then enable it in the profile's patch file, `${DSH_HOME:-~/.dsh}/profiles/web/cordis.patch.yml`. A new profile's
file is just `[]` (an empty YAML list), which the entry must **replace**, not follow — from the repo directory:

```sh
F="${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"
sed -i.bak '/^\[\]$/d' "$F" && cat cordis.patch.yml >> "$F"     # keeps a .bak copy
```

which leaves the file ending with this entry (the same snippet as this repo's `cordis.patch.yml`):

```yaml
- insert:
    - id: model-hub
      name: '@local/dsh-model-hub'
```

Start `dsh web` (it serves on `http://127.0.0.1:3080` by default) and open **Settings → Models → Model hub**.

- **CLI (optional):** `ln -s "$PWD/bin/dsh-hub.mjs" ~/.local/bin/dsh-hub`, or run `node bin/dsh-hub.mjs <command>`.
- **Update:** `git pull && dsh plugin --profile web install`, then restart `dsh web` (pnpm copies `file:` dependencies,
  so a pull alone does not reach DSH).
- **Uninstall:** delete the three `insert` lines from `cordis.patch.yml` (if no entry is left, put back a line `[]`),
  then `dsh plugin --profile web remove -w @local/dsh-model-hub`.
- The package is named `@local/dsh-model-hub` and marked `private`: it is not published to npm; install it from a clone.
- If your `dsh` is not an npm global under Homebrew or `/usr/local`, set `DSH_NODE_MODULES` to the `node_modules`
  directory of the installed `@deepseek-ai/dsh` package. Without it the plugin still loads and costs, caps, cache
  checks and the GPU panel keep working; the account list and refresh watchdog, the Claude plan card and the
  request-image cap turn off (they use DSH's own `yaml`, `pi-ai` and `sharp`).

## What it adds

- **Accounts** (Claude Pro/Max, Codex, GitHub Copilot, Kimi, OpenRouter, xAI): signed-in state, expiry, a watchdog
  that refreshes grants ahead of expiry through DSH's own credential store, and **Sign in / Sign in again** buttons
  that drive DSH's native sign-in flow (see below).
- **Costs and caps**: every model step is priced (LiteLLM's public price table plus your overrides) and appended to
  a local ledger; requests to metered providers are stopped *before they are sent* once a daily, per-session or
  per-provider cap is reached.
- **Cache check**: prompt-cache hit ratio per session, with an alert when it collapses (e.g. the system prompt or
  the tool set changed mid-session).
- **GPU server** (optional, off until configured): GPU cards with owners, load a model on chosen GPUs, unload,
  return to automatic placement — for any server that implements [the small HTTP contract below](#what-a-gpu-server-must-implement).
- **`dsh-hub` CLI** for all of the above, scriptable with `--json`.

The plugin does not add model routes: add providers (Google, OpenRouter, DashScope, a self-hosted server, …) in
DSH's own **Settings → Models → Add model provider**; the hub then prices and caps them.

## Sign in to Claude, Codex and the others

1. Settings → Models → *Model hub* → **Accounts**.
2. Click **Sign in** (or **Sign in again**). Some providers first ask how to sign in (for Claude: *Browser login* or
   *Copy code*); pick one. The panel opens the provider's page, shows a device code or a paste box when the provider
   asks for one, and can be cancelled. With *Browser login* the provider redirects back to DSH and the sign-in finishes
   by itself.
3. The grant is stored by DSH at `llm-pi-ai/<provider>` in `${DSH_HOME:-~/.dsh}/.credentials.yaml` and refreshed under
   DSH's cross-process lock. This plugin never writes credential records or DSH settings files.

The Codex CLI login (`~/.codex/auth.json`) is deliberately **not** imported: OpenAI refresh tokens rotate, so two
programs sharing one grant log each other out. DSH keeps its own, separate grant.

## `dsh-hub` CLI

Every command takes `--json` (errors then come as `{"error": "...", "code": N}` on stdout, with the same exit code).

```
dsh-hub status                      host API health, plugin features, Claude plan
dsh-hub accounts                    sign-in / expiry / watchdog state (exit 1 if a refresh failed)
dsh-hub spend [--since today|7d|30d|all] [--by provider|model|session|day]
dsh-hub prices <provider/model>...  price rows (litellm / override / unpriced)
dsh-hub cache [--session <id>]      prompt-cache hit ratios
dsh-hub gpus                        GPU cards, owners, loaded model           (GPU server only)
dsh-hub switch <model> [--gpus 2,3 | --auto] [--force]                        (GPU server only)
dsh-hub unload                      unload the GPU server's model now        (GPU server only)
dsh-hub doctor                      end-to-end health check
```

`accounts`, `spend` and `prices` read the data dir and work with DSH stopped; `status` and `cache` need the host API
(`DSH_HUB_URL`, default `http://127.0.0.1:8185`); the GPU commands talk to the configured GPU server and exit 2 with a
hint when none is configured.

## Configuration

Everything lives in the **data dir**: `$DSH_HUB_DATA_DIR`, else `$DSH_HOME/model-hub`, else `~/.dsh/model-hub`
(created `0700`; files `0600`). `dsh-hub doctor` prints the one in use.

`config.json` (optional; re-read whenever it changes; an invalid value never throws — it is ignored and reported by
`dsh-hub doctor`):

```json
{
  "gpuServer": { "id": "mybox", "name": "My GPU box", "url": "http://127.0.0.1:8000", "icon": "nvidia",
                 "hideModels": ["flash-next"], "defaultModel": "my-model" },
  "localProviders": ["mybox", "mac"],
  "hub": { "allowedOrigins": ["http://127.0.0.1:3200"] },
  "priceModels": ["google/gemini-3.8-flash"],
  "extraLedgers": ["/absolute/path/to/another/spend.jsonl"]
}
```

| Key | Meaning |
|---|---|
| `gpuServer` | the optional GPU server (see [GPU server](#gpu-server-optional)); `null` or absent = off |
| `localProviders` | DSH provider ids priced as local ($0, never capped); the GPU server's `id` is always included. A provider the price table knows as metered or subscription (e.g. `google`, `anthropic`) is never treated as local |
| `hub.allowedOrigins` | extra exact origins allowed to call the host API (see [Security model](#security-model)) |
| `priceModels` | `provider/model` rows always shown in the Costs panel (besides models you actually used) |
| `extraLedgers` | other spend ledgers (JSONL rows with `ts`, `usd`, optional `provider`) shown next to DSH's spend, **display only** |

Other files in the data dir: `spend.jsonl` (ledger), `caps.json`, `prices.json` (price overrides),
`prices.litellm.json` (24 h price-table cache), `accounts-state.json`, `provider-health.json`.

| Environment variable | Effect |
|---|---|
| `DSH_HUB_DATA_DIR` | data dir override |
| `DSH_HUB_URL` | where the CLI reaches the host API (default `http://127.0.0.1:8185`) |
| `DSH_HUB_ALLOWED_ORIGINS` | extra UI origins, comma-separated |
| `DSH_NODE_MODULES` | the installed `@deepseek-ai/dsh` package's `node_modules`, if not auto-found |
| `DSH_HUB_GPU_URL`, `DSH_HUB_GPU_NAME` | GPU server URL / name override (`ROCCO_SHIM_URL` is accepted for back-compat) |
| `DSH_HUB_EXTRA_LEDGERS` | extra ledgers, comma-separated absolute paths (overrides `extraLedgers`) |
| `DSH_HUB_PRICE_FALLBACK` | an offline LiteLLM price-table file used when the network fetch fails |
| `DSH_HUB_REFRESH=0` | account watchdog reports only, never refreshes |

## Costs, caps and the ledger

- **Ledger** `spend.jsonl`: one row per model step with token counts, `usd` (what you are charged), `apiEquivUsd`
  (what the API list price would be), price source and billing kind. **No prompt or completion text is stored.**
  Rotated at 20 MB; several DSH processes can append at once without losing rows.
- **Caps** `caps.json`, defaults `{"dailyUsd":40,"sessionUsd":15,"perProviderDailyUsd":{},"warnPct":50}`; a cap of 0
  turns it off. Only **metered** calls are ever blocked; subscription, free and local ones never are. Steps already
  in flight when a cap trips can still finish.
- **Billing kind**: a provider counts as **subscription** ($0 charged, API-list equivalent still recorded) only while
  DSH holds an OAuth sign-in for it (Claude Pro/Max, ChatGPT/Codex, Copilot, Kimi). The same provider used with an
  API key is **metered**. Every other API (Google, OpenRouter, DashScope, …) is metered; a model is **free** only if
  `prices.json` says so (`"billing": "free"`), and **local** if its provider is in `localProviders`.
- **Prices**: LiteLLM's public table (fetched over HTTPS, size-capped, cached 24 h). Overrides in `prices.json`
  (`{"provider/model": {"inPerM": 1.25, "outPerM": 10, "cacheReadPerM": 0.125, "billing": "metered"}}`, `billing`
  optional) win, and edits to the file apply without a restart. A model with no known price
  is `unpriced`, never guessed: its calls are stored at $0 and **do not count toward caps** — the Costs panel shows
  "N unpriced calls" and the host logs the model once, so you can add it to `prices.json`. If a provider has a
  `perProviderDailyUsd` cap, its unpriced models are blocked instead (their spend could not be counted).

## GPU server (optional)

The GPU panel, `gpus` / `switch` / `unload` and the `/gpu/*` routes are **off** until `config.json` names a GPU server.
With none configured the panel is hidden, the GPU routes answer `{configured:false}` (POSTs `409`), and
`dsh-hub doctor` reports "not configured" (OK).

`gpuServer` fields: `url` (http(s) base URL; optional path prefix; no credentials, query or fragment), `id` and `icon`
(`[a-z0-9][a-z0-9-]{0,39}`; `icon` must be one of the embedded provider marks, else `nvidia`), `name` (≤ 40 printable
characters; the panel title is `<name> GPUs`), optional `hideModels` (≤ 20 plain substrings, not regexes, of model ids
to leave out of the panel) and `defaultModel` (preselected when nothing is loaded).

- `switch <model>` loads a model and lets the server choose GPUs; `--gpus 2,3` pins it (the server refuses a pin it
  cannot honour). `--auto` clears a pin. A server may hold a short lease after a request and answer `409`; wait or
  pass `--force`. `unload` stops the model now.
- Other users' GPU processes and stale reservations are shown, never touched.

### What a GPU server must implement

The plugin calls the server server-to-server (no `Origin`), JSON in and out:

| Call | Timeout | Reply the plugin reads |
|---|---|---|
| `GET /v1/models` | 10 s | `{"data":[{"id","loaded","owned_by"}]}` — the panel lists models whose `owned_by` equals the server `id` (else every model not owned by `mac`) |
| `GET /v1/gpus` | 20 s | `{ok?, manager:{active}, loaded_model, state_age_s, stale, gpus:[{index, used_mib, total_mib, util_pct, processes:[{user, cmd, used_mib}], reserved_by:[owner], reservation_stale}], reservations:[{owner, gpus, stale}], pin?:{gpus, error}}` |
| `POST /v1/switch` `{model, gpus?, force?, auto?}` | 30 s | `200` loaded, `202` switching, `400` bad request, `409` lease held, `503` no GPUs free; errors as `{error}` / `{error:{message}}` / `{detail}` |
| `POST /v1/unload` `{}` | 30 s | `200` `{status}` |
| `GET /health` | 5 s | `200` when up |

Pins are unique GPU indices `0..63`; model ids match `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`. Chat does not go through the
plugin: add the server's OpenAI-compatible `/v1/chat/completions` as a normal DSH route.

## Security model

- The host API listens on **127.0.0.1:8185 only** and checks the `Host` header (DNS-rebinding protection).
- A request carrying a disallowed `Origin` is refused, so **web pages cannot use it**. Allowed UI origins: DSH's
  default `http://127.0.0.1:3080` / `http://localhost:3080`, the origin DSH itself advertises (so a `dsh web --port N`
  works without configuration), plus `hub.allowedOrigins` / `DSH_HUB_ALLOWED_ORIGINS`.
- Every state-changing request, and every read of a pending sign-in (whose authorize URL carries OAuth state),
  additionally needs the header `x-dsh-model-hub: 1`, a JSON body (≤ 16 KB) and an allowed `Origin`.
- Error text (API replies, CLI errors, stored account errors), host log lines and GPU process command lines pass
  through one redactor: known token shapes, `key=` / `token=` style parameters, `--api-key` style flags and long
  opaque strings. Ids, model names and file paths are not redacted. The ledger never holds prompt or completion text.
- **Trust boundary:** programs running as *your* user are trusted — they can read DSH's credential store directly
  anyway. Other accounts on the same machine can reach loopback ports, so use it on a single-user machine.
- No npm dependencies; the plugin loads DSH's own `yaml` and `sharp` from DSH's install (`DSH_NODE_MODULES`).

## Host API

| Route | What |
|---|---|
| `GET /healthz`, `/status` | health and `webOrigin` (the DSH web origin this hub serves); `/status` adds features (imageCap, compactionSlim, spendGuard) and Claude plan usage |
| `GET /accounts` | provider health, expiry, watchdog state, short redacted `lastError` |
| `GET /accounts/flows`, `POST /accounts/signin {provider}`, `GET /accounts/signin/<p>`, `POST /accounts/signin/<p>/answer {text}`, `POST /accounts/signin/<p>/cancel` | DSH-native sign-in. A stuck attempt expires after 10 min; cancel is immediate |
| `POST /accounts/refresh` | run the watchdog now |
| `GET /spend?since=today\|7d\|30d\|all&by=provider\|model\|session\|day` | ledger totals (incl. `unpricedCalls`), caps status, `external` (extra ledgers, display only) |
| `GET /prices?models=provider/model,...`, `GET /hub/config` | price rows + provider credit health; `priceModels` |
| `GET /cache[?session=<id>]` | prompt-cache hit ratios |
| `GET /gpu/config`, `/gpu/gpus`, `/gpu/models`, `POST /gpu/switch`, `POST /gpu/unload` | the GPU server (proxied); `/rocco/*` are kept as aliases |

**Port 8185 is fixed** (the browser half of the plugin cannot discover another). If a second DSH instance starts,
its host logs that the port is in use and serves nothing; that instance's UI then reaches the *first* instance's hub.
Its origin is normally not on the first one's allowlist, so its panels say "not reachable"; if you did allowlist it,
the panels show a notice that the data belongs to the other instance. Cost capture and caps still run in every
instance.

## Known limitations

- The Claude plan card (5-hour / weekly %) reads an **undocumented** Anthropic OAuth usage endpoint; it may change
  or stop working without notice, in which case the card shows "unavailable" and nothing else is affected.
- DSH does not expose a route's base URL to plugins, so self-hosted routes must be listed in `localProviders` to be
  priced at $0 (loopback/private auto-detection is implemented but cannot be wired yet).
- One DSH instance per machine gets working Model hub panels (port 8185); see [Host API](#host-api).

## macOS launcher

`macos/` holds an optional Dock launcher (a Chrome `--app` window around `dsh web`). It is an example tuned to the
author's setup; see [`macos/README.md`](macos/README.md) before using it.

## Development

`npm test` runs the suite (`node --test`, no npm dependencies). Plain ESM, Node built-ins only. Two integration
tests use DSH's own `sharp` and `yaml`; they are skipped, not failed, when DSH is not installed (set
`DSH_NODE_MODULES` to run them).

## License and attribution

MIT © 2026 Antonio Mastropaolo — see [`LICENSE`](LICENSE). Source: https://github.com/antonio-mastropaolo/dsh-model-hub.
If you reuse or index this code, keep the copyright notice and attribute it to Antonio Mastropaolo and
`antonio-mastropaolo/dsh-model-hub`. Embedded provider icons come from LobeHub Icons (MIT); see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
