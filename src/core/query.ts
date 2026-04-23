/**
 * Core agent loop — the load-bearing spine of Ultron.
 *
 * Async generator that yields QueryEvents and returns a Terminal.
 * Uses a while(true) loop (not recursion) with a LoopState object.
 */

import type { Message, AssistantMessage, ToolUseBlock, ToolUseId, UserMessage, ToolResultBlock } from './messages.js'
import type { ToolExecution } from '../context/attachmentTypes.js'
import {
  createUserMessage,
  createToolResultMessage,
  createErrorToolResult,
  getToolUseBlocks,
  messageId,
  toolUseId,
} from './messages.js'
import type { QueryEvent, CompactionTrigger } from './queryEvents.js'
import type { QueryDeps, RawStreamEvent, RawContentBlockStart, RawContentBlockDelta } from './queryDeps.js'
import { productionDeps } from './queryDeps.js'
import {
  makePermissionDecisionEvent,
  makeToolCallStartedEvent,
  makeToolCallFinishedEvent,
  makeCompactionStartedEvent,
  makeCompactionFinishedEvent,
} from './queryEventFactories.js'
import type { SystemPromptPart } from '../context/systemPromptParts.js'
import type { QueryParams, LoopState, Terminal } from './queryTypes.js'
import {
  DEFAULT_MAX_TURNS,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  ESCALATED_MAX_OUTPUT_TOKENS,
} from './queryTypes.js'
import { normalizeMessages } from './normalizeMessages.js'
import { toApiMessages, StreamAccumulator } from './providers/anthropicAdapter.js'
import { estimateTokens } from '../context/tokenEstimator.js'
import { shouldCompact } from '../context/tokenBudget.js'

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function* query(
  params: QueryParams,
): AsyncGenerator<QueryEvent, Terminal> {
  const deps: QueryDeps = { ...productionDeps(), ...params.deps }
  const signal = params.signal ?? new AbortController().signal
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS

  let state: LoopState = {
    messages: [...params.messages],
    maxOutputTokensRecoveryCount: 0,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    hasAttemptedCompact: false,
    lastInputTokens: undefined,
    turnCount: 1,
    transition: undefined,
  }

  while (true) {
    // -----------------------------------------------------------------------
    // 0. Check abort before doing any work
    // -----------------------------------------------------------------------
    if (signal.aborted) {
      return { reason: 'aborted', messages: state.messages }
    }

    // -----------------------------------------------------------------------
    // 1. Normalize messages
    // -----------------------------------------------------------------------
    const uuidFn = () => deps.uuid() as string
    const normalized = normalizeMessages(state.messages, uuidFn)

    // -----------------------------------------------------------------------
    // 1.5. Pre-request compaction (heuristic, first turn / post-resume)
    // -----------------------------------------------------------------------
    if (state.lastInputTokens === undefined && !state.hasAttemptedCompact) {
      const estimated = estimateTokens(normalized)
      if (shouldCompact(estimated)) {
        const result = yield* runCompaction(deps, state.messages, 'pre_request')
        if (result.success) {
          state = {
            ...state,
            messages: result.compacted,
            hasAttemptedCompact: true,
            transition: 'prompt_too_long_compact',
          }
          continue // re-normalize with compacted messages
        }
        // Heuristic may overestimate — proceed and let the API or reactive path handle it
      }
    }

    // -----------------------------------------------------------------------
    // 2. Convert to API format
    // -----------------------------------------------------------------------
    const apiMessages = toApiMessages(normalized)

    // -----------------------------------------------------------------------
    // 3. Yield request start
    // -----------------------------------------------------------------------
    yield { type: 'request_start' }

    // -----------------------------------------------------------------------
    // 4. Stream model response
    // -----------------------------------------------------------------------
    let assistantMessage: AssistantMessage
    let withheldError: 'max_output_tokens' | 'prompt_too_long' | undefined

    try {
      const streamResult = yield* streamModelResponse(
        deps,
        apiMessages,
        params.systemPromptParts,
        state,
        signal,
        params.thinkingBudget,
        params.interleavedThinking,
      )
      assistantMessage = streamResult.message
      withheldError = streamResult.withheldError
      state = { ...state, lastInputTokens: streamResult.inputTokens }
    } catch (err) {
      // Check if this is a prompt_too_long (413) error
      if (isPromptTooLongError(err)) {
        if (!state.hasAttemptedCompact) {
          const result = yield* runCompaction(deps, state.messages, 'prompt_too_long_recovery')
          if (result.success) {
            state = {
              ...state,
              messages: result.compacted,
              hasAttemptedCompact: true,
              transition: 'prompt_too_long_compact',
            }
            continue
          }
        }
        return {
          reason: 'error',
          messages: state.messages,
          error: err instanceof Error ? err : new Error(String(err)),
        }
      }

      // Unrecoverable streaming error
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)), recoverable: false }
      return {
        reason: 'error',
        messages: state.messages,
        error: err instanceof Error ? err : new Error(String(err)),
      }
    }

    // -----------------------------------------------------------------------
    // 5. Yield the complete turn
    // -----------------------------------------------------------------------
    yield { type: 'turn', message: assistantMessage }
    state.messages = [...state.messages, assistantMessage]

    // -----------------------------------------------------------------------
    // 6. Check abort after streaming
    // -----------------------------------------------------------------------
    if (signal.aborted) {
      const syntheticResults = yield* emitMissingToolResults(
        assistantMessage,
        deps,
        'Interrupted by user',
      )
      return {
        reason: 'aborted',
        messages: [...state.messages, ...syntheticResults],
      }
    }

    // -----------------------------------------------------------------------
    // 7. Extract tool_use blocks
    // -----------------------------------------------------------------------
    const toolUseBlocks = getToolUseBlocks(assistantMessage)
    const needsFollowUp = toolUseBlocks.length > 0

    // -----------------------------------------------------------------------
    // 8. Error recovery (only when no tool follow-up needed)
    // -----------------------------------------------------------------------
    if (!needsFollowUp) {
      if (withheldError === 'prompt_too_long') {
        if (!state.hasAttemptedCompact) {
          const result = yield* runCompaction(deps, state.messages, 'prompt_too_long_recovery')
          if (result.success) {
            state = {
              ...state,
              messages: result.compacted,
              hasAttemptedCompact: true,
              transition: 'prompt_too_long_compact',
            }
            continue
          }
        }
        return {
          reason: 'error',
          messages: state.messages,
          error: new Error('Prompt too long and compaction failed'),
        }
      }

      if (withheldError === 'max_output_tokens') {
        // Escalation attempt (once)
        if (state.maxOutputTokensOverride === undefined) {
          state = {
            ...state,
            maxOutputTokensOverride: ESCALATED_MAX_OUTPUT_TOKENS,
            transition: 'max_output_tokens_escalate',
          }
          continue
        }
        // Recovery retries (up to MAX_OUTPUT_TOKENS_RECOVERY_LIMIT)
        if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const nudge = createUserMessage(
            'Continue from where you left off.',
            { id: deps.uuid() },
          )
          state = {
            ...state,
            messages: [...state.messages, nudge],
            maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount + 1,
            transition: 'max_output_tokens_recovery',
          }
          continue
        }
        // Exhausted retries — return as end_turn with partial content
      }

      // Normal end (or exhausted recovery)
      return { reason: 'end_turn', messages: state.messages }
    }

    // -----------------------------------------------------------------------
    // 9. Execute tools
    // -----------------------------------------------------------------------
    const toolResults: Message[] = []

    for (const toolUse of toolUseBlocks) {
      if (signal.aborted) break

      // Phase 1 — authorize (resolve + validate + permissions + askUser)
      const auth = await deps.authorizeToolUse(toolUse, signal)

      // permission_decision is ONLY a policy event — emit it for actual
      // permission outcomes (authorized or denied). Precondition failures
      // (tool_not_found, validation, pre-auth abort) are NOT policy decisions;
      // they surface as a tool_result only.
      if (auth.outcome === 'authorized' || auth.outcome === 'denied') {
        yield makePermissionDecisionEvent(
          toolUse,
          auth.decision.decision,
          auth.decision.reason,
          {
            userResponse: auth.decision.userResponse,
            ruleCreated: auth.decision.ruleCreated,
          },
        )
      }

      if (auth.outcome !== 'authorized') {
        const resultMessage = createToolResultMessage(
          toolUse,
          auth.syntheticResult,
          deps.uuid(),
        )
        toolResults.push(resultMessage)
        yield { type: 'tool_result', message: resultMessage }
        continue
      }

      // Phase 2 — execute (tool.call only)
      const started = Date.now()
      yield makeToolCallStartedEvent(toolUse)
      const result = await deps.executeToolUse(toolUse, signal)
      const durationMs = Date.now() - started

      yield makeToolCallFinishedEvent(toolUse, result, durationMs)

      const resultMessage = createToolResultMessage(toolUse, result, deps.uuid())
      toolResults.push(resultMessage)
      yield { type: 'tool_result', message: resultMessage }
    }

    // -----------------------------------------------------------------------
    // 10. Handle abort during tools — emit missing results
    // -----------------------------------------------------------------------
    if (signal.aborted) {
      const executedToolUseIds = new Set<ToolUseId>()
      for (const msg of toolResults) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            executedToolUseIds.add(block.toolUseId)
          }
        }
      }

      const syntheticResults = yield* emitMissingToolResults(
        assistantMessage,
        deps,
        'Interrupted by user',
        executedToolUseIds,
      )

      return {
        reason: 'aborted',
        messages: [...state.messages, ...toolResults, ...syntheticResults],
      }
    }

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

    // -----------------------------------------------------------------------
    // 11. Check max turns
    // -----------------------------------------------------------------------
    if (state.turnCount >= maxTurns) {
      return {
        reason: 'max_turns',
        messages: [...state.messages, ...toolResults],
      }
    }

    // -----------------------------------------------------------------------
    // 11.5. Post-turn proactive compaction
    // -----------------------------------------------------------------------
    if (
      state.lastInputTokens !== undefined
      && shouldCompact(state.lastInputTokens)
      && !state.hasAttemptedCompact
    ) {
      const allMessages = [...state.messages, ...toolResults]
      const result = yield* runCompaction(deps, allMessages, 'post_turn')
      if (result.success) {
        state = {
          messages: result.compacted,
          maxOutputTokensRecoveryCount: 0,
          maxOutputTokensOverride: state.maxOutputTokensOverride,
          hasAttemptedCompact: false, // reset — compaction succeeded
          lastInputTokens: undefined, // will be refreshed by next API call
          turnCount: state.turnCount + 1,
          transition: 'next_turn',
        }
        continue
      }
      // Compaction failed — proceed without it
    }

    // -----------------------------------------------------------------------
    // 12. Continue to next iteration
    // -----------------------------------------------------------------------
    state = {
      messages: [...state.messages, ...toolResults],
      maxOutputTokensRecoveryCount: 0,
      maxOutputTokensOverride: state.maxOutputTokensOverride,
      hasAttemptedCompact: false,
      lastInputTokens: state.lastInputTokens,
      turnCount: state.turnCount + 1,
      transition: 'next_turn',
    }
  }
}

// ---------------------------------------------------------------------------
// Stream model response — yields delta events, returns assembled message
// ---------------------------------------------------------------------------

type StreamModelResult = {
  message: AssistantMessage
  withheldError: 'max_output_tokens' | 'prompt_too_long' | undefined
  inputTokens: number | undefined
}

async function* streamModelResponse(
  deps: QueryDeps,
  apiMessages: unknown[],
  systemPromptParts: readonly SystemPromptPart[],
  state: LoopState,
  signal: AbortSignal,
  thinkingBudget: number | undefined,
  interleavedThinking: boolean | undefined,
): AsyncGenerator<QueryEvent, StreamModelResult> {
  const accumulator = new StreamAccumulator()

  const stream = deps.callModel(
    apiMessages,
    systemPromptParts,
    {
      maxOutputTokens: state.maxOutputTokensOverride,
      thinkingBudget,
      interleavedThinking,
    },
    signal,
  )

  for await (const event of { [Symbol.asyncIterator]: () => stream }) {
    accumulator.push(event)

    // Yield delta events for real-time streaming to consumers
    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if ('text' in delta && delta.type === 'text_delta') {
        yield { type: 'text_delta', text: delta.text }
      } else if ('thinking' in delta && delta.type === 'thinking_delta') {
        yield { type: 'thinking_delta', thinking: delta.thinking }
      }
    }

    // Yield tool_use_start when a new tool_use block begins
    if (event.type === 'content_block_start') {
      const cb = event.content_block
      if (cb.type === 'tool_use') {
        yield { type: 'tool_use_start', id: toolUseId(cb.id), name: cb.name }
      }
    }
  }

  // The generator's return value carries metadata
  // (already consumed by the for-await loop completing)
  const meta = accumulator.getMeta()

  // Determine if there's a withheld error
  let withheldError: 'max_output_tokens' | 'prompt_too_long' | undefined
  if (meta.stopReason === 'max_tokens') {
    withheldError = 'max_output_tokens'
  }

  const message = accumulator.build(deps.uuid())

  return { message, withheldError, inputTokens: meta.inputTokens }
}

// ---------------------------------------------------------------------------
// Emit synthetic error tool_results for unmatched tool_use blocks
// ---------------------------------------------------------------------------

function* emitMissingToolResults(
  assistantMessage: AssistantMessage,
  deps: QueryDeps,
  errorMessage: string,
  alreadyExecuted?: Set<ToolUseId>,
): Generator<QueryEvent, Message[]> {
  const results: Message[] = []
  const toolUseBlocks = getToolUseBlocks(assistantMessage)

  for (const toolUse of toolUseBlocks) {
    if (alreadyExecuted?.has(toolUse.id)) continue

    const resultMessage = createErrorToolResult(
      toolUse.id,
      errorMessage,
      deps.uuid(),
    )
    results.push(resultMessage)
    yield { type: 'tool_result', message: resultMessage }
  }

  return results
}

// ---------------------------------------------------------------------------
// Error detection helpers
// ---------------------------------------------------------------------------

function extractToolResult(msg: Message): { content: string; isError: boolean } {
  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      return { content: block.content, isError: block.isError }
    }
  }
  return { content: '', isError: true }
}

// ---------------------------------------------------------------------------
// Compaction envelope — yields start/finish events around deps.compact
// ---------------------------------------------------------------------------

type CompactionResult =
  | { success: true; compacted: Message[] }
  | { success: false }

async function* runCompaction(
  deps: QueryDeps,
  messages: readonly Message[],
  trigger: CompactionTrigger,
): AsyncGenerator<QueryEvent, CompactionResult> {
  const messagesBefore = messages.length
  const started = Date.now()
  yield makeCompactionStartedEvent(trigger, messagesBefore)
  try {
    const compacted = await deps.compact([...messages])
    yield makeCompactionFinishedEvent(
      messagesBefore,
      compacted.length,
      Date.now() - started,
    )
    return { success: true, compacted }
  } catch (err) {
    yield makeCompactionFinishedEvent(
      messagesBefore,
      messagesBefore,
      Date.now() - started,
      err instanceof Error ? err : new Error(String(err)),
    )
    return { success: false }
  }
}

function isPromptTooLongError(err: unknown): boolean {
  if (err instanceof Error) {
    // Anthropic SDK throws errors with status codes for 413
    if ('status' in err && (err as { status: number }).status === 413) return true
    if (err.message.includes('prompt is too long') || err.message.includes('prompt_too_long')) {
      return true
    }
  }
  return false
}
