# Phase 4 Design: Permission Engine

## Overview

Phase 4 adds a centralized policy engine that owns the permission decision for every tool call. Currently, `runToolUse()` calls `tool.checkPermissions()` directly — each tool is its own authority. Phase 4 inserts `hasPermissionsToUseTool()` between the execution pipeline and the tool, implementing a fixed decision cascade that considers deny rules, ask rules, tool-specific checks, safety checks, permission mode, and a fallback. Every decision carries a structured reason for auditability.

Two new files, plus modifications to `runToolUse.ts` and `state.ts`.

---

## Architecture

```
runToolUse()  step 5 (was: tool.checkPermissions())
        |
        v
hasPermissionsToUseTool(tool, toolUse, context, opts)
        |
        +-- 1. Explicit deny rules           → deny
        +-- 2. Explicit ask rules            → ask
        +-- 3. tool.checkPermissions()       → allow/deny/ask/passthrough
        +-- 4. Safety checks (non-bypassable) → allow/ask/deny or null
        +-- 5. Mode-based resolution          → bypass/acceptEdits auto-allow
        +-- 6. Fallback                       → ask
        |
        v
    PermissionDecision { behavior, reason }
        |
        +-- if headless && behavior === 'ask'
        |       → escalate to deny, preserve original reason
        v
    Final PermissionDecision
```

`runToolUse.ts` is the sole call site. Tools still implement `checkPermissions()` for tool-specific logic, but the engine wraps that call and applies policy around it.

---

## Types (`src/core/permissions/types.ts`)

### Permission Rule

```typescript
type PermissionRuleBehavior = 'allow' | 'deny' | 'ask'

type PermissionRuleSource = 'userSettings' | 'projectSettings' | 'session' | 'cliArg'

type PermissionRule = {
  toolName: string              // exact tool name match
  behavior: PermissionRuleBehavior
  path?: string                 // optional exact path match (not a glob)
  source: PermissionRuleSource
}
```

- `toolName` is required — no global wildcard rules yet.
- `path` is an exact string match, used only when the tool has a `getPath()` method. Named `path`, not `pathPattern` — it's not a glob. Phase 5 brings real path matching.
- `source` tracks where the rule came from, for audit and conflict resolution.

### Permission Decision

```typescript
type PermissionDecision = {
  behavior: PermissionRuleBehavior
  reason: PermissionDecisionReason
}

type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'safetyCheck'; message: string }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'toolCheck'; message: string }
  | { type: 'toolCheck' }                       // tool returned allow with no message
  | { type: 'headlessEscalation'; original: PermissionDecisionReason }
  | { type: 'fallback' }
```

Every decision carries a reason. When headless mode escalates "ask" to "deny", the original reason is preserved inside `headlessEscalation` so audit trails are not destroyed.

### Safety Check

```typescript
type SafetyCheck = (
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
) => PermissionDecision | null
```

Returns a `PermissionDecision` if it has an opinion, `null` if it doesn't apply. Safety checks can return any behavior (allow/ask/deny). Phase 4 ships with an empty safety checks array. Phase 5 plugs in filesystem checks.

### Permission Options

```typescript
type PermissionOptions = {
  headless: boolean
  safetyChecks: SafetyCheck[]
}
```

Runtime execution flags that don't belong in `AppState`. Passed into `hasPermissionsToUseTool()` alongside context.

---

## Cascade Logic (`src/core/permissions/permissions.ts`)

### Signature

```typescript
function hasPermissionsToUseTool(
  tool: Tool,
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  opts: PermissionOptions,
): Promise<PermissionDecision>
```

### Decision Steps

**Step 1: Explicit deny rules**

Find all rules in `AppState.permissionRules` matching `toolUse.name` (and `path` if rule has one and tool has `getPath()`). If any rule has `behavior: 'deny'`, return immediately with `{ behavior: 'deny', reason: { type: 'rule', rule } }`.

Deny rules always win. They cannot be overridden by mode, tool checks, or anything else.

**Step 2: Explicit ask rules**

Same matching. If any rule has `behavior: 'ask'`, return `{ behavior: 'ask', reason: { type: 'rule', rule } }`.

Ask rules override bypass mode. This is intentional — if someone explicitly marks a tool as "ask", bypass should not silently allow it.

**Step 3: Tool-specific permission check**

Call `tool.checkPermissions(toolUse.input, context)`. The tool returns `PermissionResult`:

- `{ behavior: 'deny' }` → return deny with `{ type: 'toolCheck', message }`
- `{ behavior: 'ask' }` → return ask with `{ type: 'toolCheck', message }`
- `{ behavior: 'allow' }` → continue (tool says OK, but policy may still intervene)

This preserves tool-level authority for tool-specific concerns (e.g., a bash tool checking for dangerous commands) while letting the engine override with broader policy.

**Step 4: Safety checks (non-bypassable)**

Iterate `opts.safetyChecks`. First non-null result wins. Safety checks run regardless of permission mode — `bypassPermissions` does not skip them.

If a safety check returns `ask` or `deny`, that's the decision. If all return `null`, continue.

**Step 5: Mode-based resolution**

Read `context.appState.getState().permissionMode`:

- `bypassPermissions` → return `{ behavior: 'allow', reason: { type: 'mode', mode: 'bypassPermissions' } }`
- `acceptEdits` → if the tool has `getPath()` (i.e., it's a file operation), return allow with mode reason. Otherwise, continue to fallback.
- `default` → continue to fallback.

**Step 6: Explicit allow rules**

Check for `behavior: 'allow'` rules matching this tool (and path). If found, return allow with rule reason.

**Step 7: Fallback**

Return `{ behavior: 'ask', reason: { type: 'fallback' } }`.

When in doubt, ask.

### Headless Escalation

After the cascade produces a decision, if `opts.headless === true` and `behavior === 'ask'`:

```typescript
return {
  behavior: 'deny',
  reason: { type: 'headlessEscalation', original: decision.reason },
}
```

This is a boundary transformation, not part of the cascade. The original reason is preserved.

### Rule Matching (inline)

Rule matching is a simple filter, not a separate file:

```typescript
function findMatchingRules(
  rules: PermissionRule[],
  toolName: string,
  path: string | undefined,
): PermissionRule[]
```

Match on exact `toolName`. If the rule has a `path`, match on exact string equality with the tool's resolved path. If the rule has no `path`, it matches all invocations of that tool.

This stays inside `permissions.ts` until Phase 5 introduces glob/prefix matching.

---

## Integration Changes

### `runToolUse.ts` — step 5 modification

Before (Phase 3):
```typescript
// 5. Check permissions
const permission = await tool.checkPermissions(toolUse.input, context)
if (permission.behavior === 'deny') { ... }
if (permission.behavior === 'ask') { ... }
```

After (Phase 4):
```typescript
// 5. Check permissions via engine
const decision = await hasPermissionsToUseTool(tool, toolUse, context, permissionOpts)
if (decision.behavior === 'deny') {
  return makeErrorResult('permission_denied', formatDecisionMessage(decision))
}
if (decision.behavior === 'ask') {
  return makeErrorResult('permission_ask', formatDecisionMessage(decision))
}
```

`permissionOpts` comes from... where? Two options:

- **Option A**: Add `permissionOpts: PermissionOptions` to `ToolUseContext`. But we said ToolUseContext shouldn't hold policy data.
- **Option B**: `runToolUse()` takes an additional parameter.

I'll go with **Option B**: `runToolUse()` gains an optional `permissionOpts` parameter with a sensible default (`{ headless: false, safetyChecks: [] }`). Callers that don't care about permissions (tests, simple scripts) don't need to change.

```typescript
async function runToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
  permissionOpts?: PermissionOptions,
): Promise<ToolResult>
```

### `state.ts` — add rules to AppState

```typescript
type AppState = {
  readonly permissionMode: PermissionMode
  readonly permissionRules: PermissionRule[]   // new
}
```

Rules are config/policy data. They belong in AppState. Default: `[]`.

### `toolExecution.ts` — thread permissionOpts through adapter

```typescript
function createRunToolFn(context: ToolUseContext, permissionOpts?: PermissionOptions): RunToolFn
```

---

## What Phase 4 Does NOT Do

- **No persistence.** Rules are in-memory. Session persistence is Phase 10.
- **No interactive prompt UI.** "ask" decisions return as error results. Approval UX is Phase 11.
- **No filesystem safety checks.** The `safetyChecks` array ships empty. Phase 5 fills it.
- **No glob/prefix path matching.** `path` on rules is exact string match only.
- **No global wildcard rules.** Every rule requires a `toolName`.
- **No hooks.** No pre-permission hooks or `PermissionRequest` hook system.
- **No auto-mode / AI classifier.** The reference codebase has an `auto` mode that routes to an AI classifier. We don't need that yet.

---

## File Map

| File | Responsibility | New/Modified |
|------|---------------|-------------|
| `src/core/permissions/types.ts` | `PermissionRule`, `PermissionDecision`, `PermissionDecisionReason`, `SafetyCheck`, `PermissionOptions` | New |
| `src/core/permissions/permissions.ts` | `hasPermissionsToUseTool()`, `findMatchingRules()`, `formatDecisionMessage()` | New |
| `src/core/permissions/permissions.test.ts` | Full cascade coverage | New |
| `src/core/tools/runToolUse.ts` | Step 5 calls `hasPermissionsToUseTool()` instead of `tool.checkPermissions()` | Modified |
| `src/core/tools/runToolUse.test.ts` | Existing permission tests still pass; new tests for engine integration | Modified |
| `src/core/state.ts` | `AppState` gains `permissionRules` | Modified |
| `src/core/tools/toolExecution.ts` | `createRunToolFn()` threads `permissionOpts` | Modified |

---

## Implementation Order

1. `src/core/permissions/types.ts` — no deps on other new files
2. `src/core/state.ts` — add `permissionRules` to `AppState`
3. `src/core/permissions/permissions.ts` — imports types.ts, state.ts, tool types
4. `src/core/permissions/permissions.test.ts` — test cascade in isolation
5. `src/core/tools/runToolUse.ts` — swap in engine call
6. `src/core/tools/toolExecution.ts` — thread opts through adapter
7. Update existing tests as needed

---

## Verification Criteria

1. **Deny rule always wins** — deny rule present → deny, regardless of mode or tool opinion
2. **Ask rule overrides bypass** — explicit ask rule → ask, even in `bypassPermissions` mode
3. **Tool-specific deny respected** — `tool.checkPermissions()` returns deny → deny
4. **Safety check blocks in bypass mode** — safety check returns deny → deny, even with `bypassPermissions`
5. **`bypassPermissions` auto-allows** — no deny/ask rules, no safety concern → allow with mode reason
6. **`acceptEdits` allows file tools** — tool with `getPath()` → allow; tool without → fallback to ask
7. **`default` mode falls through to ask** — no matching rules, no tool objection → ask with fallback reason
8. **Allow rule matches** — explicit allow rule → allow without falling to ask
9. **Headless escalation** — ask decision + headless → deny with `headlessEscalation` reason preserving original
10. **Headless does not affect allow/deny** — only "ask" is escalated
11. **Rule path matching** — rule with `path` only matches when tool's `getPath()` returns that exact path
12. **Rule without path** — matches all invocations of that tool name
13. **Every decision has a reason** — no decision returned without a `reason` field
14. **Existing `runToolUse` tests still pass** — backward compatible for tools with no rules/engine

All tests use in-memory constructs. No API calls, no filesystem access.

---

## Downstream Consumers

- **Phase 5** (Filesystem Safety) — plugs real `SafetyCheck` functions into the `safetyChecks` array
- **Phase 6** (Tool Implementations) — tools implement `checkPermissions()` for tool-specific concerns; engine wraps them
- **Phase 10** (Session Persistence) — persists `permissionRules` to disk
- **Phase 11** (Approval UX) — wires "ask" decisions into interactive prompts instead of returning error results
