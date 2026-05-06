# Phase 2a Design: Typed Audit Spine

## Context

Phase 2 of the v2 roadmap is "Hooks & audit spine." Per `docs/ultron_v2/v2-scope.md:96`: "one typed event stream covering permission decisions, tool lifecycle, compaction, and (later) subagents; pre/post tool hooks wired to that stream. Lands before any new tool surface so observability is never retrofitted."

Following the Phase 1 cadence (1a substrate data → 1b structural consumer → 1c runtime knob), Phase 2 splits into:

- **Phase 2a (this doc) — audit spine.** Widen `QueryEvent` into a unified observability stream. Emit every permission decision, tool lifecycle boundary with timing, and compaction boundary through that stream. Tee the stream to a rotated JSONL audit log on disk with secret redaction. No user-visible surface changes beyond the log file on disk.
- **Phase 2b (future) — user-configurable pre/post tool hooks.** Shell-command hooks wired to the 2a event stream; hooks can inspect, block, or modify tool input.

2a is pure substrate. It adds no new tools, no new UX, and no config flags. Its success is invisible during a normal session — the only behavioral change is the appearance of `~/.ultron/audit.jsonl` and the retirement of `~/.ultron/permissions.jsonl` (migration: leave existing file in place, stop appending).

---

## Architecture

```
  ┌────────────────────────────────────────────────────┐
  │  src/core/query.ts  (main agent loop)              │
  │                                                    │
  │  per tool_use block:                               │
  │   auth = await deps.authorizeToolUse(tu, signal)   │
  │   if auth.outcome in {authorized, denied}:         │
  │     yield permission_decision(auth.decision)       │
  │   if auth.outcome !== 'authorized':                │
  │     yield tool_result(auth.syntheticResult)        │
  │     continue                                       │
  │   yield tool_call_started                          │
  │   t = now(); result = await deps.executeToolUse()  │
  │   yield tool_call_finished(durationMs = now()-t)   │
  │   yield tool_result                                │
  │                                                    │
  │  yield compaction_started / compaction_finished    │
  │  yield (existing variants)                         │
  └────────────────┬───────────────────────┬───────────┘
                   │                       │
                   ▼                       ▼
  ┌──────────────────────┐   ┌─────────────────────────┐
  │ authorizeToolUse     │   │ executeToolUse          │
  │ (deps seam)          │   │ (deps seam)             │
  │                      │   │                         │
  │ resolve → validate → │   │ tool.call(input, ctx,   │
  │ hasPermissionsToUseT │   │   signal)               │
  │ askUser (if 'ask')   │   │ returns ToolResult with │
  │                      │   │ errorKind populated     │
  │ returns one of:      │   │ (no authorization here) │
  │  { outcome:          │   │                         │
  │    'authorized',     │   │                         │
  │    decision }        │   │                         │
  │  { outcome:'denied', │   │                         │
  │    decision,         │   │                         │
  │    syntheticResult } │   │                         │
  │  { outcome:          │   │                         │
  │    'precondition_    │   │                         │
  │    failed',          │   │                         │
  │    syntheticResult } │   │                         │
  └──────────────────────┘   └─────────────────────────┘
                   │
                   ▼
  ┌────────────────────────────────────────────────────┐
  │  src/sdk/QueryEngine.ts :: submitPrompt            │
  │                                                    │
  │  config.auditWriter ?? createAuditWriter()  ← DI   │
  │  for await (event of gen) {                        │
  │    this.auditWriter.write(event)   ← tee           │
  │    yield event                      ← to CLI       │
  │  }                                                 │
  │                                                    │
  │  forkSubagent(…, auditWriter: this.auditWriter)    │
  └────────────────┬───────────────────────┬───────────┘
                   │                       │
                   │         ┌─────────────┴───────────┐
                   │         │ src/agents/runAgent.ts  │
                   │         │ tees using the passed-  │
                   │         │ in auditWriter (single  │
                   │         │ shared log)             │
                   │         └─────────────────────────┘
                   ▼
  ┌──────────────────────┐    ┌────────────────────────┐
  │ src/audit/           │    │ src/cli.ts             │
  │   auditLog.ts  NEW   │    │ existing consumer —    │
  │   redactOnWrite      │    │ unchanged except for   │
  │   check-before-apnd  │    │ renamed 'compact' case │
  │   rotate at 10MB     │    │                        │
  │   keep last 5        │    │                        │
  └────────┬─────────────┘    └────────────────────────┘
           │
           ▼
  ~/.ultron/audit.jsonl
  ~/.ultron/audit.jsonl.1 … .5   (rotated)
```

Data flow: the query loop drives two deps functions back-to-back — `authorizeToolUse` first (returning one of three outcomes, with a pre-built synthetic `ToolResult` on the non-authorized paths) then `executeToolUse` only if authorized. The three-way outcome distinguishes *policy* failures (`denied` — engine said no, user said deny/abort) from *precondition* failures (`precondition_failed` — tool not found, validation failed, or pre-authorization abort); the loop emits `permission_decision` **only** for policy outcomes so the audit log never conflates bad input or Ctrl-C with a deny. The split also makes `permission_decision → tool_call_started → tool_call_finished` ordering a type-level guarantee, not a buffer-draining convention. The SDK tees the stream with a DI-injectable `AuditWriter`; the same writer is threaded into subagent forks as `auditWriter.withOrigin(subagentId)` so all audit events land in one `~/.ultron/audit.jsonl` with per-origin provenance on each line.

---

## Core Types & Interfaces

### New `QueryEvent` variants (`src/core/queryEvents.ts`)

Add four variants. Keep every existing variant. Update the documentation state-machine comment.

```ts
export type PermissionDecisionEvent = {
  readonly type: 'permission_decision'
  readonly toolUseId: ToolUseId
  readonly toolName: string
  readonly input: Record<string, unknown>          // raw; redaction applied at audit write
  readonly decision: 'allow' | 'deny' | 'ask'
  readonly reason: string                          // formatDecisionMessage output
  readonly userResponse?: 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'
  readonly ruleCreated?: PermissionRule
  readonly timestamp: number
}

export type ToolCallStartedEvent = {
  readonly type: 'tool_call_started'
  readonly toolUseId: ToolUseId
  readonly toolName: string
  readonly input: Record<string, unknown>          // raw; redacted at audit write
  readonly timestamp: number
}

export type ToolCallFinishedEvent = {
  readonly type: 'tool_call_finished'
  readonly toolUseId: ToolUseId
  readonly toolName: string
  // 'denied' is NOT a valid tool_call_finished outcome — the loop short-circuits
  // denies at permission_decision, so a finish event for a denied call is never
  // emitted. 'aborted' means the tool itself aborted during execution (not a
  // pre-authorization abort, which surfaces as precondition_failed → tool_result).
  readonly outcome: 'ok' | 'error' | 'aborted'
  readonly errorKind?: ToolErrorKind               // re-use existing type from toolExecution
  readonly durationMs: number
  readonly resultPreview: string                   // 200-char slice, redacted at write
  readonly timestamp: number
}

export type CompactionStartedEvent = {
  readonly type: 'compaction_started'
  readonly trigger: 'pre_request' | 'post_turn' | 'prompt_too_long_recovery'
  readonly messagesBefore: number
  readonly timestamp: number
}

export type CompactionFinishedEvent = {
  readonly type: 'compaction_finished'
  readonly outcome: 'ok' | 'error'
  readonly messagesBefore: number
  readonly messagesAfter: number                   // equals before on error
  readonly errorMessage?: string
  readonly durationMs: number
  readonly timestamp: number
}
```

**Retire** the existing `CompactEvent` (`type: 'compact'`). `compaction_finished` is its strict superset. Every site emitting `{ type: 'compact', … }` is replaced by a `compaction_started` / `compaction_finished` pair. This closes the failure-visibility gap (today's `catch {}` blocks at query.ts:85, 135, 199, 335 swallow compaction failures silently).

**Keep** `tool_use_start` but narrow its emission to streaming only — the execution-boundary emission at `query.ts:249` is retired; execution-boundary signaling moves to `tool_call_started`. Semantic split: `tool_use_start` means *"the model is announcing a tool_use block during SSE"* (early UX badge), `tool_call_started` / `tool_call_finished` mean *"we are about to / have finished executing it"*. The CLI badge (`cli.ts` consumer) keeps working because `tool_use_start` still fires from `streamModelResponse` at `query.ts:404`.

### `ToolResult` widening (`src/core/tools/types.ts`)

Add `errorKind` so the query loop can derive `ToolCallFinishedEvent.outcome` without parsing the human-readable message.

```ts
export type ToolResult = {
  readonly content: string
  readonly isError: boolean
  readonly errorKind?: ToolErrorKind   // populated when isError; 'ToolErrorKind' is the
                                       // existing union from src/core/tools/toolExecution.ts
}
```

`makeErrorResult(kind, msg)` and `makeAbortResult()` in `src/core/tools/toolExecution.ts` are updated to populate `errorKind`. Existing callers keep working — the field is additive.

### Deps split: `authorizeToolUse` + `executeToolUse` (`src/core/queryDeps.ts`)

Retire `RunToolFn`. Introduce two deps with a three-way authorize outcome that distinguishes *policy* results from *precondition* failures:

```ts
export type AuthorizeDecisionPayload = {
  readonly decision: 'allow' | 'deny' | 'ask'
  readonly reason: string
  readonly userResponse?: 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'
  readonly ruleCreated?: PermissionRule
}

export type AuthorizeToolOutcome =
  // Policy: proceed to execute.
  | {
      readonly outcome: 'authorized'
      readonly decision: AuthorizeDecisionPayload
    }
  // Policy: engine or user said no. Emit permission_decision(deny) on the stream.
  | {
      readonly outcome: 'denied'
      readonly decision: AuthorizeDecisionPayload
      readonly syntheticResult: ToolResult   // permission_denied or aborted (user)
    }
  // Non-policy failure: tool_not_found, validation_failed, or pre-auth abort.
  // NOT a permission decision — the caller must NOT emit permission_decision
  // for this path, only the tool_result carrying the synthetic error.
  | {
      readonly outcome: 'precondition_failed'
      readonly syntheticResult: ToolResult
    }

export type QueryDeps = {
  // ...existing fields except runTool...
  readonly authorizeToolUse: (toolUse: ToolUseBlock, signal: AbortSignal) => Promise<AuthorizeToolOutcome>
  readonly executeToolUse:   (toolUse: ToolUseBlock, signal: AbortSignal) => Promise<ToolResult>
}
```

`runToolUse.ts` is split into two exports of the same names; the production `QueryDeps` from `productionDeps()` binds them against the tool registry + permission engine + `askUser` callback. Tests can override either half. The split is the *interface* the query loop drives; the existing pipeline (resolve → validate → permission check → execute) stays intact inside `authorizeToolUse` (resolve/validate/permissions) and `executeToolUse` (the `tool.call` catch). The **outcome classification** is the load-bearing detail: the first three pipeline stages (resolve/validate/pre-permission abort) return `precondition_failed`; only the permission-engine and user-ask branches return `denied`.

### `PermissionOptions` change (`src/core/permissions/types.ts`)

```ts
export type PermissionOptions = {
  // ...existing fields...
  // `logDecision` is removed — decisions surface via the query loop now.
}
```

The `logDecision` callback is removed entirely. It never served any purpose besides the `permissions.jsonl` append, which is also being retired. Back-compat with any external caller using the type is not a concern — `PermissionOptions` is not exported beyond `src/core/`.

### `AuditWriter` (`src/audit/types.ts`, new)

```ts
export type AuditWriter = {
  readonly write: (event: QueryEvent) => void     // fire-and-forget, never throws
  readonly close: () => Promise<void>             // drains in-flight writes
  /**
   * Returns a handle that shares this writer's underlying chain + byte
   * accounting but stamps every envelope with the given `origin` tag. Used
   * to mark subagent provenance when multiple query loops share one audit
   * file. The returned handle is NOT chainable — the derived handle throws
   * on `.withOrigin()`.
   */
  readonly withOrigin: (origin: string) => AuditWriter
}

export type AuditWriterOptions = {
  readonly dir?: string          // default: ~/.ultron
  readonly maxBytes?: number     // default 10 * 1024 * 1024
  readonly keep?: number         // default 5 generations
}
```

### `QueryEngineConfig` DI seam (`src/sdk/QueryEngine.ts`)

```ts
export type QueryEngineConfig = {
  // ...existing fields...
  readonly auditWriter?: AuditWriter    // NEW — if omitted, engine constructs a default
}
```

The engine constructor uses `config.auditWriter ?? createAuditWriter()`. Tests pass an in-memory writer or one pointed at a tmp dir; no production path hits `~/.ultron` unless the caller accepts the default. Subagent forks receive the parent's `auditWriter` via `SubagentOptions.auditWriter` (new field), so every event — top-level or forked — is observed by the same writer and written to the same log.

### Unchanged

- `ProviderId`, `ProviderAdapter`, `CapabilitySheet`, `ModelEntry`, `Terminal`, `QueryParams`, `RawStreamEvent`, `ApiResponseMeta`, `ToolUseContext`.
- The tool registry and `Tool` interface. The split happens at the deps seam (`QueryDeps`), not at the tool definition. Each individual tool's `validateInput` / `checkPermissions` / `call` methods keep their current signatures.

---

## Implementation Details

### `queryEvents.ts` — variants + factories

Add named factory functions for each new variant so construction is type-checked in one place:

```ts
export function makePermissionDecisionEvent(
  toolUse: ToolUseBlock,
  decision: 'allow' | 'deny' | 'ask',
  reason: string,
  extra?: { userResponse?: …; ruleCreated?: PermissionRule },
): PermissionDecisionEvent

export function makeToolCallStartedEvent(toolUse: ToolUseBlock): ToolCallStartedEvent

export function makeToolCallFinishedEvent(
  toolUse: ToolUseBlock,
  result: ToolResult,
  durationMs: number,
): ToolCallFinishedEvent

export function makeCompactionStartedEvent(
  trigger: CompactionStartedEvent['trigger'],
  messagesBefore: number,
): CompactionStartedEvent

export function makeCompactionFinishedEvent(
  messagesBefore: number,
  messagesAfter: number,
  durationMs: number,
  error?: Error,
): CompactionFinishedEvent
```

`makeToolCallFinishedEvent` derives `outcome` from `result.isError` plus the `errorKind` tag already produced by `makeErrorResult` / `makeAbortResult` in `toolExecution.ts`. `resultPreview` is `result.content.slice(0, 200)`.

### Query loop wiring (`src/core/query.ts`)

Four compaction sites (lines 71–89, 121–144, 186–208, 315–338) all follow the same pattern. Replace:

```ts
// before
try {
  const messagesBefore = state.messages.length
  const compacted = await deps.compact([...state.messages])
  yield { type: 'compact', messagesBefore, messagesAfter: compacted.length }
  …
} catch {
  // swallow
}

// after
const messagesBefore = state.messages.length
const started = Date.now()
yield makeCompactionStartedEvent('pre_request', messagesBefore)
try {
  const compacted = await deps.compact([...state.messages])
  yield makeCompactionFinishedEvent(messagesBefore, compacted.length, Date.now() - started)
  …
} catch (err) {
  yield makeCompactionFinishedEvent(
    messagesBefore,
    messagesBefore,
    Date.now() - started,
    err instanceof Error ? err : new Error(String(err)),
  )
}
```

Trigger labels per site:
- Line 74 → `'pre_request'`
- Line 124 → `'prompt_too_long_recovery'`
- Line 188 → `'prompt_too_long_recovery'`
- Line 320 → `'post_turn'`

Tool execution loop at `query.ts:246–259`:

```ts
for (const toolUse of toolUseBlocks) {
  if (signal.aborted) break

  // Phase 1 — authorize (resolve + validate + permissions + askUser).
  const auth = await deps.authorizeToolUse(toolUse, signal)

  // permission_decision is ONLY a policy event — emit it for actual permission
  // outcomes (authorized or denied). Precondition failures (tool_not_found,
  // validation, pre-auth abort) are NOT policy decisions; they surface as a
  // tool_result only.
  if (auth.outcome === 'authorized' || auth.outcome === 'denied') {
    yield makePermissionDecisionEvent(
      toolUse,
      auth.decision.decision,
      auth.decision.reason,
      { userResponse: auth.decision.userResponse, ruleCreated: auth.decision.ruleCreated },
    )
  }

  if (auth.outcome !== 'authorized') {
    const resultMessage = createToolResultMessage(toolUse, auth.syntheticResult, deps.uuid())
    toolResults.push(resultMessage)
    yield { type: 'tool_result', message: resultMessage }
    continue   // skip tool_call_started / tool_call_finished entirely
  }

  // Phase 2 — execute (tool.call only)
  const started = Date.now()
  yield makeToolCallStartedEvent(toolUse)
  const result = await deps.executeToolUse(toolUse, signal)
  const durationMs = Date.now() - started
  const resultMessage = createToolResultMessage(toolUse, result, deps.uuid())
  toolResults.push(resultMessage)

  yield makeToolCallFinishedEvent(toolUse, result, durationMs)
  yield { type: 'tool_result', message: resultMessage }
}
```

The existing `tool_use_start` emission at line 249 is **removed** (the streaming-side emission at line 404 carries the "model announced a tool_use" signal; execution is the new `tool_call_started`).

**Ordering is enforced by the type.** `authorizeToolUse` returns before `executeToolUse` is called, so authorized calls emit `permission_decision → tool_call_started → tool_call_finished`. On `denied`, only `permission_decision → tool_result` is emitted. On `precondition_failed`, only `tool_result` is emitted — no permission event fires at all. No buffer, no drain, no synchronous-callback dance.

### `runToolUse.ts` split (`src/core/tools/runToolUse.ts`)

The current single `runToolUse(toolUse, context, signal, permissionOpts)` becomes two functions in the same file:

```ts
export async function authorizeToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
  permissionOpts: PermissionOptions = DEFAULT_PERMISSION_OPTIONS,
): Promise<AuthorizeToolOutcome>

export async function executeToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
): Promise<ToolResult>
```

- `authorizeToolUse` does the current pipeline through line 106: resolve → abort check → validate → abort check → permissions (engine) → abort check → (if ask) askUser. The outcome classification is deliberate:
  - **`authorized`** — permission engine returned `allow`, or the user responded `allow_once` / `allow_by_rule` to an `ask`.
  - **`denied`** — permission engine returned `deny`, or the user responded `deny_once` / `abort` to an `ask`, or a headless ask happened without an `askUser` callback. These are actual policy outcomes — the loop emits `permission_decision(deny)` for them.
  - **`precondition_failed`** — tool not found, validation failed, validator threw, or either of the two pre-permission abort checks fired. These are NOT policy decisions and must not be conflated with denies; `authorizeToolUse` returns `{outcome: 'precondition_failed', syntheticResult}` with no `decision` field, and the loop skips the `permission_decision` emission entirely for this path.

  The `decision` field on `authorized` / `denied` outcomes collects the same fields that used to go into `PermissionLogEntry`: `{decision, reason, userResponse?, ruleCreated?}`.
- `executeToolUse` does only the tool.call step at current line 114 plus the `execution_error` catch. It assumes the caller has already authorized. If the tool is mid-execution when abort fires, the existing behavior (tool handles its own signal) is unchanged; on synchronous abort before call, returns `makeAbortResult()`.

The production `QueryDeps.authorizeToolUse` / `.executeToolUse` in `productionDeps()` simply close over the tool registry / app state / askUser callback and delegate to these two functions.

`summarizeInput` at `logging.ts:41` and the 120-char truncation are retired. The audit log captures full input (redacted).

### Audit writer (`src/audit/auditLog.ts`, new)

```ts
export function createAuditWriter(opts: AuditWriterOptions = {}): AuditWriter {
  const dir = opts.dir ?? join(homedir(), '.ultron')
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024
  const keep = opts.keep ?? 5
  const file = join(dir, 'audit.jsonl')

  // The chain MUST stay resolved so write()'s .then handler always runs.
  // A rejected seed would cause every subsequent .then(successHandler) to
  // skip the handler — no try/catch would ever fire, no stderr warn would
  // ever emit, and close() would reject. Seed with Promise.resolve() and
  // do the mkdir lazily inside each write's try/catch so transient failures
  // can recover on later writes.
  let dirEnsured = false
  let chain: Promise<void> = Promise.resolve()
  let currentBytes: number | undefined
  let consecutiveFailures = 0

  function write(event: QueryEvent, origin?: string): void {
    if (!SHOULD_AUDIT.has(event.type)) return
    chain = chain.then(async () => {
      try {
        if (!dirEnsured) {
          await mkdir(dir, { recursive: true })
          dirEnsured = true
        }
        if (currentBytes === undefined) {
          currentBytes = await statSize(file)
        }
        const line = serialize(event, origin)            // adds schemaVersion, tsIso, origin?
        const lineBytes = Buffer.byteLength(line, 'utf8')

        // Check BEFORE append. If appending this line would cross the cap,
        // rotate first so the triggering line lands in the fresh file.
        if (currentBytes + lineBytes > maxBytes) {
          await rotate(file, keep)
          currentBytes = 0
        }

        await appendFile(file, line)
        currentBytes += lineBytes
        consecutiveFailures = 0
      } catch (err) {
        consecutiveFailures++
        if (consecutiveFailures <= 3) {
          process.stderr.write(`Warning: audit write failed: ${errMsg(err)}\n`)
        }
        // After 3 failures, stay silent but keep trying — a transient disk-full
        // or perms issue should recover without user intervention.
      }
    })
  }

  function close(): Promise<void> { return chain }

  function withOrigin(origin: string): AuditWriter {
    // Shares the same chain + currentBytes accounting; only the origin tag differs.
    // Not chainable: derived handles throw on nested withOrigin.
    return {
      write: (event) => write(event, origin),
      close,
      withOrigin: () => {
        throw new Error('withOrigin does not support chaining; derive from the root writer')
      },
    }
  }

  return { write: (event) => write(event), close, withOrigin }
}
```

**Included in audit** (`SHOULD_AUDIT`): `request_start`, `turn`, `error`, `permission_decision`, `tool_call_started`, `tool_call_finished`, `tool_result`, `attachment`, `compaction_started`, `compaction_finished`.

**Excluded**: `text_delta`, `thinking_delta`, `tool_use_start`. Rationale — deltas are per-token noise that defeats the "structured" audit goal and balloons size; `tool_use_start` is redundant with `tool_call_started`. The full assembled assistant message is captured in `turn`.

**Rotation (check-before-append).** Before writing a line, if `currentBytes + lineBytes >= maxBytes`, rotate first and then append. The triggering line lands in the new `audit.jsonl`, not in `.1`. The rotation rename runs inside the same promise-chain step so no interleaved append races it:

```
audit.jsonl.4  → audit.jsonl.5   (existing audit.jsonl.5 is unlinked first)
audit.jsonl.3  → audit.jsonl.4
audit.jsonl.2  → audit.jsonl.3
audit.jsonl.1  → audit.jsonl.2
audit.jsonl    → audit.jsonl.1
# currentBytes = 0; next append re-creates audit.jsonl with the triggering line
```

Byte-size accounting is process-local (re-`stat`-ed on first write). Crashes mid-write leave `currentBytes` stale; on next process start we re-`stat`. Acceptable because Ultron is single-user-single-process by design (v2-scope.md:78).

**Never throws.** Every I/O call is try/caught; `write()` returns `void` synchronously (the actual work lands on the chain). `close()` is provided for graceful shutdown tests; production code does not call it (process exit is the signal).

### Redaction helper (`src/memory/redact.ts`, new)

```ts
export function redactString(s: string): string {
  const matches = detectSecrets(s)
  if (matches.length === 0) return s
  // Walk in reverse so earlier indices stay valid during replacement
  const sorted = [...matches].sort((a, b) => b.index - a.index)
  let out = s
  for (const m of sorted) {
    out = out.slice(0, m.index) + `[REDACTED:${m.type}]` + out.slice(m.index + m.length)
  }
  return out
}

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[REDACTED:depth]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(v => redactSecrets(v, depth + 1))
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecrets(v, depth + 1)
    }
    return out
  }
  if (value instanceof Error) return { message: redactString(value.message), name: value.name }
  return value
}
```

`detectSecrets` today returns `{type, confidence, index}` (see `src/memory/secretScanner.ts`); **extend it** to also include `length`. One-liner: populate from the matching regex's `match[0].length`. No existing caller breaks (the field is additive).

Redaction is applied **at audit-write time only**, inside `auditLog.ts` before `JSON.stringify`. The in-memory `QueryEvent` stream keeps raw data so future 2b hooks can inspect it for policy decisions.

### SDK wiring (`src/sdk/QueryEngine.ts`)

Construction — DI-injectable writer with a sane default:

```ts
// In the constructor:
this.auditWriter = config.auditWriter ?? createAuditWriter()
```

Tests inject their own writer (usually pointed at a temp dir via `AuditWriterOptions.dir`, or an in-memory fake that collects lines into an array). Production callers omit the field and get the `~/.ultron/audit.jsonl` default.

In `submitPrompt` (around current line 360 — the `for await` loop over the query generator):

```ts
for await (const event of gen) {
  this.auditWriter.write(event)
  yield event
}
```

One line change. The tee is observationally invisible to the CLI.

### Subagent wiring (`src/agents/runAgent.ts`)

Today `createForkSubagent` runs `query(...)` directly (around line 143) and yields events back to the parent — bypassing any engine-level tee. For Phase 2a, thread the writer through and tag every line with the subagent id via `withOrigin`:

```ts
export type SubagentOptions = {
  // ...existing fields...
  readonly auditWriter: AuditWriter   // required — parent's writer
}

// In the fork body, immediately before the event-consumption loop:
const forkWriter = opts.auditWriter.withOrigin(subagentId)

// In the event-consumption loop:
for await (const event of gen) {
  forkWriter.write(event)             // stamps `origin: <subagentId>` on disk
  // ...existing per-event handling...
}
```

The engine passes `this.auditWriter` into every `forkSubagent` call it builds. The parent and all subagents share one writer and one `audit.jsonl`, which is the right shape for a single-user-single-process tool — nested tool calls and compaction events from subagent forks interleave naturally into the parent log. Subagent-originated lines carry `origin: <subagentId>` in the envelope; parent lines omit the field. No subagent-scoped log file is created in 2a.

`withOrigin` returns a handle sharing the root writer's promise chain and byte accounting, so ordering and rotation stay consistent across interleaved parent / fork writes. The derived handle is not chainable — a subagent calling `.withOrigin()` on its own writer throws; today's registry forbids nested subagents anyway (`AGENT_TOOL_NAME` is excluded from the forked registry), so one level of tagging is sufficient.

`authorizeToolUse` / `executeToolUse` run inside the subagent's own `query()` just like in the top-level loop, so the ordering invariants hold identically.

### CLI compatibility (`src/cli.ts`)

One cosmetic change: the `case 'compact'` branch in the event-dispatch switch (around line 167) becomes `case 'compaction_finished'`. The new `compaction_started` variant gets no UI (it would be visual noise; the existing message showed only the delta). New `permission_decision`, `tool_call_started`, `tool_call_finished` variants are deliberately not rendered in the CLI — they flow to the audit log but stay invisible in the interactive display. 2b may add a verbose-mode renderer.

Add a `default: const _: never = event` branch to force compile-time exhaustiveness when future variants land.

### Permission log retirement

`src/core/permissions/logging.ts` is deleted. The `PermissionLogEntry` type moves to `src/audit/types.ts` (back-compat re-export for anyone importing it). `summarizeInput` is dropped entirely — the audit log captures full input with redaction; the 120-char summary was only meaningful given an un-redacted channel.

`createPermissionLogger` is removed. The `logDecision` field on `PermissionOptions` is removed. Every decision now flows through `authorizeToolUse`'s return value into `permission_decision` events on the stream, and from there to the audit writer.

Migration for existing users: `~/.ultron/permissions.jsonl` is left in place (no deletion of user data). A single stderr notice on first `QueryEngine` construction per process: *"Note: permissions.jsonl is deprecated; new decisions recorded in audit.jsonl"*. The notice is dropped in a later phase.

---

## File Map

| File | Responsibility | Change |
|------|----------------|--------|
| `docs/ultron_v2/phase2a-v2-design.md` | This doc | **New** |
| `src/core/queryEvents.ts` | Add 4 new variants (`permission_decision`, `tool_call_started`, `tool_call_finished`, `compaction_started`, `compaction_finished`), retire `CompactEvent`, update state-machine comment | Modified |
| `src/core/queryEventFactories.ts` | Factory functions for all new variants | **New** |
| `src/core/queryEvents.test.ts` | Factory shape + outcome-derivation tests | **New** |
| `src/core/query.ts` | Drive two-phase tool execution (`authorizeToolUse` → `executeToolUse`); retire line-249 `tool_use_start`; wrap 4 compaction sites with start/finish pair | Modified |
| `src/core/queryDeps.ts` | Retire `RunToolFn`; add `authorizeToolUse` / `executeToolUse` to `QueryDeps`; stub the two halves for tests | Modified |
| `src/core/queryTypes.ts` | No change today; kept in map so future reviewers can confirm | Unchanged |
| `src/core/tools/runToolUse.ts` | Split the single function into `authorizeToolUse` (resolve+validate+permissions+askUser) and `executeToolUse` (tool.call); drop `summarizeInput` import | Modified |
| `src/core/tools/types.ts` | Add `errorKind?: ToolErrorKind` to `ToolResult` | Modified |
| `src/core/tools/toolExecution.ts` | Populate `errorKind` in `makeErrorResult` / `makeAbortResult` | Modified |
| `src/core/permissions/types.ts` | Remove `logDecision` from `PermissionOptions`; remove `LogPermissionDecisionFn` export | Modified |
| `src/core/permissions/logging.ts` | **Delete** (`PermissionLogEntry` type moves to `src/audit/types.ts` for back-compat of any external importers) | Deleted |
| `src/audit/types.ts` | `AuditWriter`, `AuditWriterOptions`, `PermissionLogEntry` (moved) | **New** |
| `src/audit/auditLog.ts` | `createAuditWriter`; check-before-append rotation, filter, error-handling | **New** |
| `src/audit/auditLog.test.ts` | Filter, rotation, never-throws, redaction integration, DI-dir used not `~/.ultron` | **New** |
| `src/memory/redact.ts` | `redactString`, `redactSecrets` | **New** |
| `src/memory/redact.test.ts` | Nested object walk, all secret kinds, depth cap | **New** |
| `src/memory/secretScanner.ts` | Add `length` to `SecretMatch`; populate in every pattern | Modified |
| `src/sdk/QueryEngine.ts` | Accept `auditWriter?` in `QueryEngineConfig` with default; tee events in `submitPrompt`; thread writer into `forkSubagent` | Modified |
| `src/agents/runAgent.ts` | Accept `auditWriter` on `SubagentOptions`; tee events inside the fork's event loop | Modified |
| `src/agents/runAgent.test.ts` | Assert subagent events land on the parent-injected writer | Modified |
| `src/cli.ts` | Rename `case 'compact'` → `case 'compaction_finished'`; add exhaustiveness `default: never` | Modified |
| `tests/integration/auditSpine.test.ts` | End-to-end with temp `auditWriter`: tool_use turn, rotation at 12MB, no `~/.ultron` writes | **New** |
| existing tests referencing `compact` event / `deps.runTool` | Update assertions to `compaction_finished`; update stubs to the two-function split | Modified |

---

## Downstream Consumers

- **Phase 2b (user-configurable hooks).** Plugs into the same event stream via a new `onEvent(handler)` subscription API on `QueryEngine`. Hooks fire on `tool_call_started` (pre), `tool_call_finished` (post), and `permission_decision` (policy layer). Hook return values that mutate input require a small change to `runToolUse.ts`; 2a does not pre-design that interface — 2b owns it.
- **Phase 7 (subagents).** Adds `subagent_started` / `subagent_finished` variants and propagates the subagent's own events through its fork's audit writer; the parent's audit log can optionally annotate nested events with a `subagentId`. 2a's `_permissionEventBuffer` living on `ToolUseContext` already scopes naturally per subagent.
- **Phase 8a (hierarchical compaction).** The `compaction_started` / `compaction_finished` boundary is exactly what a per-turn summarizer needs to tag intermediate summaries; 2a's events can be observed by a future compaction supervisor without re-instrumenting `query.ts`.

No 2a consumer branches on `providerId`; the event stream is provider-agnostic.

---

## Verification Criteria

### Typecheck (substrate half)

1. `npm run typecheck` passes. The new variants force exhaustiveness in every `switch (event.type)` — `cli.ts` and the audit filter both get explicit `default: never` branches. Any missed site is a compile error.

### Event factories (`queryEvents.test.ts`)

2. Each factory produces the declared shape; all required fields populated.
3. `makeToolCallFinishedEvent` derives `outcome`: `'aborted'` for `errorKind === 'aborted'`, `'ok'` when `!isError`, `'error'` otherwise. A `permission_denied` errorKind collapses to `'error'` (defensive only — the loop never emits `tool_call_finished` for denies in practice).
4. `resultPreview` is exactly 200 chars or shorter — no truncation marker, no re-encoding.

### Redaction (`redact.test.ts`)

5. `redactString('AKIAIOSFODNN7EXAMPLE')` → `'[REDACTED:aws_access_key_id]'` (or equivalent kind string).
6. Anthropic (`sk-ant-…`), OpenAI (`sk-…`), GitHub token (`ghp_…`), PEM header, and generic `password="foo"` assignment all redacted.
7. Nested object walk: `{foo: {bar: [{baz: 'AKIA…'}]}}` → secret replaced at depth 3.
8. Depth cap: object nested 17 levels returns `'[REDACTED:depth]'` at the over-depth layer, not a stack overflow.
9. Redaction is **additive-safe**: objects whose values are `null`, `undefined`, numbers, booleans pass through unchanged.

### Deps split (`runToolUse.test.ts`)

10. `authorizeToolUse` on allow → `{outcome: 'authorized', decision: {decision: 'allow', ...}}`; no `syntheticResult` field present.
11. `authorizeToolUse` on engine deny → `{outcome: 'denied', decision: {decision: 'deny', ...}, syntheticResult: {isError: true, errorKind: 'permission_denied'}}`. The `ToolResult` is ready-to-use by the loop; no parsing needed.
12. `authorizeToolUse` on ask + user `allow_once` → `outcome: 'authorized'`, `decision.userResponse === 'allow_once'`.
13. `authorizeToolUse` on ask + user `deny_once` → `outcome: 'denied'`, `syntheticResult.errorKind === 'permission_denied'`.
14. `authorizeToolUse` on ask + user `abort` → `outcome: 'denied'`, `syntheticResult.errorKind === 'aborted'`.
15. `authorizeToolUse` on unknown tool → `{outcome: 'precondition_failed', syntheticResult: {errorKind: 'tool_not_found'}}`. No `decision` field. Same shape for `validation_failed` and pre-authorization aborts.
16. `executeToolUse` is a pure `tool.call` wrapper: no permission check, no validation. If called without prior authorization it still runs — the loop is the only thing that gates it. (This is why 2b hooks will ride on top.)
17. `ToolResult.errorKind` is populated on every error path from `makeErrorResult` / `makeAbortResult`.

### Audit log (`auditLog.test.ts`)

17. Writer honors `AuditWriterOptions.dir`: all writes go there, nothing touches `~/.ultron`.
18. Every JSONL line parses as JSON; each line has `schemaVersion: 1` and `tsIso` ISO-8601.
19. Filter: `write({type: 'text_delta', ...})` produces no disk write; `write({type: 'tool_call_started', ...})` produces exactly one line.
20. **Check-before-append rotation.** Seed `audit.jsonl` with ~9.99MB. Queue one line that would cross `maxBytes`; assert (a) `audit.jsonl.1` contains the pre-rotation content, (b) `audit.jsonl` contains exactly that triggering line, (c) `currentBytes === lineBytes` after.
21. Rotation across generations: 30MB of writes produce exactly `audit.jsonl{,,.1,.2,.3,.4,.5}`; `.5` is the oldest; no `.6`.
22. **Secret redaction on disk.** Construct a `tool_call_started` event whose `input` contains `AKIA…`; observe the raw event in-memory (secret present); then read the on-disk JSONL line (`[REDACTED:aws_access_key_id]` present, raw secret absent).
23. **Never-throws on I/O failure.** Point the writer at a path whose parent is a regular file (ENOTDIR on mkdir); `write()` must not throw, `close()` must resolve (not reject), and stderr must emit at least one but at most three `audit write failed` warnings. This exercises the seed-chain-recovery invariant: a rejected initial mkdir cannot poison the promise chain.

### Writer decorator (`auditLog.test.ts`)

24. `withOrigin(tag)` stamps the serialized envelope with `origin: <tag>`.
25. Parent + derived writer share the same chain and file: interleaved writes land in order in a single `audit.jsonl`, with only the tagged lines carrying `origin`.
26. Derived handle is not chainable: calling `.withOrigin()` on a derived handle throws.

### Pair-ordering invariants (query loop)

27. On auto-allow: loop emits `permission_decision('allow') → tool_call_started → tool_call_finished → tool_result` with matching `toolUseId`.
28. On `denied`: loop emits `permission_decision('deny') → tool_result` only. No `tool_call_started` and no `tool_call_finished` are observable on the stream.
29. On `precondition_failed`: loop emits `tool_result` only. **No `permission_decision`** fires — validation or pre-auth abort must not be recorded as a policy decision. Tested by capturing the stream and asserting `permission_decision` is absent for the specific `toolUseId`.
30. Every `tool_call_started` is followed by exactly one `tool_call_finished` with matching `toolUseId`; `durationMs >= 0`.
31. Every `compaction_started` is followed by exactly one `compaction_finished` with matching `messagesBefore`. Covers both success and catch paths.

### Redaction (`redact.test.ts`)

32. `redactString('AKIAIOSFODNN7EXAMPLE')` → `'[REDACTED:aws_access_key_id]'` (or matching kind string).
33. Anthropic (`sk-ant-…`), OpenAI (`sk-…`), GitHub token (`ghp_…`), PEM header, and generic `password="foo"` assignment all redacted.
34. Nested object walk: `{foo: {bar: [{baz: 'AKIA…'}]}}` → secret replaced at depth 3.
35. Depth cap: object nested 17 levels returns `'[REDACTED:depth]'` at the over-depth layer, not a stack overflow.
36. Objects whose values are `null`, `undefined`, numbers, booleans pass through unchanged.

### Subagent

37. `runAgent.test.ts`: a fork created via `createForkSubagent(..., {auditWriter: captured})` routes its own `tool_call_started` / `tool_call_finished` events through `captured.write`, and every captured event carries the subagent id in its `origin` marker.

### Integration (`tests/integration/auditSpine.test.ts`)

38. End-to-end: scripted `callModel` emits one tool_use; `QueryEngine` constructed with `config.auditWriter = createAuditWriter({dir: tmpDir})`; drive submitPrompt to completion. Assert `${tmpDir}/audit.jsonl` contains in order: `request_start`, `turn`, `permission_decision`, `tool_call_started`, `tool_result`, `tool_call_finished`. (`text_delta` and `tool_use_start` absent by filter.) Also assert `~/.ultron` was not touched during the test.
39. End-to-end deny path: model requests a tool whose permission engine returns `deny`; audit log contains `permission_decision(decision=deny)` followed directly by `tool_result(isError=true)`. No `tool_call_started` / `tool_call_finished` appear anywhere on disk.
40. End-to-end precondition-failed path: `authorizeToolUse` returns `{outcome: 'precondition_failed', syntheticResult}`; audit log contains the `tool_result` but NOT `permission_decision`, `tool_call_started`, or `tool_call_finished`.
41. Real-I/O rotation: feed 12MB of synthetic events through a live writer; `audit.jsonl` < 10MB at end; `audit.jsonl.1` exists; triggering-line presence in new (not rotated) file.

### No regressions

42. `npm run test` — all pre-existing tests pass after the `compact` → `compaction_finished` rename and the `deps.runTool` → `deps.authorizeToolUse` / `deps.executeToolUse` stub updates (mechanical fan-out in `queryDeps.ts` stubs + tests that touch them).

---

## Out of Scope (Hard Gate)

- **User-configurable pre/post tool hooks.** Phase 2b.
- **Subagent lifecycle events** (`subagent_started`, `subagent_finished`). Phase 7 per v2-scope.md.
- **UX for querying/filtering the audit log** — no `ultron audit` subcommand, no tail-follow, no TUI viewer.
- **Transcript redaction.** `~/.ultron/sessions/<uuid>/transcript.jsonl` continues to hold raw messages unchanged. Redaction of the session transcript layer is a separate phase; today's transcript is local-only with 0o700 directory perms.
- **Signed / tamper-evident logs, remote shipping, log-level config, structured search indexes.**
- **Hook config surface, shell-command hooks, permission-rule changes.**
- **Adding new tools** — the whole point of landing the spine before widening the tool surface.
- **New UX for thinking-output observability.** Extended-thinking deltas continue to stream only to the CLI; they are intentionally excluded from the audit log (filtered), matching OpenAI/Anthropic convention that reasoning traces are ephemeral.

---

## Deferred Design Decisions

- **Subagent lifecycle events** (`subagent_started`, `subagent_finished`). Phase 7 adds them once the lifecycle itself is richer than "fork query() and run." For 2a, subagent *tool* events already flow into the parent's audit log via the shared writer and carry `origin: <subagentId>` on each line; what's missing is the envelope around the fork itself. Harmless to land later.
- **Schema versioning.** `schemaVersion: 1` is included on every line for future breaking changes. No migration tool ships in 2a; if a breaking change ever lands, it can write `schemaVersion: 2` lines alongside and a parser can switch on the field. Explicit "not worth solving until we need to" call.
- **Metrics / structured query surface.** No indexer, no aggregation. JSONL + `jq` is the query interface for the single-user local-first posture. If that ever isn't enough, phase it in later without breaking the writer.

## Design Refinements from Review

The following decisions were tightened after design review; they are part of the shipped design, noted here so reviewers don't have to diff the history:

- **Three-way authorize outcome** (`authorized | denied | precondition_failed`). An earlier draft collapsed tool_not_found / validation_failed / pre-auth abort into `denied`, which would have made the audit log conflate bad input and Ctrl-C with policy denials. The split keeps `permission_decision` strictly a policy event.
- **`tool_call_finished` outcome narrowed to `'ok' | 'error' | 'aborted'`.** The `'denied'` bucket was dead code — the loop short-circuits denies before `tool_call_started`, so `tool_call_finished` never fires for denials. Aligning the type with runtime prevents confusion for 2b hook consumers.
- **Audit writer seed chain is always resolved.** Seeding the serialized promise chain with `mkdir(...)` directly would poison it on failure: every subsequent `.then(successHandler)` would skip its handler, meaning no writes, no warnings, and a rejected `close()`. The chain seeds with `Promise.resolve()` and the mkdir happens lazily inside each write's try/catch so transient failures can recover.
- **Subagent provenance via `withOrigin`.** Single shared `audit.jsonl` with origin stamping beats separate per-subagent logs for a single-user-single-process tool — nested tool calls interleave naturally while staying attributable.

---

## Risks & Unknowns

1. **Two-function deps ergonomics.** The split `authorizeToolUse` + `executeToolUse` is more surface than the single `runTool`. Tests that previously stubbed `runTool: async () => result` now need to stub both. **Fallback:** provide a `makeStaticToolDeps(result)` helper in `src/core/queryDeps.ts` that returns both halves wired to the same canned result; most test fixtures end up one line shorter, not longer.
2. **Redaction false negatives.** `detectSecrets` is pattern-based; novel key formats slip through. **Fallback:** keep the scanner authoritative, document the guarantee as *best-effort detection of known high-confidence formats*, make `SECRET_PATTERNS` additive. Do not promise zero leakage.
3. **Rotation race on concurrent engine instances.** Two `QueryEngine`s in one user's home both writing to `audit.jsonl` could interleave renames. **Fallback:** use `open('wx')`-style lock file during rotation; on conflict, skip rotation this cycle and retry next write. Acceptable because Ultron is single-user-single-process by design (v2-scope line 78) — this is defense in depth.
4. **Byte-size accounting drift.** `currentBytes` is process-local; mid-write crashes leave it stale. **Fallback:** at each write, if `currentBytes` exceeds `maxBytes * 1.5`, re-`stat` before deciding to rotate (cheap, infrequent).
5. **Event-union exhaustiveness breakage.** Adding variants flips every `switch (event.type)` into a type error. **Fallback:** grep for `QueryEvent` switches during implementation, add `default: const _: never = event` branches so future variants break compile predictably. Current switch sites: `cli.ts:151` and the new audit filter.
6. **Timing clock.** `Date.now()` is wall-clock and can go backwards across NTP corrections; `durationMs` could be negative. **Fallback:** accept — rare enough, and users reading an audit log will not be surprised. Upgrading to `performance.now()` would require a monotonic baseline per process; out of scope.
7. **Shared writer under subagent concurrency.** If Phase 7 ever introduces parallel subagents (v2-scope hints at "parallel fan-out for read-only investigations"), two forks could race on the promise chain inside one `AuditWriter`. **Fallback:** the writer's serialized `chain` already imposes strict ordering — parallel forks simply queue. The ordering is "globally interleaved, per-source monotonic," which is correct for a single shared log.
