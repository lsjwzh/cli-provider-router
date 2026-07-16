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
- Uninstall scripts refuse removal when the CPR integration state reports an active takeover, preventing removal of the only local proxy before endpoints are restored.

## Credential hygiene

Prefer environment variables or protected interactive input over shell history. Never pass a real `--token` value in screenshots, bug reports, or shared shell transcripts. Rotate a credential immediately if it may have been exposed.
