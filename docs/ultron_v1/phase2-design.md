# Phase 2 Design: Tool Abstraction Layer

## Overview

Phase 2 defines the contracts that all tools implement. It does not build tool implementations (Phase 6) or the execution boundary that wires tools into the query loop (Phase 3). The goal is a small, stable interface that later phases build on without modification.

Four new files, no modifications to Phase 1 code.

---

## Architecture

```
QueryDeps.RunToolFn  (Phase 1, unchanged)
        |
        |  Phase 3 will bridge this gap
        v
ToolRegistry.get(name) -> Tool
        |
        +-> tool.validateInput(input, ctx)
        +-> tool.checkPermissions(input, ctx)
        +-> tool.call(input, ctx, signal)
        |
        v
    ToolResult { content, isError }
```

`ToolResult` is structurally identical to `RunToolFn`'s return type, so Phase 3's bridge is a thin adapter.

---

## State Store (`src/core/state.ts`)

A generic, synchronous, single-instance state container. No external dependencies.

### Store Interface

```typescript
type Listener<T> = (state: T, prev: T) => void
type Unsubscribe = () => void

interface Store<T> {
  getState(): T
  setState(partial: Partial<T> | ((prev: T) => Partial<T> | T)): void
  subscribe(listener: Listener<T>): Unsubscribe
}

function createStore<T extends Record<string, unknown>>(initial: T): Store<T>
```

### setState Semantics

Both calling styles shallow-merge into the current state:

```typescript
store.setState({ permissionMode: 'acceptEdits' })            // direct partial
store.setState(prev => ({ permissionMode: 'acceptEdits' }))   // updater partial
store.setState(prev => ({ ...prev, newField: 'value' }))      // updater full replace
```

When passed a function, the return value is shallow-merged (same as the direct form). This means updaters don't need to spread the full state for single-field changes.

Listeners fire synchronously after merge, receiving `(newState, prevState)`.

### AppState

Minimal for Phase 2. Grows as later phases land.

```typescript
type AppState = {
  readonly permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions'
}

function getDefaultAppState(): AppState
// returns { permissionMode: 'default' }
```

The three permission modes come from Phase 0's product definition.

---

## Tool Interface (`src/core/tools/types.ts`)

### Core Types

```typescript
type ToolInputJSONSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

type ValidationResult =
  | { valid: true }
  | { valid: false; message: string }

type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; message: string }

type ToolResult = {
  content: string
  isError: boolean
}
```

### Tool Interface

```typescript
interface Tool {
  readonly name: string
  readonly inputSchema: ToolInputJSONSchema

  validateInput(
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  checkPermissions(
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    signal: AbortSignal,
  ): Promise<ToolResult>

  /** True if this tool can safely run concurrently with others. Default: false. */
  isConcurrencySafe?(input: Record<string, unknown>): boolean

  /**
   * Best-effort filesystem path this tool operates on, for permission routing.
   * Not all tools have a meaningful path (e.g., Bash).
   */
  getPath?(input: Record<string, unknown>): string
}
```

### Design Decisions

- **No Zod, no generics.** The project has no Zod dependency. Six tools don't justify generic parameterization over `Input`/`Output` type variables. `Record<string, unknown>` is the universal input type. Each tool narrows internally.
- **`validateInput` is required on the interface** but `buildTool()` supplies a default `() => ({ valid: true })`. Every tool has validation; most just pass through.
- **`PermissionResult` has three variants, no extra fields.** `behavior` is the decision. `message` explains why (required for `deny`/`ask`, absent on `allow`). No `updatedInput` — if Phase 3 needs input rewriting, that's a Phase 3 concern.
- **`call` takes `signal: AbortSignal` as a direct parameter** rather than extracting from context. Makes the abort contract explicit at the call site.
- **`getPath` is optional** and documented as best-effort path attribution. Tools without a meaningful path (Bash, Grep with no specific file) don't implement it.
- **`ToolResult` matches `RunToolFn`'s return type** (`{ content: string; isError: boolean }`). This is intentional — Phase 3's bridge is structurally trivial.

### buildTool Helper

```typescript
function buildTool(spec: {
  name: string
  inputSchema: ToolInputJSONSchema
  call: Tool['call']
  validateInput?: Tool['validateInput']
  checkPermissions?: Tool['checkPermissions']
  isConcurrencySafe?: Tool['isConcurrencySafe']
  getPath?: Tool['getPath']
}): Tool
```

Defaults:

| Field | Default |
|-------|---------|
| `validateInput` | `async () => ({ valid: true })` |
| `checkPermissions` | `async () => ({ behavior: 'allow' })` |
| `isConcurrencySafe` | not set (treated as false by callers) |
| `getPath` | not set |

---

## Tool Use Context (`src/core/tools/context.ts`)

Five fields. The reference `ToolUseContext` has 40+; the roadmap explicitly says "add fields only when required by your app."

```typescript
type ReadFileState = Map<string, { content: string; mtime: number }>

type ToolUseContext = {
  appState: Store<AppState>
  abortController: AbortController
  messages: readonly Message[]
  readFileState: ReadFileState
  toolRegistry: ToolRegistry
}

function createToolUseContext(opts: {
  appState: Store<AppState>
  abortController: AbortController
  messages: readonly Message[]
  readFileState?: ReadFileState
  toolRegistry: ToolRegistry
}): ToolUseContext
```

### Field Notes

- **`appState`** — `Store<AppState>`, not separate getter/setter functions. The `Store<T>` interface already provides `getState()` and `setState()`.
- **`messages`** — read-only snapshot. Tools must not mutate the message array. Phase 3's execution boundary creates fresh context per tool-call batch.
- **`readFileState`** — plain `Map`. Persists across turns within a session so `FileEdit` can reference content that `FileRead` cached. Phase 3 manages the lifecycle; Phase 6's `FileStateCache` may upgrade this to an LRU.
- **`abortController`** — passed through from the query loop. Tools check `abortController.signal.aborted` for cooperative cancellation.
- **`toolRegistry`** — available for tools that need to discover or invoke other tools (subagents in Phase 13). Most tools ignore it.

### Factory

`createToolUseContext()` defaults `readFileState` to an empty `Map` if not provided. All other fields are required.

---

## Tool Registry (`src/core/tools/registry.ts`)

### Interface

```typescript
interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  has(name: string): boolean
  getAll(): readonly Tool[]
  readonly size: number
}

function createToolRegistry(): ToolRegistry
function createDefaultRegistry(): ToolRegistry
```

### Implementation

- Backed by `Map<string, Tool>`.
- `register()` throws on duplicate names (fail-fast, unlike the reference's silent dedup).
- `getAll()` returns a frozen array for iteration (tool definitions sent to the API).

### Default Registry — Stub Tools

`createDefaultRegistry()` registers six stubs using `buildTool()`:

| Tool | `isConcurrencySafe` | Notes |
|------|---------------------|-------|
| `FileRead` | `true` | Read-only |
| `FileWrite` | not set (false) | Serialized |
| `FileEdit` | not set (false) | Serialized |
| `Glob` | `true` | Read-only |
| `Grep` | `true` | Read-only |
| `Bash` | not set (false) | Serialized |

Each stub:
- Has a correct `name` and `inputSchema` matching what the Anthropic API expects
- Uses `buildTool()` defaults for `validateInput` and `checkPermissions`
- Has `call` returning `{ content: 'Not implemented', isError: true }`
- Sets `getPath` where meaningful (FileRead, FileWrite, FileEdit return `input.file_path`)

These are temporary scaffolding. Phase 6 replaces them with real implementations in `src/tools/`.

### Input Schemas (Stub)

Each stub defines a minimal `inputSchema` with the required fields the API needs:

- **FileRead**: `{ file_path: string, offset?: number, limit?: number }`
- **FileWrite**: `{ file_path: string, content: string }`
- **FileEdit**: `{ file_path: string, old_string: string, new_string: string }`
- **Glob**: `{ pattern: string, path?: string }`
- **Grep**: `{ pattern: string, path?: string, glob?: string }`
- **Bash**: `{ command: string, timeout?: number }`

---

## Circular Dependency Analysis

```
types.ts --import type--> context.ts --import type--> registry.ts --import type--> types.ts
```

All cross-references are `import type`. TypeScript erases these at compile time, so the compiled JS has no circular `import` statements. ESM is fine with this.

---

## What Phase 2 Does NOT Do

- **No runtime JSON Schema validation.** Phase 2 defines `ToolInputJSONSchema` as a type. Phase 3 decides on a validation approach (ajv, hand-rolled subset, or Anthropic API-side validation).
- **No modification to Phase 1 files.** The bridge from `QueryDeps.RunToolFn` to `ToolRegistry` is Phase 3.
- **No real tool implementations.** Stubs return errors. Phase 6 builds the real tools.
- **No permission engine.** `checkPermissions` defaults to `{ behavior: 'allow' }`. Phase 4 builds the policy engine.

---

## File Map

| File | Responsibility | Imports from Phase 1? |
|------|---------------|----------------------|
| `src/core/state.ts` | Generic state store + AppState | No |
| `src/core/tools/types.ts` | Tool interface, ToolResult, buildTool | No (type-imports context.ts) |
| `src/core/tools/context.ts` | ToolUseContext definition + factory | Yes: `Message` from messages.ts |
| `src/core/tools/registry.ts` | ToolRegistry + stub registrations | No (type-imports types.ts) |

---

## Implementation Order

1. `src/core/state.ts` — no dependencies on other new files
2. `src/core/tools/types.ts` — type-imports context.ts (type-only, no runtime dep)
3. `src/core/tools/context.ts` — imports state.ts, registry.ts
4. `src/core/tools/registry.ts` — imports types.ts, creates stubs with buildTool

---

## Verification Criteria

1. **Lookup by name**: `createDefaultRegistry().get('FileRead')` returns a Tool with `name === 'FileRead'`; `.get('NonExistent')` returns `undefined`
2. **All six tools registered**: `createDefaultRegistry().size === 6`; `getAll()` returns all six
3. **Duplicate rejection**: `registry.register(tool)` twice with same name throws
4. **validateInput default**: stub tool's `validateInput()` returns `{ valid: true }`
5. **checkPermissions default**: stub tool's `checkPermissions()` returns `{ behavior: 'allow' }`
6. **isConcurrencySafe**: FileRead/Glob/Grep return true; FileWrite/FileEdit/Bash return false (or undefined, treated as false)
7. **Store basics**: `createStore()` → `getState()` returns initial; `setState()` merges; `subscribe()` fires on change
8. **ToolResult shape**: stub `call()` returns `{ content: string, isError: boolean }` — same shape as `RunToolFn`

All tests use in-memory constructs. No API calls, no filesystem access.

---

## Downstream Consumers

- **Phase 3** (Execution Boundary) — builds `runToolUse()` that looks up tools in the registry, validates, checks permissions, and calls. Bridges `ToolRegistry` → `RunToolFn`.
- **Phase 4** (Permission Engine) — replaces `checkPermissions` defaults with real policy logic.
- **Phase 6** (Tool Implementations) — replaces stub tools with real FileRead, FileWrite, FileEdit, Glob, Grep, Bash.
- **Phase 7** (Prompt & Context) — reads `getAll()` to build tool definitions for the API request.
- **Phase 13** (Subagents) — uses `toolRegistry` in `ToolUseContext` to create restricted tool pools.
