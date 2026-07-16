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

CPR keeps its own provider store. Run `cpr import` again to copy current data. This is different from MultiCC's own CC-Switch synchronization and from CPR's opt-in reversible takeover.

## Codex cannot reach a chat-only provider

Start the managed proxy and Web service:

```bash
cpr start --port 4567 --web-port 4568
cpr status
```

Then route Codex through a provider whose configuration requires the protocol bridge. Check `http://127.0.0.1:4567/health`. Use `cpr stop` to close both the proxy and Web listener; `cpr proxy ...` is a compatibility alias.

## Port already in use

Choose another loopback port and make sure all generated proxy configuration uses the same value. Do not solve the problem by binding the proxy publicly.

## Routing goes to the wrong Claude provider

Run `cpr doctor` and inspect the selected provider with `cpr show`. CPR strips inherited Anthropic routing variables before applying the selected provider, but wrapper scripts or shell aliases can still replace command arguments after CPR launches them.

## A directly managed CLI cannot reach CPR

Native CLI takeover writes loopback proxy URLs, so the managed service must be running on the same proxy port used during apply:

```bash
cpr status
cpr start
cpr cli-config status --cli claude
```

Use `--cli codex` for Codex. If you intentionally changed the CPR proxy port, restore the native configuration and apply again after previewing the new route. Do not hand-edit the generated CPR provider entries unless you are prepared to resolve drift.

## Direct CLI restore reports drift

CPR found a post-apply change in a managed native file and refused to overwrite it. Copy the current file somewhere private, inspect `cpr cli-config status --cli <claude|codex> --json`, and verify the active snapshot. Prefer reconciling the user change before restore. `--force --yes` restores the snapshot exactly and can discard the later edit.

For Codex, `auth.json` is outside direct takeover and should not be deleted or edited as part of recovery.

## Uninstall refuses because takeover is active

This is a safety guard. Inspect both the CC-Switch and CLI Config pages. Restore managed CC-Switch endpoints and run `cpr cli-config restore --cli <claude|codex> --yes` for every active native CLI takeover before uninstalling. If restore reports a conflict, preserve `CPR_HOME` and its snapshots and resolve the drift through the Web/CLI workflow. Do not delete state or snapshots first, and do not expect uninstall to auto-restore configuration.

## Upgrade health check fails

The upgrade script restores the previous application pointer and reports the backup location. Keep that backup, run the previous `cpr doctor`, and inspect npm output. User data is not automatically replaced by the backup because doing so could discard changes made during the attempt.

## Reporting a problem

Include operating system, Node/npm versions, CPR commit/version, redacted `cpr doctor` output, and reproduction steps. Never attach `providers.json`, a CC-Switch database/snapshot, tokens, or raw proxy traffic. Follow `SECURITY.md` for vulnerabilities.
