# macOS Dock launcher (optional example)

A tiny `.app` that opens DeepSeek Harness in a chromeless Google Chrome `--app` window, starting `dsh web` first if
it is not running and opening it with a launch token the server accepts (DSH mints a new token on every boot).

It is an **example tuned to the author's machine**: macOS, Homebrew (`/opt/homebrew/bin`), Google Chrome, and a DSH
started with an extra `--patch` file. Adapt `launcher` before using it:

- `DSH_BIN` (default `/opt/homebrew/bin/dsh`) and the `PATH` line;
- `PATCH`: the launcher passes `--patch $HOME/.ollama/launch/dsh/ollama.cordis.yml` — remove that argument if you do
  not have such a file;
- the bundle id in `Info.plist` (`local.amastro.dsh.v2`): use your own.
- API keys for routes that read one from the environment (a route's `apiKeyEnv`): a Dock launch has none. Optionally
  write `~/.config/dsh/launcher.conf` (or point `DSH_LAUNCH_CONF` at another file) with two lines,
  `env-file=<a file of NAME=value lines>` and `names=<NAME> [<NAME> ...]`. The launcher exports only the listed names
  from that file, never sources it, never prints a value, and refuses names such as `PATH`, `NODE_OPTIONS` or `DYLD_*`.

Build:

```sh
APP="/Applications/DSH.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/Info.plist"
cp launcher "$APP/Contents/MacOS/launcher" && chmod 755 "$APP/Contents/MacOS/launcher"
cp DSH.icns "$APP/Contents/Resources/DSH.icns"
codesign --force --deep -s - "$APP"
```

The launcher logs to `~/Library/Logs/DSH/dsh-web.log` (mode 0600; it contains the launch token) and supports
`DSH_NO_WINDOW=1` (start/verify everything without opening Chrome). `DSH-source-gemini-argon.png` is the AI-generated
(Gemini) source image the icon was cut from.
