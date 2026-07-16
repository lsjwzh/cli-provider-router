# CC-Switch Safety Contract

## Status

`cpr import` is read-only. Reversible endpoint takeover is available through the loopback Web console and library API. This document defines the safety contract enforced by the implementation.

## Not the MultiCC sync feature

MultiCC's CC-Switch sync reads/copies provider information for MultiCC and continues to use MultiCC's own proxy/session behavior. CPR takeover is an independent standalone workflow that deliberately changes selected CC-Switch endpoint fields after creating a recoverable local snapshot. Neither operation enables the other.

## State machine

```text
unmanaged
   |
   v
snapshot-ready --> previewed --> active --> restoring --> unmanaged
      |               |           |
      +---- error <---+-----------+
                                  |
                                  +--> conflict
```

Every transition must be persisted in `CPR_HOME/data/integration-state.json` with the CC-Switch database identity, snapshot identifier, selected providers, original-field hashes, proxy address, and timestamp. `active` must not be written until both the database transaction and proxy health check succeed.

## Snapshot requirements

Before any write, CPR must:

1. Confirm the proxy is healthy and listening on loopback.
2. Detect CC-Switch schema/version and reject unknown layouts.
3. Refuse operation if CC-Switch's own local-routing takeover is active or another CPR operation is unfinished.
4. Create a consistent SQLite snapshot using the SQLite backup API. A plain copy of a live database is invalid when WAL may be active.
5. Record a redacted manifest of provider ID, JSON path, original endpoint, and content hash.
6. Verify the snapshot can be opened and its recorded rows can be read before modifying the live database.
7. Protect the snapshot directory for the current user only.

Snapshots contain credentials and must never be uploaded or attached to issues.

## Apply requirements

- Show a preview of every selected `original URL → local URL` change.
- Rewrite only allowlisted provider endpoint fields inside one SQLite transaction.
- Use provider-specific local URLs so the proxy can select the saved upstream without reading its own rewritten value.
- Read upstream endpoints from CPR's verified integration snapshot/state, not the modified CC-Switch rows. This prevents localhost routing loops.
- Roll back the transaction on any validation or write failure.
- Re-read the committed rows and compare them with the preview before reporting success.

## Gateway requirements

- Mount `/ccswitch/:appType/:providerId[/endpoint/:rowId]/*` before any JSON/body parser.
- Resolve upstream only from the immutable endpoint map named by the active takeover state; never consult rewritten live rows.
- Verify snapshot database and endpoint-map hashes before resolving a request.
- Reject inactive/restored/conflict state, missing mappings, invalid paths, unsupported schemes, credentials embedded in URLs, and localhost/self-loop upstreams.
- Preserve end-to-end authorization headers and stream request/response bodies without buffering.
- Append remaining path segments and query parameters without allowing path traversal or replacing the snapshot base path.

## Restore requirements

Normal restore is field-level, not whole-database replacement:

- Restore only endpoint fields changed by the selected CPR takeover.
- Preserve unrelated names, models, credentials, and providers changed after takeover.
- Compare the current field with the value CPR wrote. If it differs, mark a conflict and require an explicit user decision instead of overwriting it.
- Verify restored values before marking the integration unmanaged.

A full snapshot replacement is a separately labeled disaster-recovery operation. It must stop writers, preserve the current database as another recovery artifact, and warn that unrelated later changes may be lost.

## Web controls

The Web console exposes status/schema detection, snapshot creation, diff preview, apply, restore, conflicts, and proxy health. Write operations require the loopback guard, admin token, same-origin checks, and typed confirmation.

## Shutdown and uninstall

The daemon must refuse a normal stop that would strand active CC-Switch endpoints unless a supervised handoff or restore is completed. Install scripts must refuse uninstall when integration state is active. Force options must not bypass restoration silently.

## Test matrix

- SQLite journal modes: DELETE and WAL.
- Supported CC-Switch schema fixtures plus unknown schema rejection.
- Crash before transaction, during transaction, after commit, and before state update.
- CC-Switch edits an endpoint after CPR takeover (restore conflict).
- Proxy port unavailable or health check fails.
- CC-Switch's own takeover already active.
- Repeated apply/restore is idempotent.
- Snapshot corruption is detected before a write.
