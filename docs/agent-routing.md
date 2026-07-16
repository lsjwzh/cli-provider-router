# Agent Routing and Usage

## Ownership

The provider/model routing core for sub-agents belongs in cli-provider-router. CPR also owns normalized usage accounting and the standalone usage ledger. MultiCC remains responsible for creating sessions and agents, assigning work, and supplying session/role context to CPR.

## Current behavior

The route helpers and proxy handlers support a main provider plus sub-agent route metadata. Proxy usage callbacks emit normalized events containing session, role, provider, model, stream flag, and token fields. The standalone service persists route profiles and date-sharded usage events; the Web console edits routes and queries usage.

Current role granularity differs by CLI:

- Claude can reliably distinguish `main` from `sub` in the current integration contract. The project must not promise a different provider for every named Claude Agent until the CLI supplies dependable role identity.
- Codex can carry role names such as `main`, `default`, `worker`, and `explorer`; unknown roles should fall back to the configured default sub-agent route.

## Route profile

The standalone schema is explicit and versioned, for example:

```json
{
  "schemaVersion": 1,
  "cli": "codex",
  "main": { "providerId": "provider-a", "model": "model-a" },
  "subagents": {
    "default": { "providerId": "provider-b", "model": "model-b" },
    "worker": { "providerId": "provider-c", "model": "model-c" },
    "explorer": { "providerId": "provider-b", "model": "model-b" }
  }
}
```

Resolution order is exact role → `default` sub-agent → main route. Missing/deleted providers are validation errors in the editor and explicit fallback events at runtime.

## Usage event contract

The existing proxy callback normalizes usage into fields including:

```js
{
  sessionId,
  role,
  providerId,
  providerName,
  model,
  isStream,
  usage: {
    inputTokens,
    outputTokens,
    cacheWrite,
    cacheRead
  }
}
```

The ledger adds stable event metadata, timestamps, protocol/role/provider/model dimensions, outcome and normalized token/cache counts where observable. Request or response content is out of scope for routine statistics.

## Web console

The route page edits:

- Claude main and global sub-agent provider/model.
- Codex main, default, worker, and explorer provider/model.
- Validation for missing provider, unsupported model, and proxy requirement.
- An effective-route preview before saving.

The usage page filters by date, CLI, main/sub role, provider, model, and session and reports input/output/cache token fields where the upstream protocol exposes them. `cpr usage` provides the same standalone ledger for terminal workflows.

## Host integration

Hosts should pass stable `sessionId` and role values and consume the same normalized usage event. CPR must not inspect a MultiCC database to discover them. A host may persist usage itself, use CPR's future ledger, or do both with explicit event deduplication.
