# Troubleshooting

## `cpr: command not found`

The source installer writes the command shim to `CPR_BIN_DIR` (default `~/.local/bin` on macOS/Linux). Add that directory to `PATH`, open a new shell, and run:

```bash
cpr --version
cpr doctor
```

On Windows, verify the generated `cpr.cmd` path is present in `PATH`.

## npm or npx cannot find the package

The npm package has not been published. Install a fixed, reviewed source checkout with `scripts/install.sh` or `scripts/install.ps1`; do not use `latest` or `npx` yet.

## Installer reports a version mismatch

`--version`/`-Version` must exactly match `package.json` in the selected source directory. This prevents installing an unexpected moving version. Checkout the intended commit or tag, read the package version, and try again.

## `cpr import` cannot find CC-Switch

By default CPR checks `~/.cc-switch/cc-switch.db`. Set `CPR_CC_SWITCH_DB` to an absolute path if CC-Switch stores it elsewhere. Import is read-only; it does not enable CC-Switch takeover.

Optional SQLite support uses `better-sqlite3`. If its native module is unavailable, use a supported Node version and reinstall dependencies with build tools available.

## Provider changes in CC-Switch are not reflected

CPR keeps its own provider store. Run `cpr import` again to copy current data. This is different from MultiCC's own CC-Switch synchronization and from CPR's upcoming reversible takeover.

## Codex cannot reach a chat-only provider

Run the foreground proxy and leave the terminal open:

```bash
cpr proxy start --port 4567
```

Then route Codex through a provider whose configuration requires the protocol bridge. Check `http://127.0.0.1:4567/health`. The current CLI does not provide a background daemon; `proxy stop/status` are informational.

## Port already in use

Choose another loopback port and make sure all generated proxy configuration uses the same value. Do not solve the problem by binding the proxy publicly.

## Routing goes to the wrong Claude provider

Run `cpr doctor` and inspect the selected provider with `cpr show`. CPR strips inherited Anthropic routing variables before applying the selected provider, but wrapper scripts or shell aliases can still replace command arguments after CPR launches them.

## Uninstall refuses because takeover is active

This is a safety guard. Restore CC-Switch endpoints through CPR before uninstalling. Reversible takeover is still under development; if a development build left integration state active, preserve `CPR_HOME` and its snapshots and report the exact commit through a private support channel. Do not delete the state or snapshots first.

## Upgrade health check fails

The upgrade script restores the previous application pointer and reports the backup location. Keep that backup, run the previous `cpr doctor`, and inspect npm output. User data is not automatically replaced by the backup because doing so could discard changes made during the attempt.

## Reporting a problem

Include operating system, Node/npm versions, CPR commit/version, redacted `cpr doctor` output, and reproduction steps. Never attach `providers.json`, a CC-Switch database/snapshot, tokens, or raw proxy traffic. Follow `SECURITY.md` for vulnerabilities.
