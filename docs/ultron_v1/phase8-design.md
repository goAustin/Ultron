# Phase 8 Design: Move Dynamic State into Attachments

## Overview

Phase 7 assembled the complete system prompt from static sections + dynamic context (date, git status, CLAUDE.md, env info), all cached once per cwd for the session. After the model edits files, the dynamic context becomes stale. Phase 8 moves volatile state (git status, project instructions) out of the system prompt entirely and into **attachments** — structured messages injected as user-role `<system-reminder>` content at the start of the session and refreshed after tool execution.

Two new files in `src/context/`. Small modifications to `query.ts`, `queryDeps.ts`, `queryEvents.ts`, `messages.ts`, and three Phase 7 context files.

---

## Architecture

```
  Session start:
  ┌─────────────────────────────────────────────────────┐
  │  Caller                                             │
  │                                                     │
  │  1. systemPrompt = buildFullSystemPrompt(cwd)       │
  │     → static policy + env info + date               │
  │                                                     │
  │  2. initialAttachments = getInitialAttachments(cwd) │
  │     → git status + project instructions             │
  │                                                     │
  │  3. query({                                         │
  │       messages: [...initialAttachments, userMsg],   │
  │       systemPrompt,                                 │
  │       deps: { getAttachments: buildGetAttachments(cwd) }
  │     })                                              │
  └─────────────────────────────────────────────────────┘

  During session (inside query loop):
  ┌─────────────────────────────────────────────────────┐
  │  query.ts — after tool execution                    │
  │                                                     │
  │  1. Build ToolExecution[] from blocks + results     │
  │  2. attachments = deps.getAttachments(executions)   │
  │  3. Yield AttachmentEvent for each                  │
  │  4. Append to toolResults (becomes next-turn msgs)  │
  └──────────────┬──────────────────────────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────────────────────────┐
  │  attachments.ts — buildGetAttachments(cwd)          │
  │                                                     │
  │  Detect what changed:                               │
  │  ├─ FileEdit/FileWrite success → file_change        │
  │  ├─ Any write tool success → git_status refresh     │
  │  ├─ CLAUDE.md modified → project_instructions       │
  │  └─ Midnight crossed → date_change                  │
  │                                                     │
  │  Clear stale caches (by cwd) → re-fetch → render    │
  └─────────────────────────────────────────────────────┘

  System prompt (static, stable across turns):
  ┌─────────────────────────────────────────────┐
  │  Intro section                              │
  │  System section                             │
  │  Doing tasks section                        │  Static
  │  Actions section                            │  (cacheable)
  │  Using tools section                        │
  │  Tone and style section                     │
  │  Efficiency section                         │
  │  ═══ SYSTEM_PROMPT_DYNAMIC_BOUNDARY ════    │  ← sentinel
  │  currentDate                                │  Semi-dynamic
  │  # Environment                              │  (stable in session)
  └─────────────────────────────────────────────┘

  Attachments (per-turn, in message history):
  ┌─────────────────────────────────────────────┐
  │  <system-reminder>                          │
  │  # Git Status                               │  Initial +
  │  Current branch: main ...                   │  refreshed
  │  </system-reminder>                         │
  │                                             │
  │  <system-reminder>                          │
  │  # Project Instructions                     │  Initial +
  │  {CLAUDE.md content}                        │  refreshed
  │  </system-reminder>                         │
  │                                             │
  │  <system-reminder>                          │
  │  File edited: /path/to/file.ts              │  After tools
  │  </system-reminder>                         │
  └─────────────────────────────────────────────┘
```

The key change from Phase 7: git status and project instructions are no longer in the system prompt. They live in attachments so they can be refreshed without creating contradictory context (stale snapshot + delta updates).

---

## Attachment Types (`src/context/attachmentTypes.ts`)

Exports:
- `Attachment` — Discriminated union of all attachment types
- `ToolExecution` — Structured pairing of tool call and result
- Individual attachment type exports

### `ToolExecution`

Pairs a `ToolUseBlock` with its result. Used as input to `GetAttachmentsFn` instead of raw `UserMessage[]` — avoids implicit index-matching.

```typescript
type ToolExecution = {
  readonly toolUse: ToolUseBlock
  readonly result: { readonly content: string; readonly isError: boolean }
}
```

### Attachment Types (4 for v1)

| Type | Trigger | Content |
|------|---------|---------|
| `git_status` | Any write tool (FileEdit, FileWrite, Bash) succeeds | Refreshed git snapshot |
| `project_instructions` | CLAUDE.md modified by a tool | Re-read CLAUDE.md content |
| `file_change` | FileEdit or FileWrite succeeds | Path + action (edited/created) |
| `date_change` | Current date differs from last emitted | New date string |

Note: Bash success triggers `git_status` refresh but NOT `file_change` — we can't reliably determine which files a Bash command modified.

---

## Attachments (`src/context/attachments.ts`)

Exports:
- `GetAttachmentsFn` type
- `buildGetAttachments(cwd: string): GetAttachmentsFn` — factory
- `getInitialAttachments(cwd: string): Promise<UserMessage[]>` — first-turn context
- `renderAttachment(attachment: Attachment): string` — for testing

### Initial Attachments

`getInitialAttachments(cwd)` is called by the session caller before `query()`. It fetches git status and project instructions using the existing Phase 7 functions and renders them as attachment messages:

```typescript
async function getInitialAttachments(cwd: string): Promise<UserMessage[]> {
  const [projectInstructions, systemCtx] = await Promise.all([
    getProjectInstructions(cwd),
    getSystemContext(cwd),
  ])

  const attachments: Attachment[] = []
  if (systemCtx.gitStatus) {
    attachments.push({ type: 'git_status', status: systemCtx.gitStatus })
  }
  if (projectInstructions) {
    attachments.push({ type: 'project_instructions', content: projectInstructions })
  }

  return attachments.map(a => createUserMessage(
    renderAttachment(a),
    { id: messageId(randomUUID()), flags: { isAttachment: true } }
  ))
}
```

The caller prepends these to `params.messages`:
```typescript
const systemPrompt = await buildFullSystemPrompt(cwd)
const initialAttachments = await getInitialAttachments(cwd)
query({ messages: [...initialAttachments, userMessage], systemPrompt, ... })
```

### Per-Turn Attachments

`buildGetAttachments(cwd)` returns a `GetAttachmentsFn` that captures `cwd` and `lastEmittedDate`:

```typescript
function buildGetAttachments(cwd: string): GetAttachmentsFn {
  let lastEmittedDate = new Date().toISOString().slice(0, 10)

  return async (executions: readonly ToolExecution[]): Promise<UserMessage[]> => {
    // 1. Identify successful write tools
    // 2. Generate file_change for FileEdit/FileWrite
    // 3. Check if CLAUDE.md was modified → clear cache, re-read
    // 4. If any write tool succeeded → clear git cache, re-fetch
    // 5. Check date change
    // 6. Render all to UserMessage[]
  }
}
```

### Rendering

Each attachment renders to text wrapped in `<system-reminder>` tags:

| Type | Rendered text |
|------|--------------|
| `git_status` | `<system-reminder>\nGit status has been updated after tool execution:\n{status}\n</system-reminder>` |
| `project_instructions` | `<system-reminder>\nProject instructions (CLAUDE.md) have been updated:\n{content}\n</system-reminder>` |
| `file_change` | `<system-reminder>\nFile {action}: {path}\n</system-reminder>` |
| `date_change` | `<system-reminder>\nThe date has changed. Today's date is now {newDate}.\n</system-reminder>` |

---

## Changes to Phase 7 Files

### `src/context/queryContext.ts`

`buildFullSystemPrompt()` is simplified — drops git status and project instructions sections:

```typescript
export async function buildFullSystemPrompt(cwd: string): Promise<string> {
  const staticSections = buildSystemPrompt()
  const systemCtx = await getSystemContext(cwd)

  const currentDate = `Today's date is ${new Date().toISOString().slice(0, 10)}.`

  const dynamicSections: string[] = [currentDate, systemCtx.envInfo]

  return [...staticSections, ...dynamicSections]
    .filter(s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .join('\n\n')
}
```

Git status and project instructions are now provided by `getInitialAttachments()` and `buildGetAttachments()`.

Re-exports added: `buildGetAttachments`, `getInitialAttachments`, `GetAttachmentsFn`.

### `src/context/userContext.ts` — Clear by cwd

```typescript
export function clearUserContextCache(cwd?: string): void {
  if (cwd) cache.delete(cwd)
  else cache.clear()
}
```

Backward compatible — no-arg call still clears everything.

### `src/context/systemContext.ts` — Clear by cwd

Same pattern as userContext.

---

## Changes to Core Files

### `src/core/messages.ts`

Add `isAttachment` to `MessageFlags`:

```typescript
export type MessageFlags = {
  readonly isMeta?: boolean
  readonly isApiError?: boolean
  readonly apiErrorKind?: 'max_output_tokens' | 'prompt_too_long'
  readonly stopReason?: string
  readonly model?: string
  readonly isCompactBoundary?: boolean
  readonly isAttachment?: boolean  // Phase 8
}
```

### `src/core/queryDeps.ts`

Add optional `getAttachments` dep:

```typescript
import type { GetAttachmentsFn } from '../context/attachments.js'

export type QueryDeps = {
  readonly callModel: CallModelFn
  readonly runTool: RunToolFn
  readonly compact: CompactFn
  readonly uuid: () => MessageId
  readonly getAttachments?: GetAttachmentsFn
}
```

No changes to `stubDeps()` or `productionDeps()` — the field is optional.

### `src/core/queryEvents.ts`

Add `AttachmentEvent`:

```typescript
export type AttachmentEvent = {
  readonly type: 'attachment'
  readonly message: UserMessage
}

export type QueryEvent =
  | RequestStartEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolUseStartEvent
  | ToolResultEvent
  | TurnEvent
  | ErrorEvent
  | AttachmentEvent
```

### `src/core/query.ts`

After step 10 (abort check) and before step 11 (max turns), add attachment injection:

```typescript
// -----------------------------------------------------------------------
// 10.5. Inject attachments
// -----------------------------------------------------------------------
if (deps.getAttachments) {
  const executions: ToolExecution[] = toolUseBlocks.map((toolUse, i) => ({
    toolUse,
    result: extractToolResult(toolResults[i]!),
  }))
  const attachments = await deps.getAttachments(executions)
  for (const msg of attachments) {
    yield { type: 'attachment' as const, message: msg }
    toolResults.push(msg)
  }
}
```

Helper function `extractToolResult` pulls `{ content, isError }` from a `UserMessage` containing a `ToolResultBlock`.

---

## Message Flow Detail

A concrete example of how messages flow with attachments:

```
Turn 1 (initial):
  messages = [
    user: "<system-reminder>Git status: branch main, clean</system-reminder>"     ← initial attachment
    user: "<system-reminder>Project instructions: Build with npm...</system-reminder>"  ← initial attachment
    user: "Edit foo.ts to add a logging statement"                                ← real user message
  ]
  → normalizeMessages merges consecutive user messages into one
  → API sees one user message with all three text blocks

Turn 1 response + tool execution:
  assistant: [tool_use: FileEdit { file_path: "foo.ts", ... }]
  user: [tool_result: "Edit applied successfully"]
  user: "<system-reminder>File edited: /path/to/foo.ts</system-reminder>"         ← file_change attachment
  user: "<system-reminder>Git status updated: M foo.ts</system-reminder>"         ← git_status attachment
  → normalizeMessages merges tool_result + attachment text into one user message
  → API sees one user message with tool_result block + text blocks
```

This mixed-content user message (tool_result + text blocks) is valid in the Anthropic API. `apiAdapter.ts` already handles both block types via `contentBlockToApi()`.

---

## Integration Points

| Component | Change | Details |
|-----------|--------|---------|
| `query.ts` | ~12 lines added | Attachment injection after tool execution |
| `queryDeps.ts` | Optional dep added | `getAttachments?: GetAttachmentsFn` |
| `queryEvents.ts` | New event type | `AttachmentEvent` |
| `messages.ts` | 1 flag added | `isAttachment?: boolean` |
| `queryContext.ts` | Simplified | Drops git/instructions from system prompt |
| `userContext.ts` | Minor | Clear-by-cwd support |
| `systemContext.ts` | Minor | Clear-by-cwd support |
| `apiAdapter.ts` | None | Already handles mixed user-content blocks |
| `normalizeMessages.ts` | None | Role alternation merges attachments naturally |
| `queryTypes.ts` | None | cwd captured by closure, not added to QueryParams |

---

## Test Strategy

### `src/context/attachments.test.ts` (~18 tests)

**renderAttachment (4):**
- Renders `git_status` with system-reminder wrapper
- Renders `project_instructions` with updated content
- Renders `file_change` with path and action
- Renders `date_change` with new date

**getInitialAttachments (3):**
- Returns git_status + project_instructions in git repo with CLAUDE.md
- Returns only git_status in git repo without CLAUDE.md
- Returns only project_instructions in non-git dir with CLAUDE.md

**buildGetAttachments detection (8):**
- Empty array when no executions
- Empty array when only read tools ran
- `file_change` after successful FileEdit
- `file_change` (action: 'created') after successful FileWrite
- No attachments for failed tool results
- `git_status` refresh after write tool in git repo
- `project_instructions` refresh when CLAUDE.md modified
- Bash triggers `git_status` but not `file_change`

**Date and message shape (3):**
- No `date_change` on first call (initialized to current date)
- `date_change` emitted when date differs
- Messages have `flags.isAttachment === true`

### Phase 7 test updates

- `queryContext.test.ts`: Update expectations — `buildFullSystemPrompt()` no longer contains "# Project Instructions" or "# Git Status". Still contains "Ultron", date, env info.
- `userContext.test.ts` / `systemContext.test.ts`: `clearXxxCache()` with no args still works.

---

## Implementation Order

1. `src/core/messages.ts` — Add `isAttachment` to MessageFlags
2. `src/context/attachmentTypes.ts` — Type definitions
3. `src/context/userContext.ts` + `systemContext.ts` — Clear-by-cwd
4. `src/context/queryContext.ts` — Simplify `buildFullSystemPrompt()`
5. Update Phase 7 tests for changed expectations
6. `src/context/attachments.ts` + test — Factory, rendering, detection
7. `src/core/queryDeps.ts` + `queryEvents.ts` — Add types
8. `src/core/query.ts` — Wire injection

Steps 1–2 are independent. Step 3–5 update Phase 7. Step 6 is the main new code. Steps 7–8 are core loop integration.

---

## What Phase 8 Does NOT Do

- No token budgeting or attachment eviction
- No `@`-mention file attachments or user input parsing
- No IDE/diagnostic/hook attachments
- No image/multi-modal attachment content
- No changes to `apiAdapter.ts` or `normalizeMessages.ts`
- No changes to `queryTypes.ts`
- No Bash file-change detection (only git refresh)
- No CLI entry point changes — wiring is separate
- No per-turn env info refresh — platform/shell/OS don't change mid-session

---

## Verification

1. System prompt contains only static sections + env info + date (no git status, no project instructions)
2. `getInitialAttachments(cwd)` returns git status + project instructions for first turn
3. `buildGetAttachments(cwd)` detects file changes from structured `ToolExecution[]`
4. FileEdit/FileWrite success → `file_change` with known path
5. Bash success → `git_status` refresh only (no `file_change`)
6. Failed tool results → no attachments
7. Git status cache cleared by cwd, re-fetched after writes
8. CLAUDE.md modification → `project_instructions` refresh
9. No spurious `date_change` on first pass (initialized to current date)
10. Attachment messages have `flags.isAttachment === true` and `<system-reminder>` text
11. `query.ts` yields `AttachmentEvent` when `deps.getAttachments` is defined
12. Mixed content blocks (tool_result + text) in merged user messages are API-valid
13. All existing tests pass (updated Phase 7 tests + unchanged core tests)
14. ~18 new tests covering rendering, detection, initial attachments, and message shape
