# Data and Security

## Data ownership

CPR data belongs under `CPR_HOME`, defaulting to `~/.cli-provider-router`. It must not be placed inside a MultiCC repository, worktree, or data directory. Application versions live separately under `CPR_INSTALL_ROOT` so upgrade/uninstall can preserve user data.

The target standalone layout is described in `docs/architecture.md`. Current source installers set `CPR_DATA_FILE` to `CPR_HOME/data/providers.json` for compatibility with the current CLI.

## Sensitive material

Treat these as secrets:

- `providers.json` and generated Codex authentication/config files.
- CC-Switch database snapshots and integration manifests containing original URLs.
- OAuth tokens and API keys.
- Diagnostic captures and model request/response bodies.

On Unix, directories should be mode `0700` and files containing secrets `0600`. Windows installations should inherit an ACL restricted to the installing user; shared-machine administrators should review ACLs explicitly.

## Logs and statistics

Routine logs may contain timestamps, route IDs, provider IDs/names, model names, status codes, durations, and token counts. They must not contain authorization headers, raw tokens, prompts, tool arguments, responses, cookies, or copied configuration blobs.

The usage ledger stores metadata and normalized counts only. Diagnostic content capture must be opt-in, time-bounded, visibly active, and easy to delete.

## Network exposure

The standalone proxy and Web console are designed to listen on `127.0.0.1` by default. Do not expose the service through `0.0.0.0`, a container port, reverse tunnel, or LAN proxy unless authentication, authorization, TLS, CSRF protection, and trusted-proxy rules have been deliberately configured.

Localhost does not protect against other processes running as the same user. Keep bearer credentials scoped and rotate them if an untrusted local process may have accessed CPR.

## Backups and upgrades

Upgrade scripts back up CPR data metadata before switching application versions and retain `CPR_HOME`. Backups have the same sensitivity as live data. Users are responsible for encrypted off-device backups and retention policy.

CC-Switch takeover snapshots require SQLite's backup API and verification; a plain file copy is not safe for a live WAL database. See `docs/ccswitch-safety.md`.

## Deletion

Normal uninstall removes application files and the command shim but preserves `CPR_HOME`. Purge must be explicitly requested. Purge is refused while CC-Switch takeover is active, because removing the proxy first could strand CC-Switch on localhost endpoints.
