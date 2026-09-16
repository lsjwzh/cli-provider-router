# Local request hooks (`onRequest` / `onUpstreamRejected`)

The protocol proxies sit between a CLI and a provider. Two things about that
position are unique: the proxy is the last component to see a request **before**
the upstream, and the only one that ever sees the upstream **reject** it.

Some request bodies are valid for one upstream and invalid for the next. A
conversation that one provider accepted can carry assistant reasoning traces,
encrypted content blobs, or replay ids that a different provider refuses with a
`400`/`404` — the request is well-formed, its *history* is not. That history
belongs to the host, not to the router: only the host knows which upstream the
session came from, which one it is going to, and what may be dropped.

Request hooks are the host's data-correction stage **on the hop**, so that
correction no longer has to be guessed at spawn time.

## Two moments

```js
cpr.mountClaudeProxy(app, {
  getProvider: (type, id) => store.getProvider(type, id),
  // Before the dial: fix the body up, or leave it alone.
  onRequest: (ctx) => ({ body: repair(ctx.body) }),
  // After a non-2xx: repair and re-send, once.
  onUpstreamRejected: (ctx) => (repairable(ctx) ? { retry: true, body: repair(ctx.body) } : undefined),
  hookRetryMax: 1,     // default 1
  hookTimeoutMs: 5000, // default 5000
});
```

The same options are accepted by `mountCodexProxy`, `createClaudeHandler` and
`createCodexHandler`.

### `ctx`

| field | meaning |
| --- | --- |
| `protocol` | protocol the **body is in**: `anthropic-messages` (claude) or `openai-responses` (codex) |
| `mode` | how the router will reach the upstream: `anthropic-messages`, `direct-responses`, `responses-compat`, `chat-to-responses` |
| `providerId`, `providerName` | the provider actually routed to (for a codex subagent route, the resolved provider) |
| `sessionId`, `role`, `roleKind`, `agentRole`, `routeName` | the managed route, as billed |
| `model` | the model actually sent upstream (post tier-alias resolution) |
| `isStream` | whether the client asked for a stream |
| `body` | the request body: the parsed object when it is JSON, otherwise the raw string |
| `bodyText` | always the raw text of the body |
| `status`, `message` | **rejection only** — the upstream status code and its response body (bounded) |
| `attempt` | **rejection only** — the caller's dial attempt, for logging. Not a budget: the retry budget is counted internally. |
| `errorCode` | **rejection only** — currently always `UPSTREAM_HTTP_ERROR` |

### Return value

`{ body }` replaces the body: an object is re-serialized, a string is used
verbatim. Returning nothing (or `null`, `undefined`, `false`, a non-object, an
object without `body`) leaves the request exactly as it was.

On the rejection path, `retry: true` is what authorizes a second dial. A `body`
returned **without** `retry: true` is ignored — a hook that only inspects a
rejection cannot change what the client ends up seeing. `{ retry: true }` with
no body re-dials the same request, which is useful for waiting out a transient
rejection.

## Guarantees

- **A hook never changes an untouched request.** When nothing is returned, the
  original bytes are forwarded — not a re-encoded copy — so the prompt-cache
  prefix of a normal turn is byte-identical to what it was before hooks existed.
- **Hooks are optional and inert.** With no hook installed, the dial loop, the
  error forwarding and the retry budgets are exactly what they were.
- **Bounded.** Repairs are limited to `hookRetryMax` and counted internally, so
  a hook that always asks for another try cannot keep a turn alive, and a
  caller's own attempt counter (the codex Responses-compat busy-retry) cannot
  buy extra repairs.
- **Failure-tolerant.** Every call is wrapped in `hookTimeoutMs` and its errors
  are swallowed and logged. Hook code is host code running inside the router
  process: a buggy or wedged hook degrades to "no change" and can never take the
  router down, wedge a turn, or truncate a stream.
- **Invisible to the client.** A retry only happens before anything has been
  written downstream. The client either gets its answer from the repaired
  request, or — if the repair does not help — the original rejection, verbatim.
- **In the client's protocol.** Hooks always see the body the CLI itself sent,
  even when the router has to translate it (codex → chat-only providers). The
  host repairs the shape it owns; translation re-runs on the repaired body.

## Where the hooks run

| hop | pre-dial (`onRequest`) | rejection (`onUpstreamRejected`) |
| --- | --- | --- |
| claude (Anthropic messages) | after tier-alias/model rewriting, before the dial | non-2xx, after the error body is buffered |
| codex `direct-responses` | before the dial | non-2xx |
| codex `responses-compat` | before the dial | non-2xx, sharing the loop with the busy-retry (each budget stays its own) |
| codex `chat-to-responses` | before translation | non-2xx, then the repaired Responses body is re-translated |

## Example: dropping cross-provider history

```js
const poison = (body) => {
  if (!Array.isArray(body.input)) return null;
  const input = body.input.filter(item => !(item.type === 'reasoning' || item.encrypted_content));
  return input.length === body.input.length ? null : { ...body, input };
};

cpr.mountCodexProxy(app, {
  getProvider: (type, id) => store.getProvider(type, id),
  onRequest: (ctx) => {
    const repaired = poison(ctx.body);
    return repaired ? { body: repaired } : undefined;
  },
  onUpstreamRejected: (ctx) => {
    // The upstream refused something we did not predict (a dangling
    // previous_response_id, a content shape it dislikes): strip what we can and
    // give it exactly one more chance.
    const repaired = poison(ctx.body);
    return { retry: true, body: { ...(repaired || ctx.body), previous_response_id: undefined } };
  },
});
```

## Capability negotiation

`CAPABILITIES.requestHooks` is `1.0` from the release that introduced
`onRequest`, `onUpstreamRejected`, `hookRetryMax` and `hookTimeoutMs`;
`CAPABILITIES.protocolProxy` is `1.1` and `API_VERSION` is `1.3.0`.
