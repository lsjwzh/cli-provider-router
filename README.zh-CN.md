# cli-provider-router

在不修改 Claude Code、Codex 本体的情况下，把不同调用路由到不同上游 Provider。`cli-provider-router`（CPR）由可复用路由库、`cpr` 命令以及本地 Claude/Codex 协议代理组成。

[English](README.md) · [架构](docs/architecture.md) · [安全策略](SECURITY.md) · [参与贡献](CONTRIBUTING.md)

> 项目状态：**早期开发阶段**。当前支持源码安装，npm 尚未发布。Provider 路由、双端口托管服务、本地 Web 控制台、可逆 CC-Switch 接管、路由配置和用量账本均已实现并有集成测试。

## 为什么需要 CPR

- Provider 凭据、生成的 Codex home 和运行数据存入 CPR 自有目录，与 MultiCC 隔离。
- 每次启动 CLI 时单独选择 Provider，不再反复修改全局环境变量。
- 把 Codex 的 `/responses` 请求桥接到只支持 `/chat/completions` 的上游。
- 路由内核可以被 MultiCC 等宿主复用，但 Session 和 Agent 编排仍由宿主负责。
- 主 Agent、子 Agent 的路由核心属于 CPR，可在本地 Web 控制台配置并查看统计。

## 功能状态

| 能力 | 状态 | 入口 |
|---|---|---|
| Provider 增删查 | 已可用 | `cpr add/list/show/rm` |
| 从 CC-Switch 只读导入 | 已可用 | `cpr import` |
| Claude/Codex 单次调用路由 | 已可用 | `cpr use` |
| Claude/Codex 协议代理核心 | 已可用 | 库 API 和托管服务 |
| 可逆 CC-Switch endpoint 接管 | 已可用 | Web 预览/快照/应用/恢复 + gateway |
| 主/子 Agent 路由编辑器 | 已可用 | Web 控制台 |
| 持久化用量统计 | 已可用 | `cpr usage` 和 Web 控制台 |
| 后台服务生命周期 | 已可用 | `cpr serve/start/status/stop/restart` |

## 务必区分三种 CC-Switch 功能

下面三件事不是同一个功能，也不会互相隐式触发：

- **CPR 只读导入（已可用）**：`cpr import` 把 CC-Switch Provider 数据复制到 CPR 自己的 store，绝不回写 CC-Switch。
- **MultiCC 的 CC-Switch 同步**：由 MultiCC 自己负责，只读取/复制 CC-Switch 数据供 MultiCC 使用；MultiCC 继续采用自己的默认代理和 Session 逻辑。CPR 不替换、不暗改这条链路。
- **CPR 可逆接管（已可用）**：CPR 的独立功能。先在 CPR 本地生成并校验 CC-Switch 原始 endpoint 快照，再由事务把选中的 endpoint 改为 CPR 本地代理 URL；恢复时只还原受管理字段。流式 gateway 只从 active state 对应的不可变快照读取上游，并对本机回环和异常状态 fail-closed。

完整安全约束见 [docs/ccswitch-safety.md](docs/ccswitch-safety.md)。只读导入仍是独立操作，绝不会自动启用接管。

## 安装

### 当前支持方式：从固定源码版本安装

npm 包**尚未发布**，也没有受支持的 `latest` 安装器。当前不要使用 `npm install -g cli-provider-router` 或 `npx cli-provider-router`。

请先审阅并 checkout 到明确的 commit/tag，再把精确版本交给安装脚本：

```bash
git clone https://github.com/lsjwzh/cli-provider-router.git
cd cli-provider-router
git checkout <已审阅的-commit-或-tag>
VERSION="$(node -p "require('./package.json').version")"
./scripts/install.sh --source "$PWD" --version "$VERSION"
```

Windows PowerShell：

```powershell
git clone https://github.com/lsjwzh/cli-provider-router.git
Set-Location cli-provider-router
git checkout <已审阅的-commit-或-tag>
$Version = node -p "require('./package.json').version"
.\scripts\install.ps1 -Source $PWD.Path -Version $Version
```

安装器会拒绝与 `package.json` 不一致的版本；从指定 checkout 打包，由 npm 校验依赖完整性，检查 JavaScript 语法，并运行 `cpr --version` 和 `cpr doctor`。应用版本保存在 `CPR_INSTALL_ROOT`，用户数据保存在独立的 `CPR_HOME`。

默认路径：

| 设置 | macOS/Linux | Windows |
|---|---|---|
| `CPR_HOME` | `~/.cli-provider-router` | `%USERPROFILE%\.cli-provider-router` |
| `CPR_INSTALL_ROOT` | `~/.local/share/cli-provider-router` | `%LOCALAPPDATA%\cli-provider-router` |
| 命令入口 | `~/.local/bin/cpr` | `%LOCALAPPDATA%\Microsoft\WindowsApps\cpr.cmd` |

如果命令入口目录不在 `PATH`，请手动加入。可用 `CPR_BIN_DIR` 覆盖入口目录。生成的启动器会同时设置 `CPR_HOME` 和兼容当前版本的 `CPR_DATA_FILE`。

## 升级

升级同样要求固定、已审阅的源码版本，不会自动追随 `latest`：

```bash
git fetch --tags origin
git checkout <已审阅的新-commit-或-tag>
VERSION="$(node -p "require('./package.json').version")"
./scripts/upgrade.sh --source "$PWD" --version "$VERSION"
```

```powershell
git fetch --tags origin
git checkout <已审阅的新-commit-或-tag>
$Version = node -p "require('./package.json').version"
.\scripts\upgrade.ps1 -Source $PWD.Path -Version $Version
```

升级脚本会在安装根目录生成时间戳备份，旁路安装新版本并执行健康检查；失败时恢复旧应用指针。升级不会删除 `CPR_HOME`。

## 卸载

```bash
./scripts/uninstall.sh          # 保留数据
./scripts/uninstall.sh --purge  # 明确删除数据
```

```powershell
.\scripts\uninstall.ps1        # 保留数据
.\scripts\uninstall.ps1 -Purge # 明确删除数据
```

默认保留 `CPR_HOME`。如果 CPR 集成状态显示 CC-Switch 正处于接管状态，脚本会拒绝卸载，必须先从 Web 控制台恢复 CC-Switch。

## 快速开始（当前可用命令）

```bash
cpr add deepseek --app claude \
  --base-url https://api.deepseek.com \
  --token sk-xxx \
  --model deepseek-chat

cpr import              # 只读导入
cpr list
cpr show deepseek --app claude
cpr use deepseek -- claude -p "用 Python 写快速排序"
cpr start --port 4567 --web-port 4568
cpr status                    # 输出 Web URL 和 0600 token 文件路径
cpr serve --port 4567 --web-port 4568  # 前台模式
cpr doctor
```

Web 控制台默认位于 `http://127.0.0.1:4568`，包含 Dashboard、Provider、CC-Switch 预览/快照/应用/恢复、Agent Routing、Usage 和 Settings。`cpr proxy start/status/stop/restart` 是托管服务命令的兼容别名，停止时两个监听端口会同时关闭。

## 子 Agent 路由和统计边界

子 Agent 路由代码和统计核心应归属 CPR：

- CPR 负责 Provider、模型、main/sub（以及 Codex role）路由规则和规范化 usage 事件。
- CPR 独立模式将负责规则持久化、用量账本和 Web 页面。
- MultiCC 负责 Session、Task、Workflow、worktree、dispatch 等编排，并把 Session/role 上下文传给 CPR。

standalone 服务会持久化规范化用量事件，并通过 CLI/Web 查询。详见 [docs/agent-routing.md](docs/agent-routing.md)。

## 数据与安全

- `CPR_HOME` 可能包含 Provider 凭据和生成配置，必须限制文件权限并排除在版本控制之外。
- 独立服务设计为默认只监听 `127.0.0.1`；远程暴露必须显式配置鉴权和 TLS。
- 不要把 token 写入 issue、日志、截图或测试 fixture。
- CC-Switch 接管使用经过校验的 SQLite 快照和字段级恢复，不采用无协调的普通文件复制。

运行生产凭据前请阅读 [docs/data-and-security.md](docs/data-and-security.md) 和 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm install
npm test
npm run lint
npm run test:scripts
```

贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本状态见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT
