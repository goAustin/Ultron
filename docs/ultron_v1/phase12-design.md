# Phase 12: Add Headless and SDK Support

## Context

The core loop (`query()`) is a framework-agnostic async generator that yields `QueryEvent`s and returns a `Terminal`. All dependencies are injected via `QueryDeps`. The pieces exist to assemble a conversation — `buildFullSystemPrompt(cwd)`, `createAnthropicCallModel(apiKey, model)`, `createRunToolFn(context, permOpts)`, `createCompactFn(callModel, uuid)`, `buildGetAttachments(cwd)`, `getInitialAttachments(cwd)`, session persistence via `transcript.ts` — but there's no single entrypoint that wires them together.

Phase 12 adds `QueryEngine`: a stateful session wrapper that assembles the deps, manages message history, persists transcripts, and exposes a streaming async generator interface. It works identically in interactive (CLI) and headless (SDK) modes — the only difference is whether `PermissionOptions.askUser` is provided.

## Key Design Decisions

1. **`QueryEngine` is a thin orchestration layer, not a new abstraction.** It takes a config, wires `QueryDeps`, and delegates to `query()`. No new message types, no new event types, no SDK-specific message format for v1. Consumers iterate `QueryEvent` directly.

2. **Single `submitPrompt()` async generator.** Takes a user prompt string, yields `QueryEvent`s, returns `Terminal`. Internally: creates the user message, persists it + initial attachments to transcript, builds the system prompt, calls `query()`, persists events to transcript, yields events through.

3. **Config-based wiring.** `QueryEngineConfig` captures everything needed: `apiKey`, `model`, `cwd`, `permissionMode`, `headless`, `askUser`, `logDecision`, `maxTurns`, optional `sessionId` (for resume), optional `compactModel` (defaults to main model). Consumers don't assemble deps manually.

4. **Per-submission AbortController.** Each `submitPrompt()` call creates its own `AbortController`. `abort()` cancels only the currently running submission. A previous abort does not poison the engine — subsequent submissions get fresh controllers.

5. **No concurrent submissions.** `QueryEngine` is stateful and mutates shared message history. If `submitPrompt()` is called while another is in progress, it throws immediately. A `_running` flag guards this.

6. **Long-lived deps built once in the constructor.** `createAnthropicCallModel()`, `createDefaultRegistry()`, `createStore()`, and `ReadFileState` are engine-level — created once, reused across submissions. Per-submission state is: `AbortController`, message snapshot for `ToolUseContext`, and attachment/resume handling.

7. **ToolUseContext refreshed per submission.** `createToolUseContext` captures a messages snapshot. It must be rebuilt each `submitPrompt()` call with the current message history and fresh `AbortController`, so tools see up-to-date state.

8. **Initial attachments persisted explicitly.** `getInitialAttachments(cwd)` returns messages prepended to `params.messages` before `query()`. These are NOT yielded as `QueryEvent`s, so `QueryEngine` must write them to the transcript directly. Same for the user prompt message.

9. **Resume skips initial attachments.** Resumed sessions already have their startup context in the transcript. Re-injecting initial attachments would duplicate it. `turnCount > 0` or `messages.length > 0` skips initial attachment injection.

10. **No dynamic context duplication.** Phase 8 already made `buildFullSystemPrompt()` static-only (policy + date + env info). Git status and project instructions come exclusively via attachments. Phase 12 does not deepen any duplication — it relies on the existing clean split.

11. **Configurable compaction model.** `compactModel?: string` in config. If provided, a separate `CallModelFn` is created for compaction. If omitted, the main model's `CallModelFn` is reused. This avoids hardcoding "same model for compaction."

12. **Headless mode = no `askUser`.** When `config.headless` is true, `askUser` is not passed to `PermissionOptions`. The cascade's `headlessEscalation` converts `ask` → `deny`. No silent execution.

13. **Session ID created in constructor, durable on first persist.** `createSession()` runs in the constructor (or `sessionId` is stored for lazy resume). The session directory is not created until the first `appendMessage()` call — consistent with `resume.ts` design.

14. **Minimal type surface in `types.ts`.** Only re-export stable public types that SDK consumers need. Don't leak internal types.

## Architecture

```
src/sdk/
  QueryEngine.ts   — QueryEngine class, QueryEngineConfig type, submitPrompt()
  types.ts         — re-exports of stable public types for SDK consumers
```

## Files to Create

### `src/sdk/types.ts`

**Purpose:** Single import point for SDK consumers. Re-exports only stable public types.

```typescript
// Message types
export type { Message, UserMessage, AssistantMessage, ContentBlock } from '../core/messages.js'

// Event types
export type { QueryEvent } from '../core/queryEvents.js'

// Terminal
export type { Terminal, TerminalReason } from '../core/queryTypes.js'

// Permission callback types (for custom askUser/logDecision implementations)
export type { AskUserFn, LogPermissionDecisionFn } from '../core/permissions/types.js'
export type { PermissionMode } from '../core/state.js'

// Engine
export type { QueryEngineConfig } from './QueryEngine.js'
```

No tests needed — pure re-exports.

### `src/sdk/QueryEngine.ts`

**Purpose:** Stateful session wrapper that wires deps and delegates to `query()`.

```typescript
export type QueryEngineConfig = {
  readonly apiKey: string
  readonly model: string
  readonly cwd: string
  readonly permissionMode?: PermissionMode         // default: 'default'
  readonly headless?: boolean                       // default: false
  readonly askUser?: AskUserFn                      // ignored if headless
  readonly logDecision?: LogPermissionDecisionFn
  readonly maxTurns?: number
  readonly sessionId?: string                       // resume existing session
  readonly compactModel?: string                    // default: same as model
}

export class QueryEngine {
  // --- Engine-level (long-lived) ---
  private readonly config: QueryEngineConfig
  private readonly callModel: CallModelFn
  private readonly compactCallModel: CallModelFn
  private readonly toolRegistry: ToolRegistry
  private readonly appState: Store<AppState>
  private readonly readFileState: ReadFileState
  private readonly permissionOpts: PermissionOptions
  private readonly session: SessionInfo

  // --- Per-submission ---
  private currentAbort: AbortController | null = null
  private _running = false
  private _messages: Message[] = []
  private _turnCount = 0
  private _resumed = false

  constructor(config: QueryEngineConfig)
  get sessionId(): string
  get messages(): readonly Message[]
  async *submitPrompt(prompt: string): AsyncGenerator<QueryEvent, Terminal>
  abort(): void
}
```

**Constructor:**

1. Store config
2. Build long-lived deps:
   - `callModel = createAnthropicCallModel(config.apiKey, config.model)`
   - `compactCallModel = config.compactModel ? createAnthropicCallModel(config.apiKey, config.compactModel) : callModel`
   - `toolRegistry = createDefaultRegistry()`
   - `appState = createStore({ ...getDefaultAppState(), permissionMode, workingDirectories: [cwd] })`
   - `readFileState = new Map()`
   - `permissionOpts = { headless, safetyChecks: filesystemSafetyChecks, askUser: headless ? undefined : askUser, logDecision }`
3. If `sessionId` provided: store for lazy resume, set `_resumed = false`
4. If not: `createSession()` to get session info

**`submitPrompt()` logic:**

1. Guard: if `_running`, throw `Error('submitPrompt() already in progress')`
2. Set `_running = true`, create `currentAbort = new AbortController()`
3. If `sessionId` provided and not yet resumed: `await resumeSession(sessionId)` to load `_messages`, set `_resumed = true`
4. Build system prompt: `await buildFullSystemPrompt(config.cwd)`
5. Create user message: `createUserMessage(prompt, { id: uuid() })`
6. Build messages array:
   - If first turn (no prior messages and not resumed): prepend initial attachments from `getInitialAttachments(config.cwd)`, then user message
   - If resumed or subsequent turn: append user message to `_messages`
7. Persist pre-query messages to transcript: user message + initial attachments (if any)
8. Build per-submission `ToolUseContext` with current `_messages`, fresh `AbortController`
9. Build per-submission `runTool = createRunToolFn(toolUseContext, permissionOpts)`
10. Assemble `QueryDeps`:
    - `callModel` (engine-level)
    - `runTool` (per-submission)
    - `compact: createCompactFn(compactCallModel, uuid)` (engine-level callModel, fresh uuid)
    - `uuid: () => messageId(randomUUID())`
    - `getAttachments: buildGetAttachments(config.cwd)`
11. Call `query({ messages, systemPrompt, deps, signal: currentAbort.signal, maxTurns })`
12. For each yielded event:
    - `getEventMessage(event)` → if non-null, `appendMessage(session.dir, msg)`
    - Yield event to consumer
13. On return (Terminal): update `_messages = [...terminal.messages]`, increment `_turnCount`
14. `_running = false`, `currentAbort = null`
15. Return Terminal

**`abort()`:** If `currentAbort` exists, call `currentAbort.abort()`.

**Tests (co-located):**
- Constructor creates session with UUID
- Constructor with sessionId stores it for lazy resume
- `submitPrompt` yields events and returns Terminal (mock callModel via config override or dep injection)
- `submitPrompt` persists user message and events to transcript
- Messages accumulate across multiple `submitPrompt` calls
- Concurrent `submitPrompt` throws
- Headless mode: askUser not in PermissionOptions
- `abort()` cancels in-progress query, subsequent `submitPrompt` works
- Resume loads messages from existing session
- Resume skips initial attachments
- Initial attachments injected and persisted on first turn only
- `compactModel` creates separate CallModelFn for compaction

**Testing strategy:** Tests need to mock `callModel` without a real API key. Add an optional `deps?: Partial<QueryDeps>` escape hatch to `QueryEngineConfig` that overrides the assembled deps. This is the same pattern `QueryParams` already uses. Test-only — not part of the public SDK surface.

## Files to Modify

None. Phase 12 only creates new files. The core loop, permission engine, tool execution, and session persistence are all unchanged.

## Implementation Order

1. `src/sdk/types.ts` — re-exports, no deps
2. `src/sdk/QueryEngine.ts` + tests — the main deliverable

## What Phase 12 Does NOT Do

- No CLI entrypoint (`main.ts`, stdin reader, event renderer) — that's a follow-on
- No SDK-specific message format (consumers use `QueryEvent` directly)
- No HTTP/WebSocket server
- No multi-session management (one engine = one session)
- No custom tool registration via config (uses `createDefaultRegistry()`)
- No model switching mid-session
- No streaming token usage tracking
- No permission denial collection/reporting (events already contain this info)
- No custom system prompt overrides (uses `buildFullSystemPrompt(cwd)`)

## Verification

1. `QueryEngine` wires deps and delegates to `query()` correctly
2. Mock callModel produces events that flow through `submitPrompt`
3. User message and initial attachments persisted to transcript before query starts
4. Events persisted to transcript as they stream through
5. Session ID is stable across multiple `submitPrompt` calls
6. Resume loads messages from existing session transcript, skips initial attachments
7. Concurrent `submitPrompt` throws immediately
8. `abort()` cancels only the current submission; next submission works
9. Headless mode omits `askUser` from PermissionOptions
10. Initial attachments injected on first non-resumed turn only
11. `compactModel` config creates a separate compaction caller
12. System prompt is static-only (no git status / project instructions — verified)
13. All tests pass, typecheck clean
