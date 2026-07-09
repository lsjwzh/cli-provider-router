# cli-provider-router

> Route any AI CLI (`claude` / `codex` / `opencode`) to a different upstream provider **per invocation** — by injecting spawn env. Zero changes to the CLI itself.
>
> Includes a Responses↔Chat protocol proxy so `codex` (which only speaks `/responses`) can reach domestic providers that only expose `/chat/completions` (DeepSeek, iFlytek GLM, Qwen, MiniMax, …).

Library + CLI (`cpr`).

---

## Why

`claude code` / `codex` / `opencode` each pick their upstream from env vars or a config file. If you want one terminal on DeepSeek and another on iFlytek GLM, you're stuck juggling env exports or config edits. And `codex` can't talk to most domestic providers at all — they don't expose the `/responses` endpoint it requires.

`cli-provider-router` fixes both:

- **Per-call routing**: wrap any CLI invocation with a provider name, get the right env injected. No config wrestling.
- **Protocol bridge**: a local proxy translates `codex`'s `/responses` ↔ `/chat/completions`, so it can reach chat-only providers.

It keeps its **own** provider store (`~/.cli-provider-router/providers.json`), and can **import** (read-only) from [`cc-switch`](https://github.com/farion1231/cc-switch) so you don't reconfigure from scratch.

## Install

```bash
npm install -g cli-provider-router
```

Or use without install: `npx cli-provider-router ...` / `npx cpr ...`

## CLI quick start

```bash
# Add a provider
cpr add deepseek --app claude \
  --base-url https://api.deepseek.com --token sk-xxx --model deepseek-chat

# Import from cc-switch (read-only — never writes back)
cpr import

# List
cpr list

# Use a provider to run a CLI — env is injected, TTY is preserved
cpr use deepseek -- claude -p "write quicksort in python"
cpr use xfyun-glm -- codex exec "implement this feature"
cpr use deepseek -- claude        # interactive mode works too

# codex → chat-only provider: start the protocol proxy, point codex at it
cpr proxy start --port 4567
cpr use xfyun-glm -- codex        # routes through the local proxy

# Diagnostics
cpr doctor
```

`cpr use <provider> -- <cmd...>` spawns the command with the provider's env merged in and `stdio: inherit`, so colors, interactive prompts, and exit codes all pass through.

## Library API

For hosts that manage sessions themselves (e.g. [multicc](https://github.com/lsjwzh/multicc)):

```js
const cpr = require('cli-provider-router');

const store = cpr.createStore({
  dataFile: '~/.cli-provider-router/providers.json', // configurable
  ccSwitchDb: '~/.cc-switch/cc-switch.db',           // import source
});

store.listProviders('claude');           // -> [{ id, name, appType, ... }]
store.getProvider('claude', id);          // -> full provider (with settingsConfig)
store.getProviderSummary('claude', id);   // -> UI-friendly { baseUrl, model, tokenMask, modelOptions, aliasOnly, aliasMap }
store.createProvider({ appType: 'claude', name, baseUrl, authToken, model, models });
store.updateProvider('claude', id, { ... });
store.deleteProvider('claude', id);
store.importFromCcSwitch();               // -> { imported, updated, total }

// The core: compute the env to inject when spawning a CLI for a provider.
// `store` is passed in so spawn-env can look the provider up; `model` is an
// optional per-invocation override.
const r = cpr.buildChildEnv(process.env, { cli: 'claude', providerId: 'xxx', store });
// -> { env, skipDefaultModel, aliasOnly, providerModel, providerModels, providerName, codexHome }
// spawn('claude', args, { env: { ...process.env, ...r.env } })

// Optional: mount the protocol proxies on an express-compatible app.
cpr.mountClaudeProxy(app, { getProvider: (t, id) => store.getProvider(t, id), onUsage: (e) => {} });
cpr.mountCodexProxy(app, { getProvider: (t, id) => store.getProvider(t, id), getPort: () => 3000 });
```

### Design notes

- **No session concept in the library.** `buildChildEnv` takes `{ cli, providerId, store }` — it doesn't know about your session object, just the two fields it needs.
- **No usage storage.** Proxies emit an `onUsage(event)` hook; the host tallies tokens however it likes. The library never reads or writes a `token_usage.json`.
- **express is an optional peer dep.** `mountXxxProxy(app, …)` accepts any express-compatible app; `createHandler()` is also exported for custom routing.
- **Configurable paths.** `createStore({ dataFile, ccSwitchDb })` — nothing is hardcoded to a host's directory.

## Supported CLIs

| CLI | Routing mechanism | Chat-only provider support |
|---|---|---|
| `claude` (claude-code) | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` + alias tiers | n/a (speaks `/v1/messages`) |
| `codex` | `CODEX_HOME` (per-provider auth + config.toml) | via the bundled Responses↔Chat proxy |
| `opencode` / `zcode` | native config passthrough | n/a |

## Provider model

A provider mirrors cc-switch's shape so import/export is uniform:

```js
{
  id, name, appType,            // 'claude' | 'codex'
  source: 'ccswitch' | 'manual',
  settingsConfig: {
    env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL }, // claude
    config: '<toml>',           // codex
    auth: { OPENAI_API_KEY },   // codex
    modelCatalog: { models: [{ model }] },
    proxyTarget: { baseUrl, apiKey, mode },  // codex protocol-bridge target
  }
}
```

`store.summary()` derives the UI-friendly fields: `baseUrl`, `model`, `tokenMask`, `modelOptions`, `aliasOnly`, `aliasMap`.

## License

MIT
