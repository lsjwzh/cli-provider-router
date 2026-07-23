# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for source and package releases.

## [Unreleased]

### Added

- Token-level delta sidecar (`onDelta`): every proxy branch — Chat→Responses
  (`chatStreamToResponses`), Responses direct (`proxyResponsesDirect`), Responses
  compat (`proxyResponsesCompat`), and Claude (Anthropic SSE) — accepts an optional
  `onDelta(delta, ctx)` callback. As the proxy forwards the upstream stream it
  extracts token-level deltas and forwards them to the host along with routing
  context `{providerId, sessionId, role, routeName, model}`: Chat
  `delta.content`/`reasoning_content`/`tool_calls`, Responses
  `response.output_text.delta`/`reasoning_summary_text.delta`/`function_call_arguments.delta`,
  Anthropic `content_block_delta` (text/thinking/tool_use `partial_json`). This
  lets the host render turns incrementally (opencode-style) instead of waiting
  for each completion boundary. Previously-discarded reasoning streams (e.g.
  domestic providers' `reasoning_content`) now surface too. `onDelta` is optional
  everywhere; when absent, proxy behavior is unchanged.

## [0.4.0] - 2026-07-23

### Added

- Token-level delta sidecar (`onDelta`) across all four proxy branches — see
  [Unreleased] above. New exports: `newResponsesDeltaTee`, `feedResponsesDelta`
  (codex); `_testNewUsageTee`, `_testFeedChunk` (claude, test-only).

## [0.3.0] - 2026-07-18

### Added

- Metadata-only proxy liveness events: both the Claude and Codex proxies accept
  an optional `onActivity` callback fired at three moments per turn —
  `request` (forwarding to the upstream started), `first_byte` (first upstream
  response byte, with `latencyMs`), and `end` (turn finished, with
  `status: 'success' | 'error'`). Payloads carry only routing metadata
  (sessionId/role/providerId/providerName/phase/at/latencyMs/status) — never
  request/response bodies, headers, tokens, or model output — and callback
  errors are swallowed without disturbing the forwarded stream. Declared as
  the `activityEvents` capability; JavaScript API version is now `1.2.0`.

- Durable config-store layer (`cli-provider-router/durable-store`) shared by the
  provider, route-profile, and settings stores: schema envelopes with monotonic
  revisions, rolling on-write backups with transparent recovery
  (`loadOrRecover`), fail-closed strict reads (`readJsonStrict`,
  `CorruptedStateError` — only a missing file yields defaults; permission
  errors, truncation, and malformed JSON raise), optimistic revision CAS
  (`RevisionConflictError`, HTTP 409 shape), and an owner-stamped cross-process
  file lock with timeout and stale-lock recovery (`LockTimeoutError`,
  `acquireFileLock`, `withFileLock`). Legacy bare documents (provider arrays,
  `{ providers }`/`{ version, profiles }` wrappers, bare settings objects)
  migrate transparently on the next write. Declared as the
  `durableConfigStore` capability; JavaScript API version is now `1.1.0`.

### Changed

- Provider, route-profile, and settings CRUD now runs read-modify-write cycles
  under the cross-process lock, so the Web service and concurrent
  `cpr add/rm/import` invocations can no longer lose each other's updates.
  Corrupted store files now fail closed with `CPR_CORRUPTED_STATE` instead of
  silently resetting to defaults (and then overwriting user data).

## [0.3.0] - 2026-07-18

### Added

- Stable host-embedding contracts for pure model policy and upstream HTTP
  target resolution, provider protocol/wire summaries, scoped managed route
  credentials, and one-call Claude/Codex session route preparation.
- Explicit host storage injection for provider data, Codex homes, usage, and
  managed credentials without initializing the default CPR home.
- Standalone installation, upgrade, and uninstall scripts for Bash and PowerShell.
- English and Chinese project documentation covering architecture, data ownership, agent routing, CC-Switch safety, and troubleshooting.
- Reversible CC-Switch endpoint takeover with verified snapshots, conflict-aware restore, and a fail-closed streaming gateway backed only by the active immutable snapshot.
- Reversible native Claude/Codex configuration takeover that works without CC-Switch, with exact snapshots, preview, drift detection, restore, and dedicated CLI/Web controls.
- Loopback Web console with separate CC-Switch and native CLI takeover pages, agent routing, provider management, settings, and statistics.
- Persistent standalone route profiles and sharded usage ledger.
- Managed dual-port proxy/Web service lifecycle with structured health, persistent 0600 admin token, restart, and coordinated shutdown.
- Uninstall guards for active CC-Switch and native CLI takeover state; neither normal uninstall nor purge auto-restores user configuration.
- Explicit `API_VERSION`, `CAPABILITIES`, package exports, TypeScript declarations, and capability schema.
- Immutable version+commit+tar-SHA installations, checksum verification, provenance manifests, and transactional upgrade rollback of artifact, data, and service state.
- `cpr doctor --repair` for a Node/SQLite ABI mismatch in the exact active installation.
- Cross-platform Node/OS CI plus pack, clean-install, API-contract, provenance, and rollback smoke tests.

## [0.2.0] - Unreleased

The version exists in `package.json` for development and source installation. It has not been published to npm and is not a supported GitHub Release.

### Added

- Provider store and read-only CC-Switch import.
- Per-invocation Claude and Codex environment routing.
- Claude and Codex proxy handlers and Responses-to-Chat transformation.
- Route helpers for main/sub-agent provider selection.

[Unreleased]: https://github.com/lsjwzh/cli-provider-router/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/lsjwzh/cli-provider-router/releases/tag/v0.3.0
