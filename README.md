# cli-provider-router

Route Claude Code and Codex to different upstream providers without changing the CLIs themselves. `cli-provider-router` (CPR) provides a reusable routing library, a `cpr` command, and local Claude/Codex protocol proxies.

[简体中文](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

> Project status: **0.3.x source release**. npm is not published yet. Provider routing, the dual-port managed service, local Web console, reversible CC-Switch takeover, reversible native CLI configuration takeover, route profiles, and usage ledger are implemented and covered by tests.

## Why CPR

- Keep provider credentials and generated Codex homes under CPR's own data directory, isolated from MultiCC.
- Select a provider per CLI invocation instead of repeatedly editing global environment variables.
- Bridge Codex `/responses` traffic to chat-only upstreams such as DeepSeek.
- Reuse the same routing core from another host while keeping session orchestration in that host.
- Configure main-agent and sub-agent routes, inspect statistics, and manage CC-Switch takeover from one local Web console.

## Feature status

| Capability | Status | Interface |
|---|---|---|
| Provider add/list/show/remove | Available | `cpr add`, `list`, `show`, `rm` |
| Read-only import from CC-Switch | Available | `cpr import` |
| Per-invocation Claude/Codex routing | Available | `cpr use` |
| Claude and Codex protocol proxy core | Available | Library API and managed service |
| Reversible CC-Switch endpoint takeover | Available | Web preview/snapshot/apply/restore + gateway |
| Reversible native Claude/Codex config takeover | Available | `cpr cli-config` and dedicated Web page |
| Main/sub-agent route editor | Available | Web console |
| Persistent usage statistics | Available | `cpr usage` and Web console |
| Background service lifecycle | Available | `cpr serve/start/status/stop/restart` |

## Four integrations that must remain distinct

These operations must not be treated as aliases:

- **CPR read-only import (available):** `cpr import` copies provider data from CC-Switch into CPR's own store. It does not write to CC-Switch.
- **MultiCC CC-Switch sync:** a MultiCC-owned feature that reads/copies CC-Switch provider data for MultiCC. MultiCC keeps its own proxy and session behavior. CPR does not replace or silently change this workflow.
- **CPR reversible takeover (available):** a standalone CPR feature. It creates and verifies a local snapshot of the original CC-Switch endpoints, transactionally replaces selected endpoints with CPR's local proxy URLs, and restores only the managed endpoint fields. It is an opt-in write operation with preview, conflict detection, recovery controls, and a fail-closed streaming gateway whose upstream comes only from the active immutable snapshot map.
- **CPR direct native CLI takeover (available):** a separate standalone feature for machines with or without CC-Switch. It snapshots the user's native Claude/Codex configuration, previews and applies local CPR routes, detects drift, and restores the exact original files. It does not read or write the CC-Switch database.

The takeover safety contract and recovery behavior are documented in [docs/ccswitch-safety.md](docs/ccswitch-safety.md). Read-only import remains a separate operation and never activates takeover.
Native CLI ownership, managed files, and force-restore risks are documented in [docs/direct-cli-config.md](docs/direct-cli-config.md). None of these four operations implicitly activates another.

## Installation

CPR ships project-owned install, upgrade, and uninstall scripts. They install CPR as an independent application and never place CPR data inside MultiCC or reuse MultiCC's worktree/data directories.

### Current supported method: fixed source checkout

The npm package has **not been published yet**, and there is no supported `latest` installer. Do not use `npm install -g cli-provider-router` or `npx cli-provider-router` yet.

Install from a reviewed commit or tag and pass the exact package version to the installer:

```bash
git clone https://github.com/lsjwzh/cli-provider-router.git
cd cli-provider-router
git checkout <reviewed-commit-or-tag>
VERSION="$(node -p "require('./package.json').version")"
./scripts/install.sh --source "$PWD" --version "$VERSION"
```

Windows PowerShell:

```powershell
git clone https://github.com/lsjwzh/cli-provider-router.git
Set-Location cli-provider-router
git checkout <reviewed-commit-or-tag>
$Version = node -p "require('./package.json').version"
.\scripts\install.ps1 -Source $PWD.Path -Version $Version
```

The installer refuses a version that differs from `package.json`, builds a package from the selected checkout, lets npm verify dependency integrity, checks JavaScript syntax, and runs `cpr --version` plus `cpr doctor`. Every application artifact is installed side-by-side under an immutable identity:

```text
<version>-<source-commit>-<tarball-sha256>
```

The active `current` pointer changes atomically. Reinstalling the same identity verifies and reuses it; it never overwrites that directory. The installer also keeps the exact `.tgz`, SHA-256 sidecar, and `release-manifest.json` containing the source commit, lock-file hash, Node ABI, platform, and architecture. User data remains outside the artifact in `CPR_HOME`.

For an independently supplied expected checksum, add `--expected-sha256 <64-hex>` (PowerShell: `-ExpectedSha256 <64-hex>`). A mismatch aborts before activation.

Default locations:

| Setting | macOS/Linux | Windows |
|---|---|---|
| `CPR_HOME` | `~/.cli-provider-router` | `%USERPROFILE%\.cli-provider-router` |
| `CPR_INSTALL_ROOT` | `~/.local/share/cli-provider-router` | `%LOCALAPPDATA%\cli-provider-router` |
| command shim | `~/.local/bin/cpr` | `%LOCALAPPDATA%\Microsoft\WindowsApps\cpr.cmd` |

Add the command-shim directory to `PATH` if it is not already present. `CPR_BIN_DIR` overrides it. The generated launcher exports both `CPR_HOME` and a compatible `CPR_DATA_FILE` path.

### Upgrade from another fixed checkout

Upgrade is a separate, explicit operation; the installer never silently follows a branch or updates itself.

```bash
cd cli-provider-router
git fetch --tags origin
git checkout <reviewed-new-commit-or-tag>
VERSION="$(node -p "require('./package.json').version")"
./scripts/upgrade.sh --source "$PWD" --version "$VERSION"
```

```powershell
git fetch --tags origin
git checkout <reviewed-new-commit-or-tag>
$Version = node -p "require('./package.json').version"
.\scripts\upgrade.ps1 -Source $PWD.Path -Version $Version
```

Upgrade first backs up `CPR_HOME` and records the old artifact and service state. It then installs and checks the candidate without activating it, stops the old service only when it was running, atomically switches the pointer, and restarts the candidate on the same ports. Any install, activation, restart, or health failure restores all three parts together: the old artifact pointer, the exact pre-upgrade `CPR_HOME`, and the previous running/stopped service state. The failed candidate and timestamped backup remain available for diagnosis.

### Repair a Node/SQLite ABI mismatch

`better-sqlite3` is optional, but CC-Switch import/takeover needs a native binding matching the current Node ABI. After changing Node versions, diagnose and repair the exact active installation with:

```bash
cpr doctor
cpr doctor --repair
```

The repair is scoped to the install prefix reported by `doctor`; it never rebuilds MultiCC's dependencies or another CPR artifact.

### Produce and verify a release artifact

Maintainers can create a tarball, checksum, and machine-readable provenance record without publishing:

```bash
npm run pack:release -- --output ./dist --require-clean
shasum -a 256 -c ./dist/cli-provider-router-*.tgz.sha256
```

The provenance JSON binds package semver, public API version, capabilities, commit, lock-file SHA-256, tarball SHA-256, runtime ABI, platform, and architecture. This command does **not** publish to npm.

### Uninstall

```bash
./scripts/uninstall.sh
# Explicitly delete data too:
./scripts/uninstall.sh --purge
```

```powershell
.\scripts\uninstall.ps1
# Explicitly delete data too:
.\scripts\uninstall.ps1 -Purge
```

Uninstall preserves `CPR_HOME` unless purge is explicitly requested. Both normal uninstall and purge refuse to continue while CC-Switch takeover or native CLI takeover is active. Restore from the corresponding Web page or `cpr cli-config restore` first. The scripts never auto-restore or delete native CLI configuration.

## Quick start (available commands)

```bash
# Add a Claude-compatible provider
cpr add deepseek --app claude \
  --base-url https://api.deepseek.com \
  --token sk-xxx \
  --model deepseek-chat

# Read-only import from CC-Switch
cpr import

cpr list
cpr show deepseek --app claude

# Route one command; stdio and exit status are preserved
cpr use deepseek -- claude -p "write quicksort in Python"

# Start proxy and Web console together
cpr start --port 4567 --web-port 4568
cpr status
# Open http://127.0.0.1:4568; status prints the 0600 admin-token path.

# Foreground mode for development/process managers
cpr serve --port 4567 --web-port 4568

cpr doctor
# Rebuild optional SQLite support for this exact installation when requested
cpr doctor --repair
```

### Directly manage native CLI configuration (CC-Switch not required)

```bash
cpr start
cpr cli-config detect --cli claude
cpr cli-config snapshot --cli claude --profile <profile-id> --json
cpr cli-config preview --cli claude --profile <profile-id>
cpr cli-config apply --cli claude --profile <profile-id> --yes
cpr cli-config status --cli claude
cpr cli-config restore --cli claude --yes
```

Use `--cli codex` for Codex. This workflow backs up before writing, preserves unrelated configuration, and blocks a normal restore after drift. See [the direct CLI configuration guide](docs/direct-cli-config.md) before using `--force`.

`cpr proxy start/status/stop/restart` remains a compatibility alias for the managed service commands. A normal stop shuts down both listeners in the same process.

The Web console provides Dashboard, Providers, a CC-Switch takeover page, a separate CLI Config page for native Claude/Codex detect/snapshot/preview/apply/status/restore, Agent Routing, Usage, and Settings. Both listeners bind to `127.0.0.1`; the Web port defaults to proxy port + 1.

## Library API

Version `0.3.0` exposes an explicit CommonJS export map and TypeScript declarations. Hosts should negotiate against `API_VERSION` and `CAPABILITIES` instead of probing private files or assuming package semver equals the library contract version.

```js
const cpr = require('cli-provider-router');

console.log(cpr.API_VERSION, cpr.CAPABILITIES);

const store = cpr.createStore({
  dataFile: '/absolute/path/to/providers.json',
  ccSwitchDb: '/absolute/path/to/cc-switch.db',
});

const provider = store.createProvider({
  appType: 'claude',
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  authToken: process.env.DEEPSEEK_API_KEY,
  model: 'deepseek-chat',
});

const child = cpr.buildChildEnv(process.env, {
  cli: 'claude',
  providerId: provider.id,
  store,
});

// Mount proxy handlers on an Express-compatible application.
cpr.mountClaudeProxy(app, {
  claudeProxyPath: '/claude-proxy',
  getProvider: (type, id) => store.getProvider(type, id),
  usageSink: event => recordUsage(event),
});

cpr.mountCodexProxy(app, {
  codexProxyPath: '/codex-proxy',
  getProvider: (type, id) => store.getProvider(type, id),
  usageSink: event => recordUsage(event),
});

// Must be mounted before express.json() so request/response streams stay intact.
cpr.mountCcSwitchGateway(app, { home: '/absolute/CPR_HOME' });
```

The standalone service persists normalized usage events and exposes CLI/Web queries. Library hosts can still consume the callback without using CPR's ledger. See [docs/agent-routing.md](docs/agent-routing.md) for route boundaries and current role granularity.

## Data and security

- Keep `CPR_HOME` private; it may contain provider credentials and generated CLI configuration.
- The standalone service is designed to bind to `127.0.0.1` by default. Remote exposure will require explicit authentication and TLS termination.
- Secrets must never appear in bug reports, screenshots, logs, or committed fixtures.
- CC-Switch takeover uses a verified SQLite snapshot and field-level restore, not an uncoordinated file copy.
- Native CLI snapshots and active state live only under `CPR_HOME/direct-cli-config`; CPR never changes Codex `auth.json` for direct takeover.

Read [docs/data-and-security.md](docs/data-and-security.md) and [SECURITY.md](SECURITY.md) before operating on production credentials.

## Development

```bash
npm install
npm test
npm run lint
npm run test:scripts
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for change requirements and [CHANGELOG.md](CHANGELOG.md) for release status.

## License

MIT
