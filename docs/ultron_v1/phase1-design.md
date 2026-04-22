# Phase 1 Design: Core Execution Model

## Overview

Phase 1 builds the foundational agent loop: accept user input, call LLM, detect tool requests, execute tools, append results, repeat until done. This is the load-bearing spine that every later phase builds on.

A **custom intermediate message representation** (not Anthropic API types) is used throughout the system. An explicit adapter boundary converts between internal types and the SDK at the API call site.

---

## Architecture

```
User Input
    |
query() -- async generator, while(true) loop
    |
+-------------------------------------------+
|  1. Normalize messages (internal types)    |
|  2. Convert to API format (adapter)        |
|  3. Stream API response                    |
|  4. Convert back to internal types         |
|  5. Collect tool_use blocks                |
|  6. Execute tools (stub in Phase 1)        |
|  7. Append tool results                    |
|  8. Check terminal conditions              |
|  9. Continue or return                     |
+-------------------------------------------+
    |
Yields QueryEvent stream -> consumer (CLI in later phases)
```

---

## Internal Message Types (`messages.ts`)

No Anthropic SDK imports. This is the single source of truth for message shape across the entire system.

### Branded IDs

```typescript
type MessageId = string & { readonly __brand: 'MessageId' }
type ToolUseId = string & { readonly __brand: 'ToolUseId' }
```

Type-level safety without runtime cost. Prevents accidentally passing a raw string where a typed ID is expected.

### Content Blocks

Discriminated union on `type`:

```typescript
type TextBlock = { type: 'text'; text: string }
type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
type RedactedThinkingBlock = { type: 'redacted_thinking' }
type ToolUseBlock = { type: 'tool_use'; id: ToolUseId; name: string; input: Record<string, unknown> }
type ToolResultBlock = { type: 'tool_result'; toolUseId: ToolUseId; content: string; isError: boolean }
type ImageBlock = { type: 'image'; mediaType: string; data: string }

type ContentBlock =
  | TextBlock | ThinkingBlock | RedactedThinkingBlock
  | ToolUseBlock | ToolResultBlock | ImageBlock
```

### Messages

Discriminated union on `role`:

```typescript
type MessageMeta = {
  id: MessageId
  timestamp: number
}

type MessageFlags = {
  isMeta?: boolean              // internal-only, stripped before API
  isApiError?: boolean          // represents an API error, not real content
  apiErrorKind?: 'max_output_tokens' | 'prompt_too_long'
  stopReason?: string           // from API response
  model?: string                // which model generated this
}

type UserMessage = MessageMeta & {
  role: 'user'
  content: ContentBlock[]
  flags?: MessageFlags
}

type AssistantMessage = MessageMeta & {
  role: 'assistant'
  content: ContentBlock[]
  flags?: MessageFlags
}

type Message = UserMessage | AssistantMessage
```

### Compact Boundary (Phase 10 extensibility)

```typescript
type CompactBoundary = MessageMeta & {
  role: 'user'
  content: [TextBlock]
  flags: { isMeta: true; isCompactBoundary: true }
}
```

A specialized `UserMessage` with a flag. Keeps the `Message` union narrow.

### Key Design Decisions

- **`role` is the discriminant** (not `type`, which is reserved for content blocks)
- **`ToolResultBlock.toolUseId`** uses camelCase internally; the adapter converts to `tool_use_id` for the API
- **`flags` bag** is the extensibility point for future phases (attachments in Phase 8, compaction in Phase 10)
- **No `system` role** in `Message` -- system prompt is a separate concept (Phase 7)
- **Factory functions** (`createUserMessage()`, `createAssistantMessage()`, `createToolResultMessage()`, `createErrorToolResult()`) are the only way to construct messages

---

## Streaming Events (`queryEvents.ts`)

```typescript
type RequestStartEvent = { type: 'request_start' }
type TextDeltaEvent = { type: 'text_delta'; text: string }
type ThinkingDeltaEvent = { type: 'thinking_delta'; thinking: string }
type ToolUseStartEvent = { type: 'tool_use_start'; id: ToolUseId; name: string }
type ToolResultEvent = { type: 'tool_result'; message: UserMessage }
type TurnEvent = { type: 'turn'; message: AssistantMessage }
type ErrorEvent = { type: 'error'; error: Error; recoverable: boolean }

type QueryEvent =
  | RequestStartEvent | TextDeltaEvent | ThinkingDeltaEvent
  | ToolUseStartEvent | ToolResultEvent | TurnEvent | ErrorEvent
```

### State Machine

```
RequestStart -> (TextDelta | ThinkingDelta | ToolUseStart)* -> Turn
  -> if tool_use blocks: (ToolResult)* -> RequestStart (next iteration)
  -> if no tool_use blocks: Terminal (return from generator)
  -> on error: Error -> (recovery continue | Terminal)
```

---

## Dependency Injection (`queryDeps.ts`)

```typescript
type CallModelFn = (
  messages: ApiMessageParam[],
  systemPrompt: string,
  options: CallModelOptions,
  signal: AbortSignal,
) => AsyncGenerator<RawStreamEvent, ApiResponseMeta>

type RunToolFn = (
  toolUse: ToolUseBlock,
  signal: AbortSignal,
) => Promise<ToolResultBlock>

type CompactFn = (
  messages: Message[],
) => Promise<Message[]>

type QueryDeps = {
  callModel: CallModelFn
  runTool: RunToolFn
  compact: CompactFn
  uuid: () => string
}
```

- **`callModel`** -- async generator of raw stream events (API-level), returns response metadata
- **`runTool`** -- Phase 3 hook; Phase 1 stub returns "tool execution not implemented"
- **`compact`** -- Phase 10 hook; Phase 1 stub throws "compaction not implemented"
- **`uuid`** -- injectable for deterministic test IDs

Exports: `productionDeps()` (real SDK) and `stubDeps()` (for tests).

---

## Query Parameters and Loop State (`queryTypes.ts`)

```typescript
type QueryParams = {
  messages: Message[]
  systemPrompt: string
  deps?: Partial<QueryDeps>
  signal?: AbortSignal
  maxTurns?: number                // default 100
  maxOutputTokensOverride?: number
}

type LoopState = {
  messages: Message[]
  maxOutputTokensRecoveryCount: number
  maxOutputTokensOverride: number | undefined
  hasAttemptedCompact: boolean
  turnCount: number
  transition: ContinueReason | undefined
}

type ContinueReason =
  | 'next_turn'
  | 'max_output_tokens_recovery'
  | 'max_output_tokens_escalate'
  | 'prompt_too_long_compact'

type TerminalReason =
  | 'end_turn'    // model finished naturally
  | 'max_turns'   // safety limit
  | 'aborted'     // user abort
  | 'error'       // unrecoverable error

type Terminal = {
  reason: TerminalReason
  messages: Message[]
  error?: Error
}
```

---

## Normalization Pipeline (`normalizeMessages.ts`)

Operates entirely on internal types. No SDK imports. Runs before every API call.

1. **Strip meta messages** -- remove messages where `flags.isMeta === true`
2. **Ensure tool pairing** -- for every `tool_use` block in an assistant message, verify a subsequent user message contains a `tool_result` with matching `toolUseId`. If missing, inject a synthetic error result.
3. **Strip orphaned tool results** -- remove `tool_result` blocks that don't match any preceding `tool_use`
4. **Enforce role alternation** -- merge consecutive same-role messages (concatenate content arrays)
5. **Handle thinking blocks** -- preserve within current assistant trajectory; strip from older turns

Each step is individually exported for unit testing.

---

## API Adapter (`apiAdapter.ts`)

**The ONLY file that imports `@anthropic-ai/sdk`.** This is the boundary between internal types and the SDK.

### Internal -> API (before sending)

```typescript
function toApiMessages(messages: Message[]): BetaMessageParam[]
```

- Maps role -> role, content blocks -> API content blocks
- `ToolResultBlock { toolUseId }` -> `{ type: 'tool_result', tool_use_id }`
- Strips: flags, id, timestamp
- Merges consecutive same-role messages (defensive, shouldn't exist post-normalization)

### API Stream -> Internal (during streaming)

```typescript
function buildAssistantFromStream(events: RawStreamEvent[]): AssistantMessage
```

- Accumulates `content_block_start`/`delta`/`stop` into internal `ContentBlock`s
- Extracts `stop_reason` into flags

### Raw Stream Event Types

```typescript
type RawStreamEvent =
  | { type: 'content_block_start'; index: number; content_block: ApiContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ApiDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_start'; message: { usage: Usage } }
  | { type: 'message_delta'; delta: { stop_reason: string }; usage: Usage }
  | { type: 'message_stop' }
```

---

## Agent Loop (`query.ts`)

`async function* query(params)` using a `while(true)` loop (not recursion, avoids stack depth issues).

### Loop Structure

Each iteration:

1. **Check abort** -- if `signal.aborted`, return terminal
2. **Normalize** -- run normalization pipeline on `state.messages`
3. **Convert** -- `toApiMessages()` for SDK
4. **Yield** `request_start`
5. **Stream** -- consume `deps.callModel()`, yield delta events, accumulate blocks, detect errors
6. **Yield** `turn` with complete `AssistantMessage`
7. **Check abort** after streaming
8. **Extract** `tool_use` blocks from assistant response
9. **Error recovery** (if no tool follow-up needed):
   - `prompt_too_long` -- try compaction stub (once)
   - `max_output_tokens` -- escalate to 64k (once), then retry up to 3 times with nudge message
   - Otherwise: return `end_turn` terminal
10. **Execute tools** -- iterate `tool_use` blocks, call `deps.runTool()`, yield events
11. **Handle abort** during tools -- emit synthetic error results for unexecuted tools
12. **Check max turns**
13. **Continue** -- build next state, increment turn count, loop

### Continue Sites (Phase 1)

| Reason | Trigger | Recovery |
|--------|---------|----------|
| `next_turn` | Tools executed successfully | Append results, loop |
| `max_output_tokens_escalate` | Hit token cap, no override set | Retry at 64k |
| `max_output_tokens_recovery` | Hit cap again, attempts < 3 | Append nudge message, retry |
| `prompt_too_long_compact` | 413 error, not yet attempted | Call compact stub, retry |

### Helper Generators (internal)

- **`streamModelResponse()`** -- consumes `deps.callModel()`, yields `TextDeltaEvent`/`ThinkingDeltaEvent`, accumulates blocks, detects `stop_reason` errors, returns `[AssistantMessage, withheldError]`
- **`emitMissingToolResults()`** -- for each unmatched `tool_use`, yield a synthetic error `ToolResultEvent`

---

## Error Types (`errors.ts`)

```typescript
class PromptTooLongError extends Error { ... }
class MaxOutputTokensError extends Error { ... }
class AbortedError extends Error { ... }
```

---

## Abort Handling

Two abort scenarios:

1. **During API streaming** -- stop consuming stream, emit synthetic error `tool_result` for every `tool_use` in the (partial) assistant response, return `{ reason: 'aborted' }`
2. **During tool execution** -- break tool loop, emit synthetic error results for unexecuted tools, return with all executed + synthetic results

**Invariant**: every `tool_use` block always has a matching `tool_result` in the final message array, even on abort.

---

## File Map

| File | Responsibility | SDK imports? |
|------|---------------|-------------|
| `src/core/messages.ts` | Internal message types + factories | No |
| `src/core/queryEvents.ts` | Streaming event types | No |
| `src/core/queryDeps.ts` | Dependency injection interface + stubs | No |
| `src/core/queryTypes.ts` | QueryParams, LoopState, Terminal | No |
| `src/core/normalizeMessages.ts` | Pre-API normalization pipeline | No |
| `src/core/apiAdapter.ts` | Internal <-> Anthropic SDK conversion | **Yes (only file)** |
| `src/core/query.ts` | The agent loop | No |
| `src/core/errors.ts` | Error types | No |

---

## Downstream Consumers

- **Phase 2** (Tool Abstraction) -- implements the `RunToolFn` interface defined in `queryDeps.ts`
- **Phase 3** (Tool Execution Boundary) -- plugs into the `runTool` dep slot
- **Phase 7** (Prompt & Context) -- enriches `systemPrompt` passed to `QueryParams`
- **Phase 9** (Transcript) -- consumes `QueryEvent` stream for persistence
- **Phase 10** (Compaction) -- implements the `CompactFn` interface; uses `CompactBoundary` type
- **Phase 12** (SDK) -- wraps `query()` in a higher-level `QueryEngine`

---

## Verification Criteria

1. Text-only prompt completes: yields `request_start`, `text_delta`*, `turn`, returns `end_turn`
2. Tool loop continues: tool_use -> runTool -> tool_result -> next iteration -> end_turn
3. Abort during streaming: synthetic error tool_results emitted, returns `aborted`
4. Abort during tool execution: remaining tools get synthetic results, clean terminal
5. max_output_tokens recovery: escalation -> retries (up to 3) -> terminal
6. prompt_too_long stub: compact called -> stub throws -> terminal with error
7. Normalization unit tests: meta stripping, tool pairing, orphan removal, role alternation
8. API adapter round-trip: internal message -> API format -> correct SDK shape
9. Max turns safety: maxTurns=2, tool loop -> hits limit -> `max_turns` terminal

All tests use `stubDeps()` with mock `callModel`. No real API calls needed.
