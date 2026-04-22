# Phase 10: Add Compaction

## Context

The query loop (`query.ts`) already has two compaction trigger points — both catch `prompt_too_long` errors (API 413 or withheld error), call `deps.compact(messages)`, set `hasAttemptedCompact = true`, and `continue` the loop. But `deps.compact` is a stub that throws. Phase 10 fills this in.

The API already returns `input_tokens` on every `message_start` event, and `StreamAccumulator` captures it via `getMeta()`. Phase 10 adds **proactive** compaction (before the API rejects) alongside the existing **reactive** path.

## Key Design Decisions

1. **Token estimation: hybrid approach.** Use `input_tokens` from the most recent API response as the authoritative count (free, accurate, already available via `ApiResponseMeta`). When no API count is available yet (e.g. resumed session before first API call), fall back to a character-ratio heuristic (1 token ~ 4 chars) via `estimateTokens()`. No `tiktoken` dependency, no extra API calls.

2. **Two-point proactive compaction in the loop.**
   - **Pre-request check (step 1.5):** Before each API call, if `lastInputTokens` is undefined (first turn or post-resume), run `estimateTokens(messages)` and compact if over threshold. This prevents sending a too-large prompt on the very first call.
   - **Post-turn check (step 11.5):** After tool execution completes and before the state reset, check `lastInputTokens > threshold` (using the accurate API count from the just-completed turn) and compact if needed.
   - The existing reactive path (catch 413 -> compact -> retry) remains as a safety net for edge cases where the proactive checks underestimate.

3. **Compaction = summarize-and-replace.** Call the model with a summarization prompt and the old messages. Replace everything before the summary with a single `UserMessage` marked `isCompactBoundary: true`. Keep recent logical context after the boundary verbatim.

4. **Preserve recent logical context, not raw message count.** Instead of a fixed message count, find the split point by walking backwards from the end to find complete exchange boundaries. A "complete exchange" is a user message + assistant response + any tool_result messages for that assistant's tool_use blocks. Never cut between an assistant `tool_use` and its `tool_result`. The `findCompactSplitPoint(messages)` helper returns the index where summarization stops and recent context begins. Minimum: keep at least the last complete exchange (2-3 messages). If the entire history is one exchange, throw — nothing to compact.

5. **CompactFn signature stays unchanged.** `(messages: Message[]) => Promise<Message[]>` — the factory that creates the real implementation captures `compactCallModel` and UUID generator internally. No changes to `QueryDeps`.

6. **Dedicated compaction caller.** `createCompactFn` takes `compactCallModel: CallModelFn` — a pre-configured caller for the summarization model. Model choice belongs in dependency wiring, not inside `compact.ts`. The caller may use the same model as the main loop or a cheaper one.

7. **Validate compaction output.** After the summarizer returns, check that the summary text is non-empty and has reasonable length (> 50 chars). If validation fails, throw rather than writing a bad compact boundary into history. The reactive/proactive callers already catch and handle the throw.

8. **Token budget is simple constants.** Context window size (200k), threshold ratio (80%), reserved output tokens (20k). No per-model config for v1 — single model target.

9. **No separate reactive-compaction subsystem.** The existing `prompt_too_long` retry path in `query.ts` (catch 413 -> `deps.compact` -> `continue`) already IS reactive compaction. Phase 10 fills in the `deps.compact` stub — no new reactive system needed. Per ROADMAP: "Do not implement context collapse or reactive compact until the basic summarizer is stable."

## Architecture

```
src/context/
  tokenEstimator.ts   — estimateTokens(messages), CHARS_PER_TOKEN constant
  tokenBudget.ts      — threshold constants, shouldCompact(inputTokens)
  compact.ts          — createCompactFn(compactCallModel, uuid), summarization prompt,
                         findCompactSplitPoint(), buildCompactedMessages()
```

The production wiring calls `createCompactFn(compactCallModel, uuid)` and passes the result as `deps.compact`.

## Files to Create

### `src/context/tokenEstimator.ts`

**Purpose:** Estimate token count from messages when no API count is available (first turn).

```typescript
export const CHARS_PER_TOKEN = 4

export function estimateTokens(messages: readonly Message[]): number
```

- Walks all content blocks, sums character lengths:
  - `text` -> `block.text.length`
  - `tool_use` -> `block.name.length + JSON.stringify(block.input).length`
  - `tool_result` -> `block.content.length`
  - `thinking` -> `block.thinking.length`
  - `image` / `redacted_thinking` -> fixed small estimate (100 / 10)
- Divides total chars by `CHARS_PER_TOKEN`, rounds up
- Used only as a fallback — the real count comes from `ApiResponseMeta.inputTokens`

**Tests (co-located):**
- Empty messages -> 0
- Text-only messages -> chars / 4 rounded up
- Tool use blocks include stringified input
- Tool result blocks include content string
- Mixed content blocks accumulate correctly

### `src/context/tokenBudget.ts`

**Purpose:** Token threshold constants and the "should we compact?" decision.

```typescript
export const CONTEXT_WINDOW_TOKENS = 200_000
export const RESERVED_OUTPUT_TOKENS = 20_000
export const COMPACT_THRESHOLD_RATIO = 0.80

export function getEffectiveContextWindow(): number   // 180_000
export function getCompactThreshold(): number          // 144_000
export function shouldCompact(inputTokens: number): boolean
```

Simple: `inputTokens >= getCompactThreshold()`.

**Tests (co-located):**
- `getEffectiveContextWindow()` = CONTEXT_WINDOW - RESERVED_OUTPUT
- `getCompactThreshold()` = effective * ratio
- `shouldCompact` true above threshold, false below
- Edge case: exactly at threshold -> true

### `src/context/compact.ts`

**Purpose:** The real compaction implementation — a factory that returns a `CompactFn`.

```typescript
export const MIN_SUMMARY_LENGTH = 50
export const SUMMARIZATION_MAX_TOKENS = 16_384

export function createCompactFn(
  compactCallModel: CallModelFn,
  uuid: () => MessageId,
): CompactFn

// Exported for testing:
export function findCompactSplitPoint(messages: readonly Message[]): number
export function buildSummarizationPrompt(messages: readonly Message[]): string
export function buildCompactedMessages(
  summary: string,
  recentMessages: readonly Message[],
  uuid: () => MessageId,
): Message[]
```

**`findCompactSplitPoint` logic:**

Walk backwards from the end of the messages array to find complete exchange boundaries. An "exchange" is: user message + assistant response + any tool_result messages that follow (matching the assistant's tool_use blocks). Never split between an assistant `tool_use` and its `tool_result`. Returns the index where recent context begins (everything before it gets summarized). Must keep at least the last complete exchange. If the entire history is one exchange, returns -1 (nothing to compact).

**`createCompactFn` returned function logic:**

1. Call `findCompactSplitPoint(messages)` to get split index
2. If split index is -1, throw — nothing meaningful to compact
3. Split into `toSummarize = messages.slice(0, splitIndex)` and `toKeep = messages.slice(splitIndex)`
4. Build summarization prompt from `toSummarize` using `buildSummarizationPrompt`
5. Call the model via `compactCallModel` with summarization instruction as system prompt and messages-as-text as the user message. Collect the full streamed response via `StreamAccumulator`.
6. Extract summary text from the accumulated response
7. **Validate:** if summary is empty or `< MIN_SUMMARY_LENGTH` chars, throw — compaction produced unusable output
8. Return `buildCompactedMessages(summary, toKeep, uuid)`

**`buildCompactedMessages` logic:**

1. Create a `UserMessage` with the summary text, flagged `{ isCompactBoundary: true }`
2. Concatenate `[boundaryMessage, ...toKeep]`
3. Result will pass through `normalizeMessages` in the query loop (handles role alternation, pairing)

**Summarization prompt:** Concise instruction asking the model to summarize the conversation preserving: key decisions made, file paths and code discussed, tool actions taken and their outcomes, current task state and next steps. The summary is for the model's own future context, not for the user.

**`compactCallModel` usage for summarization:** The `CallModelFn` is a streaming generator. For summarization, we iterate the full stream, accumulate with `StreamAccumulator`, and extract the text. The caller wires the model choice — `compact.ts` doesn't know or care which model is used.

**Tests (co-located):**
- `findCompactSplitPoint` keeps complete exchange (user + assistant + tool_result together)
- `findCompactSplitPoint` returns -1 when only one exchange exists
- `findCompactSplitPoint` never splits between tool_use and tool_result
- `buildSummarizationPrompt` includes text from messages, tool names, tool results
- `buildCompactedMessages` produces boundary message + recent messages
- Boundary message has `isCompactBoundary: true` flag
- Boundary message role is `user`
- `createCompactFn` with mock compactCallModel returns compacted messages with fewer items
- `createCompactFn` throws when `findCompactSplitPoint` returns -1
- `createCompactFn` throws when summarizer returns empty/too-short text
- Recent messages are preserved verbatim (same ids, content)

## Files to Modify

### `src/core/queryTypes.ts`

**Add to LoopState:**

```typescript
lastInputTokens: number | undefined
```

Initialize to `undefined`. Updated after each `streamModelResponse` completes.

### `src/core/queryEvents.ts`

**Add `CompactEvent` to the union:**

```typescript
export type CompactEvent = {
  readonly type: 'compact'
  readonly messagesBefore: number
  readonly messagesAfter: number
}
```

Yielded after successful compaction (both proactive and reactive paths).

### `src/core/query.ts`

Four changes:

1. **Capture `lastInputTokens` from stream result.** The `StreamModelResult` type already has the `message` — extend it to also carry `inputTokens` from `meta.inputTokens`. Store in `state.lastInputTokens` after streaming completes.

2. **Yield `CompactEvent` after successful compaction.** In both reactive compaction points and in the new proactive paths, yield `{ type: 'compact', messagesBefore, messagesAfter }` after `deps.compact` succeeds.

3. **Pre-request compaction check (step 1.5).** Before the API call, when `lastInputTokens` is undefined (first turn, post-resume, or after a previous compaction cleared it), use `estimateTokens(normalized)` as the token count. If `shouldCompact(estimated)` is true and `!state.hasAttemptedCompact`, compact before calling the model:

   ```typescript
   // 1.5 Pre-request compaction (heuristic-based, first turn / post-resume)
   if (state.lastInputTokens === undefined && !state.hasAttemptedCompact) {
     const estimated = estimateTokens(normalized)
     if (shouldCompact(estimated)) {
       try {
         const compacted = await deps.compact([...state.messages])
         yield { type: 'compact', messagesBefore: state.messages.length, messagesAfter: compacted.length }
         state = { ...state, messages: compacted, hasAttemptedCompact: true, transition: 'prompt_too_long_compact' }
         continue  // re-normalize and re-convert with compacted messages
       } catch {
         // Heuristic may overestimate — proceed and let the API or reactive path handle it
       }
     }
   }
   ```

4. **Post-turn compaction check (step 11.5).** After tool execution and attachments, before the state reset. Uses `lastInputTokens` (accurate API count from the just-completed turn):

   ```typescript
   // 11.5 Post-turn proactive compaction
   if (state.lastInputTokens !== undefined
       && shouldCompact(state.lastInputTokens)
       && !state.hasAttemptedCompact) {
     try {
       const allMessages = [...state.messages, ...toolResults]
       const compacted = await deps.compact(allMessages)
       yield { type: 'compact', messagesBefore: allMessages.length, messagesAfter: compacted.length }
       state = {
         messages: compacted,
         hasAttemptedCompact: false, // reset — compaction succeeded, allow future compactions
         lastInputTokens: undefined, // will be refreshed by next API call
         turnCount: state.turnCount + 1,
         transition: 'next_turn',
         maxOutputTokensRecoveryCount: 0,
         maxOutputTokensOverride: state.maxOutputTokensOverride,
       }
       continue
     } catch {
       // Compaction failed — proceed without it
     }
   }
   ```

   Note: `hasAttemptedCompact` resets to `false` after successful post-turn compaction (unlike reactive, where it stays `true` to prevent retry loops). Proactive compaction succeeded — the next turn will have a smaller context, and if it grows again later, we should compact again.

### `src/session/transcript.ts`

**Add `'compact'` to `getEventMessage`.** The `CompactEvent` doesn't carry a persistable message (it's metadata about what happened), so `getEventMessage` returns `null` for it. No change needed if the switch already has a default returning null. Verify and add the case if needed.

## Implementation Order

1. `src/context/tokenEstimator.ts` + tests — standalone, no deps on other new code
2. `src/context/tokenBudget.ts` + tests — standalone constants
3. `src/context/compact.ts` + tests — depends on message types, CallModelFn, StreamAccumulator
4. `src/core/queryTypes.ts` — add `lastInputTokens`
5. `src/core/queryEvents.ts` — add `CompactEvent`
6. `src/core/query.ts` — wire proactive compaction, capture inputTokens, yield CompactEvent
7. Verify transcript.ts handles new event type

Steps 1-2 independent. Step 3 depends on message types (already exist). Steps 4-5 independent. Step 6 depends on all prior steps.

## What Phase 10 Does NOT Do

- No context collapse (deferred per ROADMAP)
- No separate reactive-compaction subsystem beyond the existing 413 fallback in `query.ts`
- No result trimming / snipping
- No per-model context window config (single constant for v1)
- No token-budget-aware attachment injection (deferred per v1-scope)
- No `/compact` slash command (manual trigger — could be a later phase)
- No circuit breaker for repeated compaction failures (v1 has one-shot `hasAttemptedCompact` for reactive)
- No session memory compaction (Claude Code feature, out of scope)
- No `tiktoken` or API-based token counting (heuristic + API `input_tokens` is sufficient)

## Verification

1. `createCompactFn` with mock `compactCallModel` produces valid compacted messages
2. Compacted messages pass `normalizeMessages` (pairing, alternation)
3. Boundary message has `isCompactBoundary: true`
4. `resumeSession` correctly slices from compact boundary (Phase 9 already handles this)
5. Pre-request compaction triggers via `estimateTokens` when `lastInputTokens` is unavailable
6. Post-turn compaction triggers via `lastInputTokens` (accurate API count)
7. Reactive compaction (existing 413 path) works with the real `CompactFn`
8. `shouldCompact` respects threshold constants
9. `estimateTokens` produces reasonable estimates for all content block types
10. `CompactEvent` yielded after successful compaction
11. `findCompactSplitPoint` never splits between tool_use and tool_result
12. Compaction throws on empty/too-short summary (validation)
13. All tests pass, typecheck clean
