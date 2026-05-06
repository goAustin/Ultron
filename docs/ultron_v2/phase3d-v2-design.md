# Phase 3d Design: MCP Progress Notifications as Side-Channel QueryEvents

## Context

Phases 3a–3c shipped the MCP substrate, lifecycle, and operability surface:
stdio transport, JSON-RPC 2.0, namespaced registration, `$/cancelRequest`,
suffix-wildcard rules, schema wrapping, exponential-backoff reconnect,
`/mcp status | reload | list-tools`, manager gateway, and clean disposal.

Long-running MCP tools (a `git clone`, a multi-file `grep`, a chained API
call) have no way to tell the user "I'm 40% through" today. The MCP spec
covers this with `notifications/progress`, but the v1 tool-execution boundary
returns a single `Promise<ToolResult>` (`src/core/queryDeps.ts:147`) — there is
no streaming channel for *intermediate* signal during a tool call. Phase 3b
explicitly punted this with the note that progress would require widening
`executeToolUse` from `Promise<ToolResult>` into a generator-shaped contract,
"a phase of its own."

This is that phase.

### Strict constraint (non-negotiable, locked by user)

Progress is a **side channel**:

1. `ToolResult` is unchanged — its content is exactly the post-completion
   payload, exactly bound to its originating `ToolUse`.
2. Progress events flow as `QueryEvent`s on the existing streaming pipe,
   correlated by `toolUseId`.
3. Progress is **never** inserted into the message array.
4. Progress is **never** seen by `normalizeMessages` or by compaction.
5. The history persisted to disk reflects exactly the v1/v2 contract:
   `tool_use` ↔ `tool_result` pairing, no progress blocks anywhere.

Progress is observability, not transcript.

---

## Architecture

```
  src/core/query.ts (loop, line 304)
    was:   const result = await deps.executeToolUse(toolUse, signal)
    now:   const result = yield* streamToolUse(toolUse, signal, deps)
                          │
                          ▼
  src/core/tools/streamToolUse.ts  (NEW — pure callback→yield bridge)
    AsyncGenerator<ToolProgressEvent, ToolResult>
      • spawns deps.executeToolUse(toolUse, signal, onProgress)
      • drains a per-call FIFO queue
      • yields ToolProgressEvent on each onProgress call
      • returns the awaited ToolResult (or rethrows)
                          │
                          ▼
  src/core/queryDeps.ts ─ ExecuteToolUseFn gains an optional 3rd arg:
    (toolUse, signal, onProgress?) => Promise<ToolResult>
                          │
                          ▼
  src/core/tools/runToolUse.ts ─ executeToolUse(toolUse, signal, onProgress?)
    plumbs onProgress into ToolUseContext, then calls tool.call(input, ctx, signal)
                          │
                          ▼
  src/core/tools/context.ts ─ ToolUseContext gains
    onProgress?: (progress: ToolProgressInput) => void
                          │
                          ▼
  src/core/mcp/toolAdapter.ts
    call(input, ctx, signal):
      gateway({ ..., onProgress: ctx.onProgress })
                          │
                          ▼
  src/core/mcp/manager.ts ─ callTool gains onProgress?
    forwards to client.callTool
                          │
                          ▼
  src/core/mcp/client.ts
    callTool(name, args, signal, onProgress?):
      • if onProgress: mint progressToken, set _meta.progressToken on the request,
                       register progressSinks.set(token, onProgress)
      • on resolve/reject/timeout/abort: progressSinks.delete(token)
    onLine dispatcher (was: drop all notifications):
      if frame.method === 'notifications/progress':
        const sink = progressSinks.get(params.progressToken)
        if sink: sink({ progress, total, message })
        else:    debug-log late/unknown token
```

Everything below the `streamToolUse` bridge is plumbing. The hard part is the
bridge — it converts a callback-driven producer (`tool.call`'s synchronous
`onProgress(...)` invocations) into a yield-driven consumer (the query loop's
`yield*`) without breaking ordering, abort propagation, or the
`Promise<ToolResult>` shape demanded by `ExecuteToolUseFn`.

---

## Scope

### In (locked)

1. New `ToolProgressEvent` variant on the `QueryEvent` discriminated union, with
   factory `makeToolProgressEvent`.
2. `ToolUseContext.onProgress` callback (optional).
3. `ExecuteToolUseFn` signature gains an optional `onProgress` 3rd parameter.
   Existing tools that don't emit progress are unchanged at the type level.
4. `streamToolUse` generator helper — bridges callback → yield, returns
   `ToolResult`, propagates errors, respects `AbortSignal`.
5. `query.ts` loop replaces `await deps.executeToolUse(...)` with
   `yield* streamToolUse(...)`. Tool-result message construction is unchanged.
6. MCP client: per-call `progressToken` (`_meta.progressToken`), `progressSinks`
   map keyed by token, `notifications/progress` dispatcher in `onLine`, cleanup
   on every termination path.
7. MCP manager `callTool` gateway: forwards `onProgress` to `client.callTool`.
8. MCP `toolAdapter.call`: extracts `ctx.onProgress`, passes to gateway.
9. `tool_progress` added to `SHOULD_AUDIT` in `src/audit/auditLog.ts` —
   audit log is a side-channel observability stream, not history; consistent
   with the constraint.
10. Bounded queue in `streamToolUse` — soft cap (1000 events per call); on
    overflow, drop further events with one stderr line and one final
    `tool_progress` carrying `{ message: 'progress queue overflow; further events dropped' }`.

### Out (deferred to 3e+ or beyond)

- `notifications/progress` outbound from Ultron (we are consumer only).
- Resources, prompts, sampling MCP protocols.
- HTTP/SSE transport.
- Project-local `./.ultron/mcp.json` discovery.
- `/mcp call` manual invocation.
- Subagent wildcard expansion in `allowedTools`.
- Reconnect policy in user config.
- Progress UI rendering in the CLI (`src/cli.ts`). 3d emits the events; the
  CLI keeps its current "spinner only" UX. A future small slice can subscribe
  to `tool_progress` and render inline.
- Provider-side hooks for non-MCP tools to emit progress. The substrate is
  generic so any future tool can use it; 3d ships MCP as the first producer.

---

## Data flow

### Happy path: MCP tool with progress

1. Model emits `tool_use` for `mcp__demo__crawl`.
2. Query loop yields `tool_call_started`, runs PreToolUse hooks, yields each
   hook event.
3. Loop calls `yield* streamToolUse(toolUse, signal, deps)`.
4. `streamToolUse`:
   - Constructs `onProgress` that pushes onto an internal queue and wakes the
     reader.
   - Calls `deps.executeToolUse(toolUse, signal, onProgress)`. Awaiting is
     wrapped so we can race progress events vs. completion.
5. `runToolUse.executeToolUse` builds the `ToolUseContext` with `onProgress`
   wired in, calls `mcpAdapter.call(input, ctx, signal)`.
6. `mcpAdapter.call` invokes the manager gateway with `onProgress`.
7. Manager forwards to `client.callTool(name, args, signal, onProgress)`.
8. Client mints `progressToken = String(++progressCounter)`, registers
   `progressSinks.set(token, onProgress)`, sends
   `tools/call { name, arguments, _meta: { progressToken } }`.
9. Server emits one or more `notifications/progress` frames with that token.
   `client.onLine` dispatches each to the registered sink, which pushes a
   `ToolProgressEvent` into the queue.
10. `streamToolUse` yields each progress event. `query.ts`'s `yield*` forwards
    it through `runQuery`'s top-level generator out to the SDK consumer
    (`QueryEngine.submitPrompt`'s `for await`).
11. Server sends the `tools/call` response. Manager/client return a normal
    `McpToolCallResult`. Client deletes the token from `progressSinks`.
12. `streamToolUse` drains any remaining queued events, then `return`s the
    `ToolResult`. The `yield*` captures it.
13. `query.ts` calls `createToolResultMessage(toolUse, result, deps.uuid())`
    and pushes it onto the message array. **Result content is the awaited
    `ToolResult` only — no progress, no merge.**
14. PostToolUse hooks → `tool_call_finished` → `tool_result` event → next iter.

### Tool that emits no progress

`onProgress` is never called. The queue stays empty, no `tool_progress` events
fire, behavior is identical to today. **Zero observable change for tools that
don't opt in.**

### MCP server with no progress callback

If `ctx.onProgress` is undefined (e.g., a future caller doesn't want
progress), the client does **not** send `_meta.progressToken`. The server has
no token to attach progress to and either suppresses progress entirely or
sends untokened progress (which the dispatcher ignores). Saves wire and CPU.

### Abort during a long-running progress-emitting call

1. User Ctrl+C → `abortController.abort()`.
2. Existing 3b path: `client.callTool.onAbort` sends `$/cancelRequest`,
   resolves `{ kind: 'aborted' }`.
3. `progressSinks.delete(token)` runs in the same termination path.
4. `mcpAdapter.call` returns `makeAbortResult()`.
5. `streamToolUse` returns the abort `ToolResult`. Any progress events
   already queued are still drained (they happened before abort, they're
   real). Late progress notifications arriving after `progressSinks.delete`
   land on a missing token → dispatcher debug-logs and drops.

### Late progress notification (after response or after abort)

Dispatcher looks up `progressSinks.get(token)`, finds `undefined`, debug-logs
once and drops. Mirrors the existing late-response handling at
`src/core/mcp/client.ts:69`.

### Slow consumer / chatty server

The queue is bounded at 1000 events per call. On overflow, further events are
dropped with one stderr line `[mcp] progress queue overflow on <toolUseId>;
dropping further events`. A single sentinel `tool_progress` event with
`message: 'progress queue overflow; further events dropped'` is yielded so
downstream consumers see something happened. Cap is intentionally generous;
real MCP servers send single-digit-to-low-double-digit progress per call.

---

## Module breakdown

### `src/core/queryEvents.ts`

Add to the discriminated union:

```ts
export type ToolProgressEvent = {
  readonly type: 'tool_progress'
  readonly toolUseId: ToolUseId
  readonly progress: number            // raw counter (e.g., bytes done, items processed)
  readonly total: number | null        // null when server didn't supply it
  readonly message: string | null      // human-readable label, optional
  readonly timestamp: number
}

export type QueryEvent =
  | RequestStartEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolUseStartEvent
  | ToolProgressEvent           // NEW
  | ToolResultEvent
  | TurnEvent
  | ErrorEvent
  | ...
```

Source is intentionally *not* on the event. Consumers that care can correlate
by `toolUseId` back to the originating `tool_use_start` event (which carries
the tool name) and resolve source via the registry. Keeping source off the
event means the query loop doesn't need a new registry-lookup capability.

### `src/core/queryEventFactories.ts`

```ts
export function makeToolProgressEvent(args: {
  toolUseId: ToolUseId
  progress: number
  total: number | null
  message: string | null
}): ToolProgressEvent {
  return {
    type: 'tool_progress',
    toolUseId: args.toolUseId,
    progress: args.progress,
    total: args.total,
    message: args.message,
    timestamp: Date.now(),
  }
}
```

### `src/core/tools/context.ts`

Add to `ToolUseContext`:

```ts
readonly onProgress?: (progress: ToolProgressInput) => void
```

with a small input type colocated:

```ts
export type ToolProgressInput = {
  readonly progress: number
  readonly total?: number
  readonly message?: string
}
```

The callback takes the *input* shape (not the full event) so producers don't
need access to `ToolUseId` or `Date.now()` — `streamToolUse` fills those in
when constructing the event.

### `src/core/queryDeps.ts`

```ts
export type ExecuteToolUseFn = (
  toolUse: ToolUseBlock,
  signal: AbortSignal,
  onProgress?: (progress: ToolProgressInput) => void,
) => Promise<ToolResult>
```

Optional 3rd parameter — fully backward compatible. Existing test stubs and
production wiring don't have to change unless they want progress.

### `src/core/tools/runToolUse.ts`

`executeToolUse` accepts the optional `onProgress` and threads it into the
`ToolUseContext` it builds before calling `tool.call`. One field added; no
other behavior change.

### `src/core/tools/streamToolUse.ts`  (NEW)

```ts
import type { ToolProgressInput, ToolUseBlock } from '@/core/...'

export async function* streamToolUse(
  toolUse: ToolUseBlock,
  signal: AbortSignal,
  executeToolUse: ExecuteToolUseFn,
): AsyncGenerator<ToolProgressEvent, ToolResult> {
  type Item =
    | { kind: 'progress'; event: ToolProgressEvent }
    | { kind: 'done'; result: ToolResult }
    | { kind: 'error'; error: unknown }

  const queue: Item[] = []
  let waker: (() => void) | null = null
  const wake = () => { const w = waker; waker = null; if (w) w() }

  const PROGRESS_QUEUE_CAP = 1000
  let dropped = 0

  const onProgress = (p: ToolProgressInput) => {
    if (queue.length >= PROGRESS_QUEUE_CAP) {
      if (dropped === 0) {
        process.stderr.write(
          `[mcp] progress queue overflow on ${toolUse.id}; dropping further events\n`,
        )
        queue.push({
          kind: 'progress',
          event: makeToolProgressEvent({
            toolUseId: toolUse.id,
            progress: 0,
            total: null,
            message: 'progress queue overflow; further events dropped',
          }),
        })
        wake()
      }
      dropped++
      return
    }
    queue.push({
      kind: 'progress',
      event: makeToolProgressEvent({
        toolUseId: toolUse.id,
        progress: p.progress,
        total: p.total ?? null,
        message: p.message ?? null,
      }),
    })
    wake()
  }

  executeToolUse(toolUse, signal, onProgress).then(
    (result) => { queue.push({ kind: 'done', result }); wake() },
    (error)  => { queue.push({ kind: 'error', error }); wake() },
  )

  while (true) {
    while (queue.length === 0) {
      await new Promise<void>((r) => { waker = r })
    }
    const item = queue.shift()!
    if (item.kind === 'progress') yield item.event
    else if (item.kind === 'done') return item.result
    else throw item.error
  }
}
```

Pure function. Easy to unit-test with a synthetic `executeToolUse` that calls
`onProgress` a few times then resolves.

### `src/core/query.ts`

Replace line 304:

```ts
// before
let result = await deps.executeToolUse(effectiveToolUse, signal)

// after
let result = yield* streamToolUse(effectiveToolUse, signal, deps.executeToolUse)
```

Everything downstream — `createToolResultMessage`, message-array push, post-tool
hooks, `tool_call_finished`, `tool_result` event — is unchanged. Progress
events flow out via `yield*` and never touch `result` or `messages`.

### `src/core/mcp/client.ts`

**State additions:**

```ts
let progressCounter = 0
const progressSinks = new Map<string, (p: ToolProgressInput) => void>()
```

**`callTool` extension:**

```ts
async callTool(
  name: string,
  args: unknown,
  signal: AbortSignal,
  onProgress?: (p: ToolProgressInput) => void,
): Promise<McpToolCallResult> {
  // ...existing ID/timer/pending wiring...

  let progressToken: string | undefined
  if (onProgress) {
    progressToken = `p${++progressCounter}`
    progressSinks.set(progressToken, onProgress)
  }

  const params: Record<string, unknown> = { name, arguments: args }
  if (progressToken !== undefined) params._meta = { progressToken }

  // ...existing send + await + finalize...

  // On every termination path (resolve, reject, timeout, abort):
  if (progressToken !== undefined) progressSinks.delete(progressToken)
}
```

Use `try/finally` around the awaited send so cleanup runs unconditionally.

**`onLine` dispatcher** (replace the line-69 drop):

```ts
transport.onLine((line) => {
  const frame = parseFrame(line)
  if (frame === null) { /* existing log */ return }

  if (!('id' in frame)) {
    // It's a notification — dispatch by method.
    if (frame.method === 'notifications/progress') {
      const params = frame.params as
        | { progressToken?: string; progress?: number; total?: number; message?: string }
        | undefined
      const token = params?.progressToken
      if (typeof token !== 'string') return
      const sink = progressSinks.get(token)
      if (!sink) return  // late or unknown — silently drop
      const progress = typeof params.progress === 'number' ? params.progress : 0
      const total = typeof params.total === 'number' ? params.total : undefined
      const message = typeof params.message === 'string' ? params.message : undefined
      sink({ progress, total, message })
      return
    }
    // Unknown notification — keep dropping (3d does not own resources/prompts).
    return
  }

  // ...existing pending-id resolution...
})
```

**`close()` / disposal:** clear `progressSinks` entirely (defensive; keys
should already be gone if pending requests were properly settled).

### `src/core/mcp/toolAdapter.ts`

`call(input, ctx, signal)` extracts `ctx.onProgress` and passes it through:

```ts
const result = await callToolGateway({
  serverName,
  toolName: descriptor.name,
  input: serverInput,
  signal,
  onProgress: ctx.onProgress,
})
```

`McpCallToolGateway` type gains `onProgress?: (p: ToolProgressInput) => void`.

### `src/core/mcp/manager.ts`

`callTool` gateway gains `onProgress?` and forwards to `client.callTool`.
**Reconnect interaction:** if reconnect spawns a fresh client, the
`progressSinks` map lives on the *new* client — sinks registered against the
old client are gone with it (the failed call already returned
`transport_error`). No replay, no resurrection. Consistent with 3c's
no-replay invariant.

### `src/audit/auditLog.ts`

Add `'tool_progress'` to `SHOULD_AUDIT`. Audit log is a side-channel
observability stream, not transcript history — adding progress here is
consistent with the user's constraint.

---

## Critical invariants

### 1. ToolResult is exactly the awaited completion payload

`createToolResultMessage(toolUse, result, ...)` in `query.ts` runs only
after `streamToolUse`'s generator returns. Progress events are yielded *before*
the return, never *as* the return. There is no code path where a
`tool_progress` event content can leak into `result.content`.

### 2. Message history never sees progress

Progress events flow through `yield*` to the SDK consumer, but `query.ts`
inserts only `tool_use` and `tool_result` messages into `LoopState.messages`.
`normalizeMessages` operates on that array. By construction, the normalizer
cannot see what isn't there.

### 3. Compaction never sees progress

Same reasoning: compaction summarizes the message array. Progress lives in
the event stream parallel to it. Verified by reading
`src/core/normalizeMessages.ts` — it has no path that touches `QueryEvent`.

### 4. Persisted transcripts never see progress

Whatever serializes sessions reads from the message array, not from the event
stream. Progress is observability, not state.

### 5. Tools that don't opt in are unaffected

`onProgress` is optional everywhere. Tools that never call it produce zero
`tool_progress` events. The queue stays empty. `streamToolUse` immediately
hits the `done` item and returns. No measurable overhead.

### 6. Abort cleans up sinks

Every termination path in `client.callTool` deletes the progress sink — the
existing `try/finally` around pending-id cleanup is the natural home.

### 7. Reconnect doesn't resurrect sinks

When a client dies and the manager mints a new one, the old `progressSinks`
map is garbage-collected with the old client. No state survives across
reconnect. Consistent with 3c's no-replay invariant.

### 8. Ordering

`yield*` preserves yield order strictly. Progress events for tool use `T1`
appear in the order the MCP server emitted them, between
`tool_call_started(T1)` and `tool_result(T1)`. If two tool uses are processed
sequentially (today's loop is sequential per turn), their progress streams
don't interleave.

---

## Sharp edges

- **Servers that send progress without `_meta.progressToken` from us.** Some
  MCP servers may emit untokened progress. The dispatcher requires a token
  match — untokened progress is dropped silently. Acceptable: per spec,
  progress is meaningful only when the client opted in.
- **`progressCounter` collisions across reconnect.** `progressCounter` is
  per-client. A new client starts at 0. Since sinks live on the same client
  instance, no collision is possible.
- **Backpressure from very fast servers.** Soft cap at 1000 protects memory.
  Real-world MCP servers send single-digit progress events per call. If a
  server misbehaves, the user sees one stderr line plus the overflow sentinel
  event.
- **Audit volume.** A 1000-event call adds 1000 audit rows. The audit log is
  rotated; this is the same envelope as a chatty `tool_call_started` /
  `tool_call_finished` pair on a busy session. Acceptable.
- **CLI rendering.** 3d emits events but does not render them. The CLI keeps
  its current behavior. A 3-line follow-up patch can subscribe to
  `tool_progress` and update an inline status line; that's a separate UX
  decision.
- **Subagent fan-out.** Subagents have their own query loop instance. Their
  progress events flow into their own event stream, then the subagent tool's
  result is returned to the parent. The parent never sees a child's
  `tool_progress` events directly — same isolation as today.
- **Provider adapter.** No provider-adapter change. Progress lives below the
  `callModel` boundary; providers see only the eventual `tool_result`.

---

## Verification

### Unit

| File | Key assertions |
|---|---|
| `streamToolUse.test.ts` (new) | Yields progress events in order; returns the awaited ToolResult; rethrows on rejection; respects abort; queue overflow inserts sentinel + drops further; tools that never call onProgress yield nothing then return |
| `queryEventFactories.test.ts` | `makeToolProgressEvent` shape + defaults (`total: null`, `message: null` when not supplied) |
| `mcp/client.test.ts` (extend) | `_meta.progressToken` only sent when `onProgress` provided; incoming `notifications/progress` routes to the registered sink with normalized fields; unknown / late progress tokens drop silently; sink deleted on resolve / reject / timeout / abort |
| `mcp/toolAdapter.test.ts` (extend) | `ctx.onProgress` is forwarded to the gateway; gateway receiving progress invokes ctx.onProgress with normalized input |
| `mcp/manager.test.ts` (extend) | Manager `callTool` gateway forwards `onProgress` through reconnect path; reconnect doesn't resurrect old sinks |
| `query.test.ts` (extend) | A tool that calls `ctx.onProgress` produces `tool_progress` events on the QueryEvent stream between `tool_call_started` and `tool_call_finished`; the resulting message array contains exactly one `tool_use` + one `tool_result` (no progress in messages) |

### Integration — `tests/integration/mcp.test.ts`

Add a test using the in-process fake MCP server:

1. Configure `tools/call` handler to emit two `notifications/progress` frames
   (`{ progress: 1, total: 3, message: 'step 1' }`,
    `{ progress: 2, total: 3, message: 'step 2' }`) before responding.
2. Invoke the MCP tool through `engine.submitPrompt`.
3. Collect events from the SDK's `for await`.
4. Assert exactly two `tool_progress` events appear with matching `toolUseId`,
   `source: 'mcp'`, and the expected `progress` / `total` / `message`.
5. Assert the resulting message array contains no `tool_progress` data — the
   sole `tool_result` block carries only the final response content.
6. Assert that aborting mid-call cleans up: progress notifications arriving
   after abort do not throw, do not yield events.

### Manual smoke

- Use `@modelcontextprotocol/server-everything` (community sample server has a
  long-running `slowOperation` tool that emits progress).
- Configure in `~/.ultron/mcp.json`, run `node dist/cli.js`, ask the model to
  call the slow tool.
- Confirm: progress events visible in the SDK consumer (a small test harness
  can `console.log` them); `tool_result` carries only the final payload;
  message history (printable via session export) shows no progress.

Commands: `npm run typecheck && npm run test`.

---

## Acceptance criteria

- A tool whose `tool.call` invokes `ctx.onProgress(...)` produces
  `tool_progress` QueryEvents with the correct `toolUseId`, `source`,
  `progress`, `total`, `message` — appearing between `tool_call_started`
  and `tool_call_finished`.
- An MCP server emitting `notifications/progress` against the
  `_meta.progressToken` we sent produces matching `tool_progress` events end
  to end.
- An MCP `tools/call` whose `onProgress` was not provided does not include
  `_meta.progressToken` in the wire request.
- The `tool_result` message inserted into history contains exactly the
  `ToolResult.content` returned by the tool — no progress data, no metadata
  injection.
- `normalizeMessages`, compaction, and on-disk session persistence are
  byte-identical to pre-3d for a recorded session that did not emit progress;
  for a session that did emit progress, the persisted transcript still
  contains no progress blocks.
- Tools that never call `onProgress` are byte-identical at runtime to today
  (no extra events, no extra allocations beyond an unset Map entry).
- Aborting a long-running progress-emitting MCP call deletes the sink
  cleanly; subsequent late `notifications/progress` frames are dropped
  silently.
- `npm run typecheck && npm run test` are green.

---

## Implementation order

1. Materialize this plan as `docs/ultron_v2/phase3d-v2-design.md`.
2. Type-only seam: `ToolProgressEvent` in `queryEvents.ts`,
   `makeToolProgressEvent` in `queryEventFactories.ts`,
   `ToolProgressInput` in `tools/context.ts`, `onProgress?` on
   `ToolUseContext` and `ExecuteToolUseFn`. Build & typecheck — no behavior
   change yet.
3. `streamToolUse.ts` + unit tests. Pure module, no wiring.
4. Wire `query.ts:304` to `yield* streamToolUse(...)`. Run full test suite —
   should be unchanged because no producer emits progress yet.
5. `executeToolUse` in `runToolUse.ts` plumbs `onProgress` into
   `ToolUseContext`.
6. MCP client: `progressSinks`, `_meta.progressToken`, `onLine` dispatcher,
   cleanup in every termination path. Extend `client.test.ts`.
7. MCP gateway + adapter: forward `onProgress` end-to-end. Extend
   `manager.test.ts`, `toolAdapter.test.ts`.
8. `auditLog.ts`: add `'tool_progress'` to `SHOULD_AUDIT`.
9. Integration test in `tests/integration/mcp.test.ts`.
10. `npm run typecheck && npm run test`. Manual smoke against
    `server-everything`.

Each step keeps the build green before moving on.
