# Phase 9 Design: Transcript Persistence and Resume

## Overview

Phases 1–8 built the full execution pipeline but sessions are ephemeral. Phase 9 adds durable transcript storage so sessions survive process termination and can be resumed. JSONL format, one message per line, stored at `~/.ultron/sessions/<session-id>/transcript.jsonl`. Resume replays from the last compact boundary forward (inclusive).

Two new files in `src/session/`. One 1-line change to `filesystem.ts`. No changes to the core loop.

---

## Architecture

```
  Caller (future CLI main loop):
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  session = createSession()                           │
  │                                                      │
  │  // Persist user message BEFORE API call             │
  │  await appendMessage(session.dir, userMessage)       │
  │                                                      │
  │  for await (const event of query(params)) {          │
  │    const msg = getEventMessage(event)                │
  │    if (msg) await appendMessage(session.dir, msg)    │
  │    // ... render event to UI ...                     │
  │  }                                                   │
  │                                                      │
  └──────────────────────────────────────────────────────┘

  Resume flow:
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  { info, messages } = await resumeSession(sessionId) │
  │                                                      │
  │  // messages = transcript from last compact boundary │
  │  // (inclusive) forward                              │
  │                                                      │
  │  // Re-build initial attachments + system prompt     │
  │  // Continue with query({ messages, ... })           │
  │                                                      │
  └──────────────────────────────────────────────────────┘

  Filesystem:
  ~/.ultron/
    sessions/
      <uuid-1>/
        transcript.jsonl    ← one JSON message per line
      <uuid-2>/
        transcript.jsonl
```

---

## Persistence Contract

### Which events get persisted?

`getEventMessage(event: QueryEvent): Message | null` is the single source of truth:

| Event type | Persisted? | Message |
|-----------|-----------|---------|
| `turn` | Yes | `event.message` (AssistantMessage) |
| `tool_result` | Yes | `event.message` (UserMessage with ToolResultBlock) |
| `attachment` | Yes | `event.message` (UserMessage with attachment text) |
| `request_start` | No | — |
| `text_delta` | No | — |
| `thinking_delta` | No | — |
| `tool_use_start` | No | — |
| `error` | No | — |

User messages are persisted by the caller **before** calling `query()`, not as events. This ensures crash safety — if the process dies during streaming, the user's input is already on disk.

### Persistence timing

```
1. User types prompt
2. Caller creates UserMessage
3. Caller calls appendMessage(sessionDir, userMessage)     ← persisted
4. Caller calls query(params)
5. Loop yields turn event → appendMessage(sessionDir, msg) ← persisted
6. Loop yields tool_result → appendMessage(sessionDir, msg) ← persisted
7. Loop yields attachment → appendMessage(sessionDir, msg)  ← persisted
8. Loop continues or returns Terminal
```

---

## Transcript Format (`src/session/transcript.ts`)

### JSONL Schema

Each line is `JSON.stringify(message)` where message is the internal `Message` type:

```jsonl
{"id":"abc-123","timestamp":1713400000000,"role":"user","content":[{"type":"text","text":"Hello"}]}
{"id":"def-456","timestamp":1713400001000,"role":"assistant","content":[{"type":"text","text":"Hi!"}],"flags":{"stopReason":"end_turn"}}
{"id":"ghi-789","timestamp":1713400002000,"role":"user","content":[{"type":"tool_result","toolUseId":"tu-001","content":"File written","isError":false}]}
```

### Serialization

`serializeMessage(message: Message): string` — `JSON.stringify(message)`. Branded types (`MessageId`, `ToolUseId`) are strings at runtime and serialize natively. `readonly` arrays serialize as regular arrays.

### Deserialization

`deserializeMessage(line: string): Message` — `JSON.parse()` + strict validation:

**Top-level validation:**
- `role`: must be `'user'` or `'assistant'`
- `id`: must be a string
- `timestamp`: must be a number
- `content`: must be an array

**Content block validation (by discriminant):**

| Block type | Required fields |
|-----------|----------------|
| `text` | `text: string` |
| `tool_use` | `id: string`, `name: string`, `input: object` |
| `tool_result` | `toolUseId: string`, `content: string`, `isError: boolean` |
| `thinking` | `thinking: string`, `signature: string` |
| `redacted_thinking` | (none beyond `type`) |
| `image` | `mediaType: string`, `data: string` |

**Branded type reconstruction:**
- `id` → `messageId(raw.id)`
- `tool_use.id` → `toolUseId(raw.id)`
- `tool_result.toolUseId` → `toolUseId(raw.toolUseId)`

**Flags:** If present, must be an object. Individual flag values are optional.

Throws `Error` on invalid shape — the caller decides how to handle.

### Reading

`readTranscript(sessionDir: string): Promise<Message[]>`:

- Read file, split by `\n`, filter empty
- For each line, attempt `deserializeMessage()`:
  - **Trailing malformed line** (last non-empty line fails): skip silently — expected crash artifact
  - **Mid-file malformed line**: warn to stderr with line number, skip — may indicate data corruption
- `ENOENT` → return `[]`

### Writing

`appendMessage(sessionDir: string, message: Message): Promise<boolean>`:

- `mkdir(sessionDir, { recursive: true })` — idempotent
- `appendFile(path, serializeMessage(message) + '\n')`
- On error: warn to stderr, return `false`
- On success: return `true`

---

## Session Lifecycle (`src/session/resume.ts`)

### Types

```typescript
type SessionInfo = {
  readonly id: string
  readonly dir: string
  readonly createdAt: number
  readonly messageCount: number
}
```

### Constants

```typescript
const SESSIONS_BASE_DIR = join(homedir(), '.ultron', 'sessions')
```

### `createSession(): SessionInfo`

- Generate UUID v4
- Compute dir: `join(SESSIONS_BASE_DIR, id)`
- Return `{ id, dir, createdAt: Date.now(), messageCount: 0 }`
- Does NOT create the directory — happens on first `appendMessage()`
- Session is not visible to `listSessions()` until first message is persisted

### `resumeSession(sessionId: string): Promise<{ info: SessionInfo; messages: Message[] }>`

1. Compute session dir
2. Call `readTranscript(sessionDir)` — if empty/missing, throw clear error
3. Find last compact boundary: scan backwards for `flags?.isCompactBoundary === true`
4. Slice messages from boundary forward, **inclusive** (boundary message IS the summary)
5. If no boundary, return all messages
6. Derive `SessionInfo`: `createdAt` from first message timestamp, `messageCount` from total count

### `listSessions(): Promise<SessionInfo[]>`

1. `readdir(SESSIONS_BASE_DIR)` — each UUID-shaped entry is a candidate
2. For each: check if `transcript.jsonl` exists — sessions without transcripts are **not listed**
3. Read first line to get `createdAt` (first message timestamp)
4. Count lines for `messageCount`
5. Sort by `createdAt` descending (most recent first)
6. If `SESSIONS_BASE_DIR` doesn't exist → return `[]`

---

## Filesystem Safety

Add `.ultron` to the dangerous directories list in `src/core/permissions/filesystem.ts`:

```typescript
export const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  '.claude',
  '.ultron',  // Session data — self-preservation
] as const
```

This prevents the model from accidentally writing to `~/.ultron/` without explicit user approval.

---

## Integration Points

| Component | Change | Details |
|-----------|--------|---------|
| `query.ts` | None | Persistence is a caller concern |
| `queryDeps.ts` | None | No new deps |
| `queryEvents.ts` | None | `getEventMessage()` reads existing event types |
| `messages.ts` | None | Message types already JSON-serializable |
| `filesystem.ts` | 1 line | `.ultron` added to dangerous directories |
| `apiAdapter.ts` | None | |
| `normalizeMessages.ts` | None | |

---

## Test Strategy

### `src/session/transcript.test.ts` (~14 tests)

**Serialization round-trip (4):**
- UserMessage with text block preserves branded MessageId
- AssistantMessage with tool_use blocks preserves ToolUseId
- UserMessage with tool_result preserves toolUseId in block
- Message with flags (isAttachment, isCompactBoundary) round-trips

**Validation strictness (3):**
- Rejects missing `role`
- Rejects tool_use block without `name`
- Rejects tool_result block without `toolUseId`

**appendMessage (2):**
- Creates directory and file on first write, returns `true`
- Returns `false` on write error (read-only directory)

**readTranscript (4):**
- Reads messages in order
- Returns `[]` for non-existent file
- Skips trailing incomplete line silently
- Warns on mid-file corrupt line, still returns valid messages

**getEventMessage (1):**
- Returns message for turn/tool_result/attachment, null for others

### `src/session/resume.test.ts` (~10 tests)

**createSession (2):**
- Returns SessionInfo with UUID-shaped id
- Does not create directory on disk

**resumeSession (4):**
- Returns all messages when no compact boundary
- Returns from last compact boundary inclusive
- Uses LAST boundary when multiple exist
- Throws for non-existent session

**listSessions (3):**
- Lists sessions sorted by creation time
- Skips sessions without transcript files
- Returns `[]` when base dir doesn't exist

**Integration (1):**
- Create → append → resume → same messages

~24 tests total. All use temp directories.

---

## Implementation Order

1. `src/core/permissions/filesystem.ts` — Add `.ultron` to dangerous directories
2. `src/session/transcript.ts` + test — JSONL I/O, validation, getEventMessage
3. `src/session/resume.ts` + test — Session lifecycle, compact boundary handling

Steps are sequential — resume.ts imports from transcript.ts.

---

## What Phase 9 Does NOT Do

- No changes to `query.ts`, `queryDeps.ts`, `queryTypes.ts`, or `apiAdapter.ts`
- No CLI entry point — wiring into main() is separate
- No session metadata file — `createdAt` derived from first message timestamp
- No transcript pruning, rotation, or size limits
- No encryption or access control
- No file locking or concurrent access
- No automatic persistence — caller must call `appendMessage` explicitly
- No compaction — Phase 10 writes compact boundaries; Phase 9 only reads them on resume
- No session deletion API
- No `sessionId` in AppState — session identity belongs in the session layer

---

## Verification

1. Messages round-trip through serialize/deserialize with all content block types and branded IDs
2. Content block validation catches missing required fields per discriminant
3. `appendMessage` creates directory on first write, returns `true`/`false`
4. `appendMessage` returns `false` on write error (no throw)
5. `readTranscript` skips trailing incomplete line silently
6. `readTranscript` warns on mid-file corrupt lines with line numbers
7. `readTranscript` returns `[]` for non-existent files
8. `resumeSession` includes compact boundary message in result (inclusive)
9. `resumeSession` returns all messages when no boundary exists
10. `resumeSession` uses the LAST boundary when multiple exist
11. `createSession` generates UUID, does not create directory
12. `listSessions` only shows sessions with transcripts
13. `getEventMessage` returns correct message for persistable events, null for others
14. `.ultron` is in dangerous directories list
15. All 265 existing tests pass
16. ~24 new tests covering serialization, validation, persistence, and resume
