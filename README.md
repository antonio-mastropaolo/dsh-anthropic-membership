# dsh-model-hub

[![CI](https://github.com/antonio-mastropaolo/dsh-model-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/antonio-mastropaolo/dsh-model-hub/actions/workflows/ci.yml)

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH ≥ 0.2.2-rc.1) that adds a
**Model hub** to Settings → Models: provider accounts with DSH-native sign-in and a refresh watchdog, a per-model
cost ledger with spend caps, prompt-cache checks, an optional GPU-server panel, and a `dsh-hub` CLI.
(Formerly `dsh-anthropic-membership`, and in v2 `@local/dsh-model-hub`; see [Upgrading](#upgrading-from-localdsh-model-hub-v2).)

## Install

Requirements: DSH ≥ 0.2.2-rc.1, the current `latest` release (`npm i -g @deepseek-ai/dsh`, which itself needs Node ≥ 24.9) and `pnpm` on your `PATH`
(`npm i -g pnpm`: `dsh plugin` installs plugins with it; CI uses pnpm 9). macOS or Linux. The `dsh-hub` CLI and the
test suite run on Node ≥ 22.12. CI installs the packed tarball (the file that will be published, not the registry name) with
the commands below on Ubuntu and macOS and checks the running host API ([`.github/scripts/install-smoke.sh`](.github/scripts/install-smoke.sh)).

```sh
dsh plugin --profile web add -w dsh-model-hub
```

That is the whole install. `dsh plugin` creates the `web` profile on first use, installs the package with pnpm and, because the
package declares a `dsh.bundle` ([`cordis.patch.yml`](cordis.patch.yml), one `model-hub` entry), lists it among the profile's
bundles: the profile's own `cordis.patch.yml` needs no edit. (`-w` is required: pnpm refuses to add to the profile root without it.)
Start `dsh web` (it serves on `http://127.0.0.1:3080` by default) and open **Settings → Models → Model hub**.

From a clone (development; the clone's `package.json` is the same bundle, so this needs no patch edit either):

```sh
git clone https://github.com/antonio-mastropaolo/dsh-model-hub.git
cd dsh-model-hub
dsh plugin --profile web add -w "file:$PWD"
```

- **CLI (optional):** `ln -s "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-model-hub/bin/dsh-hub.mjs" ~/.local/bin/dsh-hub`
  (from a clone: `ln -s "$PWD/bin/dsh-hub.mjs" ~/.local/bin/dsh-hub`, or run `node bin/dsh-hub.mjs <command>`).
- **Update:** `dsh plugin --profile web add -w dsh-model-hub@latest`, then restart `dsh web`. From a clone:
  `git pull && dsh plugin --profile web add -w "file:$PWD"` (pnpm copies `file:` dependencies, so a pull alone does not reach DSH).
- **Uninstall:** `dsh plugin --profile web remove -w dsh-model-hub`, then restart `dsh web`. Your ledger, caps and settings stay in
  `${DSH_HOME:-~/.dsh}/model-hub`; delete that folder too if you want them gone.
- **Compatibility:** the package declares `engines.dsh` `>=0.2.2-rc.1 <0.3.0-0`. DSH refuses a bundle outside that range; to run it
  anyway use `dsh plugin --profile web allow-version dsh-model-hub@<version> --dsh-version <exact> --accept-risk`.
- The plugin finds DSH's own packages in a standard `npm i -g` install (the global prefix of the Node running DSH,
  or through the `dsh` link). Otherwise set `DSH_NODE_MODULES` to the `node_modules` directory of the installed
  `@deepseek-ai/dsh` package. Without it the plugin still loads and costs, caps, cache
  checks and the GPU panel keep working; the account list and refresh watchdog, the Claude plan card and the
  request-image cap turn off (they use DSH's own `yaml`, `pi-ai` and `sharp`). The plugin then cannot see your
  sign-ins either, so Claude, Codex and Copilot calls are counted as **metered** (priced and capped) until
  it can.

### Upgrading from `@local/dsh-model-hub` (v2)

v2 was installed from a clone under the name `@local/dsh-model-hub` and enabled by a hand-edited `cordis.patch.yml`. v3 is the npm
package `dsh-model-hub` and enables itself. Your data does not move: it stays in `${DSH_HOME:-~/.dsh}/model-hub` (ledger, caps,
config), because the data folder never depended on the package name. Stop `dsh web`, then:

```sh
F="${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"
cp "$F" "$F.bak" && awk '{l[NR]=$0} END{for(i=1;i<=NR;i++){if(l[i]=="- insert:"&&l[i+1]=="    - id: model-hub"&&l[i+2]~/^      name: .@local\/dsh-model-hub.$/&&l[i+3]!~/^[ \t]/){i+=2;continue}print l[i]}}' "$F.bak" > "$F"
grep -n '@local/dsh-model-hub' "$F" && echo "the v2 entry is still in $F: it is not the plain three-line block, so edit it out by hand (the file as it was is $F.bak)" >&2
grep -q -e '^- ' -e '^\[\]$' "$F" || printf '[]\n' >> "$F"            # a patch file with no entry must hold []
```

The `awk` line removes only the entry v2's README told you to append (an `insert` with one row, `id: model-hub`, `name: '@local/dsh-model-hub'`,
nothing else under it) and keeps the file as it was in `cordis.patch.yml.bak` (a second run overwrites that copy). If your patch file
holds that entry in any other shape (several rows under one `insert`, extra keys, a different order), the file is left exactly as it was
and the `grep` line prints the line that is still there. Then stop and delete the row whose `name` is `'@local/dsh-model-hub'` by hand
before the next block: a leftover entry would name a package that is gone, and it shares the id `model-hub` with the new bundle's row.
If the `grep` line printed nothing, the entry is gone. Then:

```sh
dsh --profile web --dump-config > /dev/null                          # the patch file must still compose before anything is removed
dsh plugin --profile web remove -w @local/dsh-model-hub              # skip this line if you already ran it
dsh plugin --profile web add -w dsh-model-hub
```

Then start `dsh web`. Running both blocks twice is harmless apart from the `remove` line, which pnpm rejects the second time (`no such dependency found`).

## What it adds

- **Accounts** (Claude Pro/Max, Codex, GitHub Copilot, OpenRouter, xAI): one row per sign-in with its state and expiry, a
  watchdog that refreshes grants ahead of expiry through DSH's own credential store, and **Sign in / Sign in again /
  Reconnect** buttons that drive DSH's native sign-in flow, whose panel opens under the row (see below). Providers not
  signed in yet are chips under **Add a sign-in**.
- **Costs and caps**: every model step is priced (LiteLLM's public price table plus your overrides) and appended to
  a local ledger; requests to metered providers are stopped *before they are sent* once a daily, per-session or
  per-provider cap is reached. The **Costs** card in Settings shows today or the last 7 days: what was charged and the API value
  that was not, each cap and plan credit as a runway, and tables by provider, outside DSH and purpose (see [Costs, caps and the
  ledger](#costs-caps-and-the-ledger)).
- **Claude plan card**: in Settings -> Models, inside the Anthropic provider row: ring gauges for the 5-hour window, the
  weekly window and the per-model weekly windows, an `est.` line when a forecast exists, what DSH itself sent in the 5-hour window,
  and the opt-in plan stop as a toggle switch (see "Stop at the plan limit" under [Costs, caps and the ledger](#costs-caps-and-the-ledger)).
- **Dock chip**: the usage chip in the composer dock is ONE button of hairline-separated segments: `5h` (a mini ring of the
  Claude 5-hour window and its percent), `Today` (DSH's charged spend today, with a mini ring against the daily cap; no ring when
  there is no cap), one segment per plan with credits (the plan's name, a ring and the percent of its included credits used this
  cycle) and `Cache` (the prompt-cache hit of the last step, text only). States: *warn* (amber) from 80% of the 5-hour window or a
  plan's credits, and for Today once the cap's warning level is passed or when the ledger could not be read in full (the amount then
  starts with `≥`); *over* (red, closed ring) at 100%, and `Cap reached` in place of the amount when a cap blocks (the Today ring then keeps its own fraction unless it is the daily cap), `Near a cap` when a session or provider cap is at its warning level;
  `—` with an empty ring when the plan reports no 5-hour window; `Signed out`, `Sign-in expired` and `API key` (each with a small
  mark, under the label `Claude`) replace the 5h figure while spend and cache still show; when the usage endpoint is unavailable
  the 5h ring and percent keep the last reading in grey; `Cache` turns amber under 5% and shows `—` before any reading; a demo hub
  puts a `DEMO` tag in front. The chip is content-sized (it never claims the whole dock row, shrinks clipped inside its border when
  the dock is narrow), takes its own row below 640 px, and is absent when there is nothing to show. Hovering the chip or focusing it
  with Tab opens its popover (fixed above the chip, at most 380 px wide), a compact plan card: a header with *Claude plan usage*,
  the account line (the Claude account's email, plan and organization, read from Anthropic's profile endpoint in the background, so
  a poll never waits for it; until the first read lands, and for 5 minutes after a failed first read (then it retries), it says
  "account not reported") and the plan pill; two small rings (5-hour, weekly), each with its reset time, and `not started` under
  the 5-hour ring when no window is open; one row per model window (Opus, Sonnet, a labelled scoped window) with a small ring, its
  reset time and its percent; then rows tagged `est.` (only when a window is estimated to fill before its reset: the window, the
  time and the range, and the rings of those windows get the dashed arc), `Stop` (the plan stop is on: the full-window sentence, or
  `On: DSH refuses Claude requests in a full window.` when no window is full) or `Extra` (the plan stop is off: the extra-usage
  sentence, see below) and `Usage` (usage unavailable); and last *Charged today* with the amount, `of $40.00` and the cap runway
  (`· no daily cap` and no runway without a cap), with an `est.` row (`$1.20 an hour · reaches the cap around 4:40 PM`, or
  `· the cap is not reached at this pace`) and a dashed stretch to the cap when the spend forecast has one. Signed out, expired and
  API key show one sentence instead of the rings (the day's spend stays); *usage unavailable* shows the last rings and model percents
  dimmed with `Unavailable (429) · last reading 12 min ago` on the `Usage` row; a demo hub puts the `DEMO` banner on top. `Escape`
  dismisses it. The popover is plain text rendered into the page body (never HTML); screen readers get the chip's one-sentence
  label and the plan lines from a hidden description. The button has no native `title`, so two tooltips never stack.
- **Forecast**: an estimate of your charged spend per hour, today's projection and when each cap would be reached at
  the current pace, and when each Claude plan window (5-hour, weekly) would hit 100 % at its recent pace: one `est.` line and a dashed
  ghost on the Today runway in the Costs card, a dashed arc on the plan card's rings for a window that fills before its reset with one
  `est.` line, the same arcs and an `est.` row in the dock popover, a summary in `dsh-hub status`, the full report in
  `dsh-hub forecast` and `GET /forecast`; always labelled an estimate, never a limit (see [Forecast](#forecast)).
- **Turn cost line**: a quiet one-line cost under every finished turn of the conversation (what was charged, the billing kind,
  route and calls), with a chevron that opens an inline detail card (tokens in and out, cache share, first token, the calls that
  ran during the turn); `dsh-hub spend --session <id|last> --by turn` and `GET /spend/turns` give the same numbers; turns recorded
  before ledger v2 show nothing (see [In the conversation](#in-the-conversation)).
- **Session receipt and Cost tab**: one session's money on one page: charged, API value that was not charged, by model / route
  (every line with its billing kind), by purpose, subagents (one level) and the spend caps; a **Cost** tab in the
  conversation with a **Copy as Markdown** button, `dsh-hub receipt <session-id|last> [--md|--json]` and
  `GET /spend/session?id=<id>` for the same numbers (see [Session receipt and the Cost tab](#session-receipt-and-the-cost-tab)).
- **Slash commands**: `/cost`, `/caps`, `/route` and `/receipt` typed into the conversation: what this session and today cost,
  the caps in effect, the route in use with its billing and price, and the session receipt. Read-only, no arguments, never
  recorded with their input; `GET /status` lists them under `commands` and `dsh-hub status` / `doctor` report them (see
  [Slash commands](#slash-commands)).
- **Cache check**: prompt-cache hit ratio per session, with an alert when it collapses (e.g. the system prompt or
  the tool set changed mid-session).
- **GPU server** (optional, off until configured): a ring of memory use per GPU (its owners in the tooltip), the server's models
  with a Load, Switch or Unload button each, a **Load on GPU** control to pin the next load to chosen GPUs, and a way back to automatic
  placement — for any server that implements [the small HTTP contract below](#what-a-gpu-server-must-implement).
- **`dsh-hub` CLI** for all of the above, scriptable with `--json`.
- **Request changes** (`imageCap` and `compactionSlim` are listed by `dsh-hub status` as feature flags): images over 2000 px are downscaled before
  a request is sent (`imageCap`, every provider, needs DSH's `sharp`); compaction requests are slimmed (long tool
  output trimmed, images and reasoning replaced by short placeholders) so they fit the model's window
  (`compactionSlim`); and only when a session **already** runs in DSH's `danger-full-access` sandbox mode, the
  plugin removes needless `sandbox_permissions` / `justification` escalation arguments from tool calls and tells the
  model so in one system-prompt sentence. It never changes the sandbox mode itself.

The plugin does not add model routes: add providers (Google, OpenRouter, DashScope, a self-hosted server, …) in
DSH's own **Settings → Models → Add model provider**; the hub then prices and caps them.

## Sign in to Claude, Codex and the others

1. Settings → Models → *Model hub* → **Accounts**. Each signed-in provider is a row (account, state and expiry, one button);
   the card header says `Auto-refresh on` (or `Auto-refresh: report only`) and has **Check now**, which runs the watchdog once.
2. For a provider that is not signed in, click its chip under **Add a sign-in**; for a row, click **Sign in again** (expired,
   expiring, revoked or refresh-failed) or **Reconnect** (healthy). The sign-in panel opens directly under that row. Some
   providers first ask how to sign in (for Claude: *Browser login* or *Copy code*); pick one. The panel opens the provider's
   page, shows a device code or a paste box when the provider asks for one, and can be cancelled (the row's button becomes
   **Cancel**). With *Browser login* the provider redirects back to DSH and the sign-in finishes by itself. A failed attempt
   says `Sign-in failed.`, that nothing was saved, and offers **Try again**.
3. The grant is stored by DSH at `llm-pi-ai/<provider>` in `${DSH_HOME:-~/.dsh}/.credentials.yaml` and refreshed under
   DSH's cross-process lock. This plugin never writes credential records or DSH settings files.

The Codex CLI login (`~/.codex/auth.json`) is deliberately **not** imported: OpenAI refresh tokens rotate, so two
programs sharing one grant log each other out. DSH keeps its own, separate grant.

## `dsh-hub` CLI

Every command takes `--json`. Whenever a command exits non-zero, its JSON on stdout carries `"error"` and `"code"`
(the exit code), next to the command's data when it has any (e.g. `prices` with an unpriced model, a failing
`doctor`).

```
dsh-hub status                      host API health, plugin features, the slash commands registered (`commands` line), spend-guard policy and error count, Claude plan windows and extra-usage state, and a forecast summary (estimates; see [Forecast](#forecast))
dsh-hub accounts                    sign-in / expiry / watchdog state (exit 1 if a refresh failed)
dsh-hub spend [--since today|7d|30d|all] [--by provider|model|session|day|purpose]
                                    ledger totals and caps, plus the dollars reserved by requests in flight in the running DSH ("in flight: unknown" when the host is not reachable)
dsh-hub spend --session <id|last> --by turn [--json]
                                    per-turn cost of one session: money or billing kind, API value not charged, tokens, cache share, route, first token, calls; offline (see [In the conversation](#in-the-conversation))
dsh-hub receipt <session-id|last> [--md|--json]
                                    one session's money: charged, API value (not charged), by route / purpose, subagents, billing kinds; --md prints Markdown to paste into a PR; offline (see [Session receipt and the Cost tab](#session-receipt-and-the-cost-tab))
dsh-hub ledger verify [--since today|7d|30d|all]
                                    re-derive every v2 row's usd / apiEquivUsd from its own tokens and rates; torn lines, duplicate ids (exit 1 on a mismatch, a torn line or an incomplete read)
dsh-hub ledger export (--csv|--jsonl) [--since today|7d|30d|all] [--out <file>] [--force]
                                    the ledger rows as CSV or JSON Lines: stdout, or --out (mode 0600, never overwrites without --force)
dsh-hub prices <provider/model>...  price rows (litellm / ollama / override / unpriced); ollama/<model> adds the peak and off-peak rates, source and date
dsh-hub plans                       prepaid plan credits: used this cycle, remaining, cycle start, next reset
dsh-hub forecast                    estimates: charged $/h now (15 and 60 min), today's projection, when each cap and plan credit is reached at this pace, when each Claude plan window hits 100 % and how old the last reading is (estimates, not limits; see [Forecast](#forecast))
dsh-hub caps [--check]              spend caps, the file they come from and today's status; exit codes with --check: 0 ok, 10 at/over warnPct, 11 a cap reached, 1 ledger unreadable or partial, or caps.json invalid
dsh-hub caps set key=value ...      dailyUsd= sessionUsd= warnPct= (1-99) provider.<id>= (a number, or off); 0 or off turns a cap off; stopAtPlanLimit=on|off (see [Stop at the plan limit](#stop-at-the-plan-limit-opt-in))
dsh-hub cache [--session <id>]      prompt-cache hit ratios
dsh-hub gpus                        GPU cards, owners, loaded model           (GPU server only)
dsh-hub switch <model> [--gpus 2,3 | --auto] [--force]                        (GPU server only)
dsh-hub unload                      unload the GPU server's model now        (GPU server only)
dsh-hub doctor                      end-to-end health check (warns when the spend guard has hit errors, or when the slash commands are not all registered: a `slash commands` check, `warn` for none registered or a name collision, never a failure; includes the plan-history file: mode, rows, age of the last reading; a demo folder: warning)
dsh-hub demo --out <dir> [--at <ISO time|now>] [--seed <n>] [--force]   write a synthetic DEMO data folder (see Demo mode)
```

`accounts`, `spend` (also `spend --session --by turn`, which never calls the host), `receipt` (never calls the host), `ledger`, `prices`, `plans`, `forecast` and `caps` read the data dir and work with DSH stopped (`caps set` writes only `caps.json`; `spend` also asks the host API, best effort, for the in-flight dollars; see Caps); `demo` reads and writes nothing but its own `--out` folder; `status` and `cache` need the host API
(`DSH_HUB_URL`, default `http://127.0.0.1:8185`); the GPU commands talk to the configured GPU server and exit 2 with a
hint when none is configured.

`caps set` is strict and exits 2 on any bad input, leaving the file untouched: `dailyUsd` and `sessionUsd` are numbers
from 0 to 1000000 (0 or `off` = off), `warnPct` is a whole number from 1 to 99, `provider.<id>` is a provider id
(`[a-z0-9][a-z0-9-]{0,39}`) with a number above 0 or `off` to remove that cap; values are plain decimals (`1e3`, `0x10`
and `NaN` are refused), a key given twice is refused, at most 64 provider caps; `stopAtPlanLimit` takes only `on` or `off`
(`maybe`, `1`, `true` exit 2). `dsh-hub caps` also prints a `plan stop  on|off` line, and `dsh-hub status` (from the host's
`/status`) and `dsh-hub doctor` (a `plan stop` check, always `ok`) report the same state. `caps --check` prints the same output as
`caps` and exits 0 (within caps), 10 (a cap is at or over `warnPct`), 11 (a cap is reached) or 1 (the ledger cannot be
read, its totals are partial, or the whole `caps.json` is ignored because it is corrupt, so your real limits are not in
force: the output says `caps.json invalid`; a reached or near cap against the defaults still gives 11 or 10; a single
bad field is not an exit 1, only the banner); with `--json` the exit code is also `"code"`. `--check` cannot be combined with `set`.

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
  "extraLedgers": ["/absolute/path/to/another/spend.jsonl"],
  "guard": { "onError": "allow" }
}
```

| Key | Meaning |
|---|---|
| `gpuServer` | the optional GPU server (see [GPU server](#gpu-server-optional)); `null` or absent = off |
| `localProviders` | DSH provider ids priced as local ($0, never capped); the GPU server's `id` is always included. The providers with built-in pricing, `anthropic`, `dashscope`, `deepseek-account`, `deepseek-official`, `github-copilot`, `google`, `ollama`, `ollama-cloud`, `openai-codex`, `openrouter` and `xai`, are never treated as local even if listed here |
| `hub.allowedOrigins` | extra exact origins allowed to call the host API (see [Security model](#security-model)) |
| `priceModels` | up to 50 `provider/model` ids (the model part may contain `/`; at most 120 characters) always shown in the Prices card, besides models you actually used |
| `plans` | prepaid monthly credits per provider, e.g. `{"ollama": {"name": "Pro", "includedUsd": 60, "resetsOnDay": 9}}`. See [Plans](#plans-and-billing-kinds) |
| `subscriptions` | provider ids declared as subscription-billed (`$0` charged, API value kept, never capped). The By provider table of the Costs card and the Prices card label them `Subscription · declared` (the tooltip says "Declared in config.json"), and `dsh-hub prices` says "declared in config.json", so a typo is visible. A provider also in `localProviders` stays local |
| `extraLedgers` | other spend ledgers (JSONL rows with `ts`, `usd`, optional `provider`) shown next to DSH's spend, **display only** |
| `guard` | `{"onError": "allow" \| "block"}`, default `allow`: what the spend guard does when it fails itself (throws an internal error). `allow` lets the request through; `block` stops it as a spend-cap stop (code `SPEND_CAP`) whose message points at `guard.onError`. `block` also stops a request whose billing could not be determined because the failure happened before its price was known (that can be a local or subscription request); a request the guard had already classified as not metered is never stopped by it. Re-read on every request. Anything but exactly `"allow"` or `"block"` is ignored (`allow`) and reported by `dsh-hub doctor` |

Other files in the data dir: `spend.jsonl` (ledger), `caps.json`, `prices.json` (price overrides),
`prices.litellm.json` (24 h price-table cache), `ollama-prices.json` (refreshed Ollama Cloud rates), `accounts-state.json`, `provider-health.json`,
`plan-history.jsonl` (Claude plan readings, see [Forecast](#forecast)) and `plan-history.trimmed` (the time of its last daily trim).

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
| `DSH_HUB_DEMO` | **demo mode, which turns spend capture and caps OFF.** Absolute path of a sealed demo folder; the host then serves only that folder (see [Show it in DSH](#show-it-in-dsh)). Anything else (relative path, not a sealed demo folder, your data dir) is logged as `DSH_HUB_DEMO ignored (reason)` and the host runs normally. Never set it in the environment you use for real work |

## Costs, caps and the ledger

- **Ledger** `spend.jsonl`: one row per model call DSH makes (chat steps, compaction, reviews, and a failed attempt
  that reports token usage), taken from the call's own usage report, with a random row `id`, token counts, `usd` (what you are charged),
  `apiEquivUsd` (what the API list price would be), price source and billing kind. **No prompt or completion text is
  stored.** If the ledger cannot be read (`ledger-unreadable`), metered requests are held back until it can. A row that
  cannot be written (disk full, permissions) is kept in memory and written first as soon as the ledger accepts writes
  (each row is written in one write as its own line, `\n{row}\n`, so the file has a blank line between rows and a
  write torn partway, even by another DSH process, never merges with another row; a row that landed twice is counted
  once, by `id`; JSONL readers should skip blank lines);
  until then metered requests are held back (`ledger-unwritable`). Rows still unwritten when DSH exits are lost.
  `dsh-hub doctor` checks that the data dir and the ledger are readable and writable.
  Rotated at 20 MB; several DSH processes can append at once without losing rows. Rotation only renames and links
  files, never deletes or rewrites them. A read counts every ledger file it saw (once per file, by inode) and reads
  again while another process is rotating; if rotations still race it after five passes, the read is marked
  incomplete. Then the spend guard holds metered requests back (`ledger-busy`, retry in a moment), and spend reports
  say `"complete": false` (the UI shows `≥` and a "partial" note; `dsh-hub spend` exits 1).
- **Ledger v2 rows** (`"v": 2`): every row the plugin writes describes itself, so its `usd` can be worked out again from
  the row alone. Besides the fields above it carries `purpose` (`chat` when DSH declares none, else DSH's own value:
  `compaction`, `session-title`, `auto-review`, ...; lower-case `[a-z0-9._-]`, up to 40 characters, anything else is
  `other`); `turn` and `step` (only for a `chat` call made while DSH's session is inside a step, as it stood when the call's row was started, not after a slow price lookup; otherwise `null`);
  `parentSessionId` (only for a subagent session, i.e. when DSH's session header says `origin: "subagent"`; an ordinary
  fork has none); `rates` (`inPerM`, `outPerM`, `cacheReadPerM`, `cacheWritePerM`: the four per-million rates actually used
  for `apiEquivUsd`, the above-200k schedule when `tier` is `above200k`); `derived` (which of those rates were not
  published and were derived, e.g. `["cacheWritePerM"]`, charged at the input rate); `tier` (`base` or `above200k`);
  `offPeak` (Ollama's off-peak card was applied); `planCoveredUsd` (the part of `apiEquivUsd` that plan credits covered:
  `0` when no plan applied, so `usd` is `apiEquivUsd` minus `planCoveredUsd` on metered and credits rows); `reasoning`
  (reasoning tokens when the provider reports them; a subset of `output`); `finish` (DSH's finish reason of the call,
  e.g. `stop`, `tool-calls`, `max-tokens`, `aborted`, `error`); `ttftMs` and `durationMs` (milliseconds from dispatch to
  the first output token and to the finish, on a monotonic clock). Anything not known is `null`, never guessed: a model
  with no known price (and a subscription model with no known API-equivalent price) has `rates: null`, `derived: null`,
  `offPeak: null`. A row is written once, when the call's `finish` chunk arrives, so it can hold `finish` and the timings;
  if the stream ends or its consumer stops without a `finish`, it is written then, with `finish`, `ttftMs`,
  `durationMs` as `null` where they were not observed. A consumer that reads the `usage` chunk and then drops the
  iterator without ever stopping it, or a stream that stalls after `usage`, does not lose the row: if no `finish`
  follows within one second of the `usage` chunk, the row is written then (finish and duration `null`) and the call's
  in-flight reservation is released. Rows written before ledger v2 have no `v` and stay readable by
  every report; they count under the purpose `unknown` (the Costs card calls it "Before ledger v2").
- **Spend by purpose**: `dsh-hub spend --by purpose` groups the period by `purpose` (`chat`, `compaction`, `session-title`,
  `auto-review`, ..., `unknown` for rows before ledger v2); `GET /spend` accepts `by=purpose` and always returns
  `byPurpose`. The Costs card has a **By purpose** table for the selected period (Today / 7 days), one row per purpose (Chat,
  Compaction, Title, Review, Before ledger v2; any other purpose by its own name), largest API value first, with its calls,
  what was charged and its API value.
- **Verify and export the ledger**: `dsh-hub ledger verify [--since today|7d|30d|all]` (default `all`) re-reads the raw
  ledger and, for every v2 row, works `apiEquivUsd` out again from the row's own tokens and stored `rates`, checks `usd`
  against it (`usd = apiEquivUsd - planCoveredUsd` for `metered` rows, `0` for `credits`, `subscription`, `free` and
  `local` rows; a `credits` row must be covered in full and only `metered` and `credits` rows may carry
  `planCoveredUsd`), and checks that `ts` is a timestamp and `v` is absent or 2, that `tier` is `base` or `above200k` (and
  `above200k` only with more than 200,000 prompt tokens), that tokens are whole numbers >= 0, that the amounts are numbers >= 0, that `billing` is a known kind and that the rates are four numbers >= 0
  (or `null` for a row with no known price). The values are the stored ones, not the reader's cleaned ones, so a value
  like `"usd": "abc"` or `"input": -1` is a mismatch. Numbers match within `1e-9` relative. A mismatch is reported as
  `{id, field, expected, stored}` (the first 100 are listed, `mismatchCount` is exact). Rows from before ledger v2 have
  nothing to re-derive from: they are counted (`v1`) and never a mismatch. A torn line (not a JSON object) fails the
  check, whatever `--since` says (a torn line has no date; a row whose `ts` cannot be read is always counted). A duplicate `id` (a row written again after a failed write;
  it is counted once) and a field outside the ledger's field list are reported (`duplicateCount`, `unknownFields`)
  but do not fail it. It exits `0` when clean, `1` on a mismatch, a torn line, or a read that was not complete
  (`complete: false`: another DSH process kept rotating the ledger, or a file is unreadable), `2` on bad arguments. With
  `--json` a failure carries `error` and `code` next to the report. The report ends with this note, on purpose: *verify
  proves arithmetic and file integrity (usd and apiEquivUsd re-derived from each row's own tokens, rates, tier and
  planCoveredUsd; ids unique; no torn lines), not that a published price was right.* It reads the ledger files through the
  same incremental, rotation-safe reader as the summaries. `dsh-hub ledger verify` and `GET /ledger/verify` re-read every
  byte, so an edit made in place to an old row is caught too (the CLI reads the files itself; the host rations the same read
  for `GET /ledger/verify` and the Verify button, because it runs on the host's event loop: it starts after work already
  queued, callers that arrive while it runs share its result, and a complete report is reused for 5 seconds unless a
  row was written by this host in between; the examined rows are not kept in memory afterwards). A final line cut off without its newline (a write that
  died) is not read until the next row ends it, so it is not counted as torn before that.
  `dsh-hub ledger export (--csv|--jsonl)` writes the rows (de-duplicated by id, oldest first, `--since` as above) with
  ledger fields only, never prompt or completion text. Columns, in this order: `ts, id, sessionId, provider, model, input,
  output, cacheRead, cacheWrite, usd, apiEquivUsd, priceSource, billing, v, purpose, turn, step, parentSessionId,
  rate_inPerM, rate_outPerM, rate_cacheReadPerM, rate_cacheWritePerM, derived, tier, offPeak, planCoveredUsd, reasoning,
  finish, ttftMs, durationMs`. A v1 row has empty cells for everything v2 added (`v` onward); `derived` is joined with
  `|`. In CSV a text cell that starts with `=`, `+`, `-`, `@`, tab or carriage return gets a leading `'` (and quotes) so
  a spreadsheet does not run it as a formula; cells with commas, quotes or line breaks are quoted per RFC 4180. JSON Lines
  has the same fields in the same order with `rates` and `derived` nested and `null` where a v1 row has nothing. Without
  `--out` the export is printed on stdout (`--json` is refused there: the export is the output). With `--out <file>` the
  path is used exactly as given (no shell, no `~` expansion), the file is created with mode `0600`, and an existing path
  (file, directory or symlink) is refused (exit 1) unless `--force`, which writes a private temp file beside it and
  renames it over the path, so a symlink there is replaced and never written through. A `--out` naming a ledger file
  (`spend.*` or `.spend.*` in the data dir, in any letter case) or any existing path that is the same file as one (same
  device and inode, so a case variant on a case-insensitive filesystem or a hard link counts) is refused with exit 2, and so
  is any `--out` inside the data dir when `--force` is given: an export can never replace the ledger or pose as one. An export from an incomplete read
  writes nothing (exit 1). The Costs card ends with a **Spend ledger** footer: a status line, `Not checked yet. Every amount on this card comes
  from it.`, until you press **Verify** (a button, disabled and reading `Verifying…` while it runs); then `N rows verified · 0
  mismatches` (the tooltip says how many older rows cannot be re-derived and repeats the honesty note), `Could not be read in
  full. Run Verify again.`, `Verify failed: <reason>`, or `N mismatches, M torn lines · run dsh-hub ledger verify` with the first
  three mismatching fields listed under it.
- **Guard errors**: if the spend guard itself throws (not a cap; an internal error), the request follows
  `guard.onError` (default `allow`: it goes through, as before; `block`: it is stopped with a message that names
  `guard.onError` and `dsh-hub doctor`, not `caps.json`). Every such exception is counted, and the newest one is kept
  with its time, redacted (secrets and URLs removed, at most 300 characters). The count and the last error
  are shown by `GET /status` (`guard`: `{onError, errors: {count, last: {at, message}}, reserved}`), `dsh-hub status` (a `guard` line, then the last error when the
  count is above 0), `dsh-hub doctor` (a `guard errors` check: `warn` when the count is above 0, which does not change
  the exit code; skipped for a host that does not report `guard`), and the Costs card (a `Guard` line, "guard errors: N, last ...", under the cap runways,
  shown only once the count is above 0; its tooltip states the policy). The counters belong to the DSH process
  that owns the host port and reset when DSH restarts; `dsh-hub status` and `doctor` report that process.
- **Caps** `caps.json`, defaults `{"dailyUsd":40,"sessionUsd":15,"perProviderDailyUsd":{},"warnPct":50,"stopAtPlanLimit":false}`; a cap of 0
  turns it off. `sessionUsd` counts a session's whole history, however old. Only **metered** calls are ever
  blocked; subscription, free and local ones never are. Steps already in flight when a cap trips can still finish.
  A finished step counts at once. Only a model with no override or cached price waits for the first price-table load
  before it is recorded; meanwhile the next metered request waits up to 3 s for it, then is held back
  (`spend-pending`) rather than checked against a ledger that is missing that step. Each DSH session, a subagent's
  included, has its own `sessionUsd` budget; the daily caps cover them all.
  **Editing:** `dsh-hub caps set dailyUsd=40 provider.google=5` (DSH can be stopped) or `POST /caps {"set": {...}}`
  (the same keys, as JSON numbers; `null` or 0 removes a provider cap). Both go through one strict validator
  (finite numbers only, 0 to 1000000, `warnPct` 1 to 99, no unknown keys, no `__proto__` / `constructor` provider ids)
  and write only the five caps keys (the four caps plus `stopAtPlanLimit`), atomically (a random exclusively-created temp file renamed over `caps.json`, mode
  `0600`; a symlink at `caps.json` is replaced, never followed). The guard re-reads `caps.json` on every request, so a
  change applies without a restart. There is no lock: the file is re-read just before the write and the merge redone when
  another writer (the host's `POST /caps`, or another `dsh-hub caps set`) changed it in between, so a concurrent edit is
  kept unless both writes land inside the instant between that re-read and the rename (then the last writer wins).
  If the old file was unparseable, it is kept as `caps.json.broken` and replaced.
  The **Edit caps** button of the Costs card (in its "Caps and plan credits" section) opens the editor in place of that section:
  number inputs for Daily cap, Session cap and Alert at (% of a cap), **Provider caps, per day** (one row per provider cap with
  its id and dollars, Add provider cap / Remove), the plan-stop switch with the sentence under it (its change is saved by Save
  like the rest), Cancel and Save. Enter saves, Escape cancels, mistakes show under the field that caused them, and only the
  fields you changed are sent (when `caps.json` is invalid, every field is sent, so Save rewrites and repairs the file). It saves
  through `POST /caps`, so a page from another DSH instance is refused (the editor shows the reason). The section shows "Caps
  saved." next to the button afterwards. In demo mode the button is disabled.
  **A bad `caps.json`** (invalid JSON, not an object, unreadable, or a field that is not a number >= 0) is never
  silent: it shows as `caps.json invalid: <reason>; using defaults` in `GET /status` (`caps.problem`),
  `dsh-hub caps`, `dsh-hub status`, `dsh-hub doctor` (fail when the whole file is ignored, warn for a single bad
  field) and a line in the warning box at the top of the Costs card. The guard keeps using the defaults (`$40` / `$15`), never "no limit".
  The per-request check reads running totals (today, the request's provider today, the session's whole history) that
  are kept up to date from the ledger's new rows only (the reader caches each file by inode and byte offset), not a
  fresh summary of the whole ledger; they equal a full recompute (`dsh-hub spend` shows the same numbers) and are
  rebuilt if a ledger file shrinks, is replaced or disappears. An unreadable or still-rotating ledger is never read
  as "no spend": the request is held back (`ledger-unreadable`, `ledger-busy`).
- **Stop at the plan limit (opt-in).** Off by default. When on, DSH refuses a Claude request instead of sending it while
  your plan gauge says the plan is used up. This is not a spend cap (a subscription costs $0 per call) and it never
  touches the caps above.
  - **What is refused:** only requests to the `anthropic` provider that are billed as **subscription** (a stored
    Claude Pro/Max sign-in in use, see Billing kind below), and only while this DSH process's own plan gauge (the
    one the plan card shows) is **fresh** and reports 100% on the 5-hour window, the weekly window, or the weekly
    window of the model family being requested (a model id containing `opus` uses the Opus weekly window, one
    containing `sonnet` the Sonnet weekly window; the labelled scoped weekly window counts only when its label names
    that same family), and that window has not reached its reset time. A window the plan reports above 100% counts as
    100%. Only Opus and Sonnet get a per-model weekly check: for any other model id (for example Haiku) just the
    5-hour and the all-models weekly windows apply. The usage % is a whole number, so 99.5% is shown and counted as 100%. The refusal is a normal error in the conversation with code `PLAN_LIMIT`, naming the window and
    its reset time, for example `your Claude 5-hour window is at 100% of the plan (resets 3:00 PM)`.
  - **What is never refused:** metered Claude (an API key), Codex, Copilot, Google, every other provider, and local
    or free models. For those the gauge is not even read.
  - **It lets the request through (fails open) when:** the gauge is unavailable, the sign-in is expired, the route uses an
    API key, or you are signed out; the gauge is older than 10 minutes (exactly 10 minutes is still trusted), has no
    fetch time or one in the future; reading it takes longer than 2 seconds; the usage endpoint returned an error;
    a percentage is missing; or the window's reset time has passed. The guard never calls Anthropic itself: it only
    reads the gauge this plugin already keeps (refreshed at most every 60 s, with a 5-minute back-off after a 429 or 403),
    and never another DSH instance's gauge.
  - **Where it is stored:** `stopAtPlanLimit` (true or false) in the plugin's own `caps.json`, never in DSH's settings.
    It is re-read on every request, so switching it applies at once. Set it with `dsh-hub caps set stopAtPlanLimit=on`
    (or `off`; DSH can be stopped), with `POST /caps {"set": {"stopAtPlanLimit": true}}` (a JSON boolean; `1`, `"true"`
    and the like are refused with 400), with the toggle switch on the Claude plan card in Settings -> Models, or with the same
    switch inside the Costs card's **Edit caps** editor (there it is saved with the other caps when you press Save). The plan card's
    switch saves as soon as you flip it, through `POST /caps`, so a page from another DSH instance is refused (the card shows the
    reason under the switch); it ignores clicks while a save is running and is disabled until the caps have loaded.
  - **What the plan card and the dock popover say** (the plan card puts one sentence under the switch; the popover puts the same
    sentence on its `Stop` or `Extra` row, except that with the switch on and no window full it says `On: DSH refuses Claude requests
    in a full window.`). Switch on and a window is full: `Your <window> is full. DSH refuses Claude requests until it resets (<time>).`
    (`<window>` is `5-hour window`, `weekly window`, `weekly Opus window` and so on; `Opus requests` / `Sonnet requests` for a
    per-model window); switch on, nothing full: `DSH refuses Claude requests in a full window until it resets.`, with ` Extra usage
    stays on for the account, but DSH will not draw on it.` added when the account has extra usage on; switch off and the usage
    endpoint reports extra usage on: `Extra usage is on for this account: past a full window, requests bill to your Anthropic balance.`;
    off: `Extra usage is off for this account: Anthropic refuses requests once a window is full.`;
    not reported: `Whether Anthropic bills or refuses requests past a full window depends on your account's extra-usage setting, which was not reported.`
    The sentence appears while the plan is live or shows its last reading (usage unavailable), not for expired, API key or signed
    out; "a window is full" is judged only from a fresh plan reading. Screen readers get the longer forms of the same
    sentences (`Stopped by DSH: your Claude <window> is at 100% (resets <time>). ...`, `Extra usage is on for your Claude
    account: requests beyond a plan window are billed to your Anthropic balance.`, `DSH does not stop Claude requests at the plan
    limit. ...`) in the chip's hidden description.
- **In-flight reservations** (parallel requests cannot overshoot a cap together): a metered, priced request that passes
  the guard reserves its worst-case cost until its spend row is written. The request is first checked against the recorded
  spend exactly as before, so a lone request near a cap behaves as it always did. Only while OTHER requests are in flight
  is it checked again against recorded spend + the dollars those requests reserved + its own worst case (daily, the
  provider's daily cap and this session's cap, each counting only the reservations that belong to it); a request that
  would then pass a cap is stopped with `which: "in-flight"` and a message that says "requests already in flight". The
  check and the reserve run in one synchronous step (nothing is awaited between reading the reserved total and adding to
  it), so of N parallel requests exactly the ones that fit together start. The worst case is the prompt size plus the
  output size, priced at the route's rates through the same tier logic as the ledger (above 200k prompt tokens uses the
  high rates), taking the larger of "all prompt tokens at the input rate" and "all prompt tokens as cache writes". The prompt
  size is the billed prompt of the previous call for the same session and route when this process has seen one, else
  `chars/4` of the system prompt, messages and tool schemas (an image block counts as 1,500 tokens, whatever its size);
  `chars/4` is a heuristic and not an upper bound for token-dense text. The output size is the request's `maxTokens` when it is a
  positive number, else a ceiling of `32000` tokens (`OUTPUT_CEILING_TOKENS`). A request with no known price, and local, free
  and subscription requests, reserve nothing. A reservation is released exactly once: when the call's spend row has been
  written (or its capture failed), or at once when the stream ends without usage, errors, is aborted, throws, or its consumer
  stops early; releasing never delays the stream. A consumer that drops its iterator without ever stopping it cannot
  release: every chunk renews the reservation, and one that no chunk has touched for 10 minutes (`RESERVATION_IDLE_MS`) is
  swept, and any reservation is swept after 2 hours (`RESERVATION_MAX_AGE_MS`), so a leak cannot block requests for
  longer. **Same process only**: reservations live in the memory of the DSH process that made them; two DSH processes on
  one data dir each see only their own, so the caps remain the truth of the shared ledger and are not a distributed lock
  (a request in the other process is counted only once its row is written). If the reservation bookkeeping itself throws
  (for example while sizing a malformed request), nothing is reserved and the request follows `guard.onError`; a failure
  to touch or release a reservation is counted with the guard errors and never interrupts the stream. The dollars in flight
  are shown by `dsh-hub spend` (a line before `caps:`: `in flight: $0.8250 reserved across 2 request(s) (running DSH process)`,
  `in flight: none (running DSH process)`, or `in flight: unknown (the running DSH process holds reservations; host API not
  reachable)` when the host does not answer; `--json` has `caps.reserved` as `{usd, count, source}` with `source` `host`,
  `unavailable` or `demo` (a demo folder never asks the host), and the exit code is not changed by it), by `GET /spend` (`caps.reserved`: `{usd, count}`), by `GET /status`
  (`guard.reserved`: `{usd, count, byProvider, stats: {reserved, released, expired, active}}`, where `reserved` always equals
  `released + expired + active`), and by the Costs card: a `Held` line under the cap runways says "$0.83 for 2 requests in flight, counted at their worst
  case.", shown only while something is in flight.
- **Billing kind**: a provider counts as **subscription** ($0 charged, API-list equivalent still recorded) only while
  DSH holds an OAuth sign-in for it (Claude Pro/Max, ChatGPT/Codex, Copilot), its route in DSH does not name an
  API key (`apiKeyEnv`; DSH sends that key instead of the sign-in), and the plugin can read both (re-checked every
  30 s; `GET /status` shows `routeAuth`). The same provider used with an API key, or while DSH's credential store or
  route config cannot be read, is **metered**: a failed read never reuses an earlier answer. `dsh-hub prices` asks the
  running host for the route config and, when the host is not reachable, does not assume subscription.
  Two more kinds of evidence make a call a subscription: a route whose base URL is exactly `https://api.z.ai/api/coding/...`
  (host compared after URL parsing; Z.ai Coding Plan keys only work there, so the call is covered even with an API key;
  the API-equivalent value comes from the LiteLLM table when it knows the model), and a provider listed in config.json
  `subscriptions`. Lookalikes (`api.z.ai.evil.example`, `evil.example/api.z.ai/api/coding/`) do not match.
  Every other API (Google, OpenRouter, DashScope, …) is metered; a model is **free** only if
  `prices.json` says so (`"billing": "free"`), and **local** if its provider is in `localProviders`.
- **Prices**: LiteLLM's public table (fetched over HTTPS, size-capped, cached 24 h). Overrides in `prices.json`
  (`{"provider/model": {"inPerM": 1.25, "outPerM": 10, "cacheReadPerM": 0.125, "billing": "metered"}}`, `billing`
  optional) win, and edits to the file apply without a restart. A model with no known price
  is `unpriced`, never guessed: its calls are stored at $0 and **do not count toward caps** — the Costs card's warning box says
  "N unpriced calls today — not counted toward caps (add prices.json)", the Prices card marks the model `Add price`, and the host logs the model once, so you can add it to `prices.json`. If a provider has a
  `perProviderDailyUsd` cap, its unpriced models are blocked instead (their spend could not be counted). While no
  price table could be loaded at all (first run offline, no cache), metered requests without a `prices.json` row are
  held back (`prices-unavailable`) and the table is retried every minute. In Settings the **Prices** card (its own card, `$ per
  million tokens`) lists each model as `provider / model` with its billing and In, Out and Cache prices; an unpriced model carries an
  `Add price` pill, and a provider whose account has no credit a `No credit (402)` pill in place of its billing.

## In the conversation

### Turn cost line

Under every **finished** turn of a conversation the plugin adds one muted line, never wrapped (a `conversation.chat.turnTail` entry; a turn
that is still running shows nothing until it closes). It is built from the ledger's v2 rows, which carry the turn number, so
it never estimates and never guesses: a turn with no ledger rows (an older ledger, a v1 row, a call that failed before it was
billed) shows **nothing** rather than a made-up number. The parts, joined by `·`, with a small swatch in front (solid: charged;
tinted: not charged; hatched: plan credits; outline: local or free) and a chevron at the end:

- **`Charged $0.0066`** or **`Not charged`**. Money: two decimals from $0.25 up, four below (`$0.40`, `$0.1248`). `Price unknown`
  stands in when every call had no known price (never `$0.00`).
- **The billing kind**: `Metered`, `Subscription`, `Credits`, `Local` or `Free`; a turn that mixed kinds lists them
  (`Metered + Credits`), and `price unknown` is added when some calls were unpriced.
- **`API value $0.1248`**, only when nothing was charged: what the calls would have cost at list prices but were not charged
  (subscription, credits that covered them, a free or local route).
- **The route** (`provider / model`, or `2 routes`) and **`3 calls`**.
- **`+ Compaction`**, **`+ Review`**: other calls made while the turn ran. The ledger gives these calls (compaction, session
  title, review) no turn number, so they are attributed **by time**: a call of the same session whose timestamp falls inside the
  turn's window (from the earliest call start to the last call end) is listed under that turn. Their money is not added to the turn's money.

The line is one button (the chevron says so); activating it, or Enter or Space with the keyboard, opens **the detail** inline under it, `Escape` closes it:

- **In** `48,210 tokens · 71% read from cache`, then `13,981 new · 34,229 cache read · 0 cache write` (input is new tokens plus cache
  reads plus cache writes); **Out** `1,134 tokens`; **Time** `First token after 0.9 s · model time 7.4 s` (each left out when unknown).
- Only when calls ran during the turn, a table **While this turn ran** with one row per purpose (`Calls`, `Charged`, `API value`) and the note
  `Not part of this turn's charge. Matched to it by time.`

Screen readers get the line as the button's label. Everything is text (route names and ids from the ledger are never interpreted as
markup) and the colours are DSH's own tokens, light and dark.

The line polls `GET /spend/turns?session=<id>`: **one request every 5 seconds per visible conversation**, shared by all turn lines
of that session, none while the browser tab is hidden, and the poll stops when the last line of the session goes away. A failed
poll keeps the numbers already shown. The host serves the rows it holds for 2 seconds however many pages ask; after that it looks at the ledger files (name, inode, size,
modification and change time) and reads them again only when one changed, so an idle ledger costs a few `stat` calls per poll, not a
re-read; a turn's line appears within a few seconds of the turn closing. Two things are read from the DSH session and not observed in a running DSH
by this change: that the ledger's session id equals the session id the page is given, and that a real step's row carries the turn
number (it is written from the same `turn/start` data the page uses); if either is wrong the line simply does not appear.

The same numbers on the command line, with DSH stopped (it reads only the data dir and never calls the host):

    dsh-hub spend --session <id|last> --by turn [--json]

`last` is the session of the newest ledger row (a subagent's row counts for its parent). One line per turn in the order above,
then `during turn N: ...` for the other calls attributed to it by time and `outside turns: ...` for the session's calls that
belong to no turn; `--json` prints `sessionId`, `turns`, `outside`, `v1Calls`, `truncated`, `complete` and `unreadable`.
Exit codes: `0` printed; `1` no ledger rows for that session (or, with `last`, no session at all), or the ledger could not be
read in full (turns found are printed first, then the reason on stderr; when the ledger could not be read and the session shows nothing, stdout
stays empty in text and only the reason is printed, because `no turns` would be false; `--json` still prints the body with `unreadable`); `2` bad usage (`--session` without `--by turn`, `--by turn` without `--session`,
`--since` with `--by turn`, or an id that is not 1-128 characters of `A-Za-z0-9_.:-`). A session whose rows all predate ledger v2 prints
`no turn data (N calls before ledger v2)` and exits 0.

### Session receipt and the Cost tab

A receipt is one session's money, read from the same ledger rows as the turn cost line. It holds:

- **Charged** (money that left the account) and **API value, not charged** (what subscription, credit, free and local calls
  would have cost at list prices), the number of **model calls**, the number of **turns** (distinct turns of the session's chat
  calls) and the **cache read** share (cache reads over the billed prompt tokens; `n/a` without any).
- The **first** and **last call** (UTC in the Markdown and the text, local time in the tab).
- **By model / route**: one line per provider/model **and billing kind**, so the same model billed two ways is two lines; biggest
  API value first. **By purpose**: `chat`, `compaction`, `session-title`, `auto-review`, `other` and any other purpose name the
  ledger carries. **Billing kinds**: `metered` (charged per use), `subscription` (covered by a plan, not charged here),
  `credits` (covered by prepaid plan credits), `local` and `free` (no charge).
- **Subagents (one level)**: rows whose `parentSessionId` is this session, rolled up with their own routes and purposes and a
  list of up to 50 subagent sessions (`and N more` beyond that). A subagent's own subagents are **not** rolled up (the receipt says
  so). The headline numbers are the session's own rows; the text and Markdown receipt add a "charged including subagents" line next to them, and the tab shows the subagents in a block of their own.
- **Not attributed**: rows written before ledger v2 carry no purpose and no turn. They are counted in every total and listed
  as `not attributed`; they are never put in a purpose.

`dsh-hub receipt <session-id|last> [--md|--json]` prints it with DSH stopped (it reads only the data dir and never calls the host).
The default is a short plain text (lines of at most 100 characters, no tables); `--md` prints exactly the Markdown the tab
copies (in a demo folder its own first line is the DEMO line; otherwise a heading, a summary table, the route, purpose, billing-kind and subagent tables, and a closing sentence saying where
the money comes from and that no prompt or completion text is recorded or shown), with nothing before or after it; `--json`
prints the receipt (`sessionId`, `calls`, `usd`, `apiEquivUsd`, `notChargedUsd`, `turns`, `firstTs`, `lastTs`, `cache`,
`byRoute`, `byPurpose`, `byBilling`, `notAttributed`, `subagents`, `withSubagents`) plus `markdown`, `complete` and `unreadable`.
`--md` and `--json` cannot be combined. `last` is the session of the newest ledger row (a subagent's row counts for its parent).
Exit codes: `0` printed; `1` no ledger rows for that session (or, with `last`, no session at all), or the ledger could not be
read in full (a receipt with calls is printed first, then the reason on stderr; when the ledger could not be read and the session
shows no calls, stdout stays empty in text and `--md` and only the reason is printed, because "no calls" would be false; `--json`
still prints the body with `unreadable`); `2` bad usage (no id, extra arguments, `--md` with `--json`, or an id that
is not `last` or 1-128 characters of `A-Za-z0-9_.:-`).

**The Cost tab.** DSH's session header shows a **Cost** tab (a `conversation.view` entry, `id` `cost`, order 20: after Chat and
the trajectory tab, before Stats). It shows money and billing kinds only; there is no token table (DSH's own Stats tab shows
tokens). From the top:

- **Header**: `Session cost`, the session id, and one line of facts, for example `6 turns · 41 calls · cache read 71% · Nov 12,
  7:26 PM – 7:31 PM` (local time; the turn count is left out for a session whose calls were recorded before ledger v2, which carry
  no turn, rather than saying `0 turns`; the cache share when it is known), and the **Copy as Markdown** button.
- **Headline**: **Charged** and **API value, not charged**, side by side, over one split bar: the charged money first (solid), then
  the API value that was not charged, route by route (tinted, hatched for plan credits). When part was charged and part was not, a
  line under the bar gives the API value in total.
- **By route** (Billing, Calls, Charged, Not charged; one line per route and billing kind, with a swatch showing how it was paid)
  and **By purpose** (Calls, Charged, API value; `Not attributed (before ledger v2)` as its last row when there are older rows).
- Beside them, in a second column: **Spend caps** (a runway for this session's charged money against `sessionUsd` and for today's
  against `dailyUsd`; a cap of 0 or off shows nothing), **API value per turn** (one bar per turn, the charged part solid, the last
  60 turns, only for a session with at least two turns and some API value) and **Subagents (one level)** (sessions and calls,
  what they charged and what was not charged, one row per subagent session (id, calls, charged; `and N more subagent sessions` past the 50 the receipt carries) and a quiet line that subagents of subagents are not counted; only when subagents ran).
- A closing line: `From the local spend ledger. API value is the list price; plan, credit, free and local routes are not charged.`

It polls `GET /spend/session?id=<id>` every 10 seconds while open, and the per-turn strip reads the turn line's shared
`GET /spend/turns` poll. Everything is text; the colours are DSH's tokens, light and dark. States: before the first call the headline
says `No model calls yet`; when the ledger could not be read in full a warning line says so, the amounts start with `≥`, and a session
with no calls shows `Calls not known` and the warning `The spend ledger could not be read in full, so the calls of this session are not
known.` instead of `No model calls yet`; while loading it says `Loading the session cost…`, and `Cost is unavailable: <reason>` when
the host cannot answer; in demo mode the tab starts with the DEMO banner.

**Copy as Markdown.** The button writes the Markdown that the host built (the very function `dsh-hub receipt --md` calls, so the
tab and the terminal print the same string) to the clipboard, **only when you click it** (never on render or on a timer), and
shows `Copied` or `Copy failed: <reason>` next to it. The Markdown contains session and subagent ids, provider and model names,
billing kinds, counts, money and times, and nothing else: every string taken from the ledger is reduced to the characters
`A-Za-z0-9 _.:/+-` (80 characters at most), so it cannot carry a table pipe, a line break, HTML, an e-mail address or a file path;
it never holds a data dir, a token, an account identity, an organisation name or any prompt text.

Read from DSH's source and not observed in a running DSH by this change: that the Cost tab appears next to Chat with the label
`Cost` and receives the session id (the slot and its `sessionId` prop are read from DSH's UI code), that the ledger's session id
equals the id the page is given, that subagent rows carry `parentSessionId` in real runs (the engine writes it; no real run
checked), and that `navigator.clipboard.writeText` works on the DSH page (a loopback page is a secure context).

### Slash commands

Four commands you type in the conversation, each answering with plain text: a few short lines, and for `/receipt` two tables aligned
with spaces only (never Markdown). DSH shows the reply collapsed in one row (newlines become spaces), so the first line always reads
as a phrase. They take **no arguments**: any text after the name is ignored. They are read-only: they never change a cap, the
ledger or a file.

| Command | What it prints |
|---|---|
| `/cost` | `This session    $0.0141 charged of $15.00 · $14.99 left · $0.1265 not charged · 6 calls.` and `Today             $9.31 charged of $40.00 · $30.69 left · within caps.` (`near the cap` or `cap reached` in place of `within caps` only when the daily cap itself is at `warn` or `block`; a provider or session cap in trouble is named in the verdict lines and leaves this line at `within caps`; labels padded, amounts right-aligned), then `Held for requests in flight: $0.00. If the cap check itself fails, requests go through.` (`are refused` when the spend guard is set to block on its own errors) and `Not charged is the API value: the list price of calls on plan, credit, free and local routes.` A cap that is off reads `no session cap` / `no daily cap`; the session row says `no model calls recorded yet.`, `not known.` (DSH gave no session id) or `not known (the ledger could not be read in full).`. When the guard is at `warn` or `block` the first two lines are the verdict (`Near the daily cap: requests still go through.`, `Daily cap reached: metered requests are stopped.`, the same for the session and a provider cap) and `Why: ...`. The session is the one that received the command (`agent.id`), read with the same function as the receipt; the verdict and the `Why:` line are judged for that same session (its own charged spend against the daily, per-provider and per-session caps, by the same `checkCaps` the spend guard uses), not for the session the host saw last, so two open conversations never show each other's guard; with no session id the session cap is not applied. `Ledger read was partial: totals may be low.` follows when the ledger could not be read in full. Money uses the CLI's rule: two decimals from $1, four below. |
| `/caps` | `Caps: $40.00 a day · $15.00 a session · warning at 50% · no provider caps · today within caps.` (`no daily cap`, `no session cap`, `no warning level` for a cap of 0; `provider caps below` and one aligned row per provider cap, `google   $5.00 a day · $1.20 spent today`); `Claude plan stop is off: DSH keeps sending Claude requests when a plan window is full.` (`is on: DSH refuses Claude requests ...`); `A problem with caps.json: ...` when the file is invalid; and `Read-only here. Change caps in Settings > Models > Model hub, or run: dsh-hub caps set dailyUsd=10`. The verdict and `Why:` lines of `/cost` come first when the daily or a provider cap is at `warn` or `block` (these caps are the same for every session; the per-session cap is in `/cost`). Nothing typed after `/caps` is read, so no limit can be raised from a chat line. |
| `/route` | One line: `deepseek/deepseek-v4.1-flash · Metered: charged per use · Signed in with an API key.` (the provider and model DSH reports for the session, `agent.model.current()`; `Subscription: covered by your plan`, `Credits: covered by prepaid credits`, `Local: runs on your machine, no charge` and `Free: no charge` read the same way; the sign-in phrase is one of `Signed in with an API key`, `Signed in with a stored sign-in`, `No sign-in needed or found`, `Sign-in not known (route config unreadable)`), and for a priced metered route `Price per 1M tokens: $0.30 in · $1.20 out · $0.03 cache read · source: litellm.` (`Price: not known (unpriced).` for an unpriced one, `Price: not known.` when the host has no price row for the route; no price line for the other kinds). When DSH has not reported a model: `Route: not known (DSH has not reported this session's model yet).` It never prints a key, a token, a URL or an environment variable name. |
| `/receipt` | `$0.0141 charged · $0.1265 API value not charged · 6 calls · 2 turns · cache read 38%.`, the span in local time and the session id (`Nov 12, 7:26 PM to 7:31 PM · session-...`), a `By route` table (billing, calls, charged, not charged) and a `By purpose` table (calls, charged, API value), one `Subagents (one level)` line when subagents ran, one `Not attributed (rows from before ledger v2)` line when older rows exist, or `No model calls recorded for this session yet.` (`The spend ledger could not be read in full, so the calls of this session are not known.` instead when the ledger could not be read and the session shows no calls); `This session: not known.` without a session id. This is the conversation's reply only: `dsh-hub receipt <id>` still prints the receipt text documented under [Session receipt and the Cost tab](#session-receipt-and-the-cost-tab). |

Every line is at most 100 characters. The text is built from money, ids, model names and counts only; the data dir and file paths
are never in a reply (a test checks all four replies for the data dir path). In [demo mode](#show-it-in-dsh) the host registers the
same four commands over the demo folder and every reply starts with the `DEMO DATA: synthetic, nothing is recorded or capped` line.

**Who can run them.** The commands registry's only entry points are the person's input in a UI (or the SDK's JSON-RPC
`commands.execute` for a user line); no model tool calls it (read from DSH's `dsh-commands` and a search of the installed `dsh-*`
packages for `commands.execute`/`find`/`list` callers). The registry stamps `source: {kind: "user"}` on the log line itself, and
`CommandInvocation` has no `source` field today; as defence in depth each handler refuses an invocation whose `source`, if a
context ever exposes one, is anything but a user source (`refused: slash commands are for the person typing them.`).

**What the session log keeps.** Each definition sets `recordInput: false`, so the registry writes the `command/run` event without
the typed arguments. The reply itself is in the session log (DSH records the result text of every command); it holds money, ids and
model names only.

**A name collision.** The four names are registered one by one. If another plugin already holds one, that registration fails alone:
the plugin logs one warning naming the command (`slash command /cost was not registered ...`), the other commands still register, and
nothing else is affected. `GET /status` carries `commands: {registered: [...], collided: [...]}` for this DSH process, `dsh-hub status`
prints a `commands` line (`commands   /cost /caps /route /receipt`, with `· collided: /cost` after a collision, or
`commands   none registered`), and `dsh-hub doctor` has a `slash commands` check: `ok`, or `warn` for none registered (DSH's
commands service was not available in the process that owns the hub port) or for a collision. An older host that does not report
`commands` adds no line and no check.

Read from DSH's source and not observed in a running DSH by this change: that the commands service is injected in the process that
owns the hub port and that the four names are free of another plugin's commands, that `invocation.agent.model.current()` exists at
runtime (typed in `runtime-types.d.ts`, never called against a live DSH), and that DSH's command card shows a multi-line reply with
its line breaks.

## Forecast

Estimates of how fast you are spending and when a cap or prepaid plan credit would be used up **if the current pace
continues**. They are not limits: a forecast never blocks a request and never changes an exit code (the caps and the
plan stop read only the ledger and, for the plan stop, the live usage gauge; no guard module imports the forecast).
Where: the **Costs card** (an `est.` line under the cap runways, and a dashed ghost on the Today runway), `dsh-hub forecast`, and
`GET /forecast`.

The Costs card's `est.` line is one sentence, for example `$1.20 an hour now, about $14.20 by midnight, under the daily cap.` or
`$1.20 an hour now: daily cap reached around 4:40 PM (range 3:10–10:05 PM).`:

- `$1.20 an hour now`: what you are being **charged** per hour over the last 15 minutes, from metered calls only (subscription,
  credits and local calls add no dollars).
- with no cap reached or about to be: `about $14.20 by midnight`, today's charged spend so far plus that hourly pace until the next
  local midnight, then `, under the daily cap` when the daily cap would not be reached before it resets.
- otherwise a colon and the cap part: it first names every cap that is already reached (`session cap reached`, `openai cap
  reached`, `daily cap reached`: a fact the guard is acting on, not a forecast), then the first cap that would be reached at this
  pace (`daily cap reached around 4:40 PM (range 3:10–10:05 PM)`, `openai cap reached around 3:10 PM`; a time on another day
  carries the weekday), joined by `;`. A cap that lacks its 3 calls has no part.
- The **Today runway** in the cap rows above the line shows the forecast as a dashed ghost from the spend dot to where today's
  projection ends (to the cap, when the daily cap is reached at this pace); the `est.` line explains it. The Latest session, provider
  and plan-credit rows have no ghost.

The line carries a tooltip that starts `Estimate, not a limit.` and lists its inputs (the call count, both rates, the
range for each cap), and a visually hidden `(estimate)` after it for screen readers. When the pace is suppressed
(below), the forecast cannot be loaded, **the last poll of `/forecast` failed** or the report is **more than 60 seconds
old**, the card shows **nothing**: no `est.` line, no ghost, no placeholder numbers and no estimate left over from an earlier
poll. The plan card and the dock follow the same rule.

**Method.** The ledger is read for the last 2, 5, 9, 15, 30 and 60 minutes and differenced into six slices (0-2, 2-5,
5-9, 9-15, 15-30 and 30-60 minutes ago). For a window W of 15 or 60 minutes the rate is the average of the slice rates
(charged dollars per hour) weighted by `exp(-age / tau)` with `tau = W / 3`, so recent minutes count more; slices older
than W are ignored. **Both** rates are reported: the headline is the 15-minute one, and the range of every projection is
between the 15- and the 60-minute rate (it is the spread of two paces, not a confidence interval).

- *Today*: charged spend since local midnight + rate x hours to the next local midnight (23, 24 or 25 hours across a
  clock change). The mid value uses the 15-minute rate, low and high the lower and higher of the two rates.
- *Daily and per-provider daily caps*: the time the remaining dollars would be used at the pace, with a range. A time
  after the next local midnight is `not-at-this-pace` (the cap resets first). Each per-provider cap uses that provider's
  own pace and call count.
- *Session cap*: the session in use (the host's), counting that session's whole history like the guard does, with a 24
  hour horizon from now. Without a session in use (`dsh-hub forecast` has no host to ask, and a host before its first
  call) the sessions that made **charged calls in the last hour** are listed, the one with the most recent charged call
  first, at most three; a session that only made subscription, credits or local calls is never picked. With no charged
  call in the last hour the newest session of any kind is shown, so a reached cap still appears.
- *Reached*: a cap with spent >= cap (the guard's own test) is `reached` whatever the pace, even when the pace is
  suppressed. A cap of 0 (off) has no entry.
- *API value, not charged*: subscription and credits calls cost nothing, but their API-list value per hour is shown
  separately and always labelled `API value, not charged`; it is a plain average over 15 and 60 minutes and never moves
  a cap line. It needs 3 subscription or credits calls in the last 15 minutes (the CLI leaves the line out when there are
  none). Calls in a `mixed` bucket are not part of it: they count toward the charged pace only.
- *Plan credits* (providers in `config.json` `plans`): the remaining credits for the current UTC billing cycle (the same
  numbers as `dsh-hub plans`) against the pace of that provider's API value, until the next reset: `runs-out`,
  `not-before-reset`, `exhausted` or `suppressed`.

**Claude plan windows.** The estimate for the 5-hour and weekly windows appears in three places, only for a live plan (not while
usage is unavailable, expired, API key or signed out) and only while the report is fresh (the same 60-second rule):

- On the **plan card**, a ring whose window the forecast says reaches 100 % before its reset gets a dashed `est.` arc between its
  used arc and the top, with a small `est.` tag; a ring whose window is not forecast to fill stays plain. One `est.` line under the
  rings says it in words, one sentence per window:
  - `5-hour fills around 4:10 PM (range 3:55–4:30 PM), before its reset.` (`Weekly` for the weekly window). The range's late end
    can be open: `(range from 2:05 PM)` (the pace could be lower than the readings can resolve, so the limit might never come). When
    the report has no times, `Weekly may fill before its reset.`
  - `5-hour stays under 100% until its reset.`: the fit says 100 % comes after the window resets. `probably stays` when the fastest
    pace inside the range would get there first, so the line hedges instead of promising.
  - `At this pace neither window fills before its reset.` (or `At this pace the weekly window does not fill before its reset.` when
    only one window has a fit) when no window fills and none hedges.
  - `Not enough readings yet` when every reported window has too few readings.
  - Nothing is shown (no `est.` line, no placeholder) when the newest reading is stale, the window has reset or is already at
    100 %, or when the report was fitted to another reset than the window shown. The plan card's `est.` line has no tooltip; the
    Costs card's does.
- In the **dock popover**, the same dashed arcs on its two rings and an `est.` row for the windows that fill (the window, the
  time and, on its own line, the range).
- For screen readers, the chip's hidden description keeps one `At this pace:` line per window under its window line, each followed
  by `(estimate)`: `At this pace: limit ~2:20 PM (range 2:05 PM–2:50 PM), 6 readings, before the reset`, `At this pace: won't reach
  100% before the reset at 5:00 PM`, or `At this pace: probably not before the reset at 5:00 PM (could be ~1:50 PM at the fastest
  pace)`.

On the plan card, the caption `Usage % counts every Claude app...` is now the `Rings` line, `Every Claude app on this account.`, and the
same words stay in the hidden description.

*History.* Each time the plan usage endpoint is fetched (the same call the plan card already makes; a cached or
backed-off read is not a reading) the plugin appends one row per window (`fiveHour`, `sevenDay`) to
`plan-history.jsonl` in the data dir: `{"v":1,"window":"fiveHour","percent":42,"resetsAt":"<ISO>","fetchedAt":<ms>}`,
exactly these five keys and nothing else (no account, token, organisation or label). A reading identical to the previous
one is written again only after 5 minutes. The file is `0600` in the `0700` data dir, opened with `O_NOFOLLOW`, bounded
to the newest 5,000 rows no older than 14 days (readers apply both bounds too), and trimmed at most once a day: the time
of the last trim is kept in `plan-history.trimmed`, so restarting DSH does not trim again; the trim rewrites through a
temp file and a rename, so a crash leaves the old file. The file's size is re-checked right before the rename and the pass
redone (up to 3 times) when another process appended meanwhile; a row appended between that final check and the rename
can still be lost (one reading; the forecast does not depend on any single reading). Two readings of the same
percent and reset within 30 seconds (two DSH processes logging one fetch) count once.

*Method.* The fit uses the **current window** only: readings whose reset is the newest reading's reset (within one
minute) and whose time lies inside the window. Of those it fits the **recent stretch**, the last fifth of the window's
length (60 minutes of the 5-hour window, 33.6 hours of the weekly one; the 3 newest readings when fewer fall in it), so a
burst early in the window does not keep predicting a limit once usage has gone quiet. The slope is the least-squares line
through those whole percents. The **range** moves the slope to the wider of two bounds: the ±0.5 % rounding of the first
and last reading, and ±2 standard errors of the fitted slope (the scatter of the readings around the line); a perfect line
therefore gets a narrow range, a noisy one a wide one. It is an estimate of an estimate, not a confidence interval of the
limit. A forecast needs **at least 3 readings spanning at least 5 minutes** (`not enough readings (N)` in `dsh-hub
forecast`); a newest reading **older than 20 minutes** gives `no forecast: last reading … ago`; once the reset time has
passed nothing is extrapolated across it (`window reset at …, waiting for a new reading`); at 100 % the report says
`at 100% now`. The percent resolution is 1 %: a slow weekly pace shows as `0` for a long time, which the range keeps open.
`dsh-hub forecast` prints these as `claude 5-hour` / `claude weekly` rows and a `claude plan` row with the age of the
last reading:

```
claude 5-hour  limit ~14:20 (range 14:05-14:50), 6 readings, before the reset at 17:00
claude weekly  won't reach 100% before the reset at Thu 14:00
claude plan    last reading 4 min ago (10:31)
```

Where readings come from. The hub has no background timer and never calls Anthropic's usage endpoint on its own while
nobody is looking. A reading is taken only when something asks for the plan: the Model hub section of Settings, the plan
card and the composer dock each poll `/status` every 4 seconds while they are on screen (`lib/client.js`, `useStatus`),
the host serves the plan from a 60-second cache (`USAGE_CACHE_MS` in `lib/plan-usage.mjs`), so that is at most one real
fetch per minute, and with *Stop at the plan limit* on, every Claude subscription request asks too. An idle hub (DSH
closed, or open with none of those showing) therefore adds no readings: after the last one, `dsh-hub forecast` says
`not enough readings` (the plan card's `est.` line says `Not enough readings yet`) until three readings span 5 minutes, and
`no forecast: last reading … ago` (the plan card shows no `est.` line) once the newest is older than 20 minutes, until the next poll. Readings are written by whichever DSH process fetched the usage. Per-model weekly windows are not forecast.

**Minimum of 3 calls.** A forecast needs **at least 3 metered calls in the last 15 minutes behind it, per target**: the
overall pace, each per-provider cap, the session cap and each plan are counted separately. Below that the target is
`suppressed` and says why (for example `fewer than 3 metered calls in the last 15 min (2)`); no rate, projection or time
is shown for it. A call counts when its bucket is billed `metered` or `mixed`; dollars always come from the charged
`usd`, so a free call never adds money.

**If the ledger cannot be read in full** (a file is unreadable, or another DSH process kept rotating it) the report
has `"complete": false` and no estimates; `dsh-hub forecast` prints the reason and exits 1.

`dsh-hub forecast [--json]` prints one block, for example:

```
forecast (estimates, not limits; nothing here blocks a request)
charged now    $1.20/h (15 min) · $1.35/h (60 min) · 12 metered calls in 15 min
today          $4.10 so far · ~$14.20 by midnight (range $13.80-$15.10)
daily cap      $40.00: ~16:40 (range 15:10-22:05)
provider openai cap $5.00: not at this pace
session cap    $15.00 (s1): reached
API value      $0.80/h (15 min) · $0.60/h (60 min), not charged (subscription and credits)
plan ollama    Pro: credits run out ~Fri 03:00 (range Thu 21:00-Sat 10:00)
```

Times are the 24 hour local clock, with a short weekday when the day is not today; a range end that is not reached before
the horizon prints `later`. A cap line can instead read `not at this pace`, `reached` or `suppressed, <reason>`; a plan line
`credits not used up before the reset on <date> at this pace`, `exhausted (resets <date>)` or `suppressed, <reason>`;
a suppressed overall pace prints `charged now    no forecast: <reason>`. When `caps.json` is invalid or has a bad
field it prints a `caps.json` row with the reason, because the defaults are then in force; the Claude plan rows are
described above, and a data dir with no plan readings prints `claude plan    no plan readings yet (written while the Claude
plan card is read)`. It reads the data dir (ledger, `caps.json`, `config.json`, `plan-history.jsonl`) and works with DSH
stopped; exit 0, except 1 for a partial ledger, 2 for extra arguments.

`dsh-hub status` adds `forecast` lines under the plan lines, in the same compact wording as `dsh-hub forecast` (the
Costs card says the same estimate as a sentence) and `limit` times only: `forecast   $1.20/h now (15 min) · today ~$14.20 · daily cap ~16:40` and `forecast   claude 5h: limit ~14:20, 6
readings` (`claude weekly: won't reach 100% before the reset`). They come from the host's `GET /forecast`, else are computed
from the data dir; a suppressed pace or a window without a forecast prints no line, and `status --json` then has no
`forecast` key (otherwise `forecast` is the whole report).

`GET /forecast` (header-gated like every read, no query) returns `{"estimate": true, "generatedAt": <ms>, "capsProblem": <string or null>, "spend": {...}, "plan": {...}}`.
`spend` has `complete`, `reason`, `minCalls` (3), `windowsMin` ([15, 60]), `charged` (`status`, `reason`, `calls15`,
`calls60`, `ratePerHour {m15, m60}`, `todayUsd`, `midnightAt`, `projectedTodayUsd {mid, low, high}`), `caps` (each with
`which`, `capUsd`, `spentUsd`, `calls15`, `state`, `reason`, `resetsAt` (the daily caps' midnight; a session cap has `horizonAt`, its 24 hour look-ahead, instead, because it never resets), `reachedAt`, `range {earliestAt, latestAt}`),
`apiValue` and `plans`; times are epoch milliseconds (`plans[].resetsAt` is an ISO date). `plan` has `estimate`,
`lastReadingAt`, `ageMs` and `windows.fiveHour` / `windows.sevenDay`, each with a `status` (`limit`, `no-limit`,
`insufficient`, `stale`, `reset`, `at-limit` or `none`), the `readings` used, `windowReadings`, `percent`, `ratePerHour`,
`resetsAt` and, for `limit`, `limitAt`, `earliestAt` and `latestAt` (null: open), for `no-limit`, `earliestAt` and `mayReach`.
The host keeps the report for 5 seconds; the Costs card, the plan card and the dock each poll it every 15 seconds and show it
only while the last poll succeeded and the report is under 60 seconds old. 503 when the host has no forecast wired.

A forecast is read-only information: the spend guard, the caps and the plan stop never read it (a test pins that no guard
module imports a forecast module, and that a steep burn that projects past a cap does not block).

## GPU server (optional)

The GPU panel, `gpus` / `switch` / `unload` and the `/gpu/*` routes are **off** until `config.json` names a GPU server.
With none configured the panel is hidden, the GPU routes answer `{configured:false}` (POSTs: `409`
`{"error":"no GPU server configured","configured":false}`), and
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
- Every state-changing request additionally needs the header `x-dsh-model-hub: 1`, an allowed `Origin`,
  `Content-Type: application/json` and a JSON object body (≤ 16 KB). `POST /caps` additionally checks on the server that
  the request's `Origin` is the DSH instance that owns the hub (`webOrigin`; `127.0.0.1` and `localhost` of the same
  port are the same instance): unknown owner gives 409, another instance's page gives 403, and nothing is written in
  either case. Every read except `GET /healthz` needs the header
  too (a web page's `<img>` or `<script>` request cannot set it), and a read of a pending sign-in (whose authorize URL
  carries OAuth state) also needs an allowed `Origin`. The UI opens or links a sign-in page only if it is `https:`.
- Error text (host API errors; every string under the `error` / `errors` / `detail` / `details` / `message` /
  `reason` fields of every GPU server reply, arrays and nested objects included, whatever its status; every CLI
  error, argument errors and `doctor` failures included; stored account errors), host log lines and GPU process
  command lines pass through one redactor: known token shapes, `key=` / `token=` style parameters, `--api-key` style flags and long
  opaque strings. Ids, model names and file paths are not redacted. The ledger never holds prompt or completion text.
- In [demo mode](#show-it-in-dsh) every `POST` other than `/gpu/switch`, `/gpu/unload` and `/accounts/refresh`
  (including routes added later) answers `409` after the Origin, header and Host checks, so nothing can be changed or
  written while a demo is served.
- `plan-history.jsonl` holds `v`, `window`, `percent`, `resetsAt` and `fetchedAt` only (every row is rebuilt from five
  validated values: no identity, token, organisation or label), is `0600` in the `0700` data dir, is opened `O_NOFOLLOW`
  (a link at its path, or at `plan-history.trimmed`, is never written through), and is bounded and trimmed as described
  under [Forecast](#forecast). `GET /forecast` is a read route: it needs the header like every other read and reflects no `Origin`.
- `GET /spend/turns` takes one opaque session id: it is length-capped (1-128 characters of `A-Za-z0-9_.:-`, so `../x`, `a/b`,
  `a%2Fb`, spaces and longer ids are 400), compared with `===` against the ledger's session ids and never joined to a file path.
  Its answer holds numbers, ids and model names only: no prompt or completion text, no file path and no data dir. It needs the
  hub header (a bare `GET` is 403) and reflects no `Origin` (a disallowed one is 403 with no CORS header).
- `GET /spend/session` follows the same rules (the parameter is `id`; `?session=` is 400): an opaque, length-capped id compared
  with `===`, never a path, the hub header required, no `Origin` reflected. Its body (receipt, `markdown`, `caps` as three numbers and
  the action word, or `null`, `complete`) holds ids, model names, counts, money and times only; the Markdown is built by a pure module from
  sanitised strings (see [Session receipt and the Cost tab](#session-receipt-and-the-cost-tab)). The tab writes to the
  clipboard only from a click.
- The slash commands (`/cost` `/caps` `/route` `/receipt`) are read-only and take no arguments (nothing typed after the name is
  read, so `/caps` cannot raise a limit), are registered with `recordInput: false` (the arguments are not written to the session
  log), refuse any non-user `source`, and reply with money, ids and model names only: no key, token, URL, environment variable name,
  path or data dir. `GET /status` reports only the lowercase names of the commands.
- **Trust boundary:** programs running as *your* user are trusted — they can read DSH's credential store directly
  anyway. Other accounts on the same machine can reach loopback ports, so use it on a single-user machine.
- No npm dependencies; the plugin loads DSH's own `yaml` and `sharp` from DSH's install (`DSH_NODE_MODULES`).

## Host API

| Route | What |
|---|---|
| `GET /healthz`, `/status` | health and `webOrigin` (the DSH web origin this hub serves); both carry `"demo": true\|false` (`true` only in [demo mode](#show-it-in-dsh), where `/status` also carries `demoNote`); `/status` adds features (imageCap, compactionSlim, spendGuard), `guard` (the spend guard's `onError` policy, its error count and last error, and `reserved`, the dollars held by requests in flight; or `null` when the engine does not report it), Claude plan usage, `commands` (`{registered, collided}`: the lowercase names of the slash commands this DSH process registered and of those another plugin already held), `caps` (`problem`, `fatal`: a bad `caps.json`, else `problem` is null; `stopAtPlanLimit`) and `routeAuth` (`apiKeyRoutes`: the routes DSH authenticates with an API key) |
| `GET /accounts` | provider health, expiry, watchdog state, short redacted `lastError`; `credentialStore` (`live` / `disposed` / `none`: where a refreshed grant would be written, and whether DSH has replaced that store since the plugin started) |
| `GET /accounts/flows` (always `{flows: []}` in demo mode), `POST /accounts/signin {provider}`, `GET /accounts/signin/<p>`, `POST /accounts/signin/<p>/answer {text}`, `POST /accounts/signin/<p>/cancel` | DSH-native sign-in. A stuck attempt expires after 10 min; cancel is immediate |
| `POST /accounts/refresh` | run the watchdog now |
| `GET /spend?since=today\|7d\|30d\|all&by=provider\|model\|session\|day\|purpose` | ledger totals (incl. `unpricedCalls`; each group's `billing` kind, or `mixed`), `byPurpose` (the split by ledger v2 `purpose`, whatever `by` is), caps status (with the session in use and its `sessionSpentUsd`, `reserved` (`{usd, count}`: dollars held by requests in flight in this DSH process), and `guard`, the same object as in `/status`), `external` (extra ledgers, display only) |
| `GET /caps`, `POST /caps {"set": {...}}` | whether `caps.json` exists (not its path: `dsh-hub caps` prints that), the caps in effect, `stopAtPlanLimit`, the defaults, `problem` / `fatal` and today's status; `POST` validates strictly (400 lists every error), writes `caps.json` and returns the new view. Needs the instance-ownership check: 409 until the hub knows its owner, 403 from another instance's page |
| `GET /spend/turns?session=<id>` | the per-turn index of one session for the turn cost line: `sessionId`, `turns` (ascending, at most the newest 1000, then `truncated: true`; each with `turn`, `calls`, `steps`, `usd`, `apiEquivUsd`, `notChargedUsd`, `input`, `output`, `cacheRead`, `cacheWrite`, `cacheReadShare`, `billing` (one kind or `mixed`) and `billings`, `routes`, `unpricedCalls`, `ttftMs`, `durationMs`, `firstTs`, `lastTs`, `during`), `outside` (calls of no turn), `v1Calls` (calls recorded before ledger v2: counted, never given a turn), `complete`, `unreadable`. `session` is required and is an opaque id matched exactly (1-128 characters of `A-Za-z0-9_.:-`, else 400; subagent rows are not part of the parent's index); an id with no rows is 200 with zeros, not 404; 503 when unavailable; `"demo": true` in demo mode. Behind the hub header like every GET; the held rows are served for 2 seconds, then read again only if a ledger file changed (an incomplete read is never held) |
| `GET /spend/session?id=<id>` | the receipt of one session: `sessionId`, `calls`, `usd`, `apiEquivUsd`, `notChargedUsd`, `turns`, `firstTs`, `lastTs`, `cache`, `byRoute` (provider, model, billing, calls, money), `byPurpose`, `byBilling`, `notAttributed`, `subagents` (one level; `sessions` at most 50 and `moreSessions`), `withSubagents`, plus `markdown` (the string `dsh-hub receipt --md` prints), `caps` (`dailyUsd`, `sessionUsd`, `todayUsd` as numbers and the `action` word `ok`, `warn` or `block`; `null` when the guard cannot report them), `complete`, `unreadable`. `id` is required and is an opaque id matched exactly (1-128 characters of `A-Za-z0-9_.:-`, else 400); an id with no rows is 200 with zeros; 503 when unavailable; `"demo": true` in demo mode (the Markdown then starts with the DEMO line). Behind the hub header like every GET; shares the held ledger rows of `/spend/turns` |
| `GET /ledger/verify?since=today\|7d\|30d\|all` | the same report as `dsh-hub ledger verify` (default `all`; `ok`, `rows`, `checked`, `v1`, `mismatchCount`, `mismatches` (at most 100), `tornLines`, `duplicateCount`, `duplicateIds`, `unknownFields`, `complete`, `unreadable`, `note`). Read-only, behind the hub header like every GET; it re-reads the whole ledger, at most once per 5 seconds per `since` (concurrent and repeated calls share that read, unless this host wrote a row in between) |
| `GET /forecast` | **estimates**, never limits: `spend` has the charged $/h over 15 and 60 minutes, today's projection, when each cap and plan credit would be reached at this pace (with a range), and the `API value, not charged` pace; `plan` has the Claude 5-hour and weekly window fits from the plan-history file; `complete: false` and no spend estimates when the ledger cannot be read in full; `capsProblem` names an invalid `caps.json`; 503 when unavailable. See [Forecast](#forecast) |
| `GET /prices?models=provider/model,...`, `GET /hub/config` | price rows + provider credit health; `priceModels` |
| `GET /cache[?session=<id>]` | prompt-cache hit ratios (`"demo": true` added in demo mode) |
| `GET /gpu/config`, `/gpu/gpus`, `/gpu/models`, `POST /gpu/switch`, `POST /gpu/unload` | the GPU server (proxied); `/rocco/*` are kept as aliases |

**Port 8185 is fixed** (the browser half of the plugin cannot discover another). If a second DSH instance starts,
its host logs that the port is in use and serves nothing; that instance's UI then reaches the *first* instance's hub.
Its origin is normally not on the first one's allowlist, so the section says "Hub not reachable"; if you did allowlist it,
the section shows a notice at its top (and the dock a pill, `other DSH's hub`) that the data belongs to the other instance. Every change (sign-in, GPU switch, refresh)
first asks the hub which instance it belongs to and is sent only when that is positively this page's instance, so
from another instance, or before the hub reports its owner, nothing is changed. Cost capture and caps still run in
every instance.

## Plans and billing kinds

**Ollama Cloud** bills per token at the rates published on https://ollama.com/pricing (input, cached input, output; some
models also have an "(Off-Peak)" row that applies outside 12:00-18:00 UTC on weekdays and all day on weekends; the
call's own UTC timestamp decides). The plugin prices `ollama` / `ollama-cloud` calls from that table, never from
LiteLLM (whose `ollama/*` rows describe local models). The table comes from a bundled snapshot (dated 2026-11-09) and a
copy refreshed in the background from the pricing page at most once per 24 h (cached in `ollama-prices.json`, never
blocking a request). The page is untrusted input: size-capped, parsed as numbers only, accepted only when at least 10
models parse with finite non-negative rates; otherwise the previous copy (or the snapshot) stays and a warning is
logged. `priceSource` is `ollama` (refreshed copy) or `ollama-snapshot` (bundled). A model not on the table is
`unpriced`, never guessed; a rate shown as "-" stays unknown. Model ids are matched exactly, after dropping a trailing
`:cloud` / `-cloud`, then by the part before `:` (`gemma4:31b-cloud` -> `gemma4`). A `prices.json` row still wins.

A route is Ollama Cloud when the provider is `ollama` / `ollama-cloud` and the base URL's host is exactly `ollama.com`
(or the model id ends in `:cloud` / `-cloud`, or the base URL is unknown). Ollama on a loopback/private base URL with a
non-cloud model is **local** ($0). The built-in-pricing guard for `localProviders` typos stays for every other provider.

**Plans.** With `plans.<provider>` set, a priced call is billed **credits** while that provider's API value this cycle
(since the most recent `resetsOnDay` at 00:00 UTC, clamped to the month's last day) stays within `includedUsd`: charged
$0, API value kept. A call that crosses the line is recorded **metered** with only the overage in `usd` (full value in
`apiEquivUsd`); later calls are metered. Caps block only metered calls, so they count real overage only. A provider
without a plan is plain pay-as-you-go. If the ledger cannot be read in full when a call is recorded, that call is left
metered (never free by accident). `dsh-hub plans` shows used / remaining / next reset; the Costs card has a runway per plan
(`<Provider> <plan> credits`, its reset date, `$X of $60`, and a note when the plan is over its included credits and the overage is
billed as metered); the dock chip gets a ring per plan.

| Billing kind | Charged (`usd`) | Capped | When |
|---|---|---|---|
| `metered` | the cost | yes | pay-as-you-go APIs; the part of a plan call beyond its credits |
| `credits` | $0 (API value kept) | no | within a configured plan's included credits this cycle |
| `subscription` | $0 (API value kept) | no | OAuth sign-in without an API key, Z.ai Coding Plan endpoint, or declared in `subscriptions` |
| `free` | $0 | no | `prices.json` says `"billing": "free"` (DashScope free tier) |
| `local` | $0 | no | `localProviders`, loopback/private base URL, Ollama non-cloud on loopback |
| `mixed` | n/a | n/a | an aggregate bucket holding more than one kind |

## Demo mode

Demo mode shows the hub with **synthetic** data: spend, caps, plan credits, accounts, a GPU server and Claude
plan gauges that are not yours. Use it for screenshots, talks and trying the panels without touching real spend
or sign-ins. It is off unless you ask for it explicitly, and every surface says so.

### Generate the demo data

    dsh-hub demo --out <dir> [--at <ISO time|now>] [--seed <n>] [--force]

Writes a **sealed demo folder** to `<dir>` (created `0700`, files `0600`): about a week of ledger rows
(`spend.jsonl`) across every billing kind (metered, credits with an Ollama plan that crosses into overage,
subscription, free, local), several providers and models, a few unpriced calls, one session whose prompt-cache hit
ratio collapses, today's metered spend at 80 % of the daily cap (a warning), `caps.json`, `config.json` (a plan and
a GPU server entry), `prices.json`, an `accounts-state.json` and `demo-accounts.json` with one healthy, one
expiring-soon and one revoked sign-in, `extra-ledger.jsonl`, `demo-cache.json`, `demo-manifest.json` and a
one-line `DEMO` marker.

- **Deterministic:** the same `--at`, `--seed` and timezone give byte-identical files. `--at` is an ISO time (default
  `now`), rounded down to the hour; it is also the demo's frozen "now" (so "today" and "expires in 8 min" stay
  true however long after generation you open it). If it is earlier than 02:00 local, it moves to 02:00 and the
  command says so. Generate and serve on the same machine (the day boundary is your local midnight).
- **Never real:** `--out` is refused when it is, lies inside, or contains the configured data dir
  (`DSH_HUB_DATA_DIR`), `$DSH_HOME/model-hub` or `~/.dsh/model-hub`, when it is a symlink, a file, or a non-empty
  folder (`--force` regenerates a folder that already has the `DEMO` marker, nothing else). No file is written through a
  symlink inside `<dir>`.
- **Sealed:** `demo-manifest.json` holds a sha256 for every file. The hub and the CLI treat a folder as a demo folder
  only if the marker, the manifest, every hash and the exact file list (plus, at most, a `.DS_Store`) agree, so a real data dir can never be
  mistaken for one, and editing a file in a demo folder makes it unusable (regenerate it).
- Rows use the ordinary ledger row format; no prompt or completion text. One conversation, session `demo-s-conv` (and its subagent
  `demo-s-conv-sub`), is written with ledger v2 rows (turns 1-4: three subscription turns, one with a compaction call while it ran,
  one metered turn, plus a session-title call), so `dsh-hub spend --session demo-s-conv --by turn` and `GET /spend/turns?session=demo-s-conv`
  have something to show, and `dsh-hub receipt demo-s-conv` / `GET /spend/session?id=demo-s-conv` (the Cost tab) show its receipt
  with the subagent rolled up; every other demo row is a v1 row.

The command prints the folder and the next steps; `--json` prints `out`, `anchor`, `files`, `rows`, `seed`, `days`
and the figures above. Exit codes: `0` written, `2` bad usage (`--out` missing, bad `--at` or `--seed`), `1` refused.

### The CLI in demo mode

When `DSH_HUB_DATA_DIR` points at a demo folder, every `dsh-hub` command answers from it, prints
`DEMO DATA: synthetic, nothing is recorded or capped` as its first line (`--json` adds `"demo": true` and
`"demoNote"`), and works with DSH stopped: it never calls the host API, never reads DSH's credential store and never
fetches a price table. `status` and `cache` use the demo fixtures instead of the host; `gpus`, `switch` and
`unload` talk to an in-process fake GPU server (changes last for that one command); `accounts` exits 1 because the demo
has a revoked sign-in, like a real one would; `doctor` reports demo mode as a **warning**. A folder with a `DEMO`
marker that fails verification stops every command with exit 2 (`help` and `demo` still work).

The other way round (a real `DSH_HUB_DATA_DIR`, but the running host is in demo mode): `status` and `doctor` say so,
`cache` prints the banner (the host's `/cache` and `/accounts` bodies carry `"demo": true`; `--json` adds `"demo": true`
and `"demoNote"`), and `accounts` never attaches the host's synthetic identity to the rows of your real data dir.

### Show it in DSH

The hub port (8185) is fixed, so stop your normal DSH first, and use a throwaway DSH home so nothing real is read:

    export DSH_HOME="$(mktemp -d)"                                  # throwaway; your real ~/.dsh is not touched
    node bin/dsh-hub.mjs demo --out "$DSH_HOME/model-hub-demo"
    # install the plugin into this DSH_HOME exactly as in "Install" (`dsh plugin --profile web add -w dsh-model-hub`, or the from-a-clone form)
    DSH_HUB_DEMO="$DSH_HOME/model-hub-demo" dsh web

With `DSH_HUB_DEMO` set to a sealed demo folder, the host reads **only** that folder (never your data dir or DSH's
credential store), serves fixtures for what normally needs DSH's credentials or the network (the account list, the Claude
plan gauges and identity `demo@example.com · Max · Demo Org`, an in-process fake GPU server, offline prices), and
does nothing else: **spend capture, the spend guard and caps are OFF**, no usage is recorded, nothing is ever
written to the demo folder, the watchdog and sign-in are off, and every state-changing route except GPU
switch/unload and the accounts "Check now" answers `409` (`POST /caps` included: in demo mode the Costs card's
**Edit caps** button is disabled and the plan card has no stop switch; `GET /caps` shows the demo folder's caps, and
`dsh-hub caps set` on a demo folder exits 2 without writing). `GET /status` reports `"demo": true`; `dsh-hub doctor` reports
it as a warning; the Model hub section shows `DEMO DATA: synthetic, nothing is recorded or capped` once, at its top (not on each
card), and so do the Claude plan card, the Cost tab and the composer chip's popover; the chip has a visible `DEMO` tag.

**Demo mode disables caps. Never leave `DSH_HUB_DEMO` set in the environment you use for real work.** It is
honoured only when it names an absolute path to a sealed demo folder that is not your data dir; otherwise the host logs
`DSH_HUB_DEMO ignored (reason)` and runs normally. A host that is already running is never switched into demo mode by
anything but its own environment at start-up.

## Known limitations

- The Claude plan card (5-hour / weekly %) reads an **undocumented** Anthropic OAuth usage endpoint; it may change
  or stop working without notice, in which case the card greys the last reading and says `Plan usage unavailable (429). Last
  reading N min ago.` and nothing else is affected. The card's `DSH` line (and `dsh-hub status`) also shows how many messages
  and model calls DSH itself sent in the 5-hour window, read from DSH's session logs (zstd-compressed: Node's built-in zstd, else the `zstd` program); when a log cannot be decoded
  that line is left out rather than shown as 0.
- `GET /status` `plan` also carries `scopedWeekly`, `sevenDayOpus`, `sevenDaySonnet` and `extraKnown` (whether the
  usage endpoint reported `extra_usage.is_enabled` as a boolean). The card and the dock popover state the extra-usage
  setting only when `extraKnown` is true (on: "bill to your Anthropic balance"; off: "Anthropic refuses requests once a
  window is full"); otherwise, with the stop switch off, they say the setting was not reported. Nothing is said while the plan is
  expired, on an API key or signed out. `dsh-hub status` prints
  one `window` line per window reported (`5h`, `weekly`, `weekly opus`, `weekly sonnet`, a scoped label) and an
  `extra usage on|off|not reported` line. The per-model weekly windows are read from `seven_day_opus` / `seven_day_sonnet`,
  which are `null` in the recorded live sample; their non-null shape is assumed to equal `seven_day` and has not been seen.
- **Stop at the plan limit** depends on that same undocumented usage endpoint and on its 5-hour / weekly / per-model weekly
  fields (the per-model fields are assumed, see above). Whether DSH shows the `PLAN_LIMIT` error text the same way it shows
  a spend-cap block has been reasoned from the spend-cap path but not observed in a running DSH.
- The plugin reads each route's base URL from DSH's loaded provider config (the same place it reads `apiKeyEnv`); when
  that is not readable the base URL is unknown, an `ollama` call is then treated as Ollama Cloud, and self-hosted routes
  should still be listed in `localProviders`.
- **Forecast** counts calls by the ledger's billing kind per bucket: a bucket whose calls are all `metered`, or a mix
  (`mixed`), counts every call in it toward the 3-call minimum, so a `mixed` bucket (for example one session that used a
  subscription provider and a metered one, or a plan provider that crossed into overage) can count free calls and trigger a
  forecast on fewer than 3 charged ones; the dollars always come from charged `usd`. The pace is recent behaviour only: a
  burst that ends, a model switch or a new session changes it within minutes, and the 15- and 60-minute range is a spread
  of two paces, not a confidence interval. `dsh-hub forecast` has no host to ask which session is in use, so its session cap
  is for the session of the newest ledger row. Up to eight passes over the cached ledger rows build one report (the host keeps it
  for 5 seconds); its time on a multi-megabyte ledger has not been measured.
- One DSH instance per machine gets working Model hub panels (port 8185); see [Host API](#host-api).
- In-flight reservations are per DSH process: a second DSH process on the same data dir does not see the first one's
  reservations (only its recorded rows), so two processes can still overshoot a cap together by what each has in flight.

## macOS launcher

`macos/` holds an optional Dock launcher (a Chrome `--app` window around `dsh web`). It is an example tuned to the
author's setup; see [`macos/README.md`](macos/README.md) before using it.

## Development

`npm test` runs the suite (`node --test`, no npm dependencies). Plain ESM, Node built-ins only. Five integration
tests use DSH's own `sharp` and `yaml`; they are skipped, not failed, when DSH is not installed (set
`DSH_NODE_MODULES` to run them). Changes by version: [`CHANGELOG.md`](CHANGELOG.md).

## License and attribution

MIT © 2026 Antonio Mastropaolo — see [`LICENSE`](LICENSE). Source: https://github.com/antonio-mastropaolo/dsh-model-hub.
If you reuse or index this code, keep the copyright notice and attribute it to Antonio Mastropaolo and
`antonio-mastropaolo/dsh-model-hub`. Embedded provider icons come from LobeHub Icons (MIT); see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
