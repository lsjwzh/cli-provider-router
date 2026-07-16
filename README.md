# cli-provider-router

Route Claude Code and Codex to different upstream providers without changing the CLIs themselves. `cli-provider-router` (CPR) provides a reusable routing library, a `cpr` command, and local Claude/Codex protocol proxies.

[简体中文](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

> Project status: **early development**. Provider storage, read-only CC-Switch import, per-invocation routing, and the Claude/Codex proxy core work today. The standalone Web console, reversible CC-Switch takeover, daemon lifecycle, and built-in usage ledger are under development. See the status table before relying on a command.

## Why CPR

- Keep provider credentials and generated Codex homes under CPR's own data directory, isolated from MultiCC.
- Select a provider per CLI invocation instead of repeatedly editing global environment variables.
- Bridge Codex `/responses` traffic to chat-only upstreams such as DeepSeek.
- Reuse the same routing core from another host while keeping session orchestration in that host.
- Configure main-agent and sub-agent routes through one standalone product. The route engine exists; persistence, statistics, and the Web workflow are being completed.

## Feature status

| Capability | Status | Interface |
|---|---|---|
| Provider add/list/show/remove | Available | `cpr add`, `list`, `show`, `rm` |
| Read-only import from CC-Switch | Available | `cpr import` |
| Per-invocation Claude/Codex routing | Available | `cpr use` |
| Claude and Codex protocol proxy core | Available | Library API; `cpr proxy start` runs in foreground |
| Reversible CC-Switch endpoint takeover | In development | Planned CLI and Web console |
| Main/sub-agent route editor | In development | Planned Web console |
| Persistent usage statistics | In development | Planned Web console and query API |
| Background daemon lifecycle | In development | Planned `cpr serve/start/stop/status` |

## CC-Switch: import, MultiCC sync, and CPR takeover are different

These operations must not be treated as aliases:

- **CPR read-only import (available):** `cpr import` copies provider data from CC-Switch into CPR's own store. It does not write to CC-Switch.
- **MultiCC CC-Switch sync:** a MultiCC-owned feature that reads/copies CC-Switch provider data for MultiCC. MultiCC keeps its own proxy and session behavior. CPR does not replace or silently change this workflow.
- **CPR reversible takeover (in development):** a standalone CPR feature. It will first create and verify a local snapshot of the original CC-Switch endpoints, then transactionally replace selected endpoints with CPR's local proxy URLs, and later restore the original endpoint fields. It is an opt-in write operation with preview, conflict detection, and recovery controls.

The takeover safety contract is documented in [docs/ccswitch-safety.md](docs/ccswitch-safety.md). Until that implementation lands, CPR only performs read-only import.

## Installation

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

The installer refuses a version that differs from `package.json`, builds a package from the selected checkout, lets npm verify dependency integrity, checks JavaScript syntax, and runs `cpr --version` plus `cpr doctor`. It installs application versions under `CPR_INSTALL_ROOT` and preserves user data in `CPR_HOME`.

Default locations:

| Setting | macOS/Linux | Windows |
|---|---|---|
| `CPR_HOME` | `~/.cli-provider-router` | `%USERPROFILE%\.cli-provider-router` |
| `CPR_INSTALL_ROOT` | `~/.local/share/cli-provider-router` | `%LOCALAPPDATA%\cli-provider-router` |
| command shim | `~/.local/bin/cpr` | `%LOCALAPPDATA%\Microsoft\WindowsApps\cpr.cmd` |

Add the command-shim directory to `PATH` if it is not already present. `CPR_BIN_DIR` overrides it. The generated launcher exports both `CPR_HOME` and a compatible `CPR_DATA_FILE` path.

### Upgrade from another fixed checkout

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

Upgrade creates a timestamped backup under the install root, installs side-by-side, runs health checks, and rolls the active application pointer back if installation fails. It does not delete `CPR_HOME`.

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

Uninstall preserves `CPR_HOME` unless purge is explicitly requested. It refuses to uninstall while the CPR CC-Switch integration state says takeover is active; restore CC-Switch first. This guard is already enforced by the scripts even while the takeover UI is still under development.

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

# Run the current foreground proxy (Ctrl-C to stop)
cpr proxy start --port 4567

cpr doctor
```

`cpr proxy status` and `stop` currently explain that the proxy is foreground-only. Do not treat them as daemon controls.

## Library API

```js
const cpr = require('cli-provider-router');

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
```

The proxy emits normalized usage events but the current release does not persist them. See [docs/agent-routing.md](docs/agent-routing.md) for route boundaries and current role granularity.

## Data and security

- Keep `CPR_HOME` private; it may contain provider credentials and generated CLI configuration.
- The standalone service is designed to bind to `127.0.0.1` by default. Remote exposure will require explicit authentication and TLS termination.
- Secrets must never appear in bug reports, screenshots, logs, or committed fixtures.
- CC-Switch takeover will use a verified SQLite snapshot and field-level restore, not an uncoordinated file copy.

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
