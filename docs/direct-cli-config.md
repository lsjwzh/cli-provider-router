# Direct native CLI configuration takeover

CPR can manage native Claude Code and Codex configuration even when CC-Switch
is not installed. This is an explicit, reversible operation: CPR first records
the original files in a private snapshot, previews the proposed result, writes
only after confirmation, detects later drift, and restores the exact snapshot.

This feature is not any of the following:

- **CPR read-only CC-Switch import** copies provider records into CPR and never
  writes to CC-Switch.
- **MultiCC CC-Switch sync** belongs to MultiCC, not CPR.
- **CPR CC-Switch endpoint takeover** snapshots and rewrites selected endpoint
  fields in the CC-Switch database.
- **CPR direct CLI takeover (this document)** changes the user's native CLI
  configuration. It works without CC-Switch and never writes its database.

Activating one path does not implicitly activate another.

## Safety lifecycle

The lifecycle is intentionally explicit:

```text
detect → snapshot → preview → apply → status/drift → restore
```

1. `detect` reports native configuration locations, whether each file exists,
   and whether CPR already has active state.
2. `snapshot` captures the original state, including the fact that a target
   file did not exist. Snapshot creation does not change native configuration.
3. `preview` computes file hashes and lists the files that would change. It
   does not expose file contents or credentials.
4. `apply` verifies the snapshot still matches disk, then atomically writes the
   managed configuration. If no snapshot ID is supplied, CPR creates one first.
5. `status` compares applied hashes to disk. A mismatch is drift and blocks a
   normal restore so CPR cannot silently overwrite edits made after takeover.
6. `restore` restores every original file byte-for-byte and removes files that
   were absent before takeover. State is cleared only after successful restore.

Only one direct takeover per CLI may be active. Start the CPR local service
before applying, and keep it running while using the managed CLI: the generated
URLs intentionally point at the loopback proxy.

## CLI workflow

Use a route profile for the same CLI as the native configuration:

```bash
# Inspect both CLIs or just one
cpr cli-config detect --json
cpr cli-config detect --cli claude

# Review before writing
cpr cli-config snapshot --cli claude --profile <claude-profile-id> --json
cpr cli-config preview  --cli claude --profile <claude-profile-id>

# Confirm explicitly; service must already be running
cpr start
cpr cli-config apply --cli claude --profile <claude-profile-id> --yes

# Detect edits made after takeover
cpr cli-config status --cli claude --json

# Restore the active snapshot
cpr cli-config restore --cli claude --yes
```

The same commands accept `--cli codex`. `snapshot`, `preview`, and `apply`
require `--profile`. `apply` may accept `--snapshot <snapshot-id>` to bind the
write to a snapshot created earlier. `restore --snapshot <snapshot-id>` selects
a snapshot explicitly. Historical or non-active snapshots require both
`--force` and `--yes`.

`--json` produces structured output suitable for local automation. Mutating
commands still require `--yes`; scripts should never assume a preview is an
apply.

## Managed files and fields

### Claude Code

CPR manages routing keys inside `~/.claude/settings.json` → `env`:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL` and the supported default-model aliases
- `ANTHROPIC_SMALL_FAST_MODEL`
- `CLAUDE_CODE_SUBAGENT_MODEL`

Unrelated JSON settings and environment keys are preserved on apply. Restore
uses the snapshot, so the original file is recovered exactly.

### Codex

CPR manages `~/.codex/config.toml` and CPR-created route files under
`~/.codex/agents/*.toml`. It adds CPR-namespaced local model providers, selects
the main route, enables multi-agent routing, and writes role-specific agent
routes from the selected profile. Unrelated TOML configuration and providers
are preserved while takeover is active.

CPR **never reads, writes, snapshots, or deletes `~/.codex/auth.json`** for this
feature. Upstream credentials remain in CPR's provider store; the Codex config
contains only a non-secret loopback hop token.

## Private state and snapshots

Everything owned by this feature stays under CPR's independent data directory:

```text
CPR_HOME/direct-cli-config/
├── state/
│   ├── claude.json
│   └── codex.json
└── snapshots/
    └── <snapshot-id>/manifest.json
```

Directories use mode `0700` and manifests/state use `0600` where the platform
supports POSIX permissions. Snapshot manifests may contain the original native
configuration, including secrets already present there. Protect and back up
`CPR_HOME` accordingly; never attach these files to an issue.

If an original target file did not exist, restore removes the file CPR created.
It does not remove unrelated parent directories.

## Drift and forced restore

Do not use `--force` as a routine fix. A forced restore intentionally replaces
post-takeover edits with the selected snapshot and can discard valid user
changes. Before forcing:

1. stop the affected CLI;
2. copy the drifted native files somewhere private;
3. verify the snapshot ID and CLI;
4. run preview/status again;
5. only then run `restore --snapshot <id> --force --yes`.

CPR's uninstall scripts refuse both normal uninstall and purge while direct
takeover state is active. They never auto-restore native files. Restore each
active CLI first.

## Web console

Start CPR and open the loopback Web console shown by `cpr status`. **CLI
Config** is a separate page from **CC-Switch**. It exposes detect, snapshot,
preview, apply, status/drift, and restore for Claude and Codex. The same safety
rules apply: no write before confirmation, no normal restore after drift, and
no hidden activation of CC-Switch integration.

