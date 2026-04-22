# Phase 3 Design: Tool Execution Boundary

## Overview

Phase 3 bridges `QueryDeps.RunToolFn` (Phase 1) and `Tool` (Phase 2). It builds the single guarded path through which every tool call flows: resolve → validate → check permissions → execute → normalize result. It also provides batch infrastructure for concurrent read-only execution, though batch mode is not wired into the query loop yet.

Three new files, no modifications to Phase 1 or Phase 2 code.

---

## Architecture

```
QueryDeps.RunToolFn  (Phase 1, unchanged)
        |
        |  createRunToolFn() adapter
        v
runToolUse(toolUse, context, signal)   ← plain async function
        |
        +-- 1. Check abort
        +-- 2. Resolve tool from registry
        +-- 3. Validate input (tool.validateInput)
        +-- 4. Check abort
        +-- 5. Check permissions (tool.checkPermissions)
        +-- 6. Check abort    ← critical: prevents racing into execution after cancel
        +-- 7. Execute (tool.call)
        +-- 8. Catch errors → structured ToolResult
        |
        v
    ToolResult { content, isError }
```

`runToolBatch()` sits alongside but is **not wired in** — `createRunToolFn()` calls `runToolUse()` directly for one tool at a time, matching the current serial loop in `query.ts`. Batch execution gets wired when `query.ts` adopts it.

---

## Shared Types & Helpers (`src/core/tools/toolExecution.ts`)

This file is the shared foundation. Both `runToolUse.ts` and `toolOrchestration.ts` import from it.

### Error Kinds

```typescript
type ToolErrorKind =
  | 'tool_not_found'
  | 'validation_failed'
  | 'permission_denied'
  | 'permission_ask'
  | 'execution_error'
  | 'aborted'
```

Error results carry a `kind` internally but the returned `ToolResult` is always `{ content: string, isError: boolean }`. Error formatting is minimal — `kind` plus the raw underlying message. No pre-baked user-facing copy; Phase 4 handles richer rendering.

### Helper Functions

```typescript
/** Construct a ToolResult for a known error kind. */
function makeErrorResult(kind: ToolErrorKind, message: string): ToolResult

/** Construct an abort result. */
function makeAbortResult(): ToolResult

/** Check signal and return abort result if aborted, otherwise undefined. */
function checkAbort(signal: AbortSignal): ToolResult | undefined
```

All synthetic error and abort result logic lives here. `runToolUse.ts` and `toolOrchestration.ts` never construct error results directly.

### Result Pair

```typescript
type ToolResultPair = {
  toolUseId: ToolUseId
  result: ToolResult
}
```

Used by `runToolBatch()` to associate results with their tool_use blocks.

### RunToolFn Adapter

```typescript
function createRunToolFn(context: ToolUseContext): RunToolFn
```

Returns a function matching the `RunToolFn` signature from `queryDeps.ts`:

```typescript
(toolUse: ToolUseBlock, signal: AbortSignal) => Promise<{ content: string; isError: boolean }>
```

Internally calls `runToolUse()`. This is the drop-in replacement for the Phase 1 stub.

---

## Single Tool Pipeline (`src/core/tools/runToolUse.ts`)

### Signature

```typescript
async function runToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
): Promise<ToolResult>
```

Plain async function, not an async generator. No consumer for streaming execution events exists yet. If events are needed later, wrapping a plain function in a generator is trivial.

### Pipeline Steps

1. **Check abort** — `checkAbort(signal)`. Return immediately if aborted.
2. **Resolve tool** — `context.toolRegistry.get(toolUse.name)`. If not found → `makeErrorResult('tool_not_found', ...)`.
3. **Validate input** — `tool.validateInput(toolUse.input, context)`. If `{ valid: false }` → `makeErrorResult('validation_failed', result.message)`.
4. **Check abort** — prevents racing into permission check after cancellation.
5. **Check permissions** — `tool.checkPermissions(toolUse.input, context)`.
   - `{ behavior: 'deny' }` → `makeErrorResult('permission_denied', result.message)`
   - `{ behavior: 'ask' }` → `makeErrorResult('permission_ask', result.message)` (no interactive UI yet; Phase 4 wires this)
   - `{ behavior: 'allow' }` → proceed
6. **Check abort** — critical checkpoint between permission resolution and execution start. Real race window here.
7. **Execute** — `tool.call(toolUse.input, context, signal)`. Wrapped in try/catch.
   - Success → return the `ToolResult`
   - Error thrown → `makeErrorResult('execution_error', error.message)`

### Input Typing

`toolUse.input` is `Record<string, unknown>` from `messages.ts`. The execution boundary treats it as untrusted. `validateInput()` narrows it; `tool.call()` receives whatever the tool's own validation accepted. No casts or type assumptions before validation.

---

## Batch Orchestration (`src/core/tools/toolOrchestration.ts`)

**Status: infrastructure, not yet wired into the query loop.**

`query.ts` currently iterates tools serially. `runToolBatch()` is built and tested but not called from production code. It will be wired in when `query.ts` adopts batch execution.

### Signature

```typescript
async function runToolBatch(
  toolUses: readonly ToolUseBlock[],
  context: ToolUseContext,
  signal: AbortSignal,
): Promise<ToolResultPair[]>
```

### Partitioning

```typescript
type Batch = {
  concurrent: boolean
  toolUses: ToolUseBlock[]
}

function partitionIntoBatches(
  toolUses: readonly ToolUseBlock[],
  registry: ToolRegistry,
): Batch[]
```

Groups consecutive `isConcurrencySafe` tools into concurrent batches. Non-safe tools get isolated single-element serial batches.

Example:
```
Input:  [FileRead, Grep, FileWrite, Glob, Grep]
Batch 1: [FileRead, Grep]     → concurrent (both isConcurrencySafe)
Batch 2: [FileWrite]          → serial (not safe)
Batch 3: [Glob, Grep]         → concurrent
```

A tool whose `isConcurrencySafe` is undefined is treated as unsafe.

### Execution

Batches execute sequentially. Within a concurrent batch:
- All tools run via `Promise.allSettled()` with a concurrency cap (default 10, simple semaphore, no external deps)
- Settled results (completed before abort) are kept
- On abort: remaining tools in the batch get `makeAbortResult()`

Between batches:
- Check abort signal. If aborted, all remaining batches get `makeAbortResult()` for each tool.

### Concurrency Cap

```typescript
const DEFAULT_MAX_CONCURRENCY = 10

async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]>
```

A minimal semaphore-based runner. No external dependencies.

---

## Error Handling Principles

1. **No exceptions escape the boundary.** Every path produces a `ToolResult`. The caller never needs try/catch around `runToolUse()`.
2. **Structured error kinds, not user-facing strings.** `ToolErrorKind` classifies the failure. The `content` field carries the raw message from the underlying layer (tool validation message, permission message, exception message). Phase 4 can format these for display.
3. **Abort is not an exception.** Abort produces a normal `ToolResult` with `isError: true` and `kind: 'aborted'`. No special error types.

---

## Abort Propagation

- Three explicit abort checkpoints in `runToolUse()`: entry, post-validation, post-permissions
- `AbortSignal` passed to `tool.call()` for cooperative cancellation within the tool
- In batch mode: abort checked before each batch and after each concurrent settlement
- Completed results are never discarded — only unstarted/unfinished tools get synthetic abort results

---

## What Phase 3 Does NOT Do

- **No interactive permission prompts.** `ask` results are treated as errors. Phase 4 adds the prompt UI and wires `ask` into an interactive flow.
- **No hooks.** The ROADMAP says "run pre-tool hooks if you support hooks." We don't yet. The pipeline structure supports adding hook slots later without changing the function signatures.
- **No runtime JSON Schema validation.** Input validation is the tool's own `validateInput()`. Runtime schema enforcement (ajv or similar) is deferred.
- **No modification to `query.ts`.** The `RunToolFn` adapter is drop-in compatible with the existing serial loop.
- **No modification to Phase 2 files.** Types, context, and registry are unchanged.
- **No streaming execution events.** `runToolUse()` is a plain async function. Event taxonomy deferred until a consumer exists.

---

## File Map

| File | Responsibility | Imports from |
|------|---------------|-------------|
| `src/core/tools/toolExecution.ts` | Error kinds, helper functions, `ToolResultPair`, `createRunToolFn()` | Phase 2 types, context, registry; Phase 1 messages |
| `src/core/tools/runToolUse.ts` | Single tool pipeline (resolve → validate → permissions → call) | `toolExecution.ts` helpers, Phase 2 types |
| `src/core/tools/toolOrchestration.ts` | Batch partitioning, concurrent/serial execution | `toolExecution.ts` helpers, `runToolUse.ts`, Phase 2 registry |

---

## Implementation Order

1. `src/core/tools/toolExecution.ts` — shared types and helpers (no deps on other new files)
2. `src/core/tools/runToolUse.ts` — imports toolExecution.ts
3. `src/core/tools/toolOrchestration.ts` — imports both

---

## Verification Criteria

1. **Unknown tool** → `{ isError: true }` with kind `tool_not_found`, no crash
2. **Invalid input** (validateInput returns `{ valid: false }`) → error before execution, tool.call never invoked
3. **Permission deny** → error before execution, tool.call never invoked
4. **Permission ask** → error (no UI yet), tool.call never invoked
5. **Successful call** → `ToolResult` from tool passed through unchanged
6. **Tool throws** → caught, kind `execution_error`, no exception escapes
7. **Abort before execution** → immediate abort result, tool.call never invoked
8. **Abort after permissions, before call** → abort result, tool.call never invoked
9. **`createRunToolFn()`** returns a function matching `RunToolFn` signature
10. **Batch partitioning**: `[safe, safe, unsafe, safe]` → 3 batches `[[safe,safe], [unsafe], [safe]]`
11. **Concurrent batch** runs tools in parallel (verified via timing or execution interleaving)
12. **Serial batch** runs tools one at a time
13. **Abort mid-batch** → completed tools keep results, remaining get abort results
14. **Concurrency cap** respected (≤ 10 concurrent)

All tests use in-memory constructs. No API calls, no filesystem access.

---

## Downstream Consumers

- **Phase 4** (Permission Engine) — replaces `checkPermissions` defaults with real policy. Wires `ask` into interactive prompts. May format error results for display.
- **Phase 6** (Tool Implementations) — real tools call through this boundary.
- **Future `query.ts` update** — adopts `runToolBatch()` for concurrent tool execution, replacing the current serial loop.
