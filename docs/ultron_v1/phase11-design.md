# Phase 11: Add Approval UX

## Context

The permission engine (Phases 4-6) already makes `allow`/`deny`/`ask` decisions through a 7-step cascade. But when the decision is `ask`, `runToolUse` currently returns `makeErrorResult('permission_ask', message)` — the tool fails, and the model sees the denial. There's no way for the user to approve or deny the action.

Phase 11 closes this loop: when a tool needs approval, prompt the user, let them allow or deny, optionally persist the decision as a rule, and log everything.

## Key Design Decisions

1. **`askUser` and `logDecision` injected via `PermissionOptions`.** `PermissionOptions` gains two optional callbacks: `askUser?: AskUserFn` and `logDecision?: LogPermissionDecisionFn`. This keeps `runToolUse` as the orchestrator without coupling it to CLI I/O or disk. The CLI layer provides real implementations; tests and SDK callers provide mocks or omit them.

2. **`askUser` lives in `runToolUse`, not in the query loop.** The query loop doesn't know about permissions — it just calls `deps.runTool(toolUse, signal)`. The `runToolUse` function already makes the permission decision. Adding the approval prompt there keeps the boundary clean.

3. **Preserve `permission_ask` when `askUser` is absent.** If the permission engine returns `ask` and no `askUser` callback exists, return `permission_ask` (unchanged from current behavior). Headless mode already converts `ask` → `deny` upstream in the cascade via `headlessEscalation`. A missing `askUser` in non-headless mode means the caller (e.g. SDK) is handling approvals externally — `permission_ask` is the correct signal.

4. **Distinguish abort from explicit denial.** `AskUserFn` returns a 4-value union: `'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'`. Ctrl+C / abort signal during the prompt returns `'abort'`, which maps to `makeAbortResult()` (existing helper). This is semantically different from "user reviewed and denied." Logged differently too.

5. **Arrow-key selector prompt.** The CLI prompt uses raw-mode terminal input with an arrow-key selector:

   ```
   ─── Permission Required ───
   Tool:   FileWrite
   Path:   /Users/foo/bar.ts
   Reason: no matching rule; requires approval

   > Deny once       ← default selection
     Allow once
     Allow by rule
   ```

   Up/Down moves selection, Enter confirms. Default selection is **Deny once** (safe default). No single-keystroke shortcuts — explicit selection prevents accidental approvals.

6. **Separate rendering from terminal I/O.** `formatApprovalPrompt()` is a pure function that returns the formatted prompt string (minus the selector). `promptForApproval()` handles raw-mode keypress input with injectable reader/writer for testability. Tests verify formatting independently from I/O.

7. **Permission logging is injected, not hardwired.** `logDecision?: LogPermissionDecisionFn` on `PermissionOptions`. The production implementation writes structured JSONL to `~/.ultron/permissions.jsonl`. `runToolUse` calls `logDecision` if provided — it doesn't import filesystem logging directly. This keeps the core permission boundary decoupled from disk I/O.

8. **`allow_by_rule` is exact-match only.** Session rule is `toolName` + exact resolved path (from `tool.getPath(input)`). No directory-wide, prefix-wide, or glob expansion in v1. If the tool has no path (e.g. Bash), the rule matches on `toolName` alone.

9. **Session-scoped rules only.** `allow_by_rule` creates a `PermissionRule` with `source: 'session'`, stored in `AppState.permissionRules`. Not persisted across sessions for v1.

## Architecture

```
src/ui/
  permissionPrompt.ts   — formatApprovalPrompt() (pure), promptForApproval() (I/O),
                           ApprovalResponse type, TerminalIO interface
src/core/permissions/
  logging.ts            — logPermissionDecision() (JSONL writer), PermissionLogEntry type,
                           LogPermissionDecisionFn type
```

Changes to existing files:
- `src/core/permissions/types.ts` — add `AskUserFn`, `LogPermissionDecisionFn`, update `PermissionOptions`
- `src/core/tools/runToolUse.ts` — handle `ask` via `askUser` callback, call `logDecision`

## Files to Create

### `src/ui/permissionPrompt.ts`

**Purpose:** CLI approval prompt — pure formatting + interactive arrow-key selector.

```typescript
export type ApprovalAction = 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'

/** Injectable terminal I/O for testability. */
export type TerminalIO = {
  readonly input: NodeJS.ReadableStream
  readonly output: NodeJS.WritableStream
}

export function formatApprovalPrompt(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
): string

export function promptForApproval(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
  io?: TerminalIO,  // defaults to process.stdin/stdout
): Promise<ApprovalAction>
```

**`formatApprovalPrompt` (pure):** Builds a multi-line string showing:

```
─── Permission Required ───
Tool:   FileWrite
Path:   /Users/foo/bar.ts
Reason: no matching rule; requires approval
```

Input display is tool-aware:
- File tools (`FileRead`, `FileWrite`, `FileEdit`): show `file_path`
- `Bash`: show `command` (truncated to 120 chars)
- `Grep`/`Glob`: show `pattern` + `path`
- Others: show first 120 chars of JSON-stringified input

**`promptForApproval` (I/O):** Renders the formatted prompt + arrow-key selector to the output stream. Enters raw mode on the input stream. Listens for:
- Up/Down arrows: move selection
- Enter: confirm selected option
- Ctrl+C / abort signal: return `'abort'`

Default selection is **Deny once** (index 0). Options order: Deny once, Allow once, Allow by rule.

**Tests (co-located):**
- `formatApprovalPrompt` includes tool name, reason
- `formatApprovalPrompt` shows `file_path` for file tools
- `formatApprovalPrompt` shows `command` for Bash (truncated)
- `formatApprovalPrompt` shows pattern for Grep
- `formatApprovalPrompt` truncates long inputs
- `promptForApproval` with mock TerminalIO: Enter on default → `deny_once`
- `promptForApproval` with mock TerminalIO: Down + Enter → `allow_once`
- `promptForApproval` with mock TerminalIO: Down + Down + Enter → `allow_by_rule`
- `promptForApproval` with aborted signal → `abort`

### `src/core/permissions/logging.ts`

**Purpose:** Structured audit log for permission decisions + production `LogPermissionDecisionFn`.

```typescript
import type { PermissionRule } from './types.js'

export type PermissionLogEntry = {
  readonly timestamp: number
  readonly toolName: string
  readonly inputSummary: string
  readonly decision: 'allow' | 'deny' | 'ask'
  readonly reason: string
  readonly userResponse?: 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'
  readonly ruleCreated?: PermissionRule
}

/** Summarize tool input for logging (file_path, command prefix, or truncated JSON). */
export function summarizeInput(toolName: string, input: Record<string, unknown>): string

/** Production log writer — appends JSONL to ~/.ultron/permissions.jsonl. */
export function createPermissionLogger(logDir?: string): LogPermissionDecisionFn
```

- `createPermissionLogger` returns a function matching `LogPermissionDecisionFn`
- Appends one JSON line to `<logDir>/permissions.jsonl` (default `~/.ultron/`)
- Creates directory if needed
- Never throws — swallows errors with stderr warning (same pattern as `appendMessage`)
- `summarizeInput` is also exported for use in `runToolUse`

**Tests (co-located):**
- `summarizeInput` returns file_path for file tools
- `summarizeInput` returns command prefix for Bash
- `summarizeInput` truncates long values
- `createPermissionLogger` writes valid JSONL to temp directory
- `createPermissionLogger` creates directory if missing
- `createPermissionLogger` swallows write errors gracefully

## Files to Modify

### `src/core/permissions/types.ts`

**Add types and update `PermissionOptions`:**

```typescript
/** Callback to prompt the user for a permission decision. */
export type AskUserFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
) => Promise<'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'>

/** Callback to log a permission decision for audit. */
export type LogPermissionDecisionFn = (
  entry: import('./logging.js').PermissionLogEntry,
) => Promise<void>

export type PermissionOptions = {
  headless: boolean
  safetyChecks: SafetyCheck[]
  askUser?: AskUserFn
  logDecision?: LogPermissionDecisionFn
}
```

### `src/core/tools/runToolUse.ts`

**Change the `ask` path:**

Current (returns error immediately):
```typescript
if (decision.behavior === 'ask') {
  return makeErrorResult('permission_ask', formatDecisionMessage(decision))
}
```

New:
```typescript
if (decision.behavior === 'ask') {
  if (!permissionOpts.askUser) {
    // No prompt function — preserve permission_ask for external handling
    return makeErrorResult('permission_ask', formatDecisionMessage(decision))
  }

  const reason = formatDecisionMessage(decision)
  const response = await permissionOpts.askUser(toolUse.name, toolUse.input, reason, signal)

  // Log the decision (if logger provided)
  if (permissionOpts.logDecision) {
    await permissionOpts.logDecision({
      timestamp: Date.now(),
      toolName: toolUse.name,
      inputSummary: summarizeInput(toolUse.name, toolUse.input),
      decision: 'ask',
      reason,
      userResponse: response,
      ...(response === 'allow_by_rule' && {
        ruleCreated: {
          toolName: toolUse.name,
          behavior: 'allow' as const,
          ...(tool.getPath?.(toolUse.input) && { path: tool.getPath(toolUse.input) }),
          source: 'session' as const,
        },
      }),
    })
  }

  if (response === 'abort') {
    return makeAbortResult()
  }

  if (response === 'deny_once') {
    return makeErrorResult('permission_denied', `User denied: ${reason}`)
  }

  if (response === 'allow_by_rule') {
    // Persist exact-match rule to AppState for this session
    const rule: PermissionRule = {
      toolName: toolUse.name,
      behavior: 'allow',
      ...(tool.getPath?.(toolUse.input) && { path: tool.getPath(toolUse.input) }),
      source: 'session',
    }
    const currentRules = context.appState.getState().permissionRules
    context.appState.setState({ permissionRules: [...currentRules, rule] })
  }

  // allow_once or allow_by_rule — fall through to execution
}
```

**No change to existing behavior when `askUser` is absent** — the `permission_ask` error result is returned unchanged. Existing tests pass without modification.

## Implementation Order

1. `src/core/permissions/types.ts` — add `AskUserFn`, `LogPermissionDecisionFn`, update `PermissionOptions`
2. `src/core/permissions/logging.ts` + tests — audit log, standalone
3. `src/ui/permissionPrompt.ts` + tests — CLI prompt with arrow-key selector, standalone
4. `src/core/tools/runToolUse.ts` — wire `askUser` and `logDecision` into the `ask` path
5. Verify existing tests still pass (no behavior change when `askUser` is absent)

Steps 2-3 are independent. Step 4 depends on 1-3.

## What Phase 11 Does NOT Do

- No TUI framework (no blessed, no ink) — raw-mode keypresses only
- No persistent rules across sessions (session-scoped only)
- No "deny by rule" user action (deny is always once)
- No undo/revoke for session rules
- No progress display during tool execution (Phase 12 or later)
- No custom approval handlers per tool (all tools use the same prompt)
- No async/parallel approval (tools are approved one at a time sequentially)
- No directory-wide or prefix-wide rule matching (exact path only)

## Verification

1. Tool requiring approval shows arrow-key selector with tool name, input, and reason
2. Selecting "Allow once" allows tool execution, tool runs successfully
3. Selecting "Deny once" denies tool execution, model sees `[permission_denied]` error
4. Selecting "Allow by rule" allows and creates exact-match session rule — same tool+path auto-approves on next call
5. Ctrl+C during prompt returns `abort` result, logged as abort (not denial)
6. Default selection is "Deny once" (safe default)
7. Headless mode still denies without prompting (existing behavior unchanged)
8. Missing `askUser` preserves `permission_ask` result (existing behavior unchanged)
9. Every decision logged via `logDecision` callback with structured metadata
10. Production logger writes JSONL to `~/.ultron/permissions.jsonl`
11. File tools show file_path in prompt, Bash shows command
12. `formatApprovalPrompt` is pure and testable independently from I/O
13. `promptForApproval` works with injectable TerminalIO for tests
14. All tests pass, typecheck clean
