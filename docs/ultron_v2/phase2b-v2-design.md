# Phase 2b Design: User-Configurable Pre/Post Tool Hooks

## Context

Phase 2 of the v2 roadmap is "Hooks & audit spine" (`docs/ultron_v2/v2-scope.md:96`). Phase 2a landed the **typed audit spine**: structured `QueryEvent` variants for permission decisions, tool lifecycle, and compaction; a two-function `authorizeToolUse` / `executeToolUse` seam that makes the policy-vs-precondition distinction explicit; a rotated JSONL audit writer with redaction. Every new tool call already flows through a typed, observable boundary.

Phase 2b is the **consumer half**: user-configurable shell-command hooks wired to that boundary. It's the smallest layer that turns the substrate into a product feature users can actually touch. Per `docs/ultron_v2/v2-scope.md:63` — "**pre-tool / post-tool hooks** (user-configured shell commands) that can inspect or block tool calls — modelled on the Claude Code harness hooks."

2a foreshadowed 2b's scope directly (`docs/ultron_v2/phase2a-v2-design.md:647`):
> Phase 2b plugs into the same event stream. Hooks fire on `tool_call_started` (pre), `tool_call_finished` (post), and `permission_decision` (policy layer). Hook return values that mutate input require a small change to `runToolUse.ts`; 2a does not pre-design that interface — 2b owns it.

Scope locked:
- **Events covered:** `PreToolUse` + `PostToolUse` only. Lifecycle hooks (UserPromptSubmit, Stop, SessionStart, PreCompact, PostCompact) are deferred.
- **Config location:** single user-level file at `~/.ultron/hooks.json`. No project-local merging in 2b. Matches Ultron's single-user-local-first posture and the `.ultron/mcp.json` precedent from `docs/ultron_v2/v2-scope.md:32`.
- **Protocol:** mirror Claude Code's subprocess JSON-stdin / JSON-stdout / exit-code-2-denies convention, because users coming from Claude Code already know it and `v2-scope.md:63` explicitly calls out "modelled on the Claude Code harness hooks."

Out of scope (hard gate): `onEvent(handler)` subscription API, in-process TS hook handlers, lifecycle hooks, hook-driven permission whitelisting, project-local config merging, CLI management subcommands, argument-level matchers (`Bash(git *)`), parallel hook execution.

---

## Architecture

```
  ┌──────────────────────────────────────────────────────────┐
  │  src/core/query.ts  (tool execution loop)                │
  │                                                          │
  │  per tool_use block:                                     │
  │    auth = await deps.authorizeToolUse(tu, signal)        │
  │    emit permission_decision (if policy outcome)          │
  │    if !authorized:                                       │
  │      effectiveToolUses.push(toolUse)                     │
  │      emit tool_result; continue                          │
  │                                                          │
  │    ┌─────────── PRE hooks (new in 2b) ────────────┐     │
  │    │ preOutcome = yield* deps.runPreToolUseHooks( │     │
  │    │   toolUse, signal                            │     │
  │    │ )                                            │     │
  │    │ emits hook_started / hook_finished per hook  │     │
  │    │                                              │     │
  │    │ if preOutcome.kind === 'block':              │     │
  │    │   effectiveToolUses.push(toolUse)            │     │
  │    │   emit tool_result(syntheticResult); continue│     │
  │    │ if preOutcome.updatedInput !== undefined:    │     │
  │    │   effectiveToolUse = { ...toolUse,           │     │
  │    │     input: preOutcome.updatedInput }         │     │
  │    │ else effectiveToolUse = toolUse              │     │
  │    │ effectiveToolUses.push(effectiveToolUse)     │     │
  │    └──────────────────────────────────────────────┘     │
  │                                                          │
  │    yield tool_call_started(effectiveToolUse)             │
  │    result = await deps.executeToolUse(                   │
  │      effectiveToolUse, signal                            │
  │    )                                                     │
  │    durationMs = ...                                      │
  │                                                          │
  │    ┌─────────── POST hooks (new in 2b) ───────────┐     │
  │    │ postOutcome = yield* deps.runPostToolUseHooks│     │
  │    │   (effectiveToolUse, result, signal)         │     │
  │    │ result = postOutcome.result                  │     │
  │    └──────────────────────────────────────────────┘     │
  │                                                          │
  │    yield tool_call_finished(effectiveToolUse,            │
  │                             result, durationMs)          │
  │    yield tool_result                                     │
  │                                                          │
  │  attachments = deps.getAttachments(                      │
  │    effectiveToolUses.map((tu,i) =>                       │
  │      ({toolUse: tu, result: ...toolResults[i]}))         │
  │  )                                                       │
  └────────────────┬─────────────────────────────────────────┘
                   │
                   ▼
  ┌───────────────────────────────────────┐
  │  src/hooks/  (new module)             │
  │  loadHooks.ts   matcher.ts            │
  │  runHook.ts  runPreToolUseHooks.ts    │
  │  runPostToolUseHooks.ts               │
  └────────────────┬──────────────────────┘
                   │
                   ▼
  ┌───────────────────────────────────────┐
  │  Audit writer (existing, 2a)          │
  │  + 'hook_started', 'hook_finished'    │
  │  added to SHOULD_AUDIT                │
  └───────────────────────────────────────┘
```

**Data flow.** Hooks insert two new stages into the tool execution loop, straddling `executeToolUse`. PreToolUse runs after the 2a authorize gate and can either block (produce a synthetic `ToolResult` with internal `errorKind: 'hook_blocked'`) or mutate the `input` that flows into `executeToolUse`. PostToolUse runs after execution and can only augment the result content (append `additionalContext`). Both emit `hook_started` / `hook_finished` events, which pick up audit coverage for free.

**Effective-tool-use tracking.** The loop maintains a parallel `effectiveToolUses: ToolUseBlock[]` array, indexed identically to `toolResults`. Every branch (denied, hook-blocked, hook-mutated, plain execution) pushes to both arrays in lockstep. This is load-bearing for the attachment pipeline (`deps.getAttachments`), which zips tool_use × result pairs — continuing to use the raw `toolUseBlocks` from the assistant message would make post-turn attachments see the original (pre-mutation) input and lie about what the tool actually executed.

**Why inline, not observer.** Hooks are blocking by contract — a "block" result must short-circuit execution. An `onEvent(handler)` observer API would be an awkward fit because observers fire after-the-fact. Inline hooks keep pair-ordering intact (`hook_started → hook_finished` around every subprocess, the way `tool_call_started → tool_call_finished` wraps every tool call) and leave the door open for a future read-only `onEvent` observer surface.

**Why sequential, not parallel.** PreToolUse hooks can mutate input; a later hook must see the earlier hook's output. Post hooks could parallelize but 2b keeps them sequential for consistency. Hook counts will be small (1–3 per event) in realistic configs.

**Trusted mutation, re-validated input.** If a PreToolUse hook mutates input, `executeToolUse` re-runs `tool.validateInput` before dispatch — a deliberate contract revision (see §"Contract change on executeToolUse"). We do NOT re-run `authorizeToolUse`: the hook is user-authored and trusted. A malicious hook bypassing permissions is a user-configured footgun, not an Ultron defect. Re-validation catches the common bug (a lint script emitting malformed `updatedInput`) before handing garbage to `tool.call`.

---

## Core Types & Interfaces

### New `QueryEvent` variants (`src/core/queryEvents.ts`)

```ts
export type HookStartedEvent = {
  readonly type: 'hook_started'
  readonly hookEvent: 'PreToolUse' | 'PostToolUse'
  readonly hookIndex: number             // position in matching-hook list
  readonly toolUseId: ToolUseId
  readonly toolName: string
  readonly matcher: string
  readonly command: string               // redacted at audit-write time
  readonly timestamp: number
}

export type HookFinishedEvent = {
  readonly type: 'hook_finished'
  readonly hookEvent: 'PreToolUse' | 'PostToolUse'
  readonly hookIndex: number
  readonly toolUseId: ToolUseId
  readonly toolName: string
  readonly matcher: string
  readonly outcome: 'ok' | 'block' | 'error' | 'timeout'
  readonly decisionReason?: string       // present on 'block'
  readonly mutatedInput: boolean         // pre-only; true iff hook returned a valid updatedInput
  readonly outputTruncated: boolean      // true if stdout or stderr hit the cap
  readonly exitCode?: number
  readonly durationMs: number
  readonly stderrPreview?: string        // ≤ 200 chars, redacted at write
  readonly timestamp: number
}
```

### `ToolErrorKind` extension (`src/core/tools/types.ts:38`)

The union lives in `types.ts`, not `toolExecution.ts`. Add one case:

```ts
export type ToolErrorKind =
  | 'tool_not_found'
  | 'validation_failed'
  | 'permission_denied'
  | 'permission_ask'
  | 'execution_error'
  | 'aborted'
  | 'hook_blocked'           // NEW
```

`makeErrorResult` / `makeAbortResult` in `src/core/tools/toolExecution.ts` are already generic over `ToolErrorKind` — just a union widening.

**Note on the on-wire surface.** `ToolResultBlock` (`src/core/messages.ts:48-53`) carries only `content: string` + `isError: boolean` — it has no `errorKind` field and that is NOT changed in 2b. The structured "this was a hook block" signal lives on the event stream (`hook_finished(outcome='block')`), not in the tool_result message. Internally, `ToolResult` (`src/core/tools/types.ts:32-36`) carries `errorKind: 'hook_blocked'` and is readable by the audit writer via the synthetic-result path, but downstream consumers of `tool_result` events see only the content string + isError flag.

### Hook config file shape (`~/.ultron/hooks.json`)

```jsonc
{
  "schemaVersion": 1,
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",        "command": "~/scripts/ultron-bash-lint.sh", "timeout": 30000 },
      { "matcher": "Write|Edit",  "command": "~/scripts/prettier-check.sh" }
    ],
    "PostToolUse": [
      { "matcher": "*", "command": "~/scripts/log-to-file.sh" }
    ]
  }
}
```

- **`matcher`**: exact tool name, `"*"` wildcard, or pipe-separated alternation (`"Write|Edit|MultiEdit"`). No regex, no argument matchers.
- **`command`**: shell string. `~` expanded to `homedir()`. Executed via `spawn(cmd, {shell: true})`.
- **`timeout`**: milliseconds, default `60000` (60s).

### Hook subprocess protocol

**Stdin (JSON, single line, then EOF).**

```ts
// PreToolUse
{
  "hook_event_name": "PreToolUse",
  "tool_name": string,
  "tool_input": Record<string, unknown>,
  "session_id": string,
  "cwd": string
}

// PostToolUse
{
  "hook_event_name": "PostToolUse",
  "tool_name": string,
  "tool_input": Record<string, unknown>,
  "tool_response": { "content": string, "is_error": boolean },
  "session_id": string,
  "cwd": string
}
```

**Stdout (JSON object or empty).**

```ts
// PreToolUse response (all fields optional)
{
  "decision"?: "block",
  "reason"?: string,
  "updatedInput"?: Record<string, unknown>
}

// PostToolUse response (all fields optional)
{
  "additionalContext"?: string
}
```

**Exit code conventions.**
- `0` with empty stdout → `outcome: 'ok'`, pass-through.
- `0` with JSON stdout → parse and extract. If `decision === 'block'`, promote to `outcome: 'block'` (see "runHook" below — this is a critical correctness rule). Otherwise apply `updatedInput` / `additionalContext`.
- `2` → `outcome: 'block'`; stderr contents become the reason.
- Any other non-zero → `outcome: 'error'`. Logged on `hook_finished` but **does not block the tool call**. Documented as "fail-open": a broken lint script should not stop the agent cold.

### Hook internal types (`src/hooks/types.ts`, new)

```ts
export type HookEventName = 'PreToolUse' | 'PostToolUse'

export type HookDefinition = {
  readonly matcher: string
  readonly command: string
  readonly timeout?: number
}

export type HookConfig = {
  readonly schemaVersion: 1
  readonly hooks: {
    readonly PreToolUse: readonly HookDefinition[]
    readonly PostToolUse: readonly HookDefinition[]
  }
}

export type HookInvocationResult =
  | {
      readonly outcome: 'ok'
      readonly exitCode: 0
      readonly updatedInput?: Record<string, unknown>  // pre only
      readonly additionalContext?: string              // post only
      readonly stderrPreview: string
      readonly durationMs: number
      readonly outputTruncated: boolean
    }
  | {
      readonly outcome: 'block'
      readonly reason: string
      readonly exitCode: 0 | 2
      readonly stderrPreview: string
      readonly durationMs: number
      readonly outputTruncated: boolean
    }
  | {
      readonly outcome: 'error'
      readonly exitCode?: number
      readonly stderrPreview: string
      readonly durationMs: number
      readonly outputTruncated: boolean
    }
  | {
      readonly outcome: 'timeout'
      readonly stderrPreview: string
      readonly durationMs: number
      readonly outputTruncated: boolean
    }

export type PreHookOutcome =
  | { readonly kind: 'continue'; readonly updatedInput?: Record<string, unknown> }
  | { readonly kind: 'block'; readonly syntheticResult: ToolResult }

export type PostHookOutcome = {
  readonly result: ToolResult
}
```

The discriminated-union return from `runHook` makes the "block path guaranteed by `outcome === 'block'`" invariant a type-level guarantee: every branch that populates `reason` also sets `outcome: 'block'`.

### New deps (`src/core/queryDeps.ts`)

```ts
export type RunPreToolUseHooksFn = (
  toolUse: ToolUseBlock,
  signal: AbortSignal,
) => AsyncGenerator<QueryEvent, PreHookOutcome>

export type RunPostToolUseHooksFn = (
  toolUse: ToolUseBlock,
  result: ToolResult,
  signal: AbortSignal,
) => AsyncGenerator<QueryEvent, PostHookOutcome>

export type QueryDeps = {
  // ...existing 2a fields...
  readonly runPreToolUseHooks: RunPreToolUseHooksFn
  readonly runPostToolUseHooks: RunPostToolUseHooksFn
}
```

Both are async generators so they stream `hook_started` / `hook_finished` as each subprocess runs. The query loop `yield*`s them. Stub defaults used by tests: `async function*() { return {kind: 'continue'} }` / `async function*(_,_,_r) { return {result: _r} }`.

### `QueryEngineConfig` (`src/sdk/QueryEngine.ts`)

```ts
export type QueryEngineConfig = {
  // ...existing fields...
  readonly hookConfig?: HookConfig
  readonly hookConfigPath?: string
}
```

`loadHooks` is lazy: read once on first `submitPrompt`, memoize on the engine instance. Missing file → empty config. Malformed JSON or schema violation → throw on first prompt (not at construction — keeps construction signature synchronous and surfaces the error where the user sees it).

### `SubagentOptions` widening (`src/agents/runAgent.ts:47-63`)

`runAgent.ts` currently builds its own `QueryDeps` (at lines 141–149) using `createAuthorizeToolUseFn` / `createExecuteToolUseFn` — no hook plumbing today. Add explicit pass-through:

```ts
export type SubagentOptions = {
  // ...existing fields...
  readonly runPreToolUseHooks: RunPreToolUseHooksFn    // NEW
  readonly runPostToolUseHooks: RunPostToolUseHooksFn  // NEW
}

// In the fork body, deps assembly:
const deps: Partial<QueryDeps> = {
  callModel: opts.callModel,
  authorizeToolUse,
  executeToolUse,
  runPreToolUseHooks: opts.runPreToolUseHooks,   // NEW
  runPostToolUseHooks: opts.runPostToolUseHooks, // NEW
  compact: createCompactFn(opts.compactCallModel, uuid),
  uuid,
}
```

`QueryEngine` passes its top-level hook runners into every `createForkSubagent(...)` call. Subagents run the same hook config as the parent — one config file, applied uniformly. The shared-audit-writer pattern from 2a means hook events in subagents land in the parent's `audit.jsonl` with `origin: <subagentId>` provenance for free.

### Unchanged

`ProviderAdapter`, `ModelEntry`, `CapabilitySheet`, `AuditWriter`, `ToolUseContext`, the `Tool` interface, `authorizeToolUse`'s signature, `ToolResultBlock`'s shape.

---

## Implementation Details

### `src/hooks/loadHooks.ts` (new)

```ts
export async function loadHooks(path: string): Promise<HookConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig()
    throw err
  }
  const parsed = JSON.parse(raw)
  return validateHookConfig(parsed)
}
```

`validateHookConfig` enforces `schemaVersion === 1`, only `PreToolUse` and `PostToolUse` keys under `hooks`, non-empty `matcher`/`command`, positive integer `timeout` if present. Unknown event keys (`"Stop"`, `"preToolUse"` lowercase, etc.) are rejected by name. `loadHooks` throws on parse / schema errors — a misconfigured hook file should never silently disable hooks.

### `src/hooks/matcher.ts` (new)

```ts
export function hookMatches(def: HookDefinition, toolName: string): boolean {
  if (def.matcher === '*') return true
  return def.matcher.split('|').map(s => s.trim()).includes(toolName)
}
```

### `src/hooks/runHook.ts` (new)

```ts
export const MAX_HOOK_STDOUT_BYTES = 1_048_576  // 1 MB
export const MAX_HOOK_STDERR_BYTES = 65_536     // 64 KB
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000

export async function runHook(
  def: HookDefinition,
  stdin: unknown,
  signal: AbortSignal,
): Promise<HookInvocationResult> {
  const started = Date.now()
  const timeout = def.timeout ?? DEFAULT_HOOK_TIMEOUT_MS
  const expandedCommand = expandHome(def.command)

  const child = spawn(expandedCommand, {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal,
    timeout,
  })
  child.stdin.end(JSON.stringify(stdin))

  // Capped collection: stop accumulating past the limit; track truncation.
  const { exitCode, stdout, stderr, outputTruncated } = await collectChildCapped(
    child,
    MAX_HOOK_STDOUT_BYTES,
    MAX_HOOK_STDERR_BYTES,
  )
  const durationMs = Date.now() - started
  const stderrPreview = stderr.slice(0, 200)
  const common = { stderrPreview, durationMs, outputTruncated }

  if (signal.aborted) return { outcome: 'error', ...common }
  if (child.killed && !signal.aborted) return { outcome: 'timeout', ...common }

  // Exit code 2 — block, reason from stderr.
  if (exitCode === 2) {
    return {
      outcome: 'block',
      reason: stderr.trim() || '(no reason given)',
      exitCode: 2,
      ...common,
    }
  }

  // Any other non-zero — error, do NOT block.
  if (exitCode !== 0) return { outcome: 'error', exitCode: exitCode ?? undefined, ...common }

  // exitCode === 0 — attempt to parse stdout.
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return { outcome: 'ok', exitCode: 0, ...common }

  let parsed: unknown
  try { parsed = JSON.parse(trimmed) }
  catch { return { outcome: 'ok', exitCode: 0, ...common } }

  const fields = extractHookFields(parsed)

  // Stdout-declared block must produce outcome:'block', not 'ok'.
  if (fields.decision === 'block') {
    return {
      outcome: 'block',
      reason: fields.reason ?? '(no reason given)',
      exitCode: 0,
      ...common,
    }
  }

  return {
    outcome: 'ok',
    exitCode: 0,
    ...(fields.updatedInput !== undefined && { updatedInput: fields.updatedInput }),
    ...(fields.additionalContext !== undefined && { additionalContext: fields.additionalContext }),
    ...common,
  }
}
```

`collectChildCapped` uses bounded buffers; once the cap is hit for a given stream, additional bytes are discarded and `outputTruncated: true` is flagged. The subprocess is NOT killed on truncation (some hooks legitimately print large results and exit cleanly); it's only killed on timeout or signal.

`extractHookFields` is a defensive reader: it pulls `decision`, `reason`, `updatedInput`, `additionalContext` from `parsed` only if they are of the expected shape (plain object for `updatedInput`, string for the others, literal `'block'` for `decision`). Unknown fields silently ignored — forward-compat with Claude Code hook scripts that emit extra fields.

**Never throws.** Every failure mode returns a typed `HookInvocationResult`.

### `src/hooks/runPreToolUseHooks.ts` (new)

```ts
export async function* runPreToolUseHooks(
  toolUse: ToolUseBlock,
  context: PreHookContext,   // { sessionId, cwd, hookConfig }
  signal: AbortSignal,
): AsyncGenerator<QueryEvent, PreHookOutcome> {
  const matching = context.hookConfig.hooks.PreToolUse.filter(h => hookMatches(h, toolUse.name))

  let currentInput = toolUse.input

  for (let i = 0; i < matching.length; i++) {
    const def = matching[i]
    yield makeHookStartedEvent('PreToolUse', i, toolUse, def)

    const res = await runHook(def, {
      hook_event_name: 'PreToolUse',
      tool_name: toolUse.name,
      tool_input: currentInput,
      session_id: context.sessionId,
      cwd: context.cwd,
    }, signal)

    yield makeHookFinishedEvent('PreToolUse', i, toolUse, def, res, {
      mutatedInput: res.outcome === 'ok' && res.updatedInput !== undefined,
    })

    if (res.outcome === 'block') {
      return {
        kind: 'block',
        syntheticResult: makeErrorResult('hook_blocked', res.reason),
      }
    }
    if (res.outcome === 'ok' && res.updatedInput !== undefined) {
      currentInput = res.updatedInput
    }
    // 'error' / 'timeout' — logged on hook_finished, move on.
  }

  return currentInput === toolUse.input
    ? { kind: 'continue' }
    : { kind: 'continue', updatedInput: currentInput }
}
```

`runPostToolUseHooks` is parallel but simpler: no block path, only `additionalContext` concatenation onto `result.content`.

### Query-loop wiring (`src/core/query.ts`)

Rewrite the tool execution block (currently lines 240–286). Key change: maintain `effectiveToolUses` parallel to `toolResults`, so the attachment pipeline (lines 317–327) can zip them correctly.

```ts
const toolResults: Message[] = []
const effectiveToolUses: ToolUseBlock[] = []   // NEW — indexed alongside toolResults

for (const toolUse of toolUseBlocks) {
  if (signal.aborted) break

  // ── Authorize (unchanged from 2a) ────────────────────────────
  const auth = await deps.authorizeToolUse(toolUse, signal)
  if (auth.outcome === 'authorized' || auth.outcome === 'denied') {
    yield makePermissionDecisionEvent(toolUse, auth.decision.decision, auth.decision.reason, {
      userResponse: auth.decision.userResponse,
      ruleCreated: auth.decision.ruleCreated,
    })
  }
  if (auth.outcome !== 'authorized') {
    const rm = createToolResultMessage(toolUse, auth.syntheticResult, deps.uuid())
    toolResults.push(rm)
    effectiveToolUses.push(toolUse)           // original — nothing executed
    yield { type: 'tool_result', message: rm }
    continue
  }

  // ── PreToolUse hooks (2b) ────────────────────────────────────
  const preOutcome = yield* deps.runPreToolUseHooks(toolUse, signal)
  if (preOutcome.kind === 'block') {
    const rm = createToolResultMessage(toolUse, preOutcome.syntheticResult, deps.uuid())
    toolResults.push(rm)
    effectiveToolUses.push(toolUse)           // original — nothing executed
    yield { type: 'tool_result', message: rm }
    continue
  }

  const effectiveToolUse: ToolUseBlock = preOutcome.updatedInput !== undefined
    ? { ...toolUse, input: preOutcome.updatedInput }
    : toolUse

  // ── Execute (unchanged from 2a, but on effectiveToolUse) ─────
  const started = Date.now()
  yield makeToolCallStartedEvent(effectiveToolUse)
  let result = await deps.executeToolUse(effectiveToolUse, signal)
  const durationMs = Date.now() - started

  // ── PostToolUse hooks (2b) ───────────────────────────────────
  const postOutcome = yield* deps.runPostToolUseHooks(effectiveToolUse, result, signal)
  result = postOutcome.result

  yield makeToolCallFinishedEvent(effectiveToolUse, result, durationMs)
  const rm = createToolResultMessage(effectiveToolUse, result, deps.uuid())
  toolResults.push(rm)
  effectiveToolUses.push(effectiveToolUse)
  yield { type: 'tool_result', message: rm }
}
```

And at `query.ts:317-327` (the attachment stage), zip on `effectiveToolUses`:

```ts
if (deps.getAttachments) {
  const executions: ToolExecution[] = effectiveToolUses.map((toolUse, i) => ({
    toolUse,
    result: extractToolResult(toolResults[i]!),
  }))
  const attachments = await deps.getAttachments(executions)
  // ...
}
```

Same length, same order, but every entry reflects what the tool **actually executed**, not what the model originally proposed.

### Contract change on `executeToolUse` (`src/core/tools/runToolUse.ts`)

Today's file header (lines 1–15) explicitly says:
> `executeToolUse` runs only `tool.call` (plus error wrapping). The caller is responsible for authorizing first.

2b revises this contract to: **always re-validate** before `tool.call`. This is a deliberate revision because:
- Pre-hooks can mutate input; un-validated mutated input would break tool implementations in confusing ways.
- The cost is cheap — `validateInput` is a local schema check.
- Every other non-hook call path already validated in `authorizeToolUse`; the extra call is idempotent for unchanged input.

Updated docstring + implementation:

```ts
/**
 * `executeToolUse` runs tool.call after an input re-validation pass.
 *
 * 2b contract change: every call re-runs tool.validateInput before dispatching
 * to tool.call. This protects tools from malformed input in two cases:
 * - PreToolUse hooks mutating tool_input to something the tool doesn't accept;
 * - Any future path that synthesizes a ToolUseBlock without going through
 *   authorizeToolUse.
 *
 * Permissions are NOT re-checked here. The caller is still responsible for
 * authorizing the original tool_use via authorizeToolUse.
 */
export async function executeToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
): Promise<ToolResult> {
  const aborted = checkAbort(signal)
  if (aborted) return aborted

  const tool = context.toolRegistry.get(toolUse.name)
  if (!tool) return makeErrorResult('tool_not_found', `Tool "${toolUse.name}" not found`)

  // NEW — re-validate. Cheap; catches hook-mutated garbage.
  try {
    const validation = await tool.validateInput(toolUse.input, context)
    if (!validation.valid) return makeErrorResult('validation_failed', validation.message)
  } catch (err) {
    return makeErrorResult('validation_failed', err instanceof Error ? err.message : String(err))
  }

  try {
    return await tool.call(toolUse.input, context, signal)
  } catch (err) {
    return makeErrorResult('execution_error', err instanceof Error ? err.message : String(err))
  }
}
```

Tests and comments referencing the old "call only" contract (grep for `"tool.call only"` and `"no permission check, no validation"`) are updated in the same commit. `runToolUse` (the compatibility wrapper) keeps working unchanged; the double-validation on the non-hook path is accepted and documented as cheap.

### Audit writer (`src/audit/auditLog.ts`)

One-line change to `SHOULD_AUDIT` (currently `auditLog.ts:28-39`): add `'hook_started'`, `'hook_finished'`. Redaction via `redactSecrets` applies automatically to `command` and `stderrPreview` fields.

### SDK wiring (`src/sdk/QueryEngine.ts`)

- Add `hookConfig?` / `hookConfigPath?` to `QueryEngineConfig`.
- Lazy-load on first `submitPrompt`; memoize per engine instance.
- Build `runPreToolUseHooks` / `runPostToolUseHooks` with the loaded config + `{sessionId, cwd}` and wire into `productionDeps()`.
- When creating any `forkSubagent`, pass the hook runners through `SubagentOptions`.

### CLI (`src/cli.ts`)

Add empty `case 'hook_started':` / `case 'hook_finished':` branches to the event-dispatch switch (preserves exhaustiveness). Interactive display stays silent — the audit log is the channel. Verbose mode is deferred.

---

## File Map

| File | Responsibility | Change |
|------|----------------|--------|
| `docs/ultron_v2/phase2b-v2-design.md` | This doc | **New** |
| `src/core/queryEvents.ts` | `HookStartedEvent`, `HookFinishedEvent`; extend `QueryEvent` union | Modified |
| `src/core/queryEventFactories.ts` | `makeHookStartedEvent`, `makeHookFinishedEvent` | Modified |
| `src/core/queryDeps.ts` | Add `RunPreToolUseHooksFn` / `RunPostToolUseHooksFn` to `QueryDeps`; stubs default to empty generators | Modified |
| `src/core/query.ts` | Insert pre-hook + post-hook stages; maintain `effectiveToolUses` array; zip attachments on effective uses | Modified |
| `src/core/tools/types.ts` | Add `'hook_blocked'` to `ToolErrorKind` union | Modified |
| `src/core/tools/toolExecution.ts` | No logic change — `makeErrorResult` already generic over `ToolErrorKind` | Unchanged |
| `src/core/tools/runToolUse.ts` | `executeToolUse` re-validates input; update top-of-file docstring; document contract revision | Modified |
| `src/hooks/types.ts` | `HookDefinition`, `HookConfig`, `HookInvocationResult`, `PreHookOutcome`, `PostHookOutcome` | **New** |
| `src/hooks/loadHooks.ts` | Read + validate `~/.ultron/hooks.json`; ENOENT → empty | **New** |
| `src/hooks/matcher.ts` | `hookMatches(def, toolName)` | **New** |
| `src/hooks/runHook.ts` | Subprocess runner with capped output collection + exit-0-JSON-block promotion | **New** |
| `src/hooks/runPreToolUseHooks.ts` | Async generator: fold matching pre-hooks | **New** |
| `src/hooks/runPostToolUseHooks.ts` | Async generator: fold matching post-hooks | **New** |
| `src/hooks/matcher.test.ts` | Matcher unit tests | **New** |
| `src/hooks/loadHooks.test.ts` | Config loader tests | **New** |
| `src/hooks/runHook.test.ts` | Subprocess protocol tests (incl. cap + exit-0-block) | **New** |
| `src/hooks/runPreToolUseHooks.test.ts` | Pre-hook orchestration tests | **New** |
| `src/hooks/runPostToolUseHooks.test.ts` | Post-hook orchestration tests | **New** |
| `tests/fixtures/hooks/*.sh` | Hook script fixtures | **New** |
| `src/audit/auditLog.ts` | Add `'hook_started'` / `'hook_finished'` to `SHOULD_AUDIT` | Modified |
| `src/sdk/QueryEngine.ts` | Accept hook config; lazy-load; wire deps; thread into subagent creation | Modified |
| `src/agents/runAgent.ts` | Add `runPreToolUseHooks` / `runPostToolUseHooks` to `SubagentOptions`; include in subagent `deps` | Modified |
| `src/agents/runAgent.test.ts` | Assert subagent receives parent's hook runners and fires them | Modified |
| `src/cli.ts` | Add empty `case` branches for new event types (exhaustiveness) | Modified |
| `tests/integration/hooks.test.ts` | End-to-end block, mutation, effective-input-attachments, subagent inheritance | **New** |

---

## Downstream Consumers

- **Lifecycle hooks (future).** UserPromptSubmit, Stop, SessionStart, PreCompact, PostCompact reuse `HookDefinition` and `runHook.ts`; only the stdin payload and call-site differ.
- **Project-local config.** `.ultron/hooks.json` in cwd merged with user-level. Additive extension to `loadHooks`.
- **Hook-driven whitelisting.** Hooks that can override `authorizeToolUse`'s decisions. Plugs into the authorize stage; requires extending `AuthorizeToolOutcome`.
- **`onEvent(handler)` observer API.** Read-only subscription for IDE / telemetry integrations. Separate from blocking hooks.

---

## Verification Criteria

### Typecheck

1. `npm run typecheck` passes. New variants force exhaustiveness in `cli.ts` and `auditLog.ts:SHOULD_AUDIT` filter — missed sites are compile errors.

### Matcher (`matcher.test.ts`)

2. `hookMatches({matcher: 'Bash', ...}, 'Bash')` → true.
3. `hookMatches({matcher: '*', ...}, 'Anything')` → true.
4. `hookMatches({matcher: 'Write|Edit', ...}, 'Edit')` → true; `'Read'` → false.
5. Whitespace in alternation (`'Write | Edit'`) trimmed.

### Config loader (`loadHooks.test.ts`)

6. ENOENT → `{schemaVersion: 1, hooks: {PreToolUse: [], PostToolUse: []}}`.
7. Malformed JSON throws with clear parse-error message.
8. Unknown event name (e.g. `"Stop"`, `"preToolUse"` case mismatch) rejected.
9. Missing `command` on a definition rejected.
10. `~`-prefixed commands stored verbatim in config; expanded only at spawn time.

### Subprocess runner (`runHook.test.ts`)

11. `exit-0.sh` (exit 0, no stdout) → `{outcome: 'ok', exitCode: 0}`.
12. `exit-2.sh` (exit 2, stderr = "denied") → `{outcome: 'block', reason: 'denied', exitCode: 2}`.
13. `exit-nonzero.sh` (exit 17) → `{outcome: 'error', exitCode: 17}`. Does NOT block.
14. `sleep-long.sh` with timeout 100ms → `{outcome: 'timeout'}`.
15. `mutate-input.sh` (exit 0, stdout `{"updatedInput":{"foo":"bar"}}`) → `{outcome: 'ok', updatedInput: {foo:'bar'}}`.
16. **`exit-0-stdout-block.sh` (exit 0, stdout `{"decision":"block","reason":"policy"}`) → `{outcome: 'block', reason: 'policy', exitCode: 0}`.**
17. `garbage-stdout.sh` (exit 0, non-JSON stdout) → `{outcome: 'ok'}` with no updatedInput (tolerated).
18. **`runaway-stdout.sh` (exit 0, emits 10MB to stdout) → `{outcome: 'ok', outputTruncated: true}` and completes without hanging.**
19. AbortSignal fired mid-subprocess → child killed, returns `{outcome: 'error'}` promptly.
20. Never throws: ENOENT command, spawn failure, etc., all return typed results.

### Pre-hook orchestration (`runPreToolUseHooks.test.ts`)

21. Empty config → no events, returns `{kind: 'continue'}`.
22. One matching pre-hook with `ok` → exactly one `hook_started` + one `hook_finished(outcome='ok')`; returns `{kind: 'continue'}`.
23. One pre-hook returning `{outcome: 'block', reason: 'policy'}` → generator returns `{kind: 'block', syntheticResult: {isError: true, errorKind: 'hook_blocked'}}`.
24. Two matching pre-hooks — first mutates input, second sees mutated input on its stdin payload. Second hook's `runHook` call arg has the mutated `tool_input`.
25. First hook blocks → second hook NOT invoked (no second `hook_started` emitted).
26. First hook `error`, second hook `block` → both run; second's block wins.
27. `hook_finished.mutatedInput === true` iff the hook returned a valid `updatedInput` plain object AND the orchestrator applied it.

### Post-hook orchestration (`runPostToolUseHooks.test.ts`)

28. Empty config → no events, returns `{result}` unchanged.
29. One post-hook with `additionalContext: "note"` → `result.content` ends with the appended note (concatenation convention documented in source).
30. Post-hook cannot block — if stdout contains `{"decision":"block"}`, field is ignored; `hook_finished` records `outcome: 'ok'`.

### Query-loop integration (`query.test.ts`)

31. With empty hook config, tool-call event order is IDENTICAL to pre-2b: `permission_decision → tool_call_started → tool_call_finished → tool_result`. No hook events.
32. Pre-hook blocks → event order is `permission_decision → hook_started → hook_finished(block) → tool_result`. **No `tool_call_started`, no `tool_call_finished`**. The `tool_result` message's `ToolResultBlock` has `isError: true`; the internal `ToolResult` carried `errorKind: 'hook_blocked'` (visible to the audit writer via the synthetic-result path, not via the wire block).
33. Pre-hook mutates input → `tool_call_started.input` on the stream equals the mutated value (NOT the original).
34. **Effective-tool-use attachment zipping**: pre-hook mutates `ls /` → `ls .`; after the turn, `deps.getAttachments` is called with an execution record whose `toolUse.input` is the mutated `{command: 'ls .'}`.
35. Post-hook augments content → `tool_call_finished.resultPreview` + the on-wire `tool_result.content` both carry the augmented text.
36. `tool_call_finished.durationMs` measures execution only (excludes pre and post hooks). Hooks have their own `durationMs` on `hook_finished`.

### Re-validation contract (`runToolUse.test.ts` — new cases)

37. `executeToolUse` with unchanged input → passes validation, dispatches to `tool.call`. (Non-regression.)
38. `executeToolUse` with hook-mutated input that fails the tool's `validateInput` → returns `{isError: true, errorKind: 'validation_failed'}`; `tool.call` is NOT invoked.
39. The file docstring in `runToolUse.ts` reflects the new "tool.call + re-validate input" contract (grep smoke test).

### Audit coverage (`auditLog.test.ts` — extensions)

40. `hook_started` / `hook_finished` persisted to disk.
41. Hook `command` containing a secret (e.g. `lint.sh --key AKIAIOSFODNN7EXAMPLE`) redacted on disk, preserved in-memory.
42. `stderrPreview` ≤ 200 chars, redacted.

### Subagent inheritance (`runAgent.test.ts`)

43. `createForkSubagent` constructed with hook runners routes tool calls through them. Scripted subagent tool_use triggers `runPreToolUseHooks` (spied); the spy records the invocation with the subagent's own context.
44. Every subagent-originated `hook_started` / `hook_finished` in the parent's audit log carries `origin: <subagentId>`.

### End-to-end (`tests/integration/hooks.test.ts`)

45. Engine constructed with `hookConfig: {block on Bash}`. Scripted tool_use for Bash. Audit log in order: `request_start`, `turn`, `permission_decision(allow)`, `hook_started`, `hook_finished(block)`, `tool_result(isError=true)`. Absent: `tool_call_started`, `tool_call_finished`.
46. Engine constructed with pre-hook that mutates Bash `ls /` → `ls .`. On-disk `tool_call_started.input.command === 'ls .'`; the scripted tool observed `ls .`.
47. `~/.ultron` is not touched (`hookConfigPath` → `tmpDir/hooks.json`; `auditWriter: createAuditWriter({dir: tmpDir})`).

### No regressions

48. `npm run test` — all pre-existing tests pass after the `QueryEvent` union grows and the re-validation contract change lands.

---

## Out of Scope (Hard Gate)

- Lifecycle hooks (UserPromptSubmit, Stop, SessionStart, PreCompact, PostCompact).
- Project-local `.ultron/hooks.json` merging.
- Hook-driven permission whitelisting.
- Argument-level matchers (`Bash(git *)`).
- Parallel hook execution.
- In-process TypeScript hook handlers.
- `onEvent(handler)` observer API.
- CLI subcommands for managing hooks.
- MCP-server-advertised hooks (Phase 3 is independent).
- Hook-discovery / hot-reload of `~/.ultron/hooks.json`.

---

## Deferred Design Decisions

- **Post-hook mutation surface.** 2b allows only `additionalContext` append. Full content rewrite or `isError` flipping deferred until we see real usage.
- **Matcher syntax upgrade.** Alternation + `*` for 2b. Regex, negation, argument matchers deferrable; current shape is forward-compatible.
- **Hook stdin schema versioning.** No `schemaVersion` in stdin today. Add when the first breaking change lands.
- **Hook failure policy.** 2b is fail-open (error exit doesn't block). A strict opt-in mode (`failMode: 'deny'` per hook) is easy to add later.
- **Output caps as config.** Hard-coded constants today (1MB stdout / 64KB stderr). Configurable per-hook later if users run up against them.

---

## Risks & Unknowns

1. **Hook performance tax.** Every matching pre-hook adds subprocess-spawn latency. Users with `*` matchers will feel it. **Fallback:** document expected cost; users narrow their matchers.
2. **Subprocess leaks.** Some shells ignore SIGTERM. **Fallback:** Ultron is single-process; orphans die with the parent session. Not Ultron's problem.
3. **Hook stdout truncation loses block decision.** A hook emitting `{"decision":"block",...}` after 1MB of prefix logging would have the decision JSON truncated. **Fallback:** document that block responses must be concise (the first chunk of stdout); add a test that block parsing still works when stdout is exactly at the cap boundary.
4. **Input-mutation trust model.** Hooks can rewrite `path: ./a` → `/etc/passwd`. No re-auth. Informed-user footgun; documented.
5. **Abort vs. block race.** User aborts mid-hook; block decision arrives ms before abort. **Fallback:** accept — block wins, tool denied, next turn proceeds normally.
6. **Config hot-reload absent.** Edits to `~/.ultron/hooks.json` apply only on the next engine instance. Documented; trivial follow-up.
7. **Exit-code-2 convention collisions.** Some user tools conventionally exit 2 on their own errors (e.g. certain linters). If a user wires those as hooks without exit-code translation, tool calls get unintentionally blocked. **Fallback:** documentation — suggest a small wrapper script; 2b prioritizes Claude-Code-hook compatibility over heuristic exit-code massaging.
