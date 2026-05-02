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
import type { QueryEvent, CompactionTrigger, ToolProgressEvent } from './queryEvents.js'
import type { QueryDeps, RawStreamEvent, RawContentBlockStart, RawContentBlockDelta } from './queryDeps.js'
import { productionDeps } from './queryDeps.js'
import {
  makePermissionDecisionEvent,
  makeToolCallStartedEvent,
  makeToolCallFinishedEvent,
  makeToolProgressEvent,
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
import { streamToolUse } from './tools/streamToolUse.js'
import {
  partitionIntoBatches,
  runWithConcurrencyLimit,
  DEFAULT_MAX_CONCURRENCY,
} from './tools/toolOrchestration.js'
import type { ToolResult } from './tools/types.js'
import type { ToolProgressInput } from './tools/context.js'
import { toApiMessages, StreamAccumulator } from './providers/anthropicAdapter.js'
import { estimateTokens } from '../context/tokenEstimator.js'
import { shouldCompact } from '../context/tokenBudget.js'

const PARALLEL_PROGRESS_BUFFER_CAP = 1000

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
    // 9. Execute tools (Phase 7b — batched dispatch with parallel fan-out
    //    for concurrency-safe tools)
    //
    // Partition tool_uses into batches of consecutive concurrency-safe tools.
    // For each batch:
    //   Phase A — serial authorize + PreToolUse hooks. permission_decision
    //             events emit live; denied/blocked tools record their
    //             synthetic result for emission in Phase C (preserves input
    //             ordering of toolResults within the batch).
    //   Phase B — parallel `Promise.all` over executeToolUse for concurrent
    //             batches with N>1 authorized records. Per-tool progress
    //             callbacks captured into a buffer (cannot yield from inside
    //             Promise.all). Single-tool / unsafe batches skip Phase B
    //             and fall through to a live streamToolUse call in Phase C.
    //   Phase C — serial PostToolUse hooks + emit tool_call_started,
    //             buffered tool_progress, tool_call_finished, tool_result
    //             events in tool_use input order.
    //
    // Authorize, hooks, and event emission stay serial because askUser may
    // prompt the user, hooks may run user shell scripts, and the parent
    // QueryEvent stream must remain ordered for downstream consumers.
    // `isConcurrencySafe` describes the tool body only.
    // -----------------------------------------------------------------------
    const toolResults: Message[] = []
    // Parallel to toolResults: the tool_use that actually reached tool.call,
    // reflecting any PreToolUse hook input mutation. Load-bearing for the
    // attachment stage below, which zips tool_use × result pairs.
    const effectiveToolUses: ToolUseBlock[] = []

    type AuthorizedRecord = {
      readonly kind: 'authorized'
      readonly toolUse: ToolUseBlock
      readonly effective: ToolUseBlock
    }
    type RejectedRecord = {
      readonly kind: 'denied' | 'blocked'
      readonly toolUse: ToolUseBlock
      readonly result: ToolResult
    }
    type PhaseARecord = AuthorizedRecord | RejectedRecord

    type ParallelRunResult = {
      readonly durationMs: number
      readonly result: ToolResult
      readonly progressEvents: readonly ToolProgressEvent[]
    }

    const batches = partitionIntoBatches(toolUseBlocks, deps.toolRegistry)

    batchLoop: for (const batch of batches) {
      if (signal.aborted) break batchLoop

      // -------------------------------------------------------------------
      // Phase A — serial authorize + PreToolUse for every tool in the batch.
      // On abort: stop *iterating* (don't authorize further tools), but
      // still fall through to Phase C so denied/blocked records buffered
      // earlier in this batch get their real tool_result emitted. Without
      // this, the bottom-of-loop missing-results emitter would synthesize a
      // generic "Interrupted by user" tool_result for tools that already
      // produced a permission_decision: deny event, leaving the audit log
      // with mismatched decision + result rows.
      // -------------------------------------------------------------------
      const records: PhaseARecord[] = []
      for (const toolUse of batch.toolUses) {
        if (signal.aborted) break  // out of Phase A only — Phase C still runs.

        const auth = await deps.authorizeToolUse(toolUse, signal)

        // permission_decision is ONLY a policy event — emit it for actual
        // permission outcomes (authorized or denied). Precondition failures
        // (tool_not_found, validation, pre-auth abort) are NOT policy
        // decisions; they surface as a tool_result only.
        if (auth.outcome === 'authorized' || auth.outcome === 'denied') {
          yield makePermissionDecisionEvent(
            toolUse,
            auth.decision.decision,
            auth.decision.reason,
            {
              userResponse: auth.decision.userResponse,
              ruleCreated: auth.decision.ruleCreated,
              safetyMetadata: auth.decision.safetyMetadata,
            },
          )
        }

        if (auth.outcome !== 'authorized') {
          records.push({ kind: 'denied', toolUse, result: auth.syntheticResult })
          continue
        }

        const preOutcome = yield* deps.runPreToolUseHooks(toolUse, signal)

        if (preOutcome.kind === 'block') {
          records.push({ kind: 'blocked', toolUse, result: preOutcome.syntheticResult })
          continue
        }

        const effective: ToolUseBlock =
          preOutcome.updatedInput !== undefined
            ? { ...toolUse, input: preOutcome.updatedInput }
            : toolUse

        records.push({ kind: 'authorized', toolUse, effective })
      }

      // -------------------------------------------------------------------
      // Phase B — parallel execute for concurrent batches with N>1
      //           authorized records. Otherwise fall through to Phase C's
      //           live streamToolUse path.
      //
      // Two correctness details:
      //
      // 1. `tool_call_started` events emit *here*, before Promise.all,
      //    so each event's `timestamp` precedes any tool_progress timestamps
      //    captured during execution. (Progress events are emitted from
      //    the buffer in Phase C, but their `timestamp` is set when the
      //    callback fires inside the tool — earlier than now.)
      // 2. `runWithConcurrencyLimit` caps concurrent in-flight executes at
      //    DEFAULT_MAX_CONCURRENCY. With 8+ read-only tools declaring
      //    isConcurrencySafe (Agent, WebFetch, WebSearch, etc.), an
      //    unbounded `Promise.all` could fan out arbitrarily wide and
      //    create avoidable API/network bursts.
      // -------------------------------------------------------------------
      const authorizedIndices: number[] = []
      for (let i = 0; i < records.length; i++) {
        if (records[i].kind === 'authorized') authorizedIndices.push(i)
      }

      const isParallelBatch = batch.concurrent && authorizedIndices.length > 1
      let parallelRuns: Map<number, ParallelRunResult> | undefined
      if (isParallelBatch) {
        // Emit tool_call_started events upfront in input order so timestamps
        // precede the tool_progress events that fire inside the parallel
        // executes.
        for (const idx of authorizedIndices) {
          yield makeToolCallStartedEvent((records[idx] as AuthorizedRecord).effective)
        }

        const tasks = authorizedIndices.map((idx) => () =>
          executeWithBufferedProgress(
            (records[idx] as AuthorizedRecord).effective,
            signal,
            deps.executeToolUse,
          ),
        )
        const settled = await runWithConcurrencyLimit(tasks, DEFAULT_MAX_CONCURRENCY)
        parallelRuns = new Map()
        for (let j = 0; j < authorizedIndices.length; j++) {
          const s = settled[j]
          // executeWithBufferedProgress is contract-bound never to reject;
          // defensively turn any rejected entry into an error ToolResult so
          // a future regression doesn't drop a sibling's results.
          const run: ParallelRunResult =
            s.status === 'fulfilled'
              ? s.value
              : {
                  durationMs: 0,
                  result: {
                    content:
                      s.reason instanceof Error ? s.reason.message : String(s.reason),
                    isError: true,
                    errorKind: 'execution_error',
                  },
                  progressEvents: [],
                }
          parallelRuns.set(authorizedIndices[j], run)
        }
      }

      // -------------------------------------------------------------------
      // Phase C — serial event emission + PostToolUse hooks in input order.
      // For the parallel branch, tool_call_started events were already
      // emitted in Phase B. The serial branch (single tool, or unsafe
      // batch) emits started → streamToolUse → finished here.
      // -------------------------------------------------------------------
      for (let i = 0; i < records.length; i++) {
        const rec = records[i]

        if (rec.kind !== 'authorized') {
          const resultMessage = createToolResultMessage(
            rec.toolUse,
            rec.result,
            deps.uuid(),
          )
          toolResults.push(resultMessage)
          effectiveToolUses.push(rec.toolUse)
          yield { type: 'tool_result', message: resultMessage }
          continue
        }

        let result: ToolResult
        let durationMs: number

        if (parallelRuns !== undefined) {
          // tool_call_started already emitted in Phase B (correct timestamp).
          const run = parallelRuns.get(i)!
          for (const ev of run.progressEvents) yield ev
          result = run.result
          durationMs = run.durationMs
        } else {
          // Serial path — emit started here so its timestamp precedes any
          // progress events that streamToolUse yields.
          yield makeToolCallStartedEvent(rec.effective)
          const started = Date.now()
          result = yield* streamToolUse(rec.effective, signal, deps.executeToolUse)
          durationMs = Date.now() - started
        }

        // PostToolUse hooks (2b). Only content mutation; cannot block.
        const postOutcome = yield* deps.runPostToolUseHooks(rec.effective, result, signal)
        result = postOutcome.result

        yield makeToolCallFinishedEvent(rec.effective, result, durationMs)

        const resultMessage = createToolResultMessage(rec.effective, result, deps.uuid())
        toolResults.push(resultMessage)
        effectiveToolUses.push(rec.effective)
        yield { type: 'tool_result', message: resultMessage }
      }

      // Phase A may have stopped iterating mid-batch on abort; Phase C
      // drained the records it had. Now break out of the outer batch loop
      // so the bottom-of-loop missing-results emitter handles any tool_uses
      // we never authorized.
      if (signal.aborted) break batchLoop
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
      // Zip on effectiveToolUses (post-PreToolUse-hook-mutation) so the
      // attachment stage sees what the tool *actually* executed, not what the
      // model originally proposed. Indexed identically to toolResults.
      const executions: ToolExecution[] = effectiveToolUses.map((toolUse, i) => ({
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
// Parallel execute helper — runs `executeToolUse` while capturing progress
// callbacks into a buffer. Used inside Phase B's `Promise.all` for concurrent
// batches because `yield` from inside `Promise.all` is impossible. The
// buffered events are replayed in input order during Phase C.
//
// Mirrors `streamToolUse`'s overflow handling: drops further progress events
// once the cap is hit, leaving a single overflow marker so the consumer
// learns about it. Defensively wraps `executeToolUse`: the contract is that
// it returns a ToolResult and never throws, but if a future implementation
// throws we still produce a valid ToolResult instead of leaking the
// rejection through `Promise.all` (which would short-circuit the batch).
// ---------------------------------------------------------------------------

async function executeWithBufferedProgress(
  toolUse: ToolUseBlock,
  signal: AbortSignal,
  executeToolUse: QueryDeps['executeToolUse'],
): Promise<{
  durationMs: number
  result: ToolResult
  progressEvents: readonly ToolProgressEvent[]
}> {
  const buffered: ToolProgressEvent[] = []
  let dropped = 0

  const onProgress = (p: ToolProgressInput): void => {
    if (buffered.length >= PARALLEL_PROGRESS_BUFFER_CAP) {
      if (dropped === 0) {
        buffered.push(
          makeToolProgressEvent({
            toolUseId: toolUse.id,
            progress: 0,
            total: null,
            message: 'progress queue overflow; further events dropped',
          }),
        )
      }
      dropped++
      return
    }
    buffered.push(
      makeToolProgressEvent({
        toolUseId: toolUse.id,
        progress: p.progress,
        total: p.total ?? null,
        message: p.message ?? null,
      }),
    )
  }

  const started = Date.now()
  try {
    const result = await executeToolUse(toolUse, signal, onProgress)
    return {
      durationMs: Date.now() - started,
      result,
      progressEvents: buffered,
    }
  } catch (err) {
    return {
      durationMs: Date.now() - started,
      result: {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
        errorKind: 'execution_error',
      },
      progressEvents: buffered,
    }
  }
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
