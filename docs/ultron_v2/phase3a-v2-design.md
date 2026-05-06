# Phase 3a Design: Minimum Viable MCP Stdio Client

## Context

Phase 3 of the v2 roadmap is "MCP-capable dynamic tool registry" (`docs/ultron_v2/v2-scope.md:97`). The pillar section (`docs/ultron_v2/v2-scope.md:24-36`) locks the shape: stdio transport first, JSON-RPC `initialize`/`tools/list`/`tools/call`, `.ultron/mcp.json` config, namespaced tools (`mcp__<server>__<tool>`), and full permission-engine routing with no privileged bypass.

Phase 3a is the **first user-visible slice** and deliberately delivers end-to-end: a server listed in `~/.ultron/mcp.json` connects at the first prompt, its tools appear in the existing `ToolRegistry`, the model can call them, and every call flows through the v1 permission cascade. Nothing smaller produces a working feature — a config loader without a client is inert, a client without registry wiring is unreachable.

What 3a explicitly does **not** own: reconnect with backoff, resources/prompts/sampling, HTTP/SSE transport, MCP `$/cancelRequest` semantics, hot-reload of config, wildcard permission rules, `/mcp status` CLI command. Those land in 3b+.

This document is the single source of truth for the 3a slice. The implementation plan it derives from is `.claude/plans/ok-now-make-a-mutable-rossum.md`.

---

## Architecture

```
  ┌─────────────────────────────────────────────────────────────┐
  │  src/sdk/QueryEngine.ts  (submitPrompt)                     │
  │                                                             │
  │  1. hookConfig lazy-load  ←── existing (lines 311-314)      │
  │  2. mcp lazy-load         ←── NEW, cached _mcpInitPromise   │
  │       └─ bootstrap all servers, register tools,             │
  │          rebuild callModel once if any registered           │
  │  3. normal query() loop                                     │
  └───────────────────────┬─────────────────────────────────────┘
                          │ bootstrap
                          ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  src/core/mcp/                                              │
  │                                                             │
  │   config.ts                                                 │
  │     loadMcpConfig(~/.ultron/mcp.json) ── McpConfig          │
  │                                                             │
  │   manager.ts                                                │
  │     createMcpManager({spawnTransport?})                     │
  │     bootstrap({config, registry, signal})                   │
  │       for each enabled server (in parallel):                │
  │         spawn  ─── transportStdio.ts                        │
  │         client ─── client.ts (initialize, tools/list)       │
  │         adapt  ─── toolAdapter.ts  (per tool → Tool)        │
  │         registry.register(adaptedTool)                      │
  │       returns { connected[], failed[] }                     │
  │     shutdown()                                              │
  │       unregister all MCP tools, close all clients           │
  │                                                             │
  │   client.ts         jsonrpc.ts         namespacing.ts       │
  │   transportStdio.ts errors.ts          index.ts             │
  └─────────────────────────────────────────────────────────────┘
                          │ per tools/call
                          ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  MCP server subprocess (user-owned, stdio)                  │
  │    stdin  ← newline-delimited JSON-RPC requests             │
  │    stdout → newline-delimited JSON-RPC responses            │
  │    stderr → diagnostic noise (bounded ring, logged)         │
  └─────────────────────────────────────────────────────────────┘
```

The existing tool-execution loop is **unchanged**. From `src/core/tools/runToolUse.ts`'s point of view, an MCP tool is just a `Tool` in the registry — same `validateInput` / `checkPermissions` / `call` interface, same permission cascade, same error kinds. The only seams added to the tool system are `source`/`namespace` metadata and a `ToolRegistry.unregister()` for clean shutdown.

---

## Scope

**In (locked):**

1. `Tool.source` and `Tool.namespace` optional fields, defaulted to `'builtin'` / undefined for every existing tool with zero behavior change
2. `ToolRegistry.unregister(name)` and `ToolRegistry.getByNamespace(ns)`; registry guard rejects non-MCP tools whose name starts with `mcp__`
3. `~/.ultron/mcp.json` config loader — ENOENT → empty config, malformed → throw; mirrors `src/hooks/loadHooks.ts`
4. Newline-delimited JSON-RPC 2.0 framing (no `Content-Length`)
5. Stdio transport: spawn subprocess, line-stream I/O, SIGTERM→SIGKILL grace shutdown
6. MCP client: `initialize` handshake + `tools/list` + `tools/call` with id correlation, per-request timeout, abort cleanup
7. Tool adapter: one MCP tool descriptor → one `Tool` with namespaced name
8. Manager: parallel `Promise.allSettled` bootstrap with fail-soft per server; `shutdown` unregisters tools before closing clients
9. QueryEngine: lazy cached-promise bootstrap inside `submitPrompt` (mirroring `hookConfig` at 311-314), `callModel` rebuild once post-bootstrap, public `init()` pre-warm and public terminal `dispose()`
10. CLI: clean shutdown in SIGINT/SIGTERM/beforeExit handlers **and** in `/quit` / `/exit` (line 115-118)

**Out (deferred to 3b+):**

- Reconnect with exponential backoff on transport death
- MCP `resources/*`, `prompts/*`, `sampling/*` protocol methods
- HTTP/SSE transport
- MCP `$/cancelRequest` notification (JSON-RPC cancellation)
- Progress notifications during long-running tool calls
- Hot-reload of `mcp.json` without process restart
- Wildcard permission rules (`mcp__github__*`)
- `/mcp status` and other management CLI commands
- Project-local `./.ultron/mcp.json` discovery (considered, rejected for 3a — stick with `~/.ultron/mcp.json` to match hooks precedent)
- Schema normalization for MCP tools whose `inputSchema.type !== 'object'` (dropped with warning in 3a; wrapping is 3b work)

---

## Data flow

### Startup

1. `new QueryEngine(config)` — synchronous, unchanged. Constructs `mcpManager` from `config.mcpManager ?? createMcpManager({ spawnTransport: config.mcpSpawnTransport ?? spawnStdioTransport })`.
2. First `submitPrompt(...)` call:
   - After hookConfig lazy-load at 311-314, check `_mcpInitPromise`. If null and `config.disableMcp !== true`, assign `_mcpInitPromise = bootstrapMcp()`.
   - `await this._mcpInitPromise` — rejects if config file is malformed; individual server failures are absorbed into `failed[]` and do not reject.
   - If any MCP tool registered AND `!_callModelRebuilt`: rebuild `callModel` with `getToolDefinitions(this.toolRegistry)` and set `_callModelRebuilt = true`.
3. Subsequent `submitPrompt` calls skip the init check cheaply (promise already resolved).

### Per tool call

Unchanged from v1 path. `src/core/tools/runToolUse.ts` dispatches via `toolRegistry.get(toolUse.name)`. For an MCP tool, `tool.call(...)` invokes `client.callTool(descriptor.name, input, signal)` and maps the typed result union to a `ToolResult`.

### Shutdown

1. CLI `/quit`, `/exit`, SIGINT, SIGTERM, or `beforeExit` triggers `await engine.dispose()`.
2. `dispose()` sets `_disposed = true`, then `await mcpManager.shutdown()`.
3. `mcpManager.shutdown()` iterates tracked servers; for each, it unregisters every tool it registered, then calls `client.close()` → `transport.close(2000)` → SIGTERM → wait → SIGKILL.
4. Subsequent `submitPrompt` calls reject immediately.

---

## Module breakdown

### `src/core/mcp/namespacing.ts`

Pure. No I/O, no imports other than types.

```ts
export const MCP_TOOL_PREFIX = 'mcp__'

// /^[a-z0-9][a-z0-9-]{0,63}$/ — no underscores, no dots, no colons.
// Validated at config load; violations throw McpConfigError.
export function isValidServerName(name: string): boolean

// Returns `mcp__<server>__<sanitizedTool>`.
export function qualifyToolName(serverName: string, toolName: string): string

// Greedy split: `mcp__SERVER__TOOL` where SERVER has no `_`.
export function parseQualifiedName(qualified: string): { serverName: string; toolName: string } | null

// Non-alphanumeric → `_`; collapse repeats; strip leading/trailing `_`;
// empty → `tool_<index>`.
export function sanitizeToolName(raw: string, fallbackIndex: number): string
```

The `__` token is unambiguous because server names cannot contain `_`. Tool names with `_` or even `__` (sanitized from weird characters) are safely nested after the `mcp__<server>__` prefix.

### `src/core/mcp/jsonrpc.ts`

Pure. ~100 LOC.

```ts
export type JsonRpcId = number | string
export type JsonRpcRequest  = { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: unknown }
export type JsonRpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown }
export type JsonRpcSuccess = { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
export type JsonRpcErrorResponse = { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } }
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse

export function encodeRequest(id: JsonRpcId, method: string, params?: unknown): string  // trailing '\n'
export function encodeNotification(method: string, params?: unknown): string             // trailing '\n'
export function parseFrame(line: string): JsonRpcResponse | JsonRpcNotification | null   // null on malformed
```

### `src/core/mcp/errors.ts`

Follows `src/core/errors.ts` pattern but in its own file — MCP is a bounded subsystem and keeping errors co-located with their throwers means an MCP-disabled build has zero dead code.

```ts
export class McpConfigError extends Error       { readonly code = 'MCP_CONFIG_ERROR' as const }
export class McpInitializeError extends Error   { readonly code = 'MCP_INITIALIZE_ERROR' as const; readonly serverName: string }
export class McpTransportError extends Error    { readonly code = 'MCP_TRANSPORT_ERROR' as const; readonly serverName: string }
export class McpProtocolError extends Error     { readonly code = 'MCP_PROTOCOL_ERROR' as const; readonly serverName: string; readonly rpcCode?: number }
```

`McpInitializeError` and `McpTransportError` are **caught internally** by the manager and recorded in `failed[]`; they don't propagate out. `McpConfigError` is the only one that reaches the user — malformed `mcp.json` causes `submitPrompt` to reject with a path in the message.

### `src/core/mcp/config.ts`

```ts
export type McpServerConfig = {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly disabled?: boolean
  readonly timeoutMs?: number  // default 30_000; applies to initialize + tools/list
}

export type McpConfig = {
  readonly schemaVersion: 1
  readonly servers: Readonly<Record<string, McpServerConfig>>
}

export async function loadMcpConfig(path: string): Promise<McpConfig>
export function emptyMcpConfig(): McpConfig
```

Validation throws `McpConfigError` with the file path in the message. Rules: `schemaVersion === 1`, server name matches `isValidServerName`, `command` is non-empty string, optional fields type-checked.

### `src/core/mcp/transportStdio.ts`

```ts
export type StdioTransport = {
  send(line: string): void                    // appends '\n' if missing
  onLine(cb: (line: string) => void): void    // delivered per completed line
  onError(cb: (err: Error) => void): void     // transport-level errors (incl. stderr spew)
  onExit(cb: (code: number | null, signal: string | null) => void): void
  close(graceMs?: number): Promise<void>      // SIGTERM → wait → SIGKILL (default 2000)
}

export type SpawnStdioTransportArgs = {
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cwd?: string
}

export function spawnStdioTransport(args: SpawnStdioTransportArgs): StdioTransport
```

Implementation notes:

- Stdout: accumulate in a string buffer, split on `\n`, emit completed lines via `onLine`. Incomplete trailing partial line stays buffered.
- Stderr: bounded 16 KB ring buffer; emit via `onError` with a `stderr:` prefix when non-empty at flush points (avoid leaking memory from a chatty server).
- `close(graceMs = 2000)`: reuse the `killAndSettle` shape from `src/hooks/runHook.ts`: SIGTERM, race `exit` against `setTimeout(graceMs)`, SIGKILL on timeout, await exit.
- Inherit `process.env` when the caller doesn't override — most MCP servers need `PATH`, `HOME`, etc.

### `src/core/mcp/client.ts`

```ts
export type McpClientState = 'idle' | 'connecting' | 'ready' | 'closed' | 'failed'

export type McpToolDescriptor = {
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown  // raw from server; validated to have type:'object' at adapter-time
}

export type McpToolCallResult =
  | { kind: 'ok'; content: string; isError: boolean }
  | { kind: 'transport_error'; message: string }
  | { kind: 'protocol_error'; code: number; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'aborted' }

export interface McpClient {
  readonly serverName: string
  readonly state: McpClientState
  readonly lastError: Error | null
  connect(signal: AbortSignal): Promise<void>
  listedTools(): readonly McpToolDescriptor[]
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<McpToolCallResult>
  close(): Promise<void>
}

export function createMcpClient(serverName: string, cfg: McpServerConfig, transport: StdioTransport): McpClient
```

Protocol specifics:

- Request IDs: monotonic ints starting at 1.
- Pending map: `Map<JsonRpcId, { resolve; reject; timer: NodeJS.Timeout }>`.
- `initialize` params: `{ protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ultron', version: '0.1.0' } }`. Server capabilities are accepted but not branched on in 3a.
- After initialize succeeds, send the mandatory `notifications/initialized` notification (per MCP spec).
- `tools/list`: expect `result.tools: Array<{ name, description?, inputSchema }>`. Filter entries missing `name` or `inputSchema`; emit one stderr warning per drop.
- `tools/call`: wire key is **`arguments`**, not `input`. Result `{ content: ContentBlock[]; isError?: boolean }`. Flatten: text blocks concatenated; image blocks replaced by `[image: <mediaType>, <N> bytes]` placeholder (3b adds real image handling).
- Transport death mid-flight: every pending request rejects with `McpTransportError`; state → `failed`.

### `src/core/mcp/toolAdapter.ts`

```ts
export function createMcpTool(args: {
  serverName: string           // already sanitized (valid by config rules)
  descriptor: McpToolDescriptor
  client: McpClient
  defaultTimeoutMs: number
}): Tool | null
```

Returns `null` if `descriptor.inputSchema?.type !== 'object'` (manager logs and skips). Otherwise produces a `Tool`:

- `name`: `mcp__<serverName>__<sanitizeToolName(descriptor.name, ...)>`
- `description`: `descriptor.description ?? '(MCP tool from ${serverName})'`
- `inputSchema`: `descriptor.inputSchema` **verbatim** after the type-object check (cast through `unknown` to `ToolInputJSONSchema`).
- `source: 'mcp'`, `namespace: serverName`, `isMutating: true`.
- `validateInput`: always `{ valid: true }` — the MCP server validates; we surface errors through the tool_result.
- `checkPermissions`: always `{ behavior: 'allow' }`. **This is critical — see §Critical invariants.**
- `call(input, ctx, signal)`: invokes `client.callTool(descriptor.name, input, signal)`, maps:
  - `ok` → `{ content, isError }`
  - `transport_error` / `protocol_error` / `timeout` → `makeErrorResult('execution_error', message)` (reuses the existing `ToolErrorKind`; no new kind in 3a).
  - `aborted` → `makeAbortResult()`
- **No** `isConcurrencySafe`, **no** `getPath` — we can't infer either from an arbitrary MCP tool.

### `src/core/mcp/manager.ts`

```ts
export type McpBootstrapResult = {
  readonly connected: readonly string[]
  readonly failed: readonly { server: string; error: Error }[]
}

export type McpServerStatus = {
  readonly server: string
  readonly state: McpClientState
  readonly toolCount: number
  readonly lastError: string | null
}

export interface McpManager {
  bootstrap(args: {
    config: McpConfig
    registry: ToolRegistry
    signal: AbortSignal
  }): Promise<McpBootstrapResult>
  shutdown(): Promise<void>
  status(): readonly McpServerStatus[]
}

export function createMcpManager(deps?: {
  spawnTransport?: typeof spawnStdioTransport
}): McpManager
```

Bootstrap algorithm (per server, concurrent via `Promise.allSettled`):

1. Skip if `server.disabled === true`.
2. `transport = deps.spawnTransport(...)`.
3. `client = createMcpClient(name, cfg, transport)`.
4. `await client.connect(signal)` with `cfg.timeoutMs ?? 30_000`. Failure → record error, close transport, continue.
5. For each tool in `client.listedTools()`: `tool = createMcpTool(...)`; if `null` skip; else `registry.register(tool)`. Record registered names for shutdown.
6. Push server name to `connected`.

`shutdown()`: for each tracked server, `registry.unregister(each registered name)` first, then `await client.close()`. Double-shutdown is idempotent (clears the tracked list).

### `src/core/mcp/index.ts`

Barrel export: `createMcpManager`, `McpManager`, types, error classes, `loadMcpConfig`, `emptyMcpConfig`, `spawnStdioTransport` (so tests can inject it).

### Seam changes to existing files

**`src/core/tools/types.ts`:**

```ts
export type ToolSource = 'builtin' | 'mcp' | 'custom'

export interface Tool {
  // ...existing fields unchanged...
  readonly source?: ToolSource      // undefined is treated as 'builtin' on read
  readonly namespace?: string
}
```

`buildTool()` defaults `source: 'builtin'` when omitted. `AgentTool` in `src/agents/agentTool.ts` returns a literal object — rather than rewriting it, the registry reads `tool.source ?? 'builtin'` so the default applies without touching the literal.

**`src/core/tools/registry.ts`:**

```ts
export interface ToolRegistry {
  register(tool: Tool): void                      // throws on mcp__ prefix w/o source:'mcp'
  unregister(name: string): boolean               // NEW
  get(name: string): Tool | undefined
  has(name: string): boolean
  getAll(): readonly Tool[]
  getByNamespace(ns: string | undefined): readonly Tool[]  // NEW
  readonly size: number
}
```

`register` adds a guard: if `tool.name.startsWith('mcp__')` and `(tool.source ?? 'builtin') !== 'mcp'`, throw. Prevents accidental shadowing.

**`src/sdk/QueryEngine.ts`:**

New fields:

```ts
private readonly mcpManager: McpManager
private _mcpInitPromise: Promise<void> | null = null
private _callModelRebuilt = false
private _disposed = false
```

New `QueryEngineConfig` fields:

```ts
readonly mcpConfig?: McpConfig             // explicit inlined config (test bypass)
readonly mcpConfigPath?: string            // defaults to ~/.ultron/mcp.json
readonly disableMcp?: boolean              // short-circuit
readonly mcpManager?: McpManager           // test seam — inject pre-built manager
readonly mcpSpawnTransport?: typeof spawnStdioTransport  // test seam — inject transport factory
```

Constructor: `this.mcpManager = config.mcpManager ?? createMcpManager({ spawnTransport: config.mcpSpawnTransport })`.

`submitPrompt`:

```ts
if (this._disposed) {
  throw new Error('QueryEngine has been disposed')
}
// ...existing hookConfig lazy-load at 311-314...
if (!this._mcpInitPromise && !this.config.disableMcp) {
  this._mcpInitPromise = this.bootstrapMcp()
}
if (this._mcpInitPromise) {
  await this._mcpInitPromise
}
if (!this._callModelRebuilt && this.toolRegistry.getByNamespace(undefined).length < this.toolRegistry.size) {
  // At least one MCP tool was registered
  const toolDefs = getToolDefinitions(this.toolRegistry)
  this.callModel = this.resolveCallModel(this._model, toolDefs)
  if (!this.config.compactModel) this.compactCallModel = this.callModel
  this._callModelRebuilt = true
}
```

New methods:

```ts
async init(): Promise<void>       // optional pre-warm; runs the same lazy-load block
async dispose(): Promise<void>    // sets _disposed, awaits mcpManager.shutdown()
```

`dispose()` is idempotent (second call no-ops).

**`src/cli.ts`:**

- In `/quit` and `/exit` handlers at line 115-118: `await engine.dispose(); process.exit(0)`.
- Add `process.on('SIGINT', async () => { await engine.dispose(); process.exit(130) })` and equivalent for `SIGTERM`.
- After engine construction and (optional) `engine.init()`, if the returned `failed[]` is non-empty, write one `[mcp] server "<name>" failed: <reason>` line to stderr per failure.

---

## Critical invariants

### 1. Permission cascade interaction — MCP tools return `allow` from `checkPermissions`

This is the single most subtle part of the design. `src/core/permissions/permissions.ts:75-123` evaluates:

1. Explicit deny rules
2. Explicit ask rules
3. `tool.checkPermissions()` ← **short-circuits** if it returns `deny` or `ask`
4. Safety checks
5. Mode (bypass / acceptEdits)
6. Explicit allow rules
7. Fallback `ask`

If MCP tools returned `{behavior: 'ask'}` at step 3, the cascade would short-circuit there and step 6 (allow rules) would never be consulted. Every call — including calls against a session "always allow" rule the user created on the previous call — would prompt.

**Therefore MCP tools return `{behavior: 'allow'}` from `checkPermissions`.** The cascade falls through:

- Step 4 (safety checks): no-op since MCP tools have no `getPath`.
- Step 5 (modes): `bypassPermissions` allows (user chose it); `acceptEdits` does NOT allow MCP tools because they have no `getPath`. Good.
- Step 6: explicit allow rule matches → allowed without prompting.
- Step 7: fallback → `ask`. First call always hits this.

Interactive "always allow" at step 7 creates a session allow rule (`runToolUse.ts:104`). Subsequent calls match step 6. Exactly the v1 "prompt once, then remember" UX, with no new code in the permission system.

Headless mode has no `askUser`, so step 7 resolves to `permission_ask` error → MCP tools are effectively denied unless an explicit allow rule is pre-configured. Matches the v2-scope intent.

### 2. `callModel` rebuild

Tool definitions are baked into `callModel` at constructor time (`src/sdk/QueryEngine.ts:144`). MCP tools aren't known until the first `submitPrompt` bootstraps the manager. If `callModel` were not rebuilt, the model would never see MCP tools in its tools array and could never invoke them.

Rebuild is triggered post-bootstrap, guarded by `_callModelRebuilt`, only if any MCP tool actually registered. It runs before the first model call, inside `submitPrompt` and after the MCP init promise resolves. Test-injected `config.deps.callModel` overrides bypass this path — intentional, since tests using `deps.callModel` are not exercising the provider layer.

### 3. `dispose()` is terminal

Once `dispose()` runs, `_disposed = true` and `submitPrompt` rejects fast. This avoids a partial lifecycle where MCP is torn down but the engine keeps trying to serve requests with a stale `callModel`. If a future phase needs reversible lifecycles, that's an explicit design choice then.

CLI `/quit` and `/exit` paths — currently calling `process.exit(0)` directly at `src/cli.ts:115-118` — must `await engine.dispose()` first. Signal handlers (SIGINT/SIGTERM/beforeExit) do the same. The test suite asserts no zombie subprocesses remain after `dispose()`.

### 4. Subagent exclusion

`src/agents/runAgent.ts:84` defaults `allowedTools` to `['FileRead', 'Glob', 'Grep']`. Subagents created with this default do NOT see MCP tools. This is the correct conservative default — most MCP tools mutate state in ways that aren't appropriate for a read-only investigation subagent. Users who want MCP in subagents opt in by listing the specific `mcp__*` names in `allowedTools`.

The broader question of how subagents should interact with MCP — whether there should be a "read-only MCP tool" flag, whether manifests should drive inheritance — is explicitly a **subagent-phase** problem, not a 3a problem.

---

## Sharp edges and known issues

- **Stdout discipline.** MCP servers must write **only** JSON-RPC frames to stdout. A startup banner, a debug print, a warning log — any non-JSON line on stdout — breaks framing. 3a responds to unparseable lines with one stderr warning and keeps going; it does not attempt to recover desynced framing. Document in the design doc and README that server authors must honor stdio discipline. This is an industry standard and every maintained MCP server already follows it.
- **JSON Schema draft compatibility.** MCP servers emit schemas at their own discretion — some use features (e.g., `$ref`, `oneOf` at the top level) that provider APIs may reject. 3a passes schemas verbatim and lets the provider be the validator; if we see recurring breakage with specific servers in practice, 3b can add a schema rewriter. Do not pre-build one.
- **Non-object top-level schemas.** `ToolInputJSONSchema` requires `type: 'object'`. MCP tools that declare another top-level type (rare but legal per spec) are **dropped** in 3a with a stderr warning. Wrapping into `{ type: 'object', properties: { value: originalSchema } }` is a reasonable 3b polish but out of scope now.
- **Late responses for aborted requests.** When `callTool` is aborted, the pending entry is removed. If the server's response arrives later, `parseFrame` succeeds but the ID lookup finds nothing — the response is silently dropped (with one debug log). The server may still be doing work for the aborted call; proper MCP `$/cancelRequest` semantics are 3b.
- **Zombie subprocesses on SIGKILL.** If Ultron is SIGKILLed (not SIGINT/SIGTERM), MCP subprocesses may orphan. Node's default `detached: false` puts the child in the parent's process group, so on Linux/macOS the kernel should clean them up when the group is killed. Tested by the integration test (spawn fake server, `engine.dispose()`, assert the fake's close handler fired).
- **Registry collisions.** The `mcp__` prefix guarantees no collision with any existing built-in. The `register()` guard prevents future built-ins from accidentally claiming the prefix. If two MCP servers each expose a `read` tool, namespacing (`mcp__fs__read` vs `mcp__github__read`) keeps them distinct. Sanitized-tool-name collisions *within one server* get a `_<index>` suffix with a stderr warning.
- **Provider support.** The Anthropic adapter at `src/core/providers/anthropicAdapter.ts` passes `input_schema` through; OpenAI and MiniMax adapters do the same. MCP tools thus work across all providers without provider-specific code. Verified by reading the adapter code — no action needed in 3a.

---

## Verification

### Unit (colocated `*.test.ts`)

| File | Key assertions |
|---|---|
| `namespacing.test.ts` | valid/invalid server names; qualify/parse round-trips; tool-name sanitization incl. collision suffixing |
| `jsonrpc.test.ts` | encode/parse round-trips for request/notification/success/error; malformed frames → null |
| `config.test.ts` | ENOENT → empty; malformed JSON throws; schema violations throw with path; valid configs round-trip |
| `transportStdio.test.ts` | spawn `node -e "..."` one-liner as fake server: write/read echo, `onExit` fires, `close(2000)` kills a hung child within grace |
| `client.test.ts` | inject fake transport (no subprocess): initialize happy path + server error + timeout; list drops invalid entries; call success + protocol_error + transport_error + abort; late response after abort is silently dropped |
| `toolAdapter.test.ts` | name shape; `source`/`namespace`/`isMutating` correct; `checkPermissions → {behavior:'allow'}`; null return when `inputSchema.type !== 'object'`; full result-variant mapping |
| `manager.test.ts` | 3 parallel servers, 1 failing doesn't block others; registered tools findable; `shutdown` unregisters all + closes; double-shutdown idempotent |
| `registry.test.ts` (modified) | `unregister` / `getByNamespace`; `source` defaults to `'builtin'` on undefined; `mcp__` guard rejects non-MCP tools |

### Integration — `tests/integration/mcp.test.ts`

In-process fake MCP server implemented as an EventEmitter-based `StdioTransport`. No external dependencies, no subprocess.

```ts
function fakeMcpServer(handlers: {
  initialize?: (params: unknown) => unknown
  'tools/list'?: () => unknown
  'tools/call'?: (params: { name: string; arguments: unknown }) => unknown
}): StdioTransport { /* ... */ }
```

Inject via `config.mcpSpawnTransport` (not via `config.deps.callModel` — that override would bypass the rebuilt `callModel` and make the rebuild invariant untestable).

Assertions:

1. After first `submitPrompt`, `engine.getRegistry().has('mcp__fake__echo') === true`.
2. `getToolDefinitions(engine.getRegistry())` includes `mcp__fake__echo`.
3. First call: fake `askUser` returns `allow_once` → `tool_result` received correctly.
4. Second call: fake `askUser` returns `allow_by_rule` → session rule created.
5. Third call: `askUser` is **not** invoked (session rule matches at cascade step 6) → proves the `allow`-from-`checkPermissions` + fallback-ask pattern works end-to-end.
6. `await engine.dispose()` closes the fake transport (handler fires); `await engine.submitPrompt(...)` after dispose rejects; second `dispose()` no-ops.

A separate small test covers subagent exclusion: spawn a subagent with default `allowedTools`, confirm `mcp__fake__echo` is not in its tool pool and invocation falls through.

### Manual smoke

- `~/.ultron/mcp.json` pointing at `npx -y @modelcontextprotocol/server-filesystem /tmp`.
- Run `npm run build && node dist/cli.js`.
- Confirm the `mcp__filesystem__*` tools are listed in `/model` or a test invocation, approve via permission prompt, verify result.

Commands: `npm run typecheck && npm run test`.

---

## Acceptance criteria

- A server listed in `~/.ultron/mcp.json` appears in the registry after the first `submitPrompt` completes.
- First call to an MCP tool prompts the user (interactive) or returns `permission_ask` (headless); "always allow" creates a session rule that makes subsequent calls to the same tool pass without prompting.
- Subagents with default `allowedTools` do NOT see MCP tools; explicitly listing `mcp__*` in `allowedTools` opts in.
- Killing the server subprocess mid-session produces clean `execution_error` tool_results for subsequent calls; no hang.
- `await engine.dispose()` leaves no zombie subprocesses; subsequent `submitPrompt` rejects; second `dispose()` is a no-op; CLI `/quit` and `/exit` dispose before `process.exit(0)`.
- Malformed `~/.ultron/mcp.json` causes `submitPrompt` to reject with an `McpConfigError` whose message names the file path.
- A server whose `initialize` times out is skipped with one stderr line; other servers still load; `submitPrompt` does not reject.
- An MCP tool whose descriptor `inputSchema.type !== 'object'` is dropped with one stderr line; other tools from the same server still load.
- `npm run typecheck && npm run test` both pass on main.

---

## Implementation order

1. `docs/ultron_v2/phase3a-v2-design.md` (this document)
2. Seam: `src/core/tools/types.ts`, `src/core/tools/registry.ts` + tests
3. Pure modules: `src/core/mcp/errors.ts`, `namespacing.ts`, `jsonrpc.ts`, `config.ts` + tests
4. Client stack: `src/core/mcp/transportStdio.ts`, `client.ts`, `toolAdapter.ts` + tests
5. Orchestrator: `src/core/mcp/manager.ts`, `index.ts` + tests
6. Wiring: `src/sdk/QueryEngine.ts`, `src/cli.ts` + integration test

Each step should keep `npm run typecheck && npm run test` green before moving to the next.
