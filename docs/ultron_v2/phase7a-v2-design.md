# Phase 7a Design: Forked Context + Scoped Tool Pool

## Status

Implemented; pending merge. Plan: `~/.claude/plans/now-make-a-plan-compiled-yeti.md`. Final test run: 1506 passed (1 skipped) across 105 files; typecheck clean.

## Context

`v2-ROADMAP.md §7a` calls for a **real subagent implementation** to replace the v1 Phase 13 stub: forked message list, **subset** of parent's tools (never superset), shared permission engine, separate transcript, result returned to parent as a tool result. Verification clauses:

> Subagent calling a tool outside its scoped pool is **denied at the permission layer**.
> Parent transcript is **unmodified** during subagent execution.

Most of this substrate is **already shipped** in `src/agents/runAgent.ts` as `createForkSubagent`:

- Cloned `AppState` via `createStore({ ...parent })` (line 114) — mutations isolated.
- Fresh `ReadFileState = new Map()` (line 117).
- Filtered tool registry via `buildFilteredRegistry` (lines 119-123, 227-242) — only `allowedTools`, `Agent` always excluded.
- `AbortController` linked to parent (lines 104-109) — parent abort cascades.
- Separate transcript dir at `<sessionDir>/agents/<subagentId>/transcript.jsonl` (line 99).
- Audit writer derived via `parent.auditWriter.withOrigin(subagentId)` (line 175).
- Subagent system prompt assembled via `buildSubagentSystemPrompt` (line 139).
- Result wrapped as `SubagentResult { text, terminal, subagentId }` (lines 208-212) and returned to the parent's `AgentTool` as a `tool_result`.

What's missing is the last 20% that turns "works in practice" into "satisfies the verification contract literally":

1. **Defense-in-depth at the permission layer.** Today the subagent's tool subset is enforced **only** by `buildFilteredRegistry()`. The model never sees the tool, so it can't call it. But the cascade itself doesn't know about the subagent scope: `runAgent.ts:134` reuses `opts.permissionOpts` verbatim, and `scopedToolAllowlist` is `undefined` unless a skill is active. If a tool ever leaked through (a future PreToolUse hook rewrite, a manually-injected `tool_use`, a registry regression), the cascade has nothing to deny it with.
2. **Named primitive: `sandboxContext.ts`.** The roadmap lists it as a deliverable. Today the fork-context construction is inlined inside `createForkSubagent`'s closure. Extracting it gives Phase 7b (parallel fan-out) and Phase 7c (nested audit correlation) a stable surface to depend on, and lets unit tests exercise the isolation primitive without spinning up the full query loop.
3. **Test asserting the verification clause literally fires.** The current tests prove the registry filter works (model can't see the tool) but don't prove a permission-layer deny.

## The three load-bearing decisions

### 1. The pre-resolution gate is the load-bearing fix, not the cascade extension

A naive read of "denied at the permission layer" suggests: extend `permissions.ts` with a new `agentScope` reason variant, thread the subagent's `allowedTools` into `PermissionOptions.scopedToolAllowlist`, done. That's necessary, but it isn't sufficient.

`src/core/tools/runToolUse.ts:55-61` resolves the tool from `context.toolRegistry` **before** the permission cascade runs:

```ts
// 2. Resolve tool — NOT a policy decision.
const tool = context.toolRegistry.get(toolUse.name)
if (!tool) {
  return precondition(
    makeErrorResult('tool_not_found', `Tool "${toolUse.name}" not found`),
  )
}
// ...
// 5. Check permissions via engine — this is the actual policy decision.
const decision = await hasPermissionsToUseTool(tool, toolUse, context, permissionOpts)
```

With a filtered subagent registry, an out-of-scope `Glob` call short-circuits at step 2 as a `tool_not_found` **precondition failure**. The cascade never runs. No `permission_decision` event, no `agentScope` reason, no audit row. The verification clause would not be literally true.

The fix is a **pre-resolution gate** in `authorizeToolUse`. Extract a helper from the cascade:

```ts
// src/core/permissions/permissions.ts
export function checkScopedAllowlist(
  toolName: string,
  opts: PermissionOptions,
): PermissionDecision | null {
  if (
    opts.scopedToolAllowlist !== undefined &&
    !opts.scopedToolAllowlist.includes(toolName)
  ) {
    return {
      behavior: 'deny',
      reason: opts.scopeSource === 'agent'
        ? { type: 'agentScope', toolName, allowed: opts.scopedToolAllowlist }
        : { type: 'skillScope', toolName, allowed: opts.scopedToolAllowlist },
    }
  }
  return null
}
```

Insert step-1.5 in `authorizeToolUse`, **before** the registry resolve:

```ts
// 1.5. Pre-resolution scope gate — a scoped allowlist deny is a policy
//      decision, not a precondition failure. Without this, a filtered
//      subagent registry would surface as tool_not_found instead of
//      agentScope.
const scopeDecision = checkScopedAllowlist(toolUse.name, permissionOpts)
if (scopeDecision !== null) {
  const reason = formatDecisionMessage(scopeDecision)
  return denied(
    { decision: 'deny', reason },
    makeErrorResult('permission_denied', reason),
  )
}
```

The cascade-internal step-1.5 (currently `permissions.ts:76-88`) stays — it delegates to the same helper. Two reasons to keep both:

- Direct callers of `hasPermissionsToUseTool` (notably `permissions.test.ts`) still need the engine itself to enforce scope when given a resolved tool object.
- The helper-and-call structure makes the deny shape provably identical at both layers — there's only one place where the reason variant is constructed.

This is a strictly tighter version of Phase 5b's two-layer pattern. Phase 5b put the second layer **inside** the cascade (sufficient for skills, where the registry is unfiltered and every tool resolves). Phase 7a needs the second layer **before** registry resolution because the subagent registry is intentionally filtered. The earlier placement is a superset of the later one — it covers Phase 5b's scope too. Phase 5b's existing tests stay green either way (all skill activation runs use the parent's full registry, so the gate at step 1.5 of `authorizeToolUse` and the gate inside the cascade are functionally equivalent for skills; both delegate to the same helper).

### 2. `agentScope` is a separate reason variant from `skillScope`

The mechanism is identical: deny if `toolUse.name ∉ scopedToolAllowlist`. The **source** isn't:

- `skillScope` denies are user-driven (the user activated a skill that narrows the tool list). Audit consumers may want to surface "skill X is restricting your tools."
- `agentScope` denies are runtime-driven (a subagent is running with a hardcoded subset). The user didn't ask for the narrowing — they asked the agent to do something, and the agent runtime constrained the subagent's scope.

Three reasons to preserve the distinction:

1. **Audit clarity.** A `permission_decision` event with `reason.type: 'agentScope'` tells a log reader "this happened inside a forked subagent context" without needing to correlate against `origin: <subagentId>`. (Phase 7c will add full correlation; until then, the reason variant is the cheapest signal.)
2. **User-facing message.** `formatDecisionMessage` should produce different copy for the two cases. Skill-scope: "tool not in active skill's allowed-tools." Agent-scope: "tool not in subagent's allowed tools."
3. **Future-proofing.** If a future phase wants to ship a slash command that lists active scope sources (e.g. `/scope`), the type discriminator is already in place.

Cost of distinction: one new field on `PermissionOptions` (`scopeSource?: 'skill' | 'agent'`, default behaves as `'skill'` for back-compat), one new reason variant, one new arm in `formatDecisionMessage`. Phase 5b stays byte-identical because `scopeSource` is undefined on its calls.

The rejected alternative — renaming `skillScope` → generic `scopedAllowlist` — would ripple through Phase 5b's tests, the decision-message formatter, and any audit-log readers that already pattern-match on the literal string `'skillScope'`. Cleaner long-term but defer to a separate cleanup phase if it ever happens.

### 3. Effective allowed-tools is one list, computed once, used by both consumers

Surfaced in review of the first implementation pass. The naive form ("subagent's `scopedToolAllowlist` = the requested `allowedTools`") has two failure modes:

1. **Parent-scope superset.** If the parent is already running inside a scoped activation — most commonly a skill restricting the parent to `['FileRead']` — and the subagent's requested `allowedTools` is the default `['FileRead', 'Glob', 'Grep']`, a naive override would *widen* the parent's scope. The roadmap's "subset of parent's tools, never superset" contract would be violated.
2. **Registry/scope disagreement.** `buildFilteredRegistry` always drops `Agent` (no recursive subagents). If the scope list still contained `Agent`, an emitted `Agent` tool_use would pass the pre-resolution gate (because the name is in the allowlist) and then fail at registry resolve as `tool_not_found` — not as the `agentScope` deny the verification clause expects.

Fix: compute the **effective** allowed-tools list once via `computeEffectiveAllowedTools(requested, parentScope)` and use it for both the filtered registry **and** the `scopedToolAllowlist` carried on the permission opts. The helper is pure:

```ts
export function computeEffectiveAllowedTools(
  requested: readonly string[],
  parentScope: readonly string[] | undefined,
): readonly string[] {
  const effective: string[] = []
  for (const name of requested) {
    if (name === AGENT_TOOL_NAME) continue              // (no recursion)
    if (parentScope !== undefined && !parentScope.includes(name)) continue
    effective.push(name)
  }
  return effective
}
```

- Drops `Agent` unconditionally (no recursion).
- Intersects with `parentScope` when the parent is already scoped (`parentScope = undefined` is the unscoped case → identity).

Two properties fall out:

- **Subset invariant** "subagent ⊆ parent ⊆ … ⊆ root" is provable from the helper alone — once Phase 7b/7c lands nested forks, the same helper composes by induction.
- **Registry/scope agreement** is guaranteed by construction: both consumers read from the same list, so an emitted `Agent` (or any other dropped name) lands an `agentScope` deny instead of a `tool_not_found` precondition.

There's also a related ordering decision in `createSandboxContext`: the parent-abort `addEventListener` happens **last**, after all the synchronous setup (`createStore`, `buildFilteredRegistry`, `withOrigin`). That way, if any prior step throws, the listener was never attached and there's nothing to leak — no `try { addEventListener } catch { removeEventListener }` dance needed.

## Architecture

### `src/agents/sandboxContext.ts` — new factory

A pure construction function. No I/O, no event streaming, no transcript writing. Returns the bundle of state the fork loop needs:

```ts
export type SandboxContext = {
  readonly appState: Store<AppState>
  readonly readFileState: ReadFileState
  readonly toolRegistry: ToolRegistry
  readonly abortController: AbortController
  readonly permissionOpts: PermissionOptions
  readonly auditWriter: AuditWriter // already origin-tagged
  readonly cleanup: () => void      // detach parent-abort listener
}

export function createSandboxContext(opts: {
  parentAppState: Store<AppState>
  parentToolRegistry: ToolRegistry
  parentSignal: AbortSignal
  parentPermissionOpts: PermissionOptions
  parentAuditWriter: AuditWriter
  allowedTools: readonly string[]
  subagentId: string
}): SandboxContext
```

Internals lift verbatim from `runAgent.ts:104-123, 175`:

- Compute the effective allowed-tools list via `computeEffectiveAllowedTools` (intersect parent scope, drop `Agent`).
- Clone `AppState` via `createStore({ ...parent })`.
- Fresh `ReadFileState = new Map()`.
- Filtered `ToolRegistry` via `buildFilteredRegistry(parent, effective)` (move the helper into this module; `runAgent.ts` re-exports for the existing test).
- `permissionOpts` = parent's plus `scopedToolAllowlist: effective` and `scopeSource: 'agent'`.
- `auditWriter` = `parentAuditWriter.withOrigin(subagentId)`.
- New `AbortController` linked to `parentSignal`, **registered last** so any throw during the synchronous setup above can never leak the listener. `cleanup()` detaches it; `runAgent.ts`'s `finally` block calls it.

`createForkSubagent` collapses to: build sandbox via `createSandboxContext`, build `toolUseContext` from sandbox, build `authorizeToolUse`/`executeToolUse`, run `query()`. External shape unchanged.

### `src/core/tools/runToolUse.ts` — pre-resolution gate

One new step (step 1.5) between abort check and registry resolve. Calls `checkScopedAllowlist` and short-circuits with a permission-denied synthetic result if the helper returns a decision.

### `src/core/permissions/permissions.ts` — extracted helper + reason variant

- New exported `checkScopedAllowlist(toolName, opts) → PermissionDecision | null`.
- Cascade step-1.5 (lines 76-88) delegates to it.
- New `'agentScope'` arm in `PermissionDecisionReason` and `formatDecisionMessage`.

### `src/core/permissions/types.ts` — type additions

```ts
export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'safetyCheck'; message: string }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'toolCheck'; message: string }
  | { type: 'toolCheck' }
  | { type: 'headlessEscalation'; original: PermissionDecisionReason }
  | { type: 'skillScope'; toolName: string; allowed: readonly string[] }
  | { type: 'agentScope'; toolName: string; allowed: readonly string[] } // NEW
  | { type: 'fallback' }

export type PermissionOptions = {
  headless: boolean
  safetyChecks: SafetyCheck[]
  askUser?: AskUserFn
  scopedToolAllowlist?: readonly string[]
  scopeSource?: 'skill' | 'agent' // NEW — defaults to 'skill' behavior
}
```

### `src/agents/runAgent.ts` — rewire

Lines 104-123 replaced by a single `createSandboxContext` call. Permission opts threaded through the sandbox carry the new `scopedToolAllowlist` + `scopeSource: 'agent'`. Pass the sandbox's `permissionOpts` into `createAuthorizeToolUseFn` instead of `opts.permissionOpts`. Remove the inlined `buildFilteredRegistry` (moved into `sandboxContext.ts`).

## Edits and surfaces touched

| Path | Change |
|---|---|
| `src/core/permissions/types.ts` | +`scopeSource?: 'skill' \| 'agent'`; +`'agentScope'` reason variant |
| `src/core/permissions/permissions.ts` | New exported `checkScopedAllowlist`; cascade step-1.5 delegates; `formatDecisionMessage` gets `'agentScope'` arm |
| `src/core/tools/runToolUse.ts` | New step-1.5 in `authorizeToolUse` before registry resolve |
| `src/core/permissions/permissions.test.ts` | Sibling `agentScope` describe block + `checkScopedAllowlist` helper tests + `formatDecisionMessage` arm |
| `src/core/tools/runToolUse.test.ts` | Three new tests: agentScope deny before resolve, skillScope deny before resolve (back-compat), undefined-scope is a no-op |
| `src/agents/sandboxContext.ts` | **NEW** — `createSandboxContext()` factory + `computeEffectiveAllowedTools` helper; lifted `buildFilteredRegistry` here |
| `src/agents/sandboxContext.test.ts` | **NEW** — `computeEffectiveAllowedTools` property tests (parent-scope intersection, Agent dropped); sandbox agreement (registry matches scope); appState clone isolation; abort cascade; cleanup detaches listener |
| `src/agents/runAgent.ts` | Replace inlined construction with `createSandboxContext`; subagent's `permissionOpts` now carry `scopedToolAllowlist: effective` + `scopeSource: 'agent'` |
| `src/agents/runAgent.test.ts` | +3 tests: out-of-scope tool denies as `agentScope` (not `tool_not_found`); `Agent` tool_use denies as `agentScope`; subagent cannot widen the parent's `scopedToolAllowlist` |
| `docs/ultron_v2/phase7a-v2-design.md` | This file. |

Reused (no changes): `buildSubagentSystemPrompt`, `getInitialAttachments`, `createCompactFn`, `appendMessage` / `getEventMessage`, `auditWriter.withOrigin`, `query()` itself, `DEFAULT_ALLOWED_TOOLS = ['FileRead', 'Glob', 'Grep']`, the `Agent`-tool exclusion logic.

## Test plan

End-to-end check sequence (all green at time of writing — 105 files, 1506 passing, 1 skipped):

1. `npm run typecheck` clean.
2. `npm run test` — every pre-existing suite stays green. `skillScope` behavior is byte-identical because `scopeSource` defaults to skill semantics.
3. **Permission engine** (`src/core/permissions/permissions.test.ts`): new `agentScope` describe block mirroring the skill-scope cases (in/out of allowlist, empty list denies all, explicit user-deny still wins, `bypassPermissions` overridden, omitting `scopeSource` defaults to `skillScope`); standalone `checkScopedAllowlist` helper tests; `formatDecisionMessage` `agentScope` arm.
4. **`authorizeToolUse`** (`src/core/tools/runToolUse.test.ts`): regression-guard for the pre-resolution gate. With a registry that does NOT contain `Glob` and `scopedToolAllowlist: ['FileRead']` + `scopeSource: 'agent'`, returns outcome `'denied'` with the `agentScope` formatted reason — explicitly **not** `tool_not_found`. Sibling test pins the skill default. Third test asserts undefined scope is a no-op (falls through to the normal resolve step).
5. **`sandboxContext`** (`src/agents/sandboxContext.test.ts`, new file): `computeEffectiveAllowedTools` properties — passthrough when parent unscoped, `Agent` always dropped (even when present in `parentScope`), intersection narrows, empty parent denies all, request order preserved. `createSandboxContext` agreement — `scopedToolAllowlist` exactly matches the filtered registry; intersects with parent scope. `AppState` clone isolation. Abort cascade. `cleanup()` detaches listener (post-cleanup parent abort does not flip the child).
6. **End-to-end subagent** (`src/agents/runAgent.test.ts`): three new integration tests using a `tool_use → end_turn` `callModel` and a capturing audit writer. (a) Out-of-scope `Glob` produces a `permission_decision` event with `reason` containing `"subagent's allowed tools"` and a `permission_denied` synthetic — not `tool_not_found`. (b) `Agent` requested in `allowedTools` denies as `agentScope`, proving the registry/scope-agreement fix. (c) Parent under a skill activation (`scopedToolAllowlist: ['FileRead']`) cannot be widened by a subagent requesting the default trio; `Glob` denies as `agentScope`.
7. Existing test "subagent's mutations don't leak to parent appState" stays green — the sandbox factory's `createStore({ ...parent })` clone is the same operation.
8. Manual sanity: run a quick local `Agent` invocation, confirm parent transcript and `~/.ultron/audit.jsonl` events are unchanged in shape; subagent events still carry `origin: <subagentId>`.

## Compatibility note for Phase 7b/7c

`createSandboxContext` is the seam Phase 7b (parallel fan-out) and Phase 7c (nested audit correlation) extend:

- **7b** can wrap N `createSandboxContext` calls in a `Promise.all` for read-only subagents (no write-capable tools in their `allowedTools`). The factory's pure-construction property — no shared mutable state across calls — makes parallelization free.
- **7c** can extend the factory's `parentAuditWriter.withOrigin(subagentId)` line to also stamp `parentCorrelationId` into every event. The `'agentScope'` reason variant is already in place to be picked up by the tree-rendering test fixture.
- **Nested forks (the eventual case where a subagent forks its own subagent — gated behind future work; today `Agent` is excluded from subagent registries).** When that lands, `computeEffectiveAllowedTools` becomes load-bearing: each level passes its `effectiveAllowedTools` as the next level's `parentScope`, so the subset invariant "leaf ⊆ … ⊆ root" composes by induction. The helper is already pure and exhaustively tested — no additional logic required at the recursion site.

## Does NOT do

Per `v2-ROADMAP.md §7a` "Does NOT do" gate:

- Parallel fan-out (Phase 7b).
- Nested audit correlation `parentCorrelationId` (Phase 7c). Today the audit writer's `withOrigin(subagentId)` stamp is sufficient.
- Recursive subagents — `Agent` is excluded from the filtered registry; keep it that way.
- Subagent-to-subagent communication.
- Renaming `skillScope` → a fully-generic `scopedAllowlist` reason. Defer to a separate cleanup phase if pursued.
