# Security Policy

## Supported versions

cli-provider-router is in early development and has not yet published an npm release. Security fixes currently target the default branch. After tagged releases begin, this section will list supported release lines.

## Reporting a vulnerability

Do not open a public issue containing a token, database, request body, or exploitable detail. Use GitHub's private security advisory flow for `lsjwzh/cli-provider-router`. If that channel is unavailable, open a minimal issue asking the maintainer for a private contact method without including sensitive details.

Include the affected commit/version, operating system, impact, and a redacted reproduction. Remove API keys, cookies, OAuth tokens, home-directory names, and provider account identifiers.

## Security boundaries

- `CPR_HOME` is a secret-bearing data directory. Restrict it to the current user and never synchronize it to a public cloud or repository.
- The local proxy and Web console bind to loopback. Loopback is not authentication; untrusted local processes may still reach it, so administrative APIs also require the generated token.
- CPR receives provider credentials and may observe model traffic. Logs must contain metadata only unless the user explicitly enables a short-lived diagnostic capture.
- Imported CC-Switch data is copied into CPR's own store. The current `cpr import` operation is read-only.
- Reversible CC-Switch takeover is a separate opt-in write feature. It uses a verified backup, transaction, allowlist of fields, snapshot-only gateway, loop prevention, and conflict-aware restore. See `docs/ccswitch-safety.md`.
- Direct native CLI takeover is another separate opt-in write feature and works without CC-Switch. It snapshots `~/.claude/settings.json`, `~/.codex/config.toml`, and managed Codex agent route files before changing them. It never modifies Codex `auth.json`. See `docs/direct-cli-config.md`.
- Direct CLI snapshots can contain secrets that already existed in native configuration. `CPR_HOME/direct-cli-config` therefore uses private directory/file permissions and must be handled as secret-bearing data.
- Normal restore refuses configuration drift. `--force` may intentionally discard edits made after apply and must only be used after a private manual backup and snapshot-ID review.
- Uninstall scripts refuse removal or purge when either CPR takeover is active, preventing removal of the only local proxy before CC-Switch endpoints or native CLI files are restored. They never perform an automatic restore.

## Credential hygiene

Prefer environment variables or protected interactive input over shell history. Never pass a real `--token` value in screenshots, bug reports, or shared shell transcripts. Rotate a credential immediately if it may have been exposed.
