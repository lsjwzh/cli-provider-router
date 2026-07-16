# Agent Routing and Usage

## Ownership

The provider/model routing core for sub-agents belongs in cli-provider-router. CPR should also own normalized usage accounting and the standalone usage ledger. MultiCC remains responsible for creating sessions and agents, assigning work, and supplying session/role context to CPR.

## Current behavior

The route helpers and proxy handlers already support a main provider plus sub-agent route metadata. Proxy usage callbacks emit normalized events containing session, role, provider, model, stream flag, and token fields. Standalone route-profile persistence, an embedded usage database, and the Web editor are still in development.

Current role granularity differs by CLI:

- Claude can reliably distinguish `main` from `sub` in the current integration contract. The project must not promise a different provider for every named Claude Agent until the CLI supplies dependable role identity.
- Codex can carry role names such as `main`, `default`, `worker`, and `explorer`; unknown roles should fall back to the configured default sub-agent route.

## Target route profile

The planned standalone schema should be explicit and versioned, for example:

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

The planned ledger will add event IDs, CLI, request timestamps, duration, outcome/error class, and route-profile revision. Request or response content is out of scope for routine statistics.

## Web console target

The route page will edit:

- Claude main and global sub-agent provider/model.
- Codex main, default, worker, and explorer provider/model.
- Validation for missing provider, unsupported model, and proxy requirement.
- An effective-route preview before saving.

The statistics page will aggregate by date, CLI, main/sub role, provider, model, and session, including input/output/cache tokens, failure rate, and latency where available.

## Host integration

Hosts should pass stable `sessionId` and role values and consume the same normalized usage event. CPR must not inspect a MultiCC database to discover them. A host may persist usage itself, use CPR's future ledger, or do both with explicit event deduplication.
