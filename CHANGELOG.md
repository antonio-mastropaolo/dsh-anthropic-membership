# Changelog

All notable changes to dsh-model-hub are listed here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - Unreleased

Thanks to Mihail Turusov (sneakyjoeru) for pull requests #1, #3 and #4: the dock chip sizing, the opt-in plan stop and the dock chip tooltip.

### Added

- Install with `dsh plugin --profile web add -w dsh-model-hub`. The plugin is published as `dsh-model-hub` with a bundle manifest, so installing and enabling no longer means editing a patch file. It also declares an icon and the DSH versions it supports (`>=0.2.2-rc.1 <0.3.0-0`). Being listed on DSH's Discover page is a separate catalogue submission, not something the package does by itself.
- Ledger v2: every row now says what the call was for (`purpose`), its turn and step, the rates used, the tier, the part covered by plan credits, the finish reason and the timings. Older rows still read. `dsh-hub spend --by purpose` and a purpose split in the Costs card show where the money went. The ledger never stores prompt or completion text.
- `dsh-hub ledger verify` re-derives every Ledger v2 row's amounts and reports torn lines and duplicate ids. `dsh-hub ledger export --csv` (or `--jsonl`) writes a file with the ledger fields only; it never overwrites an existing file without `--force`, never overwrites the ledger with or without `--force`, and `--force` is refused inside the data folder. The Costs card shows a ledger line with a Verify button, backed by `GET /ledger/verify`.
- Spend guard policy `guard.onError` (`allow` or `block`) decides what happens when the guard itself fails. Guard errors are counted in `status`, `doctor` and the Costs card.
- Requests in flight reserve their worst-case dollars, so concurrent requests in one DSH process cannot together overshoot a cap. Reserved dollars show in `spend`, in `/spend` and in the Costs card.
- Caps editor: `dsh-hub caps`, `dsh-hub caps set` and `dsh-hub caps --check` from the command line, `GET /caps` and `POST /caps` on the host, and an inline editor in the Costs card. A corrupt `caps.json` is reported in `status`, `doctor` and the card.
- Opt-in plan stop: the switch "Stop Claude requests at 100% of a plan window" on the plan card (`stopAtPlanLimit` in `caps.json`, off by default, also `dsh-hub caps set stopAtPlanLimit=on`). Thanks to sneakyjoeru (PR #3).
- The Claude dock chip shows the plan card's lines in a tooltip on hover and on keyboard focus. Thanks to sneakyjoeru (PR #4).
- Forecast, always labelled an estimate and never used to block a request: `dsh-hub forecast`, `GET /forecast`, a line in the Costs card, a summary in `dsh-hub status` and the dock chip's Today tooltip. For spend it gives the charged dollars per hour over the last 15 and 60 minutes, today's projection, and when each cap and plan credit would be reached at that pace, with a range. For the Claude plan it fits the 5-hour and weekly windows from a local history of usage readings and says when a window would reach 100% before its reset, or that it will not; the plan card and the dock chip's tooltip show the same lines. The fit needs at least 3 readings spanning 5 minutes, and readings are taken only when something reads the plan (the open Settings page, the dock chip or the plan stop), never by a background timer.
- A cost line under every finished turn of a conversation: dollars charged (or the billing kind when nothing is charged), tokens, cache share, route, time to first token and number of calls, with compaction and review calls named separately. `dsh-hub spend --session <id|last> --by turn` and `GET /spend/turns` give the same numbers. Turns recorded before Ledger v2 show nothing rather than a guess.
- Session receipt: a Cost tab in the conversation with a Copy as Markdown button, `dsh-hub receipt <session-id|last> [--md|--json]` and `GET /spend/session`. It shows what one session charged, the API value that was not charged, the split by route and by purpose, subagent sessions one level down, and the billing kind of every line. The Markdown never contains prompt or completion text, file paths, emails or organisation names.
- Slash commands `/cost`, `/caps`, `/route` and `/receipt` in the conversation. They are read-only, take no arguments, are not recorded with their input, and are listed by `dsh-hub status` and `doctor`; a name taken by another plugin is reported instead of breaking the plugin.
- Demo mode: `dsh-hub demo` writes a sealed synthetic data folder, and `DSH_HUB_DEMO` serves it with a DEMO banner on every panel and every CLI table. Nothing is recorded and no caps are applied in demo mode. A headless screenshot script produces the README images from it.
- This changelog.

### Changed

- The package is renamed from `@local/dsh-model-hub` to `dsh-model-hub`. This is a breaking change for v2 installs: follow "Upgrading from `@local/dsh-model-hub` (v2)" in the README. Your data folder `${DSH_HOME:-~/.dsh}/model-hub` is unchanged, and the row id in the bundle stays `model-hub`.
- `/status` and `/accounts` no longer wait for the Claude profile call.
- Small dollar amounts read the same everywhere (CLI, slash commands, receipt, Cost tab, turn line): zero is `$0.00`, and a real charge below `$0.0001` reads `<$0.0001` instead of `$0.0000`.
- The spend guard reads incremental ledger totals instead of re-reading the ledger.
- The dock chip is sized to its content and no longer claims the whole composer dock row. Thanks to sneakyjoeru (PR #1).

### Fixed

- A plan window reported above 100% was ignored. It is now kept as 100%, so an exhausted window still counts and the opt-in plan stop sees it.

### Security

- `ledger export` refuses to overwrite the ledger, checked by file identity and in any letter case.
- `GET /caps`, `POST /caps` and `GET /ledger/verify` keep the Origin, header and JSON-body checks of every other route.
- The plan history file `plan-history.jsonl` keeps only the window, percent, reset time and reading time (no account, token or organisation), is `0600`, is opened without following links, and is bounded and trimmed daily. `GET /forecast` needs the hub header like every other read.
- `GET /spend/turns` and `GET /spend/session` need the hub header, treat the session id as an exact-match string (length-capped, never a file path) and return no prompt or completion text and no paths. Route and model names from the ledger are sanitised before they are printed to a terminal.
- A demo folder is sealed by a SHA-256 manifest, so a real data folder cannot be mistaken for one.
- The host's ledger verify is rationed so it cannot starve the request path.

## [2.0.0] - 2026-11-08

Version 2 was installed from a clone of the repository as `@local/dsh-model-hub`.

### Added

- The Model hub section in Settings, Models: provider accounts with DSH-native sign-in and a refresh watchdog, a per-model cost ledger with daily, session and provider caps, prompt-cache checks, an optional GPU-server panel that works with any server implementing the small HTTP contract, and the `dsh-hub` CLI.
- Ollama Cloud pricing taken from Ollama's own table (a snapshot plus a 24-hour refresh), plan credits as a billing kind, the Z.ai Coding Plan endpoint, declared subscriptions and `dsh-hub plans`.
- The signed-in Claude account (email, plan, organisation) on the plan card, in Accounts and in `dsh-hub accounts`.
- A new interface: a refined Model hub section, a ring-gauge plan card and a dock chip, using DSH design tokens only, in light and dark.

### Changed

- The GPU server is generic and optional (`config.json`) instead of hard-wired.
- The plugin finds a standard `npm i -g` DSH install.

### Fixed

- Claude sign-in no longer gets stuck; stale grants are handled; grants refresh through DSH's credential store.
- Many hardening fixes from eleven adversarial review rounds: fail-closed ledger reads, byte-accurate read offsets, lock-free appends, and redaction of secrets in logs and `doctor`.

### Removed

- The Kimi provider.
