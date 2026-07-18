# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for source and package releases.

## [Unreleased]

### Added

- Stable host-embedding contracts for pure model policy and upstream HTTP
  target resolution, provider protocol/wire summaries, scoped managed route
  credentials, and one-call Claude/Codex session route preparation.
- Explicit host storage injection for provider data, Codex homes, usage, and
  managed credentials without initializing the default CPR home.

## [0.3.0] - 2026-07-18

### Added

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

[Unreleased]: https://github.com/lsjwzh/cli-provider-router/compare/main...HEAD
[0.3.0]: https://github.com/lsjwzh/cli-provider-router/compare/v0.2.0...v0.3.0
