# Phase 3c Design: MCP Lifecycle Hardening

## Context

Phase 3a (`docs/ultron_v2/phase3a-v2-design.md`) and Phase 3b (`docs/ultron_v2/phase3b-v2-design.md`) have already delivered more than the original `v2-ROADMAP.md` split expected for 3c:

- `~/.ultron/mcp.json` config loading.
- stdio client lifecycle with `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
- manager bootstrap, clean shutdown, and tool unregister.
- `/mcp status`.
- `$/cancelRequest` on aborted calls.
- suffix-wildcard permission rules.
- non-object schema wrapping.

Therefore Phase 3c is **not** the original broad "config surface + lifecycle" slice. It is the remaining lifecycle/operability slice: reconnect after server death, explicit config reload, and better read-only introspection. The goal is to make MCP usable in long-lived CLI sessions without widening the tool execution boundary or adding new MCP protocol surfaces.

### Why this phase exists

The current MCP path is functionally complete for happy-path sessions, but it has three long-session problems:

1. **Unexpected server exit is terminal.** Once the subprocess dies, the registered tools still exist but calls fail against a dead client. Users must restart Ultron.
2. **Config changes require restart.** Adding, disabling, or editing a server in `~/.ultron/mcp.json` has no effect until a new process starts.
3. **Status is too shallow for diagnosis.** `/mcp status` shows state and tool count, but not reconnect attempts, last transition time, or registered tool names.

Phase 3c fixes those without changing the provider adapters, the permission cascade, hooks, audit shape, or the `query()` loop.

### What 3c explicitly does not own

- **Progress notifications.** Receiving `notifications/progress` still needs a generator-shaped `executeToolUse` so progress can be yielded between `tool_call_started` and `tool_call_finished`.
- **HTTP/SSE transport.** stdio remains the only transport in v2 Phase 3.
- **MCP resources, prompts, and sampling.** Tools remain the only MCP capability consumed.
- **`/mcp call`.** Manual invocation risks becoming either a permission bypass or a second-class tool runner. If added later, it must route through the same authorization, hook, audit, and transcript path as model-initiated tool calls.
- **Automatic project-local `./.ultron/mcp.json` discovery.** Auto-spawning repo-controlled commands is a trust-boundary change. A future phase can add it with an explicit trust gate.
- **Automatic replay of interrupted tool calls.** MCP tools are conservatively mutating. Retrying a `tools/call` after disconnect can duplicate side effects.
- **Subagent wildcard expansion.** Still belongs to the subagent phase.

### Invariants that must not break

1. **No privileged MCP path.** Every MCP call remains a normal `Tool` call and continues through `authorizeToolUse`, PreToolUse hooks, `executeToolUse`, PostToolUse hooks, audit, and transcript persistence.
2. **MCP tools keep `checkPermissions() -> allow`.** The permission cascade still reaches user/session rules instead of short-circuiting at tool-level `ask`.
3. **No in-flight replay.** If a server exits during a call, that call returns an error. Reconnect only affects future calls.
4. **Provider tools are rebuilt only when definitions change.** Reload/reconnect must not rebuild `callModel` on every status change.
5. **`dispose()` remains terminal.** Reconnect timers and reload attempts must stop after engine disposal.

---

## Architecture

3c introduces a manager-owned server handle between the registry tool and the concrete client:

```
  src/cli.ts
    /mcp status
    /mcp reload
    /mcp list-tools [server]
      |
      v
  src/sdk/QueryEngine.ts
    reloadMcp()
      - refuses while submitPrompt() is running
      - calls manager.reload(...)
      - rebuilds callModel only if tool definitions changed
    listMcpTools(server?)
    getMcpStatus()
      |
      v
  src/core/mcp/manager.ts
    McpServerHandle
      config
      state
      client | null
      registeredToolNames
      descriptors
      generation
      reconnectAttempts
      nextRetryAt
      lastConnectedAt / lastDisconnectedAt / lastError

    callTool(server, tool, args, signal)
      - ensure connected or reconnect if allowed
      - delegate to current client
      - never replay an interrupted call

    reload(config, registry, signal)
      - diff old vs new config
      - close removed/disabled/changed servers
      - bootstrap added/changed servers
      - unregister/register tools
      - return whether tool definitions changed
      |
      v
  src/core/mcp/toolAdapter.ts
    createMcpTool({ serverName, descriptor, callToolGateway })
      - stable Tool registered in ToolRegistry
      - call() routes through manager gateway
      - no concrete McpClient captured
      |
      v
  current McpClient + stdio subprocess
    replaceable across reconnect/reload
```

The key design decision is that the `Tool` object registered in `ToolRegistry` should not close over a single `McpClient`. A reconnect replaces the client. A reload may replace config, process, and descriptors. The registry-facing tool must either be replaced during reload or route through a stable manager gateway. 3c uses the gateway because it keeps reconnect cheap and avoids stale client captures.

---

## Scope

**In (locked):**

1. Detect unexpected subprocess exit after a server reached `ready`.
2. Reconnect on the next call to that server, using bounded exponential backoff.
3. Do not replay an in-flight `tools/call` that failed due to disconnect.
4. Add manager `reload(...)` to re-read MCP config and reconcile server/tool state without process restart.
5. Add QueryEngine `reloadMcp()` that rebuilds provider `callModel` only when effective tool definitions changed.
6. Add `/mcp reload`.
7. Add `/mcp list-tools [server]`.
8. Extend status rows with reconnect and transition metadata.

**Out (deferred):**

- Progress events.
- HTTP/SSE and remote server policy.
- Resources/prompts/sampling.
- Project-local MCP config discovery.
- Auto-installation of MCP servers.
- Manual `/mcp call`.
- Subagent wildcard expansion.
- Retrying failed in-flight tool calls.
- Permission-rule wildcard diagnostics. 3c has no persistent permission-rule config loader, so adding `describeUnsupportedWildcard()` here would create dead code. Add diagnostics when the permission settings surface exists.

---

## Data flow

### 1. Unexpected disconnect -> future reconnect

1. A server is `ready` and exposes registered tools such as `mcp__github__list_repos`.
2. Its stdio transport exits unexpectedly.
3. The client `onExit` rejects all pending requests. Any currently executing tool call returns `transport_error` through the existing `ToolResult` mapping.
4. The manager handle records:
   - `state: 'failed'`
   - `lastError: 'Transport exited'` or equivalent
   - `lastDisconnectedAt: Date.now()`
   - `nextRetryAt` based on the backoff policy
5. The registered `Tool` stays in the registry. This is intentional: the model can still call it, and the call path can attempt reconnect.
6. On a later call to any tool for that server, the adapter calls the manager gateway.
7. The gateway checks whether reconnect is allowed:
   - If disposed or disabled, return `transport_error`.
   - If backoff is still active, return `transport_error` with "retry available in N ms".
   - If max attempts are exhausted, return `transport_error` with the last error.
   - Otherwise spawn a replacement transport, connect, and list tools without publishing it yet.
8. If reconnect succeeds and the descriptor set is unchanged, the call runs against the new client.
9. If reconnect succeeds but the descriptor set changed, the manager closes the new client, marks the server `failed`, and the call returns `transport_error` with "MCP tool set changed; run /mcp reload". Registry mutation is forbidden during a submission.
10. If reconnect fails, the handle records the failure, increments attempts, updates `nextRetryAt`, and the call returns `transport_error`.

Reconnect timeout semantics are separate from tool-call timeout semantics:

- `timeoutMs` remains the per-request MCP timeout used by `initialize`, `tools/list`, and `tools/call`.
- Reconnect may spend up to `timeoutMs` on `initialize` and up to `timeoutMs` on `tools/list`.
- After reconnect succeeds, the actual `tools/call` receives a fresh full `timeoutMs` budget.
- Backoff waiting is not charged to `tools/call`; when backoff is active, calls fail fast with retry timing instead of waiting.

### 2. Server exits during a tool call

1. `client.callTool(...)` has already sent `tools/call`.
2. Transport exits before a response arrives.
3. `onExit` rejects pending requests.
4. The call returns `transport_error`.
5. The manager marks the server reconnectable for future calls.
6. The failed call is **not replayed** after reconnect.

Rationale: MCP tools may create issues, write files, send messages, or mutate external systems. Without idempotency metadata, replay is unsafe.

### 3. `/mcp reload`

1. User edits `~/.ultron/mcp.json`.
2. User types `/mcp reload`.
3. CLI calls `await engine.reloadMcp()`.
4. `QueryEngine.reloadMcp()` refuses if `_running === true`.
5. The engine loads config using the same `mcpConfigPath` resolution as bootstrap.
6. Manager diffs current handles against new config:
   - Removed server: unregister tools, close client, delete handle.
   - Disabled server: unregister tools, close client, keep idle status row.
   - Added server: create handle and bootstrap.
   - Changed server config: close old client, unregister old tools, bootstrap fresh with new config.
   - Unchanged server: preserve current connection and registered tools.
7. Manager returns a reload result containing connected/failed/removed/disabled/unchanged servers, `toolDefinitionsChanged`, and status rows for unchanged servers still in backoff.
8. If `toolDefinitionsChanged`, QueryEngine rebuilds `callModel` and `compactCallModel` if the compact model follows the main model.
9. CLI prints a compact summary and returns to the prompt.

### 4. `/mcp list-tools [server]`

1. User types `/mcp list-tools` or `/mcp list-tools github`.
2. CLI calls `engine.listMcpTools(serverName?)`.
3. QueryEngine delegates to manager.
4. Output is read-only and derived from registered descriptors:
   ```
   [mcp] github
     mcp__github__list_repos       List repositories
     mcp__github__create_issue     Create an issue
   [mcp] filesystem
     mcp__filesystem__read_file    Read a file
   ```
5. If the server is unknown or has no tools, print a clear empty-state line.

No tool call occurs. No permission decision is needed for listing already-registered metadata.

---

## Module breakdown

### `src/core/mcp/manager.ts`

This is the main Phase 3c file.

**New public types:**

```ts
export type McpReloadResult = {
  readonly connected: readonly string[]
  readonly failed: readonly McpBootstrapFailure[]
  readonly removed: readonly string[]
  readonly disabled: readonly string[]
  readonly unchanged: readonly string[]
  readonly backoff: readonly McpServerStatus[]
  readonly toolDefinitionsChanged: boolean
}

export type McpRegisteredToolInfo = {
  readonly server: string
  readonly name: string
  readonly description: string
  readonly state: McpClientState
}
```

**Extended `McpServerStatus`:**

```ts
export type McpServerStatus = {
  readonly server: string
  readonly state: McpClientState
  readonly toolCount: number
  readonly lastError: string | null
  readonly reconnectAttempts: number
  readonly nextRetryAt: number | null
  readonly lastConnectedAt: number | null
  readonly lastDisconnectedAt: number | null
}
```

Existing CLI can still render a subset, so this is additive for callers that only inspect current fields.

**Manager API after 3c:**

```ts
export interface McpManager {
  bootstrap(args: {
    config: McpConfig
    registry: ToolRegistry
    signal: AbortSignal
  }): Promise<McpBootstrapResult>

  reload(args: {
    config: McpConfig
    registry: ToolRegistry
    signal: AbortSignal
  }): Promise<McpReloadResult>

  callTool(args: {
    serverName: string
    toolName: string
    input: unknown
    signal: AbortSignal
  }): Promise<McpToolCallResult>

  listTools(serverName?: string): readonly McpRegisteredToolInfo[]
  shutdown(): Promise<void>
  status(): readonly McpServerStatus[]
}
```

**Handle shape:**

```ts
type McpServerHandle = {
  serverName: string
  config: McpServerConfig
  state: McpClientState
  client: McpClient | null
  descriptors: McpToolDescriptor[]
  registeredToolNames: string[]
  generation: number
  lastError: string | null
  reconnectAttempts: number
  nextRetryAt: number | null
  lastConnectedAt: number | null
  lastDisconnectedAt: number | null
  reconnectPromise: Promise<void> | null
  reconnectAbortController: AbortController | null
}
```

`reconnectPromise` deduplicates simultaneous calls to the same failed server. If two tool calls arrive while the server is reconnecting, both wait on one reconnect attempt. They still run separate `tools/call` requests after reconnect succeeds.

`reconnectAbortController` exists so `shutdown()` can abort an in-progress spawn/connect path and then terminate the transport best-effort. Disposal is terminal; reconnect must not keep a subprocess alive after engine shutdown.

**Backoff policy:**

```ts
const DEFAULT_RECONNECT = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 5,
}
```

Backoff is per server and per session. A manual `/mcp reload` resets attempts for changed or re-enabled servers because it is an explicit operator action.

**Config equality:**

Use stable JSON comparison over the validated `McpServerConfig` fields:

- `command`
- `args`
- `env`
- `cwd`
- `disabled`
- `timeoutMs`

If any field changes, treat it as a server replacement. Do not mutate a live subprocess in place.

**Descriptor equality:**

Use stable JSON comparison over the provider-visible tool definition fields:

- `name`
- normalized `description` (`undefined` and missing are equivalent)
- canonical JSON of `inputSchema`

This same descriptor equality drives both reconnect validation and `toolDefinitionsChanged`. Reconnect is transport repair only: if descriptors differ from the currently registered descriptors, reconnect fails with "MCP tool set changed; run /mcp reload" and does not mutate the registry. Explicit reload is the only 3c path that reconciles descriptor changes.

**Register/unregister rules:**

- Removed/disabled/changed servers unregister all previously registered tool names before closing the old client.
- Added/changed servers register tools after `connect()` and `tools/list`.
- If one tool fails registration due to collision, continue with other tools and record a stderr warning, matching 3a behavior.
- If explicit reload sees a server descriptor set differ from the current descriptor set, update registered tools and mark tool definitions changed.

Reconnect changing tools is rare but legal at the MCP level, but 3c treats it as a reload-required condition because registry mutation during a submission is unsafe.

### `src/core/mcp/toolAdapter.ts`

Today the adapter captures a concrete `McpClient`. 3c changes it to capture a gateway function.

```ts
export type McpCallToolGateway = (args: {
  serverName: string
  toolName: string
  input: unknown
  signal: AbortSignal
}) => Promise<McpToolCallResult>
```

`createMcpTool` receives the gateway:

```ts
createMcpTool({
  serverName,
  descriptor,
  fallbackIndex,
  callToolGateway,
})
```

`call(input, _ctx, signal)` unwraps schema-wrapped `value` exactly as 3b does, then calls:

```ts
const result = await callToolGateway({
  serverName,
  toolName: descriptor.name,
  input: serverInput,
  signal,
})
```

All result mapping remains unchanged:

- `ok` -> normal `ToolResult`
- `aborted` -> `makeAbortResult()`
- `transport_error` / `protocol_error` / `timeout` -> `execution_error`

### `src/core/mcp/client.ts`

Minimal changes.

- Preserve current `onExit` pending rejection.
- Make sure `lastError` is set on exit.
- Do not add reconnect logic here. Reconnect belongs to the manager because it requires config, registry, and tool metadata.
- Continue sending `$/cancelRequest` on abort.

`McpClient` remains a single-connection object. It is replaceable, not reusable after failure.

### `src/core/mcp/config.ts`

No schema expansion is required for 3c. Existing fields are enough:

```ts
{ command, args, env, cwd, disabled, timeoutMs }
```

Reconnect policy is intentionally not user-configurable in 3c. It can become config later if real-world servers need it. Keeping it fixed avoids another validation surface.

Add a pure helper if useful:

```ts
export function sameMcpServerConfig(a: McpServerConfig, b: McpServerConfig): boolean
```

### `src/sdk/QueryEngine.ts`

Add:

```ts
async reloadMcp(): Promise<McpReloadResult>
listMcpTools(serverName?: string): readonly McpRegisteredToolInfo[]
```

`reloadMcp()` behavior:

- Throws if disposed.
- Throws if `_running` is true.
- No-ops if `disableMcp === true`.
- Loads config from `config.mcpConfig` or disk using the existing path behavior.
- Calls `mcpManager.reload(...)`.
- If `result.toolDefinitionsChanged`, rebuilds `callModel` and `compactCallModel` using `getToolDefinitions(this.toolRegistry)`.
- Sets `_callModelRebuilt = true` if MCP tools are present after reload.

Important nuance: if reload removes all MCP tools, `callModel` still must rebuild so providers stop advertising removed tools.

### `src/cli.ts`

Add slash commands:

```text
/mcp reload
/mcp list-tools
/mcp list-tools <server>
```

Rendering:

`/mcp reload`:

```text
[mcp] reload complete: connected=1 failed=0 removed=1 disabled=1 unchanged=2 backoff=1 toolsChanged=true
[mcp] filesystem still in backoff; retry in 4s
```

If reload fails due to malformed config:

```text
[mcp] reload failed: Invalid MCP config at ...
```

`/mcp list-tools`:

```text
[mcp] github ready
  mcp__github__list_repos       List repositories
  mcp__github__create_issue     Create an issue
```

Update the startup hint:

```text
Type /quit to exit, /session, /model, /mcp status, /mcp reload, /mcp list-tools.
```

---

## Critical invariants

### 1. Reconnect never bypasses authorization

Reconnect happens inside `tool.call`, after `authorizeToolUse` has already allowed the specific call. This is acceptable because reconnect is transport repair, not a separate capability. The repaired call is still the same authorized tool name and input after PreToolUse hooks.

If reconnect changes the advertised tool set in any way, the gateway returns `transport_error` with "MCP tool set changed; run /mcp reload". It does not execute a different tool and does not mutate the registry.

### 2. In-flight calls are never replayed

When transport exits, `McpClient` rejects pending calls. The manager may mark the handle reconnectable, but the failed call completes with an error. Future calls may reconnect. This avoids duplicate side effects.

### 3. Tool definition changes rebuild provider callModel exactly once per explicit reload

`callModel` is rebuilt when one of these changes:

- A tool is registered.
- A tool is unregistered.
- A registered tool's description or input schema changes.

It is not rebuilt for:

- state changes (`ready` -> `failed`)
- reconnect attempts
- status metadata updates
- backoff timer changes

Reconnect attempts must compare descriptors to prove transport repair is safe, but they must not publish descriptor changes. Explicit `/mcp reload` is the registry reconciliation path.

### 4. Reload is not allowed during a submission

Reload mutates the registry and may rebuild `callModel`. Doing that while `query()` is iterating tool calls would create inconsistent execution. 3c takes the simple safe path: reject reload while `_running`.

### 5. `dispose()` cancels lifecycle work

On dispose:

- Abort any `reconnectAbortController` before closing clients.
- Close every live client.
- Clear handles.
- Clear pending reconnect timers/promises.
- Set a terminal flag so future reconnect/reload attempts fail fast.

No reconnect should start after disposal.

---

## Sharp edges

- **Server changes its tools on reconnect.** Reconnect fails with "MCP tool set changed; run /mcp reload" and closes the replacement client. This is intentionally strict: reconnect repairs transport only, while reload reconciles descriptors and rebuilds provider tool definitions.

- **Backoff makes a tool appear broken.** If a previous reconnect failed, the next call may return "retry available in N ms" instead of spawning immediately. This prevents tight retry loops when the model repeatedly calls a broken tool.

- **Reload does not reset unchanged failed servers.** This is intentional. Reload is a config reconciliation command, not a "force retry now" command. CLI output must surface unchanged servers still in backoff so the user can distinguish "reload worked" from "server still cooling down".

- **Reload removes a tool the model saw earlier.** Because reload is blocked while a submission is running, this cannot happen mid-turn. The next model request gets rebuilt definitions.

- **Config-injected command changes are dangerous.** This is already true for user-level `~/.ultron/mcp.json`; the user owns that file. Project-local discovery remains out of scope because repo-controlled config has a different trust model.

- **Tool proxy keeps stale description until reload.** That is acceptable. MCP has no push-based tool-definition update in this phase, and reconnect intentionally refuses descriptor changes.

---

## Verification

### Unit

| File | Key assertions |
|---|---|
| `manager.test.ts` | Reconnects after unexpected exit on next call; reconnect `initialize`/`tools/list` and subsequent `tools/call` each get independent `timeoutMs` budgets; does not replay failed in-flight call; respects max attempts; concurrent calls dedupe reconnect via one promise; `shutdown()` aborts in-progress reconnect and prevents future reconnect. |
| `manager.test.ts` | Reconnect with identical descriptors succeeds; reconnect with changed descriptors fails with reload-required error and does not mutate registry. |
| `manager.test.ts` | `reload()` removes deleted servers, disables disabled servers, bootstraps added servers, restarts changed servers, preserves unchanged ready servers, includes unchanged failed/backoff servers in `backoff`, and returns `toolDefinitionsChanged` accurately using canonical descriptor equality. |
| `toolAdapter.test.ts` | Adapted MCP tools call the gateway instead of a concrete client; schema wrapping still unwraps `{value: X}` before gateway call. |
| `QueryEngine.test.ts` | `reloadMcp()` refuses while running; rebuilds `callModel` when tools change; rebuilds when all MCP tools are removed; no-ops when MCP is disabled. |

### Integration

Add or extend `tests/integration/mcp.test.ts`:

1. Start a fake server, connect, list tools, kill it, then invoke the same MCP tool with identical descriptors. Assert manager reconnects and the second call succeeds.
2. Kill a server during an in-flight call. Assert the call returns a transport/execution error and the fake server did not receive a second `tools/call`.
3. Load config with server `a`, then rewrite config to server `b`, run `engine.reloadMcp()`, and assert `mcp__a__*` tools are gone while `mcp__b__*` tools are present.
4. Change a server's `tools/list` output across reload and assert `callModel` receives rebuilt tool definitions.
5. Change a server's `tools/list` output during reconnect and assert the call fails with reload-required error and no registry mutation occurs.
6. `/mcp list-tools` rendering can be covered by a small CLI helper test if command rendering is factored; otherwise keep it as a manual smoke.

### Manual smoke

- Configure `~/.ultron/mcp.json` with a filesystem MCP server.
- Start Ultron and run `/mcp status`.
- Kill the server subprocess externally.
- Run `/mcp status` and confirm failed metadata is visible.
- Ask the model to use the same MCP tool; confirm reconnect occurs.
- Edit `~/.ultron/mcp.json` to disable the server.
- Run `/mcp reload`, then `/mcp status` and `/mcp list-tools`.

Commands:

```sh
npm run typecheck
npm run test
```

---

## Acceptance criteria

- An MCP server that exits unexpectedly can reconnect on the next call, within a bounded exponential backoff policy.
- Reconnect uses separate request budgets: `initialize`, `tools/list`, and the eventual `tools/call` each receive a full `timeoutMs`; active backoff fails fast instead of consuming call timeout.
- Reconnect succeeds only when `tools/list` descriptors are identical to the currently registered descriptors. Descriptor changes during reconnect fail with "MCP tool set changed; run /mcp reload" and do not mutate the registry.
- A `tools/call` interrupted by disconnect returns an error and is never replayed automatically.
- `/mcp reload` reconciles added, removed, disabled, changed, and unchanged servers without restarting Ultron.
- `/mcp reload` output surfaces unchanged failed servers still in backoff with retry timing.
- Provider `callModel` is rebuilt when MCP tool definitions change, including when all MCP tools are removed.
- `/mcp list-tools [server]` shows registered MCP tools with descriptions and clear empty states.
- `/mcp status` includes reconnect attempts, next retry time, last connected time, last disconnected time, and last error.
- Existing 3a/3b behavior remains intact: config load semantics, clean shutdown, cancellation, wildcard permission matching, schema wrapping, and subagent defaults.
- `npm run typecheck && npm run test` are green after implementation.

---

## Implementation order

1. Add the manager handle model and gateway `callTool(...)` while preserving current bootstrap behavior.
2. Update `toolAdapter` to call the gateway instead of capturing `McpClient`.
3. Add unexpected-exit detection, reconnect state, and backoff.
4. Add canonical config/descriptor equality and enforce descriptor-identical reconnect.
5. Add `reload(...)`, config diffing, backoff reporting, and explicit tool-definition-change detection.
6. Add QueryEngine `reloadMcp()` and `listMcpTools(...)`.
7. Add CLI commands and rendering helpers.
8. Expand unit and integration tests.
9. Run `npm run typecheck` and `npm run test`.
