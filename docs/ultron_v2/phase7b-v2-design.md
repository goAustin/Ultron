# Phase 7b Design: Parallel Subagent Fan-Out

## Status

Implemented; pending merge. Plan: `~/.claude/plans/now-make-a-plan-hazy-charm.md`. Final test run: 1527 passing (1 skipped) across 106 files; typecheck clean. Pre-implementation baseline was 1506 — Phase 7b adds 21 new tests across `agentTool.test.ts` (+5), `sandboxContext.test.ts` (+5), `runAgent.test.ts` (+3), and a new `tests/integration/queryParallelFanOut.test.ts` (+9, including 3 regression tests for the post-review fixes below). Zero regressions in the 1506 pre-existing tests.

### Post-review fixes (against the first implementation pass)

A code review surfaced three real defects in the initial Phase 7b shipped code. All three are fixed and pinned by regression tests.

1. **Concurrency cap was missing.** The original Phase B used raw `Promise.all` over every authorized concurrency-safe tool. The plan's §5 prescribed `runWithConcurrencyLimit(tasks, DEFAULT_MAX_CONCURRENCY)` (cap = 10). With 8+ read-only tools declaring `isConcurrencySafe` (Agent, FileRead, Glob, Grep, WebFetch, WebSearch, MemoryRead, CodeSandbox), one turn could fan out unboundedly and create avoidable API/network/process bursts. **Fix:** export `DEFAULT_MAX_CONCURRENCY` from `toolOrchestration.ts`; route Phase B through `runWithConcurrencyLimit`. Defensive shape: `runWithConcurrencyLimit` returns `PromiseSettledResult[]`, so any future regression that lets a parallel run reject is converted into an error `ToolResult` rather than dropping a sibling's result.

2. **Abort during Phase A dropped buffered denied/blocked records.** The inner Phase A loop's `if (signal.aborted) break batchLoop` unwound the entire batch loop, leaving the `records` array unprocessed. The bottom-of-loop missing-results emitter then synthesized a generic "Interrupted by user" tool_result for tool_uses that already had a `permission_decision: deny` event emitted live in Phase A — leaving the audit log with mismatched decision + result rows. **Fix:** replace the inner-loop `break batchLoop` with `break` (out of just the inner loop), let Phase B/C drain whatever records are present, then check `signal.aborted` after Phase C and break the outer loop only then.

3. **`tool_call_started` timestamps were captured after execution.** The original Phase C emitted `tool_call_started` *after* `Promise.all` resolved, so its timestamp was later than any `tool_progress` timestamps captured during execution (those fire from inside the tool, on the callback). Audit consumers ordering by timestamp would see `started > progress > finished` for the same tool. **Fix:** emit `tool_call_started` events upfront in input order *before* `Promise.all` for parallel batches. The serial branch is unchanged. Regression test asserts `started.timestamp ≤ progress.timestamp` for every tool in a parallel batch.

### Other deviation from the plan

The "defensive `isReadOnly: false` on write tools (`FileWriteTool`, `FileEditTool`, `BashTool`, `MemoryWrite`, `MemoryEdit`)" entry was dropped during implementation. The assertion in `buildFilteredRegistry` reads `tool.isReadOnly !== true`, which catches both `undefined` and `false` equivalently, so an explicit `false` declaration adds noise without changing observable behavior. Existing tests that assert `expect(FileEditTool.isMutating).toBeUndefined()` would have needed to grow a sibling assertion otherwise. The plan's table parenthetical already noted "default would suffice."

## Context

`v2-scope.md §7` ("Subagents via Agent SDK") names "parallel read-only fan-out" as the deliverable for the subagents pillar. Phase 7a's design doc named the wedge explicitly:

> **7b** can wrap N `createSandboxContext` calls in a `Promise.all` for read-only subagents (no write-capable tools in their `allowedTools`). The factory's pure-construction property — no shared mutable state across calls — makes parallelization free.

Today, when the model emits two `Agent` tool_use blocks in one turn, the parent loop at `src/core/query.ts:247` (`for (const toolUse of toolUseBlocks)`) runs them strictly back-to-back. End-to-end latency for "fan out 5 read-only investigations" is the sum of children, not the slowest child.

The orchestration substrate exists but is dormant. `src/core/tools/toolOrchestration.ts:1-7` opens with:

> Status: infrastructure, not yet wired into query.ts.

`partitionIntoBatches` (`toolOrchestration.ts:42-66`) is pure and reusable. `runWithConcurrencyLimit` (`toolOrchestration.ts:151-177`) implements bounded fan-out via a semaphore. What's missing is the wiring into `query.ts` — and a careful answer to the question "what exactly is the safe-to-parallelize unit?" Naively, the answer is "the whole per-tool body." Correctly, the answer is "only `executeToolUse`."

This phase delivers four things:

1. Generalised parallel fan-out for any concurrency-safe tool (Agent, FileRead, Glob, Grep, WebFetch, WebSearch, MemoryRead, CodeSandbox).
2. A new `Tool.isReadOnly` flag plus a fork-time invariant in `buildFilteredRegistry`, so `AgentTool.isConcurrencySafe = true` is provably correct regardless of `SubagentOptions.allowedTools` configuration.
3. An `AgentTool.call()` semantics tweak: surface subagent terminal errors as `isError: true` instead of swallowing them as fallback text.
4. The threading work (`toolRegistry` onto `QueryDeps`) needed to give the loop access to partition the batch.

## The four load-bearing decisions

### 1. Parallelize only `executeToolUse`. Authorize, hooks, and event emission stay serial

A naive read of "isConcurrencySafe means we can run N copies in parallel" suggests: extract the entire per-tool body of the loop in `query.ts:247-321` (authorize → preHooks → execute → postHooks → emit) into a helper, then run helpers via `Promise.all`. This is wrong, and the failure modes matter:

- **`authorizeToolUse` may call `askUser`** (`src/core/permissions/permissions.ts`). Two parallel tools triggering `askUser` simultaneously means two overlapping permission prompts. The CLI prompt UX is single-threaded — the user can only see and answer one prompt at a time. This is unacceptable as a default.
- **Authorization may persist permission rules.** When the user picks "always allow" in a prompt, the cascade writes to `~/.ultron/permissions.json`. Two concurrent rule writes race; the file format does not support last-write-wins safely.
- **PreToolUse hooks run user-defined shell scripts** (Phase 2b). These can write to disk, mutate environment, send network requests — anything. `isConcurrencySafe` describes the **tool body**; it makes no claim about user-authored hook side effects.
- **PostToolUse hooks** have the same shell-script property and the same risk.

So `isConcurrencySafe` properly describes the `tool.call()` body **only**. The fix is structural: split the per-tool body into three phases per batch and parallelize only the middle one.

```ts
const batches = partitionIntoBatches(toolUseBlocks, deps.toolRegistry)
for (const batch of batches) {
  if (signal.aborted) { /* synthesize abort results, break */ }

  // Phase A — serial: authorize + PreToolUse for every tool in the batch.
  //   Yields permission_decision events live. Tools that fail authorization
  //   or get blocked by PreToolUse produce their tool_result here and drop
  //   out of phase B.
  const authorized: { toolUse, effective }[] = []
  for (const tu of batch.toolUses) {
    const auth = await deps.authorizeToolUse(tu, signal)
    yield ...permission_decision...
    if (auth.outcome !== 'authorized') { push synthetic result; continue }
    const pre = yield* deps.runPreToolUseHooks(tu, signal)
    if (pre.kind === 'block')          { push synthetic result; continue }
    authorized.push({ toolUse: tu, effective: applyPreHookInput(tu, pre) })
  }

  // Phase B — parallel iff this is a concurrent batch with N>1.
  //   Each parallel run captures any tool_progress callbacks into a
  //   per-tool buffer because we can't yield from inside Promise.all.
  let runs: Run[]
  if (batch.concurrent && authorized.length > 1) {
    runs = await Promise.all(
      authorized.map(({ effective }) =>
        runOneExecuteWithBufferedProgress(effective, signal, deps.executeToolUse)
      ),
    )
  } else {
    runs = [] // serial path streams progress live via streamToolUse below
  }

  // Phase C — serial: postHooks + emit started/progress/finished/result
  //   events in tool_use input order.
  for (const a of authorized) {
    yield makeToolCallStartedEvent(a.effective)
    let result: ToolResult
    if (batch.concurrent && authorized.length > 1) {
      const run = runs[i]
      for (const p of run.progressEvents) yield p
      result = run.result
    } else {
      result = yield* streamToolUse(a.effective, signal, deps.executeToolUse)
    }
    const post = yield* deps.runPostToolUseHooks(a.effective, result, signal)
    yield makeToolCallFinishedEvent(a.effective, post.result, durationMs)
    yield { type: 'tool_result', message: createToolResultMessage(...) }
  }
}
```

Properties:

- For non-concurrent batches (single tool, or unsafe tool), the path is byte-equivalent to today: progress streams live via `streamToolUse`, hooks run in their original positions, events fire in their original order.
- For concurrent batches, the *only* change in execution semantics is that N `tool.call()` bodies run in parallel under `Promise.all`. Authorization, hooks, and the parent's QueryEvent emission all remain serial.
- The pre-resolution agent-scope deny (Phase 7a) still fires inside `authorizeToolUse` — this batching wraps that, doesn't replace it.

### 2. The `Agent` concurrency-safe claim is backed by a fork-time read-only invariant

`AgentTool.isConcurrencySafe()` runs at partition time inside `query.ts`, with only the tool_use input visible (`{ prompt }`). It cannot inspect the subagent's wiring. Today, `SubagentOptions.allowedTools` is configurable (`runAgent.ts:70`), defaulting to `DEFAULT_ALLOWED_TOOLS = ['FileRead', 'Glob', 'Grep']` (`runAgent.ts:86`) but overridable by callers. If a caller passes `['FileWrite']`, an unconditional `isConcurrencySafe = true` is a lie.

Two ways to plug this:

| Option | Mechanism | Verdict |
|---|---|---|
| (a) Inspect closure scope | `AgentTool.isConcurrencySafe` reaches through `context.forkSubagent` to read its bound `allowedTools` | **Reject.** `forkSubagent: ForkSubagentFn` is opaque-by-design (`type ForkSubagentFn = (prompt: string) => Promise<SubagentResult>`). Adding a metadata channel leaks scope concerns through the function boundary. |
| (b) Enforce read-only invariant at fork time | Assert in `buildFilteredRegistry` (or a companion check) that every tool in `effectiveAllowedTools` has `isReadOnly === true`. Throw `SubagentScopeError` otherwise. | **Pick.** Subagent registries are guaranteed read-only at construction; `Agent.isConcurrencySafe = true` is then provably correct under any caller. |

Option (b) requires a new `isReadOnly: boolean` flag on the `Tool` interface. Defaults to `false` if omitted. Annotations:

- `true`: `FileRead`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `MemoryRead`, `CodeSandbox`, `Agent` (delegating to read-only subagents is itself read-only).
- `false`: `FileWrite`, `FileEdit`, `Bash`, `MemoryWrite`.

`isConcurrencySafe` and `isReadOnly` are *related but distinct* — most read-only tools are also concurrency-safe, but the orthogonality preserves room for a future read-only tool that holds a non-thread-safe handle (none today). Forcing them into one flag would mis-couple the two concerns.

The invariant tightens defense-in-depth without breaking any existing path: `DEFAULT_ALLOWED_TOOLS` already passes; the only callers it bites are ones that explicitly opted to widen. None today.

### 3. AgentTool surfaces subagent terminal errors as `isError: true`

Today (`agentTool.ts:73-76`):

```ts
return {
  content: result.text,
  isError: false,
}
```

`SubagentResult.terminal` is ignored. A subagent terminal of `reason: 'error'` (model failure, max-turns exhausted, abort) currently surfaces to the parent model as fallback text with no error signal. The model has no way to distinguish "the subagent investigated X and found nothing" from "the subagent crashed mid-investigation."

Phase 7b's failure-isolation test ("one subagent error does not block siblings") needs this distinction to be meaningful. Fix:

```ts
return {
  content: result.text,
  isError: result.terminal.reason === 'error',
}
```

This is a small, isolated v1 oversight. Including it in 7b is cheap and enables a real test assertion. Same hosting decision as Phase 7a's `agentScope` reason: the right place to fix the gap is at the layer that surfaces the result, not the layer that produces it.

### 4. Threading `toolRegistry` onto `QueryDeps` is the honest fix

`partitionIntoBatches(toolUses, registry)` needs the registry to look up `isConcurrencySafe`. Today, `QueryDeps` (`src/core/queryDeps.ts`) exposes function-shaped capabilities — `callModel`, `authorizeToolUse`, `executeToolUse`, `runPreToolUseHooks`, etc. — and the registry is encapsulated inside the closures of `authorizeToolUse` / `executeToolUse` (which both close over a `ToolUseContext` that holds it).

Two ways to surface the registry to the orchestration logic:

- (a) Add `toolRegistry: ToolRegistry` to `QueryDeps`, threaded explicitly.
- (b) Add `isConcurrencySafe(name, input): boolean` to `QueryDeps`, keeping the registry encapsulated.

**Pick (a).** The registry is no longer "one detail of how authorize/execute work" — it's now load-bearing for the loop's batching decisions. Surfacing it explicitly matches the existing `toolOrchestration.runToolBatch(toolUses, context, ...)` signature, which already takes registry-bearing context. `productionDeps()` builds the registry up front anyway; threading it is one extra field.

(b) would minimize the dep surface but spread orchestration knowledge into the deps factory. (a) is the cleaner factoring once orchestration is no longer a leaf concern.

## Architecture

### `src/core/tools/types.ts` — new flag

```ts
export type Tool = {
  // ... existing fields ...
  readonly isReadOnly?: boolean       // NEW — defaults to false
  readonly isConcurrencySafe?: (input: Record<string, unknown>) => boolean
}
```

### `src/agents/agentTool.ts` — flag, predicate, error surfacing

```ts
export function createAgentTool(): Tool {
  return {
    name: AGENT_TOOL_NAME,
    description: '...',
    inputSchema,
    isReadOnly: true,                    // NEW
    isConcurrencySafe: () => true,       // NEW

    async validateInput(...) { ... },
    async checkPermissions(...) { ... },

    async call(input, context): Promise<ToolResult> {
      if (!context.forkSubagent) { ... }
      const prompt = input.prompt as string
      const result = await context.forkSubagent(prompt)
      return {
        content: result.text,
        isError: result.terminal.reason === 'error',  // CHANGED
      }
    },
  }
}
```

### `src/agents/sandboxContext.ts` — fork-time read-only invariant

`buildFilteredRegistry` (lines 145-156) gains a per-tool `isReadOnly` assertion:

```ts
export class SubagentScopeError extends Error { /* ... */ }

export function buildFilteredRegistry(
  parentRegistry: ToolRegistry,
  allowedTools: readonly string[],
): ToolRegistry {
  const filtered = createToolRegistry()
  for (const name of allowedTools) {
    if (name === AGENT_TOOL_NAME) continue
    const tool = parentRegistry.get(name)
    if (!tool) continue                         // unchanged: silently drop unknown
    if (tool.isReadOnly !== true) {
      throw new SubagentScopeError(
        `Subagent allowedTools cannot include write-capable tool "${name}"`,
      )
    }
    filtered.register(tool)
  }
  return filtered
}
```

The error throws *during* `createSandboxContext`; the `runAgent.ts` finally block runs and detaches the parent-abort listener (`sandbox.cleanup()`), so a rejected fork doesn't leak listeners.

The first-party tools in `src/tools/` (FileReadTool, GlobTool, GrepTool, WebFetchTool, WebSearchTool, MemoryReadTool, CodeSandboxTool) declare `isReadOnly: true`. The mutating tools (FileWriteTool, FileEditTool, BashTool, MemoryWriteTool) leave the flag absent (defaults to `false`) or declare `false` explicitly for clarity.

### `src/core/queryDeps.ts` — registry on QueryDeps

```ts
export type QueryDeps = {
  // ... existing fields ...
  readonly toolRegistry: ToolRegistry         // NEW
}

export function productionDeps(): QueryDeps {
  // ... existing wiring ...
  return {
    // ...
    toolRegistry,
  }
}
```

Test deps similarly gain a registry — most tests already construct one, so this is plumbing.

### `src/core/query.ts` — batched dispatch

The serial `for (const toolUse of toolUseBlocks)` loop at lines 247-321 is rewritten as the three-phase batch driver shown in §1 above. The existing abort handling (lines 326-345), missing-result synthesis, and attachment zip remain unchanged — they observe `toolResults` and `effectiveToolUses` arrays which the new driver populates with the same shape.

The serial-path branch (single tool, or unsafe tool) continues to call `streamToolUse` and yield events live, so the byte-identical behavior for unsafe tools is preserved.

Concurrency cap: reuse `DEFAULT_MAX_CONCURRENCY = 10` from `toolOrchestration.ts:22`. For batches of N > 10, fall back to `runWithConcurrencyLimit`. For N ≤ 10, plain `Promise.all` is fine (the semaphore overhead is wasteful at that size).

### `src/sdk/QueryEngine.ts` — pass registry

One-line change to thread `toolRegistry` into the `query()` deps it constructs.

### `src/agents/runAgent.ts` — pass sandbox registry

The subagent's `query()` deps receive `toolRegistry: sandbox.toolRegistry`, so nested batches inside a subagent also fan out concurrently. (Subagents can emit two `Glob` tool_uses in one turn; with this wiring, they fan out the same way the parent does.)

## Edits and surfaces touched

| Path | Change |
|---|---|
| `src/core/tools/types.ts` | +`isReadOnly?: boolean` on `Tool` (default `false`) |
| `src/agents/agentTool.ts` | +`isReadOnly: true`, +`isConcurrencySafe: () => true`, +`isError: result.terminal.reason === 'error'` in `call()` |
| `src/agents/sandboxContext.ts` | `buildFilteredRegistry` asserts `tool.isReadOnly === true`; throws new `SubagentScopeError` otherwise |
| `src/tools/FileReadTool.ts` | +`isReadOnly: true` |
| `src/tools/GlobTool.ts` | +`isReadOnly: true` |
| `src/tools/GrepTool.ts` | +`isReadOnly: true` |
| `src/tools/WebFetchTool.ts` | +`isReadOnly: true` (if file exists at this phase; else deferred) |
| `src/tools/WebSearchTool.ts` | +`isReadOnly: true` (likewise) |
| `src/tools/MemoryReadTool.ts` | +`isReadOnly: true` |
| `src/tools/CodeSandboxTool.ts` | +`isReadOnly: true` (if exists; sandbox isolates effects) |
| ~~`src/tools/FileWriteTool.ts`, `FileEditTool.ts`, `BashTool.ts`, `MemoryWriteTool.ts`~~ | ~~+`isReadOnly: false` (defensive; default would suffice)~~ — **dropped during implementation.** Invariant `tool.isReadOnly !== true` catches `undefined` and `false` equivalently. |
| `src/core/queryDeps.ts` | +`toolRegistry: ToolRegistry` on `QueryDeps`; `productionDeps` threads it |
| `src/core/query.ts` | Replace serial per-tool loop with three-phase batch driver (Phase A serial authorize+preHooks → Phase B parallel `Promise.all` over `executeToolUse` for concurrent batches → Phase C serial postHooks + event emission); preserve abort handling, missing-result synthesis, attachment zip |
| `src/sdk/QueryEngine.ts` | Pass engine's `toolRegistry` into `query()` deps |
| `src/agents/runAgent.ts` | Pass sandbox's `toolRegistry` into the subagent's `query()` deps |
| `src/agents/agentTool.test.ts` | New tests: `isConcurrencySafe()` returns `true`; `isReadOnly === true`; `call()` surfaces `isError: true` for `terminal.reason === 'error'` |
| `src/agents/sandboxContext.test.ts` | New tests: `buildFilteredRegistry({ allowedTools: ['FileWrite'] })` throws `SubagentScopeError`; default allowlist passes |
| `src/core/query.test.ts` | New describe `parallel fan-out`: 3-Glob batch executes in parallel (timing mock); authorize/askUser stays serial under fan-out (no overlapping prompts); mixed `[Glob, FileEdit, Grep, FileWrite]` partitions correctly; PreToolUse mutation propagates inside parallel batch; abort terminates parallel batch; tool_result block ordering aligns with tool_use input order |
| `src/agents/runAgent.test.ts` | New tests: two `Agent` tool_uses fan out in parallel (timing mock); one subagent error → `isError: true` while sibling completes normally; parent abort cascades to all parallel subagents (each `cleanup()` runs); ordered tool_results in next API call |
| `docs/ultron_v2/phase7b-v2-design.md` | This file |

Reused unchanged: `src/audit/auditLog.ts` (chain-serialization already safe under parallel writes), `src/session/transcript.ts` (per-subagent dirs already disjoint), `src/core/tools/toolOrchestration.ts` (`partitionIntoBatches` and `runWithConcurrencyLimit` reused as-is — `runToolBatch` itself stays dormant; it predates the Phase 2b hook split and we don't use it).

## Test plan

End-to-end check sequence:

1. `npm run typecheck` — clean.
2. `npm run test` — every pre-existing suite green. Per-tool event ordering preserved bytes-identical; serial-path behavior unchanged for unsafe tools and single-tool turns.
3. **`agentTool.test.ts`** — `isReadOnly === true`; `isConcurrencySafe()` returns `true`; `call()` surfaces `isError: true` when `result.terminal.reason === 'error'`, `isError: false` otherwise.
4. **`sandboxContext.test.ts`** — `buildFilteredRegistry({ allowedTools: ['FileWrite'] })` throws `SubagentScopeError`. `buildFilteredRegistry({ allowedTools: ['FileRead', 'Glob'] })` succeeds with both tools registered.
5. **`query.test.ts` parallel execute** — 3 `Glob` tool_uses in one assistant turn: each tool's mock `executeToolUse` resolves after a 100ms `setTimeout`; assert wall-clock ≈ 100ms (not 300ms). Per-tool event order matches input order. `tool_result` blocks in the next API call's `user` message align with the assistant's `tool_use` block IDs/order.
6. **`query.test.ts` authorize stays serial** — 3 `Glob` tool_uses where `askUser` is wired (e.g., a deny rule on tool 1) → `askUser` invoked at most once at any time (assert via mock that tracks invocation overlap; never two concurrent invocations). Permission decisions and rule mutations happen sequentially.
7. **`query.test.ts` mixed batch partition** — `[Glob, FileEdit, Grep, FileWrite]` → partition emits `parallel(Glob)` → `serial(FileEdit)` → `parallel(Grep)` → `serial(FileWrite)`. PreToolUse input mutation on a tool inside a parallel batch reflects in that tool's effective use (not its sibling's).
8. **`query.test.ts` abort during fan-out** — parent abort during a parallel batch terminates all in-flight runs; missing tool_results synthesized for remaining tools in the batch *and* subsequent batches; no `AbortController` listener leak in `sandboxContext`.
9. **`runAgent.test.ts` parallel subagents** — `callModel` emits two `Agent` tool_uses → both subagents run concurrently → both produce distinct tool_results in input order. (Time-mock the inner `callModel` with staggered delays to make concurrency observable; assert wall-clock ≈ max child, not sum.)
10. **`runAgent.test.ts` failure isolation** — one subagent's inner `callModel` errors → that subagent's `Terminal` has `reason: 'error'`; sibling completes normally. Both produce tool_results: first has `isError: true` carrying the subagent's terminal-error text, second is normal `isError: false` with the agent's output.
11. **`runAgent.test.ts` cascading abort under fan-out** — parent abort during a 3-Agent batch cancels all three subagents' inner loops; each `sandbox.cleanup()` runs; audit log carries `origin: <subagentId>` for each subagent's abort event.
12. **Manual sanity** — single local invocation that prompts "use Agent twice in parallel to investigate X and Y." Inspect `~/.ultron/audit.jsonl`: subagent-internal events from both subagents interleave naturally with distinct `origin` tags; parent's `tool_call_finished`/`tool_result` rows appear in tool_use input order; no overlapping permission prompts.

## Compatibility note for Phase 7c

`createSandboxContext`'s pure-construction property remains untouched. Phase 7c (nested audit correlation) extends `parentAuditWriter.withOrigin(subagentId)` to also stamp `parentCorrelationId`; the parallel-fan-out path doesn't change that surface. The fork-time read-only invariant introduced here composes with 7c trivially — nested forks (when eventually unblocked) would inherit the same `isReadOnly` check at every level.

If Phase 7c wants to live-stream parallel-batch progress events (replacing the per-tool buffer with a merging async iterator), that's a localized change in `query.ts` — call sites and `Tool.isConcurrencySafe` semantics don't move.

## Does NOT do

Per `v2-scope.md §7` "parallel read-only fan-out":

- **Live event streaming inside a parallel batch.** `tool_progress` events are buffered per-tool and replayed in input order. Subagent-internal audit events still stream live (via `runAgent.ts:177`). A future phase can swap the buffer for a merging async iterator without changing call sites or `Tool` semantics.
- **Nested audit correlation `parentCorrelationId`** (Phase 7c). The `withOrigin(subagentId)` stamp from 7a remains the sole correlation signal.
- **Recursive subagents.** `Agent` is still excluded from subagent registries (`sandboxContext.ts:132`).
- **AgentTool input-schema change to accept a list of tasks per tool_use.** Parallelism arrives via the model emitting multiple `Agent` blocks; the schema stays `{ prompt }`.
- **Per-subagent concurrency cap separate from the tool cap.** Reuse the existing `DEFAULT_MAX_CONCURRENCY = 10`.
- **Subagent-to-subagent communication.** Sibling subagents are independent; they don't see each other's transcripts or in-flight state.
- **Renaming `runToolBatch`'s legacy path.** It stays dormant; deletion is deferred to a separate cleanup phase.
- **A separate `isConcurrencySafe` story for hooks.** Hooks run serially under fan-out by construction (Phase A and Phase C); per-hook concurrency control is a distinct concern.

## Risks and open questions

- **Tool-progress buffering memory bound.** `streamToolUse` already caps the queue at `PROGRESS_QUEUE_CAP = 1000` per tool (`streamToolUse.ts:22`). The parallel path's per-tool buffer inherits the same cap — N parallel tools at the cap means up to N×1000 events in memory. At `DEFAULT_MAX_CONCURRENCY = 10` that's 10,000 events, ~bounded.
- **Determinism vs. real-time UX.** The buffer-and-replay design trades parent-side real-time progress for deterministic ordering. The audit log retains live observability for the work that matters (subagent tool calls). If the trade turns out wrong in practice, the swap to a merging iterator is local.
- **`isReadOnly` on first-party tools that don't exist yet.** WebFetch/WebSearch/CodeSandbox may or may not be implemented at this phase; the table above lists them conditionally. Add the flag where the file exists; defer the rest to whichever phase introduces them.
