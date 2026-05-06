# Phase 3b Design: MCP Operability Slice

## Context

Phase 3a (`docs/ultron_v2/phase3a-v2-design.md`) landed the MCP substrate: stdio transport, JSON-RPC 2.0 framing, `initialize` / `tools/list` / `tools/call`, namespaced `mcp__<server>__<tool>` registration, the `allow`-from-`checkPermissions` cascade pattern, and lifecycle hooks (`init()`, `dispose()`, CLI shutdown). It deliberately deferred cancellation, progress, status visibility, wildcard rules, and non-object schemas.

Phase 3b is the **operability slice**: four items, chosen because the 3a substrate works functionally but is awkward to live with, and because each fits inside an existing seam without widening the execution boundary.

1. **`$/cancelRequest`** — today Ctrl+C releases the Ultron-side pending entry but leaves the server spinning. A user cancelling a 30-second `tools/call` should not pay compute on the other side. Fire-and-forget JSON-RPC notification per MCP spec, outbound-only.
2. **`/mcp status`** — users have no introspection into which servers connected, which tools registered, what failed. Requires a small manager-semantics change so failed and disabled servers are visible, not just connected ones.
3. **Wildcard permission rules** — without suffix `*`, a user installing a 40-tool server must create 40 allow rules. Backward-compatible because literal names never contain `*`. Scoped to suffix-only (`mcp__github__*`, `mcp__*`) to keep the blast radius contained.
4. **Schema wrapping** — MCP tools declaring non-object top-level schemas are legal per spec (e.g., a tool whose only input is a single string, `{ type: 'string' }`). 3a drops them with a stderr warning. 3b wraps them so they register.

### What 3b explicitly does not own

- **Mid-call progress surfacing.** Receiving `notifications/progress` and turning it into an ordered `mcp_tool_progress` event between `tool_call_started` and `tool_call_finished` requires widening `executeToolUse` from `Promise<ToolResult>` (`src/core/queryDeps.ts:147`) into a generator — the shape `runPreToolUseHooks` already uses. That contract change is a phase of its own. 3b leaves `src/core/mcp/client.ts:68-69` dropping unknown notifications unchanged; no `_meta.progressToken` goes on the wire.
- **Wildcards in subagent `allowedTools`.** `src/agents/runAgent.ts:235` uses `parentRegistry.get(name)` — an exact lookup. Expanding wildcards there requires a different change (pattern-match against `parentRegistry.getAll()`) and belongs in the subagent phase. 3b's wildcards are **permission-cascade only**.
- Reconnect/backoff, hot-reload, HTTP/SSE transport, resources/prompts/sampling, project-local `./.ultron/mcp.json`, `/mcp reload`, `/mcp list-tools`, `/mcp call`.

### 3a invariants that must not break

1. **The `allow`-from-`checkPermissions` cascade.** `tool.checkPermissions() → {behavior: 'allow'}` stays. Wildcards take effect at `findMatchingRules` (cascade step 6 matching), *before* the tool-level check; no adapter behavior changes.
2. **`callModel` is rebuilt at most once after MCP bootstrap.** 3b does not re-register tools. Wrapping a non-object schema happens at registration time; the wrapped tool enters the registry once like any other.
3. **`dispose()` is terminal.** The cancel notification is fire-and-forget and must not block `close()`.
4. **Subagent default `allowedTools` is unchanged.** 3b does not touch `DEFAULT_ALLOWED_TOOLS = ['FileRead', 'Glob', 'Grep']`. Users wanting MCP tools in a subagent continue to list exact names; wildcard expansion at the subagent boundary is a separate phase.

---

## Architecture

```
  ┌───────────────────────────────────────────────────────────────────┐
  │  src/cli.ts  (REPL loop)                                          │
  │                                                                   │
  │  slash-command branches (line 115-149):                           │
  │    /quit /exit /session /model                                    │
  │    /mcp status   ←── NEW: calls engine.getMcpStatus()             │
  │                      renders connected / connecting / failed /    │
  │                      disabled rows uniformly                      │
  └───────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │  src/sdk/QueryEngine.ts                                           │
  │    getMcpStatus() — shape unchanged, but now returns all          │
  │    configured servers (not just connected ones)                   │
  └───────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │  src/core/mcp/                                                    │
  │                                                                   │
  │   manager.ts                                                      │
  │     bootstrap: track every configured server from the start      │
  │       of bootstrapOne (state: 'connecting'), transition to        │
  │       'ready' / 'failed' by outcome. Disabled servers enter      │
  │       tracked as state: 'idle' without a client.                 │
  │     shutdown: unregister tools + close clients (unchanged)       │
  │     status(): returns all tracked rows                           │
  │                                                                   │
  │   client.ts                                                       │
  │     callTool.onAbort: send $/cancelRequest before resolving       │
  │       `{kind:'aborted'}` (fire-and-forget)                        │
  │     onLine: unchanged — notifications still drop                 │
  │                                                                   │
  │   toolAdapter.ts                                                  │
  │     wrapSchema() — wraps non-object valid-primitive schemas      │
  │     call(): unwraps input.value before client.callTool           │
  │                                                                   │
  │  jsonrpc.ts, errors.ts, namespacing.ts   (no change)             │
  └───────────────────────────────────────────────────────────────────┘
                          │
                          ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │  src/core/permissions/permissions.ts                              │
  │    findMatchingRules  (line 130-143)                              │
  │      rule.toolName !== toolName  →  matchesToolName(rule, name)   │
  │      suffix-*: mcp__github__*, mcp__*, File*                     │
  │      bare '*' fails closed                                        │
  └───────────────────────────────────────────────────────────────────┘
                          │
                          ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │  MCP server subprocess                                            │
  │    stdin  ← requests + $/cancelRequest notifications              │
  │    stdout → responses + notifications (dropped by client in 3b)   │
  └───────────────────────────────────────────────────────────────────┘
```

No new files. No new module boundaries. No new public `QueryEngine` API. No change to `QueryEngineConfig`.

---

## Scope

**In (locked):**

1. `$/cancelRequest` notification sent inside `callTool`'s `onAbort` when `pending.has(id)` — fire-and-forget, only if the request is still outstanding.
2. Manager tracks every configured server from the start of `bootstrapOne`, so `status()` returns `connecting` / `ready` / `failed` / `idle` (disabled) rows uniformly; `lastError` is populated for failed rows.
3. `/mcp status` interactive CLI slash-command — one aligned line per tracked server: name, state, tool count, last error.
4. Suffix-`*` wildcard match in `findMatchingRules`. Bare `*` is rejected (fails closed). Applies to any `PermissionRule.toolName` — not only MCP.
5. Schema wrapping for non-object-but-valid-primitive `inputSchema`: wrap into `{ type: 'object', properties: { value: <original> }, required: ['value'], additionalProperties: false }`; adapter unwraps `input.value` at `tools/call` time. Unsupported top-level shapes (e.g., `{anyOf: …}`) continue to be dropped with a clearer stderr message.

**Out (deferred):**

- Receiving / surfacing `notifications/progress` (needs a generator-shaped `executeToolUse`).
- Wildcard expansion in subagent `allowedTools` (needs a different filter in `src/agents/runAgent.ts`).
- Reconnect/backoff, hot-reload, HTTP/SSE transport, resources/prompts/sampling, project-local config.
- Any non-suffix wildcard (prefix-`*`, mid-`*`, glob, regex).
- `/mcp reload`, `/mcp list-tools`, `/mcp call <tool>`.

---

## Data flow

### 1. Cancel — Ctrl+C → `$/cancelRequest`

1. Cancellation of an in-flight MCP call is driven by the existing tool-use abort path: `context.abortController.abort()` fires, the `AbortSignal` passed into `tool.call(input, ctx, signal)` transitions, and `toolAdapter.call` passes it through to `client.callTool(name, input, signal)`.
2. `client.callTool` already installs `signal.addEventListener('abort', onAbort)` (`src/core/mcp/client.ts:225`). **New in 3b:** inside `onAbort`, after locating `pending.get(id)`, if the entry exists (server has not responded yet), **also** send `$/cancelRequest` with the same `id`. If the entry is absent (response already arrived), do not send — `pending.get(id)` *is* the settled-gate.
3. The cancel uses the same integer `id` that was sent for the original `tools/call`. Per MCP spec, the server matches the id and cancels its in-flight handler.
4. Fire-and-forget. The client does not track the cancel in `pending`. If the transport is already closed, `transport.send` may throw; we swallow inside `onAbort` to preserve the fire-and-forget shape.
5. A late successful response for the aborted id: `onLine` looks up `pending`, finds nothing, silently drops — unchanged 3a behavior.
6. The adapter surfaces `{kind: 'aborted'}` as `makeAbortResult()`; the query loop emits `tool_call_finished` with `outcome: 'aborted'` and a `tool_result` with `errorKind: 'aborted'`.

### 2. Status — `/mcp status`

1. User types `/mcp status` at the `you>` prompt.
2. `cli.ts` matches the branch and calls `engine.getMcpStatus()` (already at `src/sdk/QueryEngine.ts:536-538`).
3. The manager now populates `tracked` from the start of `bootstrapOne` with `state: 'connecting'`, transitioning to `ready` on success or `failed` on initialize/transport error. Disabled servers are tracked as `idle` without a live client. Empty config → empty array.
4. CLI render:
   ```
   [mcp] fake         ready       tools=3    lastError=(none)
   [mcp] github       failed      tools=0    lastError=initialize timed out
   [mcp] legacy       idle        tools=0    lastError=(disabled)
   ```
   State-specific ANSI color: `ready` green, `connecting` cyan, `idle`/`closed` dim, `failed` red. Empty array → `[mcp] no servers configured`.
5. Re-prompt via `prompt()`.

### 3. Wildcard — `mcp__github__*` matches `mcp__github__list_repos`

1. `findMatchingRules(rules, 'mcp__github__list_repos', toolPath)` filters rules. For each rule, `matchesToolName(rule.toolName, toolName)`:
   - If `rule.toolName` ends with `*`, strip the trailing `*` and check `toolName.startsWith(prefix)`. Empty prefix (`'*'` alone) returns false.
   - Otherwise literal equality (3a behavior unchanged).
2. **Example cascade** for `mcp__github__list_repos` with `{toolName: 'mcp__github__*', behavior: 'allow', source: 'userSettings'}`:
   - Steps 1–2: no deny, no ask.
   - Step 3: `tool.checkPermissions()` → `allow`. Continue.
   - Step 4: no `getPath`; filesystem safety no-ops.
   - Step 5: default mode. Continue.
   - Step 6: wildcard matches → `{behavior: 'allow', reason: {type: 'rule', rule}}`. No prompt.
3. `mcp__*` matches every MCP tool.
4. `mcp__*` against `Bash`: `'Bash'.startsWith('mcp__')` is false. Falls through to step 7 (fallback ask) — unchanged.

### 4. Schema wrap — `{type: 'string'}` → `{type: 'object', properties: {value: …}}`

1. Server advertises `echo_string` with `inputSchema: { type: 'string', description: '…' }`.
2. `createMcpTool`: `isObjectSchema` → false; `isNonObjectValidSchema` → true for `string | number | integer | boolean | array | null` top-level. Wrap into
   ```ts
   { type: 'object', properties: { value: <original> }, required: ['value'], additionalProperties: false }
   ```
   Set `wrapped = true`. `additionalProperties: false` prevents the provider from hallucinating extra fields.
3. Augment description: append `\n\n(This tool accepts a single \`value\` argument.)`.
4. On `call(input, ctx, signal)`, if `wrapped`, pass `input.value` as `arguments`; else pass `input` as-is.
5. Manager's existing null-return log fires only for shapes without a valid top-level `type` (e.g., `{anyOf: …}`). Message updated to `"dropped: unsupported top-level schema"`.

---

## Module breakdown

### `src/core/mcp/client.ts`

`onLine` and the `dispatch` path are **unchanged** from 3a — notifications still early-return at `client.ts:68-69`.

**`callTool.onAbort` — revised:**

```ts
const onAbort = (): void => {
  const entry = pending.get(id)
  if (entry) {
    pending.delete(id)
    clearTimeout(entry.timer)
    try {
      transport.send(encodeNotification('$/cancelRequest', { id }))
    } catch {
      // transport already closed; fire-and-forget contract preserved.
    }
  }
  signal.removeEventListener('abort', onAbort)
  resolve({ kind: 'aborted' })
}
```

No new types, no new exports, no new maps or closures. The only wire-level change is one outbound notification on a narrow path.

### `src/core/mcp/manager.ts`

**Today:** `Tracked` is pushed only after `client.connect()` succeeds (`manager.ts:99`). `status()` iterates `tracked` (`manager.ts:148`), so failed and disabled servers are invisible.

**After 3b:** `tracked` is the single source of truth for all configured servers. Structure:

```ts
type Tracked = {
  serverName: string
  state: McpClientState              // 'idle' | 'connecting' | 'ready' | 'failed' | 'closed'
  client: McpClient | null           // null for disabled servers
  registeredToolNames: string[]
  lastError: string | null
}
```

**`bootstrap` rewrite (sketch):**

```ts
async bootstrap({ config, registry, signal }): Promise<McpBootstrapResult> {
  registryRef = registry
  const connected: string[] = []
  const failed: McpBootstrapFailure[] = []

  for (const [name, cfg] of Object.entries(config.servers)) {
    if (cfg.disabled === true) {
      tracked.push({
        serverName: name, state: 'idle', client: null,
        registeredToolNames: [], lastError: null,
      })
    } else {
      tracked.push({
        serverName: name, state: 'connecting', client: null,
        registeredToolNames: [], lastError: null,
      })
    }
  }

  const activeEntries = Object.entries(config.servers).filter(
    ([, cfg]) => cfg.disabled !== true,
  )

  const results = await Promise.allSettled(
    activeEntries.map(async ([name, cfg]) => {
      await bootstrapOne(name, cfg, registry, signal)
      return name
    }),
  )

  for (const [i, result] of results.entries()) {
    const name = activeEntries[i][0]
    const row = tracked.find(t => t.serverName === name)!
    if (result.status === 'fulfilled') {
      row.state = 'ready'
      connected.push(name)
    } else {
      const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason))
      row.state = 'failed'
      row.lastError = err.message
      failed.push({ server: name, error: err })
      process.stderr.write(`[mcp] server "${name}" failed: ${err.message}\n`)
    }
  }

  return { connected, failed }
}
```

`bootstrapOne` writes the `client` and `registeredToolNames` fields on the existing `tracked` row (found by `serverName`) rather than pushing a new one.

**`status()` — trivial after the widening:**

```ts
status(): readonly McpServerStatus[] {
  return tracked.map(t => ({
    server: t.serverName,
    state: t.state,
    toolCount: t.registeredToolNames.length,
    lastError: t.state === 'idle' ? '(disabled)' : t.lastError,
  }))
}
```

**`shutdown()` — only touch rows with a live client:**

```ts
async shutdown(): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  const snapshot = tracked.splice(0, tracked.length)
  const registry = registryRef
  for (const t of snapshot) {
    if (registry) {
      for (const toolName of t.registeredToolNames) {
        registry.unregister(toolName)
      }
    }
  }
  await Promise.allSettled(snapshot.filter(t => t.client !== null).map(t => t.client!.close()))
}
```

**Existing test update:** `manager.test.ts:244` ("status reflects connected servers; empty after shutdown") still passes in spirit but its assertion needs to match the new shape — specifically, after `shutdown()` the array is empty (unchanged), and before shutdown `length === 1` (unchanged) with `state === 'ready'` (unchanged). New assertions below in §Verification cover failed and disabled rows.

### `src/core/mcp/toolAdapter.ts`

**New helpers:**

```ts
function wrapSchema(original: unknown): ToolInputJSONSchema {
  return {
    type: 'object',
    properties: { value: (original ?? {}) as Record<string, unknown> },
    required: ['value'],
    additionalProperties: false,
  }
}

function isNonObjectValidSchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false
  const t = (schema as Record<string, unknown>).type
  return t === 'string' || t === 'number' || t === 'integer'
    || t === 'boolean' || t === 'array' || t === 'null'
}
```

**Revised `createMcpTool` body (core change):**

```ts
let effectiveSchema: ToolInputJSONSchema
let wrapped = false
if (isObjectSchema(descriptor.inputSchema)) {
  effectiveSchema = descriptor.inputSchema as ToolInputJSONSchema
} else if (isNonObjectValidSchema(descriptor.inputSchema)) {
  effectiveSchema = wrapSchema(descriptor.inputSchema)
  wrapped = true
} else {
  return null
}

const sanitized = sanitizeToolName(descriptor.name, fallbackIndex)
const qualifiedName = qualifyToolName(serverName, sanitized)
const baseDescription = descriptor.description ?? `(MCP tool from ${serverName})`
const description = wrapped
  ? `${baseDescription}\n\n(This tool accepts a single \`value\` argument.)`
  : baseDescription

const tool: Tool = {
  name: qualifiedName,
  description,
  inputSchema: effectiveSchema,
  source: 'mcp',
  namespace: serverName,
  isMutating: true,
  async validateInput() { return { valid: true } },
  async checkPermissions() { return { behavior: 'allow' } },
  async call(input, _ctx, signal) {
    const serverInput = wrapped ? (input as Record<string, unknown>)['value'] : input
    const result = await client.callTool(descriptor.name, serverInput, signal)
    switch (result.kind) {
      case 'ok':              return { content: result.content, isError: result.isError }
      case 'aborted':         return makeAbortResult()
      case 'transport_error':
      case 'protocol_error':
      case 'timeout':         return makeErrorResult('execution_error', result.message)
    }
  },
}
return tool
```

No `ctx.onMcpProgress`. No progress-sink wiring. The `call` signature matches 3a except for the optional unwrap branch.

### `src/core/mcp/manager.ts` — drop message

The stderr line at `manager.ts:82-87` updates:

```ts
process.stderr.write(
  `[mcp] server "${name}" tool "${descriptor.name}" dropped: unsupported top-level schema\n`,
)
```

Triggered only when `createMcpTool` returns null — now reserved for schemas lacking a valid top-level `type` (e.g., `anyOf`, `oneOf`, `$ref` at the root).

### `src/core/permissions/permissions.ts`

**New helper:**

```ts
function matchesToolName(ruleToolName: string, toolName: string): boolean {
  if (!ruleToolName.endsWith('*')) return ruleToolName === toolName
  const prefix = ruleToolName.slice(0, -1)
  if (prefix.length === 0) return false  // bare '*' fails closed
  return toolName.startsWith(prefix)
}
```

**`findMatchingRules` — changed predicate:**

```ts
return rules.filter((rule) => {
  if (!matchesToolName(rule.toolName, toolName)) return false
  if (rule.path !== undefined) {
    return toolPath !== undefined && rule.path === toolPath
  }
  return true
})
```

`formatDecisionMessage` is unchanged — a wildcard rule renders its `toolName` verbatim (`mcp__github__*`), which is what the user typed.

### `src/core/permissions/types.ts`

No type change. `PermissionRule.toolName` stays `string`; wildcard semantics live entirely at the matcher boundary.

### `src/cli.ts`

**New slash-command branch** (between `/model` at line 149 and the readline close at line 152):

```ts
if (trimmed === '/mcp status') {
  const statuses = engine.getMcpStatus()
  if (statuses.length === 0) {
    console.log('[mcp] no servers configured')
  } else {
    const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)
    for (const s of statuses) {
      const stateColor =
        s.state === 'ready'      ? '\x1b[32m' :
        s.state === 'connecting' ? '\x1b[36m' :
        s.state === 'failed'     ? '\x1b[31m' :
                                   '\x1b[2m'
      const err = s.lastError ?? '(none)'
      console.log(
        `[mcp] ${pad(s.server, 12)} ${stateColor}${pad(s.state, 10)}\x1b[0m tools=${s.toolCount}   lastError=${err}`,
      )
    }
  }
  prompt()
  return
}
```

No QueryEvent switch changes — `mcp_tool_progress` is not introduced in 3b.

### Files **not** changed in 3b

- `src/core/queryEvents.ts` — no new event variant.
- `src/core/tools/context.ts` — no `onMcpProgress` field.
- `src/core/query.ts` — no sink wiring.
- `src/core/mcp/jsonrpc.ts` — unchanged.
- `src/agents/runAgent.ts` — unchanged (subagent wildcard expansion deferred).

---

## Critical invariants

### 1. Cancel does not race with a late response

Every interleaving of (response arrives) × (abort fires) × (cancel sent) leaves the client consistent:

- **Response before abort.** `pending.resolve` deletes `pending[id]`, clears timer, removes the abort listener. If `onAbort` nevertheless runs across a tick boundary, `pending.get(id)` returns `undefined` → **no `$/cancelRequest` is sent**. The second `resolve({kind:'aborted'})` is a no-op on the already-resolved Promise. `pending.get(id)` is the settled-gate; no extra boolean needed.
- **Abort before response.** `onAbort` deletes pending, clears timer, sends cancel, resolves `{aborted}`. A later server response lands in `onLine`, finds no pending entry, drops silently.

### 2. Status returns all configured rows

After 3b, `tracked` mirrors `config.servers` from the first `bootstrapOne` invocation. Invariants:

- `|tracked|` during bootstrap and steady state = `|config.servers|`.
- Every `McpServerStatus.state` is drawn from `{idle, connecting, ready, failed, closed}`.
- After `shutdown()`, `tracked.length === 0` (unchanged from 3a).
- `lastError` is `(disabled)` for `idle` rows, or the underlying error message for `failed`, or `null` otherwise.

### 3. Wildcard scope

**Decision: allow wildcards on any rule, not only `mcp__*`.** Rationale:

- `PermissionRule.toolName` is a plain string; adding "MCP-only" wildcards would require prefix-aware validation that doesn't exist today.
- Literal tool names contain no `*`, so the extension is pure — no existing rule semantics change.
- Bare `*` fails closed — a user with `{toolName: '*'}` gets the fallback ask on every call, which is safer than allow-all.
- Non-MCP wildcards are immediately useful (`File*` once WebFetch/WebSearch land). Forbidding them would be pre-optimizing.

Blast radius is contained by the existing cascade:

- Deny rule wildcard beats allow rule wildcard at step 1.
- `tool.checkPermissions` fires at step 3 for built-ins (MCP tools still return `allow`).
- Safety checks (step 4) fire for tools with `getPath`. Wildcards cannot bypass filesystem safety.

Subagents do **not** get wildcard behavior in 3b (see §4 below).

### 4. Subagent filter is unchanged

`src/agents/runAgent.ts:227` `buildFilteredRegistry` exact-matches each name via `parentRegistry.get(name)`. A subagent spawned with `allowedTools: ['mcp__github__*']` gets zero tools. This is the intentional 3b behavior — expanding patterns at the subagent boundary is a different change (would require `parentRegistry.getAll()` + pattern matching + collision semantics) and belongs in the subagent phase. Users who want MCP tools in a subagent list exact names.

### 5. Schema wrap round-trip

For any valid non-object schema `S`, `wrapSchema(S)` produces an object schema such that `input.value = X` where `X` conforms to `S` unwraps to `X` exactly. JSON round-trips preserve types per JSON Schema.

**Corners:**

- `S = { type: 'object', properties: { value: … } }` is detected as an object schema and passes through **unwrapped** — no collision with the wrapper's `value` field.
- `S = { type: 'array', items: {…} }` wraps; `input.value` is the array; server receives the array. Correct.
- `S = { anyOf: [...] }` (no top-level `type`) returns null from `createMcpTool`; manager logs "unsupported top-level schema". A future phase may add walker-based support.

---

## Sharp edges

- **Server ignores `$/cancelRequest`.** Some MCP servers don't implement it. Ultron returns `{aborted}` immediately either way; the orphan server-side work completes and its response is dropped as a late frame. Cost is wasted server compute — acceptable, that's the fire-and-forget contract.

- **Wildcard matches too eagerly.** `mcp__github__*` has prefix `mcp__github__` (trailing double-underscore). Sanitized server names never contain `_` (§3a namespacing), and `mcp__github_foo__bar` can't arise. Safe.

- **Bare `*` in user settings.** Returns false from `matchesToolName` → falls through to fallback ask. Fails closed. A loader-time warning would be cleaner; 3c polish.

- **Wrapped schema collides with a legit `value` field.** Only possible if the original schema is itself an object with a `value` property — which bypasses wrapping entirely. No collision by construction.

- **`/mcp status` called before bootstrap finishes.** After 3b, the CLI's startup `engine.init().catch(...)` (`src/cli.ts:235`) populates `tracked` with `connecting` rows immediately, so a racey `/mcp status` shows `connecting` lines rather than "empty". Honest and useful.

- **`close()` during `connecting`.** `bootstrapOne` may be in-flight when shutdown begins. The existing `client.close()` path handles pending rejection; manager's `tracked` snapshot captures whatever state rows had at that moment. No deadlock because `close()` awaits `Promise.allSettled`.

- **Duplicate `id` on `$/cancelRequest`.** `nextId++` is monotonic; the cancel reuses the aborted call's id, which is never issued again.

---

## Verification

### Unit (colocated `*.test.ts`)

| File | Key assertions |
|---|---|
| `client.test.ts` | **cancel**: fake transport stalls `tools/call`; abort the call; assert `sentFrames` includes `$/cancelRequest` with the right `id`; assert result is `{kind:'aborted'}`. **cancel after response**: response arrives, then abort fires → `sentFrames` does **not** include a cancel. **cancel on closed transport**: abort after `close()`; `transport.send` throws and is swallowed; result still resolves `{aborted}`. |
| `toolAdapter.test.ts` | **wrap string**: `{type:'string'}` → tool registers with `inputSchema.type === 'object'` and `properties.value.type === 'string'`; `call({value:'hello'},…)` invokes `client.callTool(name, 'hello', signal)`. **wrap array**: `{type:'array', items:…}` → call passes `[1,2,3]` raw. **object passthrough**: `{type:'object',…}` not wrapped; `call` forwards `input` unchanged. **garbage drop**: `{anyOf:[…]}` → `createMcpTool` returns null. |
| `permissions.test.ts` | **wildcard MCP**: `mcp__fake__*` matches `mcp__fake__echo`. **miss**: `mcp__fake__*` does not match `Bash`. **prefix strictness**: `mcp__fake__*` does not match `mcp__fake2__foo`. **global MCP**: `mcp__*` matches `mcp__a__x` and `mcp__b__y`. **non-MCP wildcard**: `File*` matches `FileRead` and `FileWrite`. **bare `*`**: no match (fails closed). **deny wildcard**: deny rule wildcard still beats allow rule wildcard. |
| `manager.test.ts` | **Update existing** "status reflects connected servers" — now also asserts row count equals configured-server count, not just connected count. **status includes failed**: server whose initialize throws → `status()[i].state === 'failed'`, `lastError` populated, row still present after bootstrap. **status includes disabled**: config with `disabled: true` → row with `state: 'idle'`, `toolCount: 0`, `lastError: '(disabled)'`. **status during bootstrap**: call `status()` before `Promise.allSettled` resolves → rows in `connecting` state. **shutdown clears all**: after `shutdown()`, `status()` → `[]`. |

### Integration — `tests/integration/mcp.test.ts`

Extend the existing fake transport to script hold-and-abort. New `it(…)`:

1. **cancel sends `$/cancelRequest`** — fake's `tools/call` handler returns a never-resolving promise; abort after 10 ms; assert `sentFrames` includes `{method:'$/cancelRequest', params:{id:<call id>}}`; assert `tool_result.errorKind === 'aborted'`.
2. **status after bootstrap** — `engine.init()`, then `engine.getMcpStatus()` returns `[{server:'fake', state:'ready', toolCount:<n>, lastError:null}]`. Configure a second server that fails to initialize; assert both rows present.
3. **wildcard rule pre-configured** — inject `{toolName:'mcp__fake__*', behavior:'allow', source:'userSettings'}` via state; `askUser` is a vitest mock; submit a prompt that invokes `mcp__fake__echo`; assert `askUser` **not** called; assert tool result arrives.
4. **schema wrap end-to-end** — fake declares `{name:'shout', inputSchema:{type:'string'}}`; scripted `callModel` emits tool_use with input `{value:'hello'}`; fake's handler receives `arguments: 'hello'` (raw, not wrapped); result content is `HELLO`.

### Manual smoke

- `~/.ultron/mcp.json` pointing at `npx -y @modelcontextprotocol/server-filesystem /tmp`; run CLI; `/mcp status` shows `filesystem ready tools=<n> lastError=(none)`.
- Ctrl+C during a long-running MCP call; for servers that honor cancel, confirm the server stops compute.
- Add `{toolName:'mcp__filesystem__*', behavior:'allow'}` to user settings; confirm no permission prompt.

Commands: `npm run typecheck && npm run test`.

---

## Acceptance criteria

- Aborting an in-flight MCP `tools/call` causes Ultron to send exactly one `$/cancelRequest` notification with the original request id, fire-and-forget, and resolve the tool result with `errorKind: 'aborted'`. If the response arrived before the abort, no cancel is sent. If the transport is closed, the send is swallowed.
- `/mcp status` prints one aligned line per **configured** server (connected, connecting, failed, or disabled), with name, state, tool count, and last error (or `(none)` / `(disabled)`). Empty config prints `[mcp] no servers configured`.
- A rule `{toolName: 'mcp__github__*', behavior: 'allow'}` matches every tool under server `github` without prompting. `mcp__*` matches every MCP tool. `*` matches nothing. Non-MCP wildcards (`File*`) work identically.
- An MCP tool whose `inputSchema.type` is a valid non-object primitive registers with a wrapped schema; calls round-trip `{value: X}` → `X` to the server. Unsupported shapes (`anyOf`, `oneOf`, `$ref` at root) continue to be dropped with a clearer stderr message.
- `npm run typecheck && npm run test` green. No new module boundaries, no new public engine method, no change to `QueryEngineConfig`.
- 3a invariants hold: `checkPermissions` still returns `allow`; cascade fallback-ask pattern unchanged; `dispose()` terminal; subagent default `allowedTools` unchanged; subagent `allowedTools` filter still does exact match.

---

## Implementation order

Each step keeps `npm run typecheck && npm run test` green.

1. **Permissions wildcard** — `src/core/permissions/permissions.ts` + `permissions.test.ts`. Pure, isolated.
2. **Schema wrap** — `src/core/mcp/toolAdapter.ts` + `toolAdapter.test.ts`, plus log-message tweak in `src/core/mcp/manager.ts`.
3. **Manager tracks-all widening** — `src/core/mcp/manager.ts` + update `manager.test.ts:244` plus new failure-row / disabled-row / bootstrap-in-flight tests. Largest step; isolated to one file.
4. **Cancel in client** — `src/core/mcp/client.ts` `onAbort` addition + unit test.
5. **`/mcp status` CLI branch** — `src/cli.ts`.
6. **Integration tests** — cancel + status-covers-failures + wildcard + schema-wrap.

### Critical files for implementation

- `src/core/mcp/client.ts`
- `src/core/mcp/toolAdapter.ts`
- `src/core/mcp/manager.ts`
- `src/core/permissions/permissions.ts`
- `src/cli.ts`
- `tests/integration/mcp.test.ts`
