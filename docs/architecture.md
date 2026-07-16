# Architecture

## Product boundary

cli-provider-router owns provider normalization, CLI spawn configuration, protocol routing, standalone route policy, normalized usage events, the standalone usage ledger, and the Web console.

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
                         +--> CPR usage ledger
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
├── data/route-profiles.json
├── data/usage/                     # date-sharded JSONL ledger
├── ccswitch/state.json
├── ccswitch/snapshots/
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
3. CPR reversible takeover: verified snapshot → selected CC-Switch endpoint rewrite → CPR snapshot-backed gateway → upstream, with restore.

No path should silently activate another. In particular, importing providers must never imply takeover.

## Web and managed service

`cpr start` and `cpr serve` run the proxy/gateway port and a separate Web port in one process. Both bind only to `127.0.0.1`; the Web port defaults to proxy port + 1. The service writes its state, health, PID, and a 0600 admin token under `CPR_HOME/run`. It owns provider UI, CC-Switch preview/snapshot/apply/restore, route profiles, usage queries, settings, and health status. `stop` closes both HTTP servers before recording the stopped state.

The CC-Switch gateway is mounted before JSON parsing so it can stream arbitrary request and response bodies. It resolves upstreams only through the active takeover state's `snapshotId`, verifies snapshot hashes, preserves authentication headers, appends the remaining path/query safely, and rejects loopback/self routes.

## Compatibility principles

- Accept legacy routing metadata while emitting CPR-namespaced metadata for new standalone sessions.
- Keep public proxy mount paths configurable.
- Keep usage callbacks available even after the standalone ledger is added.
- Do not remove MultiCC adapters until host parity tests demonstrate equivalent spawn and proxy behavior.
