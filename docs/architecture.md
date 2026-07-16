# Architecture

## Product boundary

cli-provider-router owns provider normalization, CLI spawn configuration, protocol routing, standalone route policy, normalized usage events, and—when completed—the standalone usage ledger and Web console.

A host such as MultiCC owns orchestration: sessions, tasks, workflows, worktrees, dispatch, and process supervision. It may call CPR's library and pass `sessionId` and role context, but CPR must not read MultiCC's private data directory or infer orchestration state from it.

```text
Claude/Codex process
        |
        | generated env / CODEX_HOME
        v
 CPR route policy --------> CPR provider store
        |
        | optional local HTTP proxy
        v
 Claude messages / Codex responses adapter
        |
        +--------> upstream provider
        |
        +--------> normalized usage event
                         |
                         +--> host callback (available)
                         +--> CPR usage ledger (in development)
```

## Current modules

- `lib/store.js`: provider CRUD, summaries, read-only CC-Switch import, and Codex target resolution.
- `lib/spawn-env.js`: sanitizes inherited routing variables and creates provider-specific child environments and Codex homes.
- `lib/routing.js`: main/sub-agent route metadata and proxy environment/config helpers.
- `lib/proxy/claude.js`: Anthropic-compatible request routing and normalized usage callbacks.
- `lib/proxy/codex.js`: Codex `/responses` routing and compatibility behavior.
- `lib/proxy/codex-transform.js`: Responses ↔ Chat transformations.
- `cli/index.js`: current provider commands, per-invocation routing, diagnostics, and foreground proxy entry.

## Standalone data layout

The target layout is isolated under `CPR_HOME` (default `~/.cli-provider-router`):

```text
CPR_HOME/
├── config/settings.json
├── data/providers.json
├── data/route-profiles.json       # in development
├── data/integration-state.json    # in development
├── data/usage.sqlite              # in development
├── backups/cc-switch/             # in development
├── codex-homes/
├── logs/
├── run/
└── captures/                      # opt-in diagnostics only
```

The current CLI historically defaults its provider file to `~/.cli-provider-router/providers.json`. The source installer supplies `CPR_DATA_FILE=$CPR_HOME/data/providers.json` so new standalone installations use the target layout. Migration code must continue to recognize the historical path.

Application binaries are separate from data. Source installers place immutable versions under `CPR_INSTALL_ROOT`, switch an application pointer only after health checks, and leave `CPR_HOME` untouched during a normal upgrade or uninstall.

## CC-Switch integrations

There are three explicit paths:

1. CPR read-only import: CC-Switch database → CPR provider store.
2. MultiCC sync: CC-Switch data → MultiCC, controlled entirely by MultiCC.
3. CPR reversible takeover (in development): verified snapshot → selected CC-Switch endpoint rewrite → CPR proxy → upstream, with restore.

No path should silently activate another. In particular, importing providers must never imply takeover.

## Web and daemon target

The standalone Web console and service lifecycle are in development. The target service binds to `127.0.0.1`, exposes a versioned local API, and owns provider UI, CC-Switch preview/apply/restore, route profiles, usage queries, and health status. HTTP handlers must call service-layer operations rather than edit files or SQLite rows directly.

## Compatibility principles

- Accept legacy routing metadata while emitting CPR-namespaced metadata for new standalone sessions.
- Keep public proxy mount paths configurable.
- Keep usage callbacks available even after the standalone ledger is added.
- Do not remove MultiCC adapters until host parity tests demonstrate equivalent spawn and proxy behavior.
