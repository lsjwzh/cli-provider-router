# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and intends to use semantic versioning after the first public release.

## [Unreleased]

### Added

- Standalone installation, upgrade, and uninstall scripts for Bash and PowerShell.
- English and Chinese project documentation covering architecture, data ownership, agent routing, CC-Switch safety, and troubleshooting.

### In development

- Reversible CC-Switch endpoint takeover with verified snapshots and conflict-aware restore.
- Loopback Web console for CC-Switch operations, agent routing, provider management, and statistics.
- Persistent standalone route profiles and usage ledger.
- Background service lifecycle and structured health checks.

## [0.2.0] - Unreleased

The version exists in `package.json` for development and source installation. It has not been published to npm and is not a supported GitHub Release.

### Added

- Provider store and read-only CC-Switch import.
- Per-invocation Claude and Codex environment routing.
- Claude and Codex proxy handlers and Responses-to-Chat transformation.
- Route helpers for main/sub-agent provider selection.

[Unreleased]: https://github.com/lsjwzh/cli-provider-router/compare/main...HEAD
