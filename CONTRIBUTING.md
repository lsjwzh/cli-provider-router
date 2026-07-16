# Contributing

Thank you for improving cli-provider-router. The project handles credentials, local proxy traffic, and configuration owned by other applications, so changes need evidence beyond “works on my machine.”

## Before opening a change

1. Open an issue for new public commands, persistent schemas, or CC-Switch write behavior.
2. Keep CPR standalone data under `CPR_HOME`; do not add a dependency on a MultiCC data directory.
3. Preserve the distinction between MultiCC's read-only CC-Switch sync and CPR's opt-in reversible takeover.
4. Never commit real provider tokens, copied CC-Switch databases, request bodies, or user home paths.

## Development setup

Requirements: Node.js 18 or newer, npm, and Bash for the Unix script checks. PowerShell 7 is recommended for testing Windows scripts.

```bash
npm install
npm test
npm run lint
npm run test:scripts
```

Native `better-sqlite3` support is optional for read-only legacy import today, but it will be required for CC-Switch backup/takeover development. Use synthetic SQLite fixtures only.

## Change requirements

- Add or update tests for observable behavior.
- Keep current and upcoming features clearly labeled in documentation.
- Make persistent writes atomic; write to a temporary file, sync, then rename where applicable.
- For CC-Switch changes, use transactions and SQLite's backup facilities. Never copy a live WAL database with a plain file copy.
- Redact authorization headers, tokens, and request content from logs.
- Keep the Web service loopback-only by default. Any remote-listen option needs authentication, CSRF protection, and explicit documentation.
- Do not change stored schemas without a forward migration, rollback behavior, and fixtures covering old data.

## Pull request checklist

- [ ] Tests and static checks pass.
- [ ] No credentials or machine-specific paths are present.
- [ ] User-facing behavior is documented in English and Chinese where practical.
- [ ] Upgrade and rollback implications are described.
- [ ] CC-Switch write behavior, if any, includes preview, snapshot verification, conflict detection, and restore tests.
- [ ] Existing MultiCC integration behavior remains compatible or has an explicit migration plan.

## Commit style

Use focused commits with an imperative summary, for example `docs: explain reversible CC-Switch takeover`. Avoid mixing refactors, schema changes, and user-facing behavior in one commit.
