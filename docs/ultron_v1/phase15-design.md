# Phase 15 Design: Build the Test Matrix

## Overview

Phases 1–9 produced 289 tests across 20 files, but critical core files have zero coverage: `query.ts` (the agent loop), `normalizeMessages.ts` (the 5-step message pipeline), and `messages.ts` (factory functions). There are no integration tests (end-to-end flow) or security tests (attack scenarios through the full boundary).

Phase 15 adds co-located unit tests for untested core modules, integration tests for the query loop and session resume, and security tests for permission bypass and filesystem safety attacks — all through the real execution boundary.

Six new test files. One config change. No source changes.

---

## Architecture

```
  Test structure after Phase 15:

  src/
    core/
      messages.test.ts              ← NEW
      normalizeMessages.test.ts     ← NEW
      permissions/
        permissions.test.ts         (existing)
        filesystem.test.ts          (existing)
      tools/
        runToolUse.test.ts          (existing)
        toolOrchestration.test.ts   (existing)
        registry.test.ts            (existing)
        fileStateCache.test.ts      (existing)
      state.test.ts                 (existing)
    tools/
      *.test.ts                     (existing)
    context/
      *.test.ts                     (existing)
    session/
      *.test.ts                     (existing)

  tests/                            ← NEW directory
    integration/
      queryLoop.test.ts             ← NEW
      resumeContinuity.test.ts      ← NEW
    security/
      permissionBypass.test.ts      ← NEW
      filesystemSafety.test.ts      ← NEW
```

---

## Unit Tests

### `src/core/messages.test.ts`

Tests the message factory functions, helpers, and branded types.

**Factory functions:**

| Scenario | Verified behavior |
|----------|------------------|
| `createUserMessage` with string | Wraps in `[{ type: 'text', text }]` |
| `createUserMessage` with blocks | Passes ContentBlock array through |
| `createAssistantMessage` | Sets role, content, id, timestamp |
| `createToolResultMessage` | Creates tool_result block paired to ToolUseBlock |
| `createErrorToolResult` | Creates error result with `isError: true` |

**Helpers:**

| Scenario | Verified behavior |
|----------|------------------|
| `getToolUseBlocks` | Extracts tool_use blocks, ignores text/thinking/tool_result |
| `getToolResultBlocks` | Extracts tool_result blocks, ignores others |
| `hasToolUse` true | Returns true when tool_use present |
| `hasToolUse` false | Returns false when no tool_use |
| Empty message | Returns empty arrays from get* helpers |

**Branded types:**

| Scenario | Verified behavior |
|----------|------------------|
| `messageId()` | Returns typed MessageId, usable as string |
| `toolUseId()` | Returns typed ToolUseId, usable as string |

### `src/core/normalizeMessages.test.ts`

Tests each step of the 5-step pipeline individually, plus the composed function.

**Step 1 — `stripMetaMessages`:**

| Scenario | Input → Output |
|----------|---------------|
| Strips meta | `[user(meta), assistant, user]` → `[assistant, user]` |
| Keeps non-meta | `[user(flags:{}), user]` → both kept |
| Empty input | `[]` → `[]` |

**Step 2 — `ensureToolResultPairing`:**

| Scenario | Input → Output |
|----------|---------------|
| Already paired | `[asst(tu:1), user(tr:1)]` → unchanged |
| Unpaired | `[asst(tu:1)]` → synthetic error result appended |
| Multiple unpaired | `[asst(tu:1, tu:2)]` → two synthetics |

**Step 3 — `stripOrphanedToolResults`:**

| Scenario | Input → Output |
|----------|---------------|
| Removes orphan | `[asst(tu:1), user(tr:1, tr:99)]` → `tr:99` removed |
| Keeps paired | `[asst(tu:1), user(tr:1)]` → unchanged |
| Drops empty msg | `[user(tr:99)]` → message dropped |

**Step 4 — `enforceRoleAlternation`:**

| Scenario | Input → Output |
|----------|---------------|
| Merges same-role | `[user, user]` → `[user(merged content)]` |
| Preserves alternating | `[user, asst, user]` → unchanged |
| **Metadata preservation** | Merged message keeps first message's id and timestamp |

**Step 5 — `stripStaleThinkingBlocks`:**

| Scenario | Input → Output |
|----------|---------------|
| Current trajectory preserved | Last assistant's thinking blocks kept |
| Older stripped | Earlier assistant's thinking blocks removed |
| Empty placeholder | Stripping all blocks → `[{ type: 'text', text: '' }]` |

**Composed `normalizeMessages()`:**

| Scenario | What it tests |
|----------|--------------|
| Realistic conversation | Multi-turn with tools passes through all 5 steps correctly |
| Pathological input | Meta + unpaired + orphaned + non-alternating + stale thinking → clean output |

---

## Integration Tests

### `tests/integration/queryLoop.test.ts`

Tests the full `query()` async generator with mock deps.

**Mock strategy:** The `callModel` mock emits **raw Anthropic-like stream events** — because `query()` feeds them to `StreamAccumulator` which expects the raw SSE format:

```typescript
function emitRawEvents(blocks, stopReason): AsyncGenerator<RawStreamEvent, ApiResponseMeta> {
  // message_start with usage
  // For each block:
  //   content_block_start (text: {type:'text', text:''}, tool_use: {type:'tool_use', id, name, input:''})
  //   content_block_delta (text_delta or input_json_delta with serialized input)
  //   content_block_stop
  // message_delta with stop_reason
  // message_stop
  // return ApiResponseMeta
}
```

**Required scenarios:**

| Scenario | Setup | Expected |
|----------|-------|----------|
| Text-only end_turn | callModel returns text block, end_turn | Terminal reason `end_turn` |
| Tool → result → end | First: tool_use. Second: text, end_turn | 2 request_start events, tool_result event, Terminal end_turn |
| Multiple tools | Response with 2 tool_use blocks | Both tools executed, results in messages |
| max_turns | maxTurns: 1, response has tool_use | Terminal reason `max_turns` |
| Abort before tools | Signal aborted after turn event | Synthetic error results for tool_use blocks |
| Abort during tools | Signal aborted after first tool | Partial results + synthetic for remaining |
| max_output_tokens | stop_reason: max_tokens | Escalation (maxOutputTokensOverride set) |
| Attachments present | deps.getAttachments returns messages | AttachmentEvent yielded, messages in state |
| No getAttachments | deps.getAttachments undefined | No attachment events (backward compat) |

### `tests/integration/resumeContinuity.test.ts`

Tests the persist → resume → query input path.

| Scenario | What it verifies |
|----------|-----------------|
| Message round-trip | Write user + assistant → resume → identical messages |
| Compact boundary inclusive | Boundary message is **first** in resumed result (contains summary) |
| Attachment flags | isAttachment flag survives serialize/deserialize |
| Pairing intact | Resumed messages with tool_use/tool_result pass normalizeMessages without errors |

---

## Security Tests

### `tests/security/permissionBypass.test.ts`

Tests permission enforcement through the full `runToolUse()` chain. Assertions check the actual `ToolResult` shape: `result.isError === true` and `result.content` containing the specific error prefix string.

Each test builds a real `ToolUseContext` with `createToolUseContext()`, a real `ToolRegistry`, real permission rules, and calls `runToolUse()`.

| Scenario | Mode | Expected |
|----------|------|----------|
| Deny rule blocks | default | `isError: true`, content contains `[permission_denied]` |
| Deny in bypass | bypassPermissions | `isError: true`, content contains `[permission_denied]` |
| Dangerous path in bypass | bypassPermissions, FileEdit on .bashrc | `isError: true`, content contains `[permission_ask]` |
| Headless deny | default, no prompt fn | `isError: true`, content contains `[permission_denied]` |
| Ask overrides auto-approve | acceptEdits + ask rule | `isError: true`, content contains `[permission_ask]` |
| Allowed succeeds | default, FileRead | `isError: false` |

### `tests/security/filesystemSafety.test.ts`

Tests filesystem safety through `runToolUse()` with real temp directories and filesystem operations. Safety checks apply to **mutating tools only** (FileEdit, FileWrite) — no FileRead symlink test (reads are allowed by design).

| Scenario | Attack | Expected |
|----------|--------|----------|
| Symlink escape (edit) | Symlink inside cwd → file outside cwd, FileEdit | `[permission_ask]` |
| Symlink escape (write) | Symlink inside cwd → outside, FileWrite | `[permission_ask]` |
| Dangerous dir write | FileWrite to `.git/hooks/pre-commit` | `[permission_ask]` |
| Path traversal | FileEdit with `../../etc/passwd` | Blocked (outside working directory) |
| No prior read | FileEdit without prior FileRead | `[validation_failed]` |
| Stale write | FileRead, external modify, FileEdit | `[validation_failed]` |

---

## Config Change

### `vitest.config.ts`

```typescript
test: {
  include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
},
```

---

## Implementation Order

1. `vitest.config.ts` — Add include pattern
2. `src/core/messages.test.ts` — Foundation (other tests import factories)
3. `src/core/normalizeMessages.test.ts` — Pipeline tests
4. `tests/integration/queryLoop.test.ts` — Agent loop
5. `tests/integration/resumeContinuity.test.ts` — Session round-trip
6. `tests/security/permissionBypass.test.ts` — Permission enforcement
7. `tests/security/filesystemSafety.test.ts` — Filesystem attacks

Steps 2-3 are independent. Steps 4-7 are independent of each other.

---

## What Phase 15 Does NOT Do

- No real API calls — all tests use mock/stub deps
- No compaction continuity tests — Phase 10 not built
- No headless approval UI tests — Phase 12 not built
- No performance/load/benchmark tests
- No CI pipeline setup (test commands exist: `npm run test`)
- No coverage reporting configuration
- No `apiAdapter.ts` stream parsing tests (requires mock SSE setup, deferred)
- No mutation testing

---

## Verification

1. `normalizeMessages` pipeline tested per-step + composed, including metadata preservation
2. `messages.ts` factories and helpers fully covered
3. `query()` loop tested for normal flow, error recovery, abort, and attachments using raw stream events
4. Session resume verified end-to-end (compact boundary inclusive)
5. Permission deny enforced in all modes through `runToolUse()`, assertions on actual ToolResult shape
6. Dangerous paths trigger safety checks in bypassPermissions through real boundary
7. Symlink escapes blocked for mutating tools through real filesystem + tool boundary
8. All tests pass, typecheck clean
