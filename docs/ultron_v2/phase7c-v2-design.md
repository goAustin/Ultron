# Phase 7c Design: Nested Audit Correlation

## Status

Implemented; pending merge. Plan: `~/.claude/plans/now-make-a-plan-quizzical-simon.md`. Phase 7a is shipped (`docs/ultron_v2/phase7a-v2-design.md`); Phase 7b is shipped (`docs/ultron_v2/phase7b-v2-design.md`). This phase extends the audit spine with parent→child correlation IDs, lands a tree-reconstruction utility promised in 7a's compatibility note, and corrects a Phase 7a precedence interaction surfaced during review (see "Post-review fixes" below). Final test run: 1549 passed (1 skipped) across 107 files; typecheck clean. Pre-implementation baseline was 1527 — Phase 7c adds 22 new tests across `auditLog.test.ts` (+4), `auditTree.test.ts` (+10, new file), `runToolUse.test.ts` (+3), `agentTool.test.ts` (+2), `sandboxContext.test.ts` (+1), `runAgent.test.ts` (+2), and zero regressions.

### Post-review fixes (against the first implementation pass)

A code review surfaced one real defect adjacent to the audit-correlation work, fixed and pinned by a regression test.

1. **Pre-resolution scope gate stole the cascade's explicit-deny precedence.** Phase 7a placed the scope gate (now `runToolUse.ts:55-83`) **before** the registry-resolve step so a filtered subagent registry would surface out-of-scope calls as `agentScope` policy denies instead of `tool_not_found` precondition failures. But the gate fired *unconditionally* on scope mismatch, even when the tool was in the registry. That contradicted the cascade invariant in `permissions.ts:65-79`: explicit user deny rules (step 1) win over scope checks (step 1.5). With an active skill scope and a user `deny` rule for an out-of-scope tool, the pre-resolution gate emitted `permission_decision: deny` with `reason: skillScope` instead of `reason: rule` — the deny outcome was correct but the audit reason was demoted, masking user-driven denies inside scoped activations from any consumer that filters by `reason.type`. **Fix:** apply the pre-resolution gate **only when the tool can't be resolved**. Subagent path (filtered registry, tool absent) still emits `agentScope`; parent-under-skill path (unfiltered registry, tool resolves) falls through to the cascade where explicit deny wins at step 1. Both paths still share `checkScopedAllowlist`, so the deny shape is byte-identical when the gate fires. Regression test: `runToolUse.test.ts:347-376` asserts `reason` is `'rule'`-formatted, not `'active skill's allowed-tools'`, for the (resolvable + skill scope + deny rule) case.

## Context

`v2-scope.md §7` ("Subagents via Agent SDK") closes with a "Hooks & Observability" pillar. Phase 7a tagged subagent events with `origin: <subagentId>` via `auditWriter.withOrigin(subagentId)` (`auditLog.ts:108`); Phase 7b made `Agent` tool_uses fan out concurrently. Together those create the failure mode 7c fixes:

When two `Agent` blocks fan out in parallel, both subagents write through derived `withOrigin(...)` handles whose envelopes interleave on a single `audit.jsonl`. A consumer reading the log sees `origin: subagent-A`, `origin: subagent-B`, `origin: subagent-A`, ... but has no field linking either subagent back to the parent's `tool_call_started` (with `toolUseId: tu_xxx`) that spawned it. Temporal proximity is unreliable under fan-out, and once nested forks become possible (a future phase), the ambiguity gets worse.

7a's design doc named the wedge:

> **7c** can extend the factory's `parentAuditWriter.withOrigin(subagentId)` line to also stamp `parentCorrelationId` into every event. The `'agentScope'` reason variant is already in place to be picked up by the tree-rendering test fixture.

7b's design doc reaffirmed:

> Phase 7c (nested audit correlation) extends `parentAuditWriter.withOrigin(subagentId)` to also stamp `parentCorrelationId`; the parallel-fan-out path doesn't change that surface.

So the deliverable is: every audit envelope a subagent writes carries a `parentToolUseId` field naming the parent-side `Agent` `ToolUseBlock.id` that spawned it. With `parentToolUseId` plus the existing `origin: subagentId` and the parent's existing `tool_call_started.toolUseId`, a downstream consumer can rebuild the parent→child tree unambiguously even under interleaved parallel fan-out.

## The three load-bearing decisions

### 1. `parentToolUseId` is the correlation key — not a fresh UUID

Two candidates for the correlation field:

| Option | Mechanism | Verdict |
|---|---|---|
| (a) Fresh `correlationId: UUID` per fork | Generate at `createForkSubagent` time, stamp on subagent envelopes, also include on the parent's `tool_call_started` for the spawning `Agent`. | **Reject.** Two new fields (parent-side and child-side) for one link. Requires a new event-type schema change to put `correlationId` on `ToolCallStartedEvent`. Buys nothing the existing `toolUseId` doesn't already provide. |
| (b) `parentToolUseId: ToolUseId` | Stamp every subagent envelope with the internal `ToolUseBlock.id` of the parent's `Agent` block. The parent's `ToolCallStartedEvent.toolUseId` already exists (`queryEvents.ts:81`); the link is parent.toolUseId == child.parentToolUseId. | **Pick.** Single new field on the envelope. Zero schema churn on event types. `ToolUseBlock.id` (`messages.ts:43`) is the provider-agnostic identifier each adapter normalizes into — Anthropic SSE id, OpenAI tool_call id, and MiniMax id all flow through it — and is unique per call within a session. |

The semantics: every audit envelope a subagent emits carries `parentToolUseId: <Agent ToolUseBlock.id>`. Tree reconstruction is a one-pass scan: parent rows have `tool_call_started.toolUseId`; child rows have `parentToolUseId`; match on equality. Under parallel fan-out, `parentToolUseId` distinguishes which subagent each envelope belongs to even when sibling events interleave.

For nested forks (gated behind future work — Phase 7a/b explicitly exclude `Agent` from subagent registries), the same field composes: a hypothetical grandchild's `parentToolUseId` would be the child subagent's `Agent` tool_use id; tree reconstruction walks the chain by repeated lookup. No nested-correlation logic needs to exist today.

### 2. Stamp at envelope level, not on event types

Two layers where the field could live:

- (α) **Event level.** Add `parentToolUseId?: ToolUseId` to every `QueryEvent` variant (or to a base envelope type the events extend). The query loop populates it on every emit.
- (β) **Envelope level.** Add `parentToolUseId?: ToolUseId` next to `origin` in the audit envelope. The audit serializer stamps it. Event types in `queryEvents.ts` are unchanged.

**Pick (β).** Reasons:

1. **`origin` is already at the envelope level** (`auditLog.ts:135`). `parentToolUseId` is the same kind of provenance/correlation signal: who spawned this writer, not what happened in this event. Putting it at the same layer keeps the model coherent.
2. **Event types describe what happened, not who spawned it.** Polluting every variant with `parentToolUseId?` (or threading it via a base type) is a cross-cutting concern that the audit boundary already owns.
3. **Plumbing is one method on `AuditWriter`** (`withOrigin`'s second arg) instead of touching ~25 event variants and every emission site in `query.ts`.
4. **Tree reconstruction reads from envelopes** (parsed JSONL lines), which is where the field naturally lives.
5. **Redaction stays clean.** `auditLog.ts:127-140` spreads `redactSecrets(event)` into the envelope; envelope-level `parentToolUseId` lives alongside `tsIso`/`origin`, not inside the redacted payload, so there is no field collision and no risk of redaction stripping the correlation key.

The cost is one optional second arg on `withOrigin`. The non-chainability invariant (`auditLog.ts:114-116`) is preserved — derived handles still throw if `withOrigin` is called on them.

### 3. Per-call rebind of `forkSubagent` keeps AgentTool unaware

The mechanical question: how does `AgentTool.call(input, context)` learn the parent's `toolUse.id` so it can pass it to `forkSubagent`?

Three options:

| Option | Mechanism | Verdict |
|---|---|---|
| (i) Add `currentToolUseId` to `ToolUseContext` | Static context grows a per-call field; `executeToolUse` shallow-copies and sets it on the per-call `callContext` (`runToolUse.ts:218-223` already builds one). AgentTool reads `context.currentToolUseId`. | **Reject.** Adds a public field useful only to AgentTool. Footgun: any future caller reading `context.currentToolUseId` outside `tool.call` reads stale data (the static context never carries it). |
| (ii) Pass `toolUse` as a 4th arg to `tool.call` | Generic per-call metadata channel: `tool.call(input, context, signal, toolUse)`. AgentTool reads `toolUse.id`; other tools ignore. | **Reject for 7c.** Requires touching every tool definition (cosmetic but wide ripple). Worth doing as a standalone refactor; not load-bearing here. |
| (iii) Per-call rebind of `forkSubagent` | The executor (`runToolUse.ts:executeToolUse`) holds two `forkSubagent` typed signatures: a widened `EngineForkSubagentFn = (prompt, parentToolUseId) => Promise<SubagentResult>` stored on the static context, and a unary `ForkSubagentFn = (prompt) => Promise<SubagentResult>` that the executor binds per-call by capturing `toolUse.id` in a closure. AgentTool's `call()` body is unchanged. | **Pick.** Most localized change. AgentTool stays unary. The two-type split makes the seam explicit: tools see the unary `forkSubagent`; the engine wires the widened `engineForkSubagent`. |

Approach (iii) implementation:

```ts
// src/agents/runAgent.ts — both types live here (single source of truth)
export type ForkSubagentFn = (prompt: string) => Promise<SubagentResult>

export type EngineForkSubagentFn = (
  prompt: string,
  parentToolUseId: ToolUseId,
) => Promise<SubagentResult>

// src/core/tools/context.ts — type-only import; no duplicated definitions
import type { ForkSubagentFn, EngineForkSubagentFn } from '../../agents/runAgent.js'

export type ToolUseContext = {
  // ... existing fields ...
  engineForkSubagent?: EngineForkSubagentFn  // NEW — set by engine, never tools
  forkSubagent?: ForkSubagentFn              // existing — populated per-call
}
```

```ts
// src/core/tools/runToolUse.ts — executeToolUse
const callContext: ToolUseContext = {
  ...context,
  ...(onProgress && { onProgress }),
  ...(context.engineForkSubagent && {
    forkSubagent: (prompt: string) =>
      context.engineForkSubagent!(prompt, toolUse.id),
  }),
}
```

Two properties fall out:

- **AgentTool's `call()` body is byte-identical** — it still calls `context.forkSubagent(prompt)`. The per-call closure injects the parent toolUseId transparently.
- **Per-tool concurrency is safe** — Phase 7b already constructs a per-call `callContext` shallow copy for each parallel `executeWithBufferedProgress` task; the per-call `forkSubagent` closure rides on the same per-call object, so two parallel `Agent` calls each capture their own `toolUse.id`.

Fallback: if `engineForkSubagent` is undefined (subagents themselves — they don't get to fork), `forkSubagent` is also undefined, and AgentTool's existing guard (`agentTool.ts:76-80` "Agent delegation is not available in this context") fires. No new branch.

## Architecture

### `src/audit/types.ts` — widen `withOrigin` signature

```ts
import type { ToolUseId } from '../core/messages.js'

export type AuditWriter = {
  readonly write: (event: QueryEvent) => void
  readonly close: () => Promise<void>
  /**
   * Returns a non-chainable handle that shares this writer's underlying
   * chain + byte accounting but stamps every envelope with the given
   * `origin` tag and (optionally) a `parentToolUseId` linking events to the
   * parent-side `tool_call_started` that spawned the writer's owner.
   */
  readonly withOrigin: (
    origin: string,
    opts?: { readonly parentToolUseId: ToolUseId },
  ) => AuditWriter
}
```

Backward-compatible: existing callers pass just `origin`. The non-chainability invariant stays.

### `src/audit/auditLog.ts` — envelope serialization

`write()` gains a third internal parameter; `serialize()` stamps the field next to `origin`:

```ts
function withOrigin(
  origin: string,
  opts?: { readonly parentToolUseId: ToolUseId },
): AuditWriter {
  return {
    write: (event) => write(event, origin, opts?.parentToolUseId),
    close,
    withOrigin: () => {
      throw new Error('withOrigin does not support chaining; derive from the root writer')
    },
  }
}

function serialize(
  event: QueryEvent,
  origin?: string,
  parentToolUseId?: ToolUseId,
): string {
  // ...
  const envelope: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    tsIso: new Date(timestamp).toISOString(),
    ...(origin !== undefined && { origin }),
    ...(parentToolUseId !== undefined && { parentToolUseId }),
    ...(redactSecrets(event) as Record<string, unknown>),
  }
  return JSON.stringify(envelope) + '\n'
}
```

`SCHEMA_VERSION` stays at `1` — `parentToolUseId` is an additive optional field. Pre-7c readers ignore it; post-7c readers tolerate its absence.

### `src/agents/runAgent.ts` — single source of truth for both fork-fn types

Both `ForkSubagentFn` (existing, unary, tool-facing) and `EngineForkSubagentFn` (new, widened, engine-facing) live here. `context.ts` already imports `ForkSubagentFn` from `runAgent.ts`; we extend that import to cover both types rather than duplicating the type definition across files.

```ts
import type { ToolUseId } from '../core/messages.js'

/** Tool-facing fork fn — unary; populated per-call by executeToolUse. */
export type ForkSubagentFn = (prompt: string) => Promise<SubagentResult>

/** Engine-level fork fn — widened with the parent tool_use.id for audit correlation. */
export type EngineForkSubagentFn = (
  prompt: string,
  parentToolUseId: ToolUseId,
) => Promise<SubagentResult>

export function createForkSubagent(opts: SubagentOptions): EngineForkSubagentFn {
  return async (prompt: string, parentToolUseId: ToolUseId): Promise<SubagentResult> => {
    const subagentId = randomUUID()
    // ... existing setup ...

    const sandbox = createSandboxContext({
      // ... existing fields ...
      parentToolUseId,                         // NEW — threaded through
    })

    // ... rest unchanged ...
  }
}
```

### `src/agents/sandboxContext.ts` — accept and forward `parentToolUseId`

```ts
export type SandboxContextOptions = {
  // ... existing fields ...
  readonly parentToolUseId: ToolUseId        // NEW — required
}

export function createSandboxContext(opts: SandboxContextOptions): SandboxContext {
  // ... existing computeEffectiveAllowedTools, store, registry, permissionOpts ...

  // CHANGED — withOrigin takes the second arg
  const auditWriter = opts.parentAuditWriter.withOrigin(
    opts.subagentId,
    { parentToolUseId: opts.parentToolUseId },
  )

  // ... rest unchanged ...
}
```

`parentToolUseId` is required (not optional) on `SandboxContextOptions`: the only caller is `createForkSubagent`, which always knows it. Making it optional would create a "forgot to thread it" footgun.

### `src/core/tools/context.ts` — type-only import + new field

Type-only import both `ForkSubagentFn` and `EngineForkSubagentFn` from `../../agents/runAgent.js` (matching the existing pattern for `ForkSubagentFn` / `SubagentResult`). No type definitions added or duplicated here.

```ts
import type {
  ForkSubagentFn,
  EngineForkSubagentFn,
} from '../../agents/runAgent.js'

export type ToolUseContext = {
  // ... existing fields ...

  /**
   * Engine's fork fn (set once by the QueryEngine). Tools never read this
   * directly; the executor binds it per-call into `forkSubagent` below.
   */
  engineForkSubagent?: EngineForkSubagentFn

  /**
   * Per-call fork fn (set by executeToolUse for each tool.call). AgentTool
   * reads this; the closure has already captured the parent tool_use.id.
   * Undefined on the static context.
   */
  forkSubagent?: ForkSubagentFn

  // ... onProgress, notify ...
}

// createToolUseContext factory: replace `forkSubagent` parameter with
// `engineForkSubagent`. The static context never sets `forkSubagent`.
```

### `src/core/tools/runToolUse.ts` — restructured `authorizeToolUse` + per-call rebind

**`authorizeToolUse` — pre-resolution gate is now resolve-conditional.** Per the post-review fix above, the scope gate moved from "before registry resolve, fires unconditionally" to "after the registry returns, fires only when the tool was not found." Pseudocode:

```ts
// Before (Phase 7a):
//   1. abort
//   1.5. checkScopedAllowlist → if scope mismatch, deny  ← stole cascade precedence
//   2. resolve tool → tool_not_found if absent
//   3. validate
//   ...
//   5. cascade (handles explicit-deny → scope → ... internally)
//
// After (Phase 7c):
//   1. abort
//   2. resolve tool
//      ├ found    → continue
//      └ missing  → checkScopedAllowlist → if mismatch, scope deny; else tool_not_found
//   3. validate
//   ...
//   5. cascade (unchanged — still has the in-cascade scope gate at step 1.5)
```

The change preserves both invariants the design has to satisfy:

- **Subagent verification clause** (Phase 7a): an out-of-scope tool inside a filtered subagent registry surfaces as a `permission_decision: deny` with `agentScope` reason, not a `tool_not_found` precondition. The tool is absent from the filtered registry, so the resolve step misses, and the new fallback emits `agentScope`.
- **Cascade explicit-deny precedence** (Phase 5b + post-review fix): under an unfiltered registry with a user deny rule for an out-of-scope tool, the cascade runs and step 1 wins over step 1.5. The pre-resolution gate doesn't fire because the tool resolves.

Both paths still share `checkScopedAllowlist`. The reason variant is constructed in exactly one place.

**`executeToolUse` — per-call rebind.**

In `executeToolUse`, **replace** the existing onProgress-only ternary (`runToolUse.ts:218-223`) with a single object-spread construction. The current pattern only allocates a copy when `onProgress` is truthy and otherwise reuses the static `context` reference verbatim; with the new per-call `forkSubagent` rebind, we need the copy whenever **either** `onProgress` or `context.engineForkSubagent` is set, so the cleanest factoring is to drop the ternary and always construct the per-call object inside this code path:

```ts
// Before:
//   const callContext: ToolUseContext = onProgress
//     ? { ...context, onProgress }
//     : context
// After:
const callContext: ToolUseContext = {
  ...context,
  ...(onProgress && { onProgress }),
  ...(context.engineForkSubagent && {
    forkSubagent: (prompt: string) =>
      context.engineForkSubagent!(prompt, toolUse.id),
  }),
}
```

No other change in `executeToolUse`. The validation pass and `tool.call` invocation are unchanged. (Cost of always allocating the shallow copy: negligible — one object literal per tool call, on a code path that's already allocating a `ToolUseBlock`, a `ToolResult`, and at minimum two Promise frames.)

### `src/sdk/QueryEngine.ts` — wire `engineForkSubagent` into the static context

Where the engine constructs `ToolUseContext` (today via `createToolUseContext({ ..., forkSubagent: ... })`), rename the parameter to `engineForkSubagent` and pass the widened `EngineForkSubagentFn` returned by `createForkSubagent`. One-line rename.

### Tree-reconstruction utility — `src/audit/auditTree.ts`

A pure utility lifted into `src/audit/auditTree.ts`. Lives under `src/audit/` (not `tests/`) because future production callers are plausible — most concretely, a `/audit tree` slash command that renders parent→child trees from an audit slice. It is consumed by tests today, and exported as a real utility for future consumers; not test-only.

**Scope contract.** `buildAuditTree` operates on a **single-session audit slice**, not an arbitrary `audit.jsonl` file. Today's audit envelope carries no session id, so over a long-running append-only `audit.jsonl` containing multiple sessions, two distinct sessions could in principle reuse a `ToolUseBlock.id` (provider IDs are unique per request, not per machine-lifetime), which would mislink children to a stale parent. Callers are responsible for slicing the log to one session before passing it in — typically by reading from `~/.ultron/audit.jsonl` between two `request_start` boundaries, or by capturing live envelopes from a single run. A future phase that adds a session-id field to every envelope can relax this contract; until then, scope discipline is the caller's job, and the doc comment says so explicitly.

```ts
export type AuditEnvelope = {
  readonly schemaVersion: number
  readonly tsIso: string
  readonly origin?: string
  readonly parentToolUseId?: ToolUseId
  readonly type: QueryEvent['type']
  // plus the spread event fields
} & Record<string, unknown>

export type AuditTreeNode = {
  readonly origin: string | null   // null for root (no origin)
  readonly parentToolUseId: ToolUseId | null
  readonly events: readonly AuditEnvelope[]
  readonly children: readonly AuditTreeNode[]
}

/**
 * Build a tree from a single-session slice of audit envelopes. Grouping
 * is by the pair `(origin, parentToolUseId)`, NOT by `origin` alone —
 * under a correct producer the two are equivalent (every origin maps to
 * exactly one parentToolUseId), but grouping by both surfaces a buggy
 * producer that reused an origin under two different parents as separate
 * subtrees rather than collapsing them into one mislinked subtree. Pure
 * — no I/O.
 *
 * Scope: callers MUST pass a slice from one session. Mixing envelopes
 * from multiple sessions can mislink children to stale parents because
 * `ToolUseBlock.id` is unique per request, not per machine-lifetime,
 * and the envelope carries no session id today.
 *
 * - Envelopes with no `origin` form a single synthetic root subtree.
 * - Each `(origin, parentToolUseId)` pair becomes one child subtree of
 *   whichever ancestor subtree contains a `tool_call_started.toolUseId`
 *   matching that `parentToolUseId`.
 * - If a subtree's `parentToolUseId` has no matching `tool_call_started`
 *   in any ancestor, throw — orphans indicate a malformed log (or a
 *   caller that didn't scope to one session) and silently returning
 *   them as top-level children would mask producer bugs.
 */
export function buildAuditTree(envelopes: readonly AuditEnvelope[]): AuditTreeNode
```

Used by the test in `runAgent.test.ts` to verify under parallel fan-out that two subagents' events resolve to the right parent `tool_call_started`. Pure, exhaustively unit-testable.

## Edits and surfaces touched

| Path | Change |
|---|---|
| `src/audit/types.ts` | `withOrigin` second arg `{ parentToolUseId: ToolUseId }`; import `ToolUseId` |
| `src/audit/auditLog.ts` | `write()` and `serialize()` accept `parentToolUseId`; envelope stamps it parallel to `origin`; `withOrigin` plumbs it; `SCHEMA_VERSION` unchanged (additive optional field) |
| `src/audit/auditLog.test.ts` | New tests: `withOrigin('id', { parentToolUseId })` stamps both fields; second arg is optional (back-compat); chained throw still fires; redactor doesn't strip the field |
| `src/audit/auditTree.ts` | **NEW** — `AuditEnvelope` shape + `buildAuditTree(envelopes)` pure utility |
| `src/audit/auditTree.test.ts` | **NEW** — exhaustive tests: empty input, single root, one child, two parallel children with interleaved events, child with no `tool_call_started` matching its `parentToolUseId` (well-formedness assertion) |
| `src/core/tools/context.ts` | Type-only import of `ForkSubagentFn` + `EngineForkSubagentFn` from `runAgent.ts` (no duplicated type definitions); add `engineForkSubagent?: EngineForkSubagentFn` field on `ToolUseContext`; rename `forkSubagent` factory param to `engineForkSubagent`; document per-call rebind contract on `ToolUseContext.forkSubagent` |
| `src/core/tools/runToolUse.ts` | `authorizeToolUse`: scope gate moved from pre-resolve (unconditional) to post-resolve fallback (fires only on `tool_not_found`), so explicit-deny rules in the cascade keep precedence over `skillScope`/`agentScope`. `executeToolUse`: per-call rebind derives unary `forkSubagent` from `context.engineForkSubagent` capturing `toolUse.id` |
| `src/core/tools/runToolUse.test.ts` | New tests: `executeToolUse` invokes `engineForkSubagent` with `(prompt, toolUse.id)`; static `context.forkSubagent` is undefined while `engineForkSubagent` is set; AgentTool sees the unary view; **regression** — explicit user deny rule wins over `skillScope` when the tool is resolvable (cascade invariant preserved) |
| `src/agents/agentTool.ts` | **No change** — `call()` body still does `context.forkSubagent(prompt)` |
| `src/agents/agentTool.test.ts` | New test: under a per-call rebind harness, `AgentTool.call` triggers the underlying engine fork with the right `parentToolUseId` |
| `src/agents/runAgent.ts` | Define new `EngineForkSubagentFn` type alongside the existing `ForkSubagentFn` (single source of truth for both); `createForkSubagent` returns `EngineForkSubagentFn` and accepts `parentToolUseId` as second arg; threads `parentToolUseId` into `createSandboxContext` |
| `src/agents/runAgent.test.ts` | Existing direct-call tests (`fork('Search for files')` etc., e.g. `runAgent.test.ts:93`) update to pass a synthetic `parentToolUseId` second arg — `createForkSubagent` is internal wiring, not public SDK surface, so the churn is intentional. New tests: (a) single subagent — every subagent envelope carries `origin: subagentId` AND `parentToolUseId: <Agent ToolUseBlock.id>`; (b) parallel fan-out — both subagents' envelopes carry their respective parent toolUseIds, and `buildAuditTree` reconstructs the parent → 2-child tree correctly under interleaving |
| `src/agents/sandboxContext.ts` | `SandboxContextOptions.parentToolUseId: ToolUseId` (required); pass to `withOrigin` |
| `src/agents/sandboxContext.test.ts` | New test: `createSandboxContext({ parentToolUseId })` invokes `parentAuditWriter.withOrigin(subagentId, { parentToolUseId })` |
| `src/sdk/QueryEngine.ts` | One-line: pass `engineForkSubagent: createForkSubagent(...)` instead of `forkSubagent: ...` to `createToolUseContext` |
| `docs/ultron_v2/phase7c-v2-design.md` | This file. |

Reused unchanged: `redactSecrets`, all `QueryEvent` types in `queryEvents.ts`, the existing `withOrigin` non-chainability test, `partitionIntoBatches` / `runWithConcurrencyLimit` (Phase 7b), the parent-loop's `tool_call_started` emission in `query.ts:383, 450`, and AgentTool's `call()` body.

## Test plan

End-to-end check sequence:

1. `npm run typecheck` — clean.
2. `npm run test` — every pre-existing suite stays green. `withOrigin('id')` (one-arg) calls remain valid; existing tests don't see a behavioral change.
3. **`auditLog.test.ts`** — sibling test to `withOrigin stamps the envelope with an origin field` (`auditLog.test.ts:201-210`): `withOrigin('sub', { parentToolUseId: 'tu_abc' })` stamps both `origin` and `parentToolUseId`. Second arg is optional (one-arg call still works). Redactor doesn't touch envelope-level fields (parallel to existing `origin` redaction guarantee).
4. **`auditTree.test.ts`** (new): unit tests for `buildAuditTree`. Cases: empty input; single envelope (root); one parent + one child correctly linked; two parallel children with interleaved events resolving to distinct subtrees keyed by `(origin, parentToolUseId)`; same `origin` reused under two distinct `parentToolUseId` values surfaces as two separate subtrees (defense-in-depth against a buggy producer); malformed input where a child's `parentToolUseId` has no matching `tool_call_started` in any ancestor subtree throws (orphans are not silently re-parented).
5. **`runToolUse.test.ts`** — three new tests:
   - **per-call rebind** — build a `ToolUseContext` with `engineForkSubagent` mocked; call `executeToolUse(toolUse, context, signal)` with a `tool` whose body invokes `context.forkSubagent('prompt')`; assert the mock saw `('prompt', toolUse.id)`.
   - **negative case** — when `context.engineForkSubagent` is undefined, the per-call `callContext.forkSubagent` is also undefined.
   - **explicit-deny precedence regression** — with `scopedToolAllowlist: ['FileRead']` (skill scope) + a user `deny` rule for `Glob` + Glob in the registry, `auth.decision.reason` contains `'rule'`, not `'active skill's allowed-tools'`. Pins the post-review fix that moved the pre-resolution gate to be resolve-conditional.
6. **`agentTool.test.ts`** — new test: drive `AgentTool.call(input, callContext)` where `callContext.forkSubagent` is a per-call closure (matching what `executeToolUse` would build). Assert the engine fork was called with the parent `toolUseId`.
7. **`sandboxContext.test.ts`** — new test: pass `parentToolUseId: 'tu_xyz'` to `createSandboxContext`; capture the call into `parentAuditWriter.withOrigin`; assert second arg is `{ parentToolUseId: 'tu_xyz' }`. Existing tests for clone isolation, abort cascade, and cleanup stay green.
8. **`runAgent.test.ts` single fork** — extend the existing `makeCapturingWriter` (lines 48-56) to record `(event, origin, parentToolUseId)` triples. Run a fork. Assert every captured triple has `origin === subagentId` AND `parentToolUseId === <the Agent ToolUseBlock.id used in the fork test>`.
9. **`runAgent.test.ts` parallel fan-out** — drive a parent loop emitting two `Agent` blocks (`tu_A`, `tu_B`) in one assistant turn. Both subagents run concurrently per Phase 7b. Capture all envelopes. Run `buildAuditTree` on the captured envelopes. Assert: root has 2 children; child[A] has all envelopes with `parentToolUseId === 'tu_A'`; child[B] has all envelopes with `parentToolUseId === 'tu_B'`; no envelope is misattributed despite interleaving.
10. **Manual sanity** — local invocation prompting "use Agent twice in parallel to investigate X and Y." Inspect `~/.ultron/audit.jsonl`: every subagent envelope carries `origin` AND `parentToolUseId`; the values match the parent's `tool_call_started.toolUseId` for the corresponding `Agent` block; `buildAuditTree` (via a one-shot script) renders the expected 1-parent-2-children tree.

## Compatibility note for future phases

`createSandboxContext`'s pure-construction property is preserved. Future phases:

- **Nested subagents** (when `Agent` is unblocked from subagent registries): `parentToolUseId` composes by induction — the grandchild's `parentToolUseId` is the child's `Agent` `ToolUseBlock.id`, the child's is the root's, and `buildAuditTree` walks the chain by repeated lookup. No correlation logic needs to exist today; the field already supports nesting.
- **Hooks observability** (Phase 2b's hook events already carry `toolUseId`): hook events emitted from inside a subagent automatically inherit `parentToolUseId` via the same `withOrigin` derivation, so hook→tool→subagent traces compose for free.
- **Slash command for scope/tree rendering** (e.g. `/audit tree`): can read `~/.ultron/audit.jsonl` and call `buildAuditTree` directly. The fixture is already pure and exhaustively tested.

## Does NOT do

- **Add a fresh `correlationId` UUID** parallel to `parentToolUseId`. The core `ToolUseBlock.id` is the natural correlation key; a new UUID would be redundant. (Rejected option (a) in §1.)
- **Promote `parentToolUseId` to event-level fields.** Stays at envelope level next to `origin`. (Rejected option (α) in §2.)
- **Add `currentToolUseId` to `ToolUseContext`** as a public per-call field. Per-call rebind via the executor avoids the footgun. (Rejected option (i) in §3.)
- **Widen `Tool.call` signature** to take a 4th per-call metadata arg. Worth doing, but orthogonal to 7c. (Rejected option (ii) in §3.)
- **Live tree rendering during execution.** `buildAuditTree` is post-hoc on the audit log; no streaming reconstruction.
- **Bump `SCHEMA_VERSION`.** `parentToolUseId` is additive and optional. Pre-7c readers ignore it; post-7c readers tolerate its absence.
- **Rename or migrate existing `origin` semantics.** Origin stays the subagent identity field; `parentToolUseId` is the new parentage field. They're orthogonal.
- **Emit a new `subagent_started` / `subagent_finished` audit event.** The parent's existing `tool_call_started` / `tool_call_finished` for the `Agent` tool_use already brackets the subagent's lifetime; adding a parallel pair would double-write.
- **Recursive subagents.** Still blocked at `buildFilteredRegistry` (`sandboxContext.ts:178`). 7c only makes the future correlation work cheaper.
