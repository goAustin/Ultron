/**
 * Phase 7b — parallel fan-out for concurrency-safe tools.
 *
 * The query loop partitions tool_uses into batches of consecutive
 * concurrency-safe tools. For each concurrent batch with N>1 authorized
 * records, `executeToolUse` runs in parallel via `Promise.all`. Authorize,
 * PreToolUse / PostToolUse hooks, and event emission all stay serial.
 */

import { describe, it, expect } from 'vitest'

import { query } from '../../src/core/query.js'
import { adaptRunTool } from '../../src/core/queryDeps.js'
import { createUserMessage, messageId } from '../../src/core/messages.js'
import { createDefaultRegistry } from '../../src/core/tools/registry.js'
import type { QueryEvent } from '../../src/core/queryEvents.js'
import type {
  CallModelFn,
  RawStreamEvent,
  ApiResponseMeta,
  RunToolFn,
  AuthorizeToolUseFn,
  ExecuteToolUseFn,
} from '../../src/core/queryDeps.js'
import type { ToolProgressInput } from '../../src/core/tools/context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string, stopReason = 'end_turn'): CallModelFn {
  return async function* () {
    yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 10 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason } as ApiResponseMeta
  }
}

/**
 * Emit raw stream events for a turn containing N tool_use blocks.
 */
function multiToolUseResponse(
  toolUses: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
): CallModelFn {
  return async function* () {
    yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
    for (let i = 0; i < toolUses.length; i++) {
      const tu = toolUses[i]
      yield {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: '' },
      } as RawStreamEvent
      yield {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input ?? {}) },
      } as RawStreamEvent
      yield { type: 'content_block_stop', index: i } as RawStreamEvent
    }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason: 'end_turn' } as ApiResponseMeta
  }
}

function sequenceResponses(...fns: CallModelFn[]): CallModelFn {
  let idx = 0
  return async function* (msgs, sys, opts, signal) {
    const fn = fns[idx++]!
    return yield* fn(msgs, sys, opts, signal)
  }
}

async function collectEvents(
  params: Parameters<typeof query>[0],
): Promise<{ events: QueryEvent[]; terminal: { reason: string } }> {
  const events: QueryEvent[] = []
  const gen = query(params)
  let result = await gen.next()
  while (!result.done) {
    events.push(result.value)
    result = await gen.next()
  }
  return { events, terminal: result.value as { reason: string } }
}

const userMsg = createUserMessage('Hello', { id: messageId('u1') })

// ---------------------------------------------------------------------------
// Parallel execute — three concurrency-safe tools fan out
// ---------------------------------------------------------------------------

describe('query loop — parallel fan-out (Phase 7b)', () => {
  it('three concurrency-safe tool_uses in one turn execute concurrently', async () => {
    // Track each tool's execution timeline. If parallelism is correctly
    // wired, all three start before any of them finishes — total wall time
    // ≈ max(durations), not sum.
    const startedAt: Record<string, number> = {}
    const finishedAt: Record<string, number> = {}
    const t0 = Date.now()
    const DELAY_MS = 80

    const runTool: RunToolFn = async (toolUse) => {
      startedAt[toolUse.id] = Date.now() - t0
      await new Promise((r) => setTimeout(r, DELAY_MS))
      finishedAt[toolUse.id] = Date.now() - t0
      return { content: `${toolUse.name}-result`, isError: false }
    }

    const callModel = sequenceResponses(
      multiToolUseResponse([
        { id: 'tu-a', name: 'Glob', input: { pattern: '*.ts' } },
        { id: 'tu-b', name: 'Grep', input: { pattern: 'foo' } },
        { id: 'tu-c', name: 'FileRead', input: { file_path: '/tmp/x' } },
      ]),
      textResponse('Done.'),
    )

    const wallStart = Date.now()
    const { terminal } = await collectEvents({
      messages: [userMsg],
      systemPromptParts: [],
      deps: {
        callModel,
        toolRegistry: createDefaultRegistry(),
        ...adaptRunTool(runTool),
      },
    })
    const wallElapsed = Date.now() - wallStart

    expect(terminal.reason).toBe('end_turn')

    // All three executions overlapped: each started before any finished.
    expect(startedAt['tu-a']).toBeLessThan(finishedAt['tu-a'])
    expect(startedAt['tu-b']).toBeLessThan(finishedAt['tu-a']) // tu-b started before tu-a finished
    expect(startedAt['tu-c']).toBeLessThan(finishedAt['tu-a'])

    // Total wall time is approximately one DELAY_MS (parallel), not three.
    expect(wallElapsed).toBeLessThan(DELAY_MS * 2)
  })

  it('emits tool_results in tool_use input order even when parallel', async () => {
    // Stagger durations so completion order != input order.
    const delays: Record<string, number> = { 'tu-a': 60, 'tu-b': 20, 'tu-c': 40 }

    const runTool: RunToolFn = async (toolUse) => {
      await new Promise((r) => setTimeout(r, delays[toolUse.id]))
      return { content: `${toolUse.id}-result`, isError: false }
    }

    const callModel = sequenceResponses(
      multiToolUseResponse([
        { id: 'tu-a', name: 'Glob' },
        { id: 'tu-b', name: 'Grep' },
        { id: 'tu-c', name: 'FileRead' },
      ]),
      textResponse('Done.'),
    )

    const { events } = await collectEvents({
      messages: [userMsg],
      systemPromptParts: [],
      deps: {
        callModel,
        toolRegistry: createDefaultRegistry(),
        ...adaptRunTool(runTool),
      },
    })

    const toolResultEvents = events.filter((e) => e.type === 'tool_result')
    // Three from the parallel batch. (Plus possibly more from later turns,
    // but the next response is text-only.)
    expect(toolResultEvents.length).toBe(3)

    // Pull tool_use_id from each result message.
    const orderedIds = toolResultEvents.map((e) => {
      if (e.type !== 'tool_result') return ''
      for (const block of e.message.content) {
        if (block.type === 'tool_result') return block.toolUseId
      }
      return ''
    })
    expect(orderedIds).toEqual(['tu-a', 'tu-b', 'tu-c'])
  })

  it('authorize stays serial under fan-out — never overlaps', async () => {
    // Track authorize entry/exit timestamps. The contract: only one
    // `authorizeToolUse` call is in flight at a time, regardless of how
    // many concurrency-safe tool_uses are in the batch. (Permission UI
    // and rule mutation are single-threaded by design.)
    let inFlight = 0
    let maxConcurrent = 0
    const AUTH_DELAY_MS = 30

    const authorizeToolUse: AuthorizeToolUseFn = async () => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((r) => setTimeout(r, AUTH_DELAY_MS))
      inFlight--
      return {
        outcome: 'authorized',
        decision: { decision: 'allow', reason: 'test' },
      }
    }

    const executeToolUse: ExecuteToolUseFn = async () => ({
      content: 'ok',
      isError: false,
    })

    const callModel = sequenceResponses(
      multiToolUseResponse([
        { id: 'tu-a', name: 'Glob' },
        { id: 'tu-b', name: 'Grep' },
        { id: 'tu-c', name: 'FileRead' },
      ]),
      textResponse('Done.'),
    )

    await collectEvents({
      messages: [userMsg],
      systemPromptParts: [],
      deps: {
        callModel,
        toolRegistry: createDefaultRegistry(),
        authorizeToolUse,
        executeToolUse,
      },
    })

    // Authorization NEVER overlapped: the cascade can call askUser, mutate
    // permission rules, and write audit rows — all single-flight.
    expect(maxConcurrent).toBe(1)
  })

  it('mixed safe/unsafe partition: concurrent → serial → concurrent', async () => {
    // Build a turn with [Glob, FileEdit, Grep, FileWrite].
    // Expect execution shape: parallel(Glob), serial(FileEdit),
    //                         parallel(Grep), serial(FileWrite)
    // Track concurrency on a per-batch basis.
    const startTimes: Record<string, number> = {}
    const t0 = Date.now()

    const runTool: RunToolFn = async (toolUse) => {
      startTimes[toolUse.id] = Date.now() - t0
      await new Promise((r) => setTimeout(r, 30))
      return { content: 'ok', isError: false }
    }

    const callModel = sequenceResponses(
      multiToolUseResponse([
        { id: 'tu-glob', name: 'Glob' },
        { id: 'tu-edit', name: 'FileEdit', input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
        { id: 'tu-grep', name: 'Grep' },
        { id: 'tu-write', name: 'FileWrite', input: { file_path: '/tmp/y', content: 'x' } },
      ]),
      textResponse('Done.'),
    )

    const { events } = await collectEvents({
      messages: [userMsg],
      systemPromptParts: [],
      deps: {
        callModel,
        toolRegistry: createDefaultRegistry(),
        ...adaptRunTool(runTool),
      },
    })

    // Each tool reaches its own serial / parallel batch in input order.
    expect(startTimes['tu-glob']).toBeLessThan(startTimes['tu-edit'])
    expect(startTimes['tu-edit']).toBeLessThan(startTimes['tu-grep'])
    expect(startTimes['tu-grep']).toBeLessThan(startTimes['tu-write'])

    // tool_results emit in input order.
    const orderedIds = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => {
        if (e.type !== 'tool_result') return ''
        for (const block of e.message.content) {
          if (block.type === 'tool_result') return block.toolUseId
        }
        return ''
      })
    expect(orderedIds).toEqual(['tu-glob', 'tu-edit', 'tu-grep', 'tu-write'])
  })

  it('one tool failing does not block siblings in a parallel batch', async () => {
    const runTool: RunToolFn = async (toolUse) => {
      if (toolUse.id === 'tu-fail') {
        return { content: 'failed', isError: true, errorKind: 'execution_error' }
      }
      return { content: 'ok', isError: false }
    }

    const callModel = sequenceResponses(
      multiToolUseResponse([
        { id: 'tu-ok-a', name: 'Glob' },
        { id: 'tu-fail', name: 'Grep' },
        { id: 'tu-ok-b', name: 'FileRead' },
      ]),
      textResponse('Done.'),
    )

    const { events, terminal } = await collectEvents({
      messages: [userMsg],
      systemPromptParts: [],
      deps: {
        callModel,
        toolRegistry: createDefaultRegistry(),
        ...adaptRunTool(runTool),
      },
    })

    expect(terminal.reason).toBe('end_turn')
    const toolResultEvents = events.filter((e) => e.type === 'tool_result')
    expect(toolResultEvents.length).toBe(3)
  })

  // -------------------------------------------------------------------------
  // Regression tests — review-driven fixes
  // -------------------------------------------------------------------------

  it('caps concurrency at DEFAULT_MAX_CONCURRENCY = 10 (regression — was unbounded Promise.all)', async () => {
    // Spawn 15 concurrency-safe tool_uses in one turn. The cap should prevent
    // more than 10 from being in-flight simultaneously.
    const inFlight: { count: number; max: number } = { count: 0, max: 0 }

    const executeToolUse: ExecuteToolUseFn = async () => {
      inFlight.count++
      inFlight.max = Math.max(inFlight.max, inFlight.count)
      await new Promise((r) => setTimeout(r, 30))
      inFlight.count--
      return { content: 'ok', isError: false }
    }

    const toolUses = Array.from({ length: 15 }, (_, i) => ({
      id: `tu-${i}`,
      name: 'Glob' as const,
    }))

    const callModel = sequenceResponses(
      multiToolUseResponse(toolUses),
      textResponse('Done.'),
    )

    await collectEvents({
      messages: [userMsg],
      systemPromptParts: [],
      deps: {
        callModel,
        toolRegistry: createDefaultRegistry(),
        executeToolUse,
        authorizeToolUse: async () => ({
          outcome: 'authorized',
          decision: { decision: 'allow', reason: 'test' },
        }),
      },
    })

    // 15 tools, cap of 10 → max in-flight is exactly 10, not 15.
    expect(inFlight.max).toBeLessThanOrEqual(10)
    expect(inFlight.max).toBeGreaterThan(1) // sanity: actually parallelized
  })

  it('preserves denied tool_results when abort trips during Phase A (regression)', async () => {
    // Three tool_uses in a parallel batch. The first authorizes successfully;
    // the second is denied (real `permission_denied` content); the third's
    // authorize call observes signal.aborted and the loop breaks. Without
    // the fix, the second tool's denied tool_result was lost — replaced by
    // a generic "Interrupted by user" synthetic. With the fix, Phase C
    // still drains records buffered before abort.
    const ac = new AbortController()
    let authCallCount = 0

    const authorizeToolUse: AuthorizeToolUseFn = async (toolUse) => {
      authCallCount++
      if (toolUse.name === 'Grep') {
        // Deny the second tool with a clear, distinguishable reason.
        return {
          outcome: 'denied',
          decision: { decision: 'deny', reason: 'rule-driven deny' },
          syntheticResult: {
            content: 'permission_denied: rule-driven deny',
            isError: true,
            errorKind: 'permission_denied',
          },
        }
      }
      // For the third tool (after we've recorded the second's deny), abort.
      if (authCallCount === 3) {
        ac.abort()
      }
      return {
        outcome: 'authorized',
        decision: { decision: 'allow', reason: 'test' },
      }
    }

    const callModel = sequenceResponses(
      multiToolUseResponse([
        { id: 'tu-1', name: 'Glob' },
        { id: 'tu-2', name: 'Grep' },
        { id: 'tu-3', name: 'FileRead' },
      ]),
      textResponse('Done.'),
    )

    const { events } = await collectEvents({
      messages: [userMsg],
      systemPromptParts: [],
      signal: ac.signal,
      deps: {
        callModel,
        toolRegistry: createDefaultRegistry(),
        authorizeToolUse,
        executeToolUse: async () => ({ content: 'ok', isError: false }),
      },
    })

    // Find tu-2's tool_result.
    const tu2Result = events.find((e) => {
      if (e.type !== 'tool_result') return false
      for (const block of e.message.content) {
        if (block.type === 'tool_result' && block.toolUseId === 'tu-2') return true
      }
      return false
    })

    expect(tu2Result).toBeDefined()
    if (tu2Result?.type === 'tool_result') {
      const block = tu2Result.message.content.find(
        (b) => b.type === 'tool_result' && b.toolUseId === 'tu-2',
      )
      // The denied result must carry the real permission_denied content,
      // NOT the generic "Interrupted by user" synthetic that the
      // missing-results emitter would have produced.
      if (block?.type === 'tool_result') {
        expect(block.content).toContain('permission_denied')
        expect(block.content).not.toContain('Interrupted by user')
      }
    }
  })

  it('tool_call_started timestamp precedes tool_progress timestamps (regression)', async () => {
    // In a parallel batch, progress callbacks fire during execute — earlier
    // than when Phase C would have emitted tool_call_started. The fix:
    // emit tool_call_started in input order BEFORE Promise.all, so its
    // timestamp is captured first.
    const PROGRESS_DELAY_MS = 30

    const executeToolUse: ExecuteToolUseFn = async (
      _toolUse,
      _signal,
      onProgress?: (progress: ToolProgressInput) => void,
    ) => {
      if (onProgress) {
        // Wait briefly so the progress timestamp is comfortably later.
        await new Promise((r) => setTimeout(r, PROGRESS_DELAY_MS))
        onProgress({ progress: 50, total: 100, message: 'half-way' })
      }
      await new Promise((r) => setTimeout(r, PROGRESS_DELAY_MS))
      return { content: 'ok', isError: false }
    }

    const callModel = sequenceResponses(
      multiToolUseResponse([
        { id: 'tu-a', name: 'Glob' },
        { id: 'tu-b', name: 'Grep' },
      ]),
      textResponse('Done.'),
    )

    const { events } = await collectEvents({
      messages: [userMsg],
      systemPromptParts: [],
      deps: {
        callModel,
        toolRegistry: createDefaultRegistry(),
        executeToolUse,
        authorizeToolUse: async () => ({
          outcome: 'authorized',
          decision: { decision: 'allow', reason: 'test' },
        }),
      },
    })

    // For each tool, find its started + progress events and check timestamps.
    for (const toolUseId of ['tu-a', 'tu-b']) {
      const startedEvent = events.find(
        (e) => e.type === 'tool_call_started' && e.toolUseId === toolUseId,
      )
      const progressEvents = events.filter(
        (e) => e.type === 'tool_progress' && e.toolUseId === toolUseId,
      )
      expect(startedEvent).toBeDefined()
      expect(progressEvents.length).toBeGreaterThan(0)

      if (startedEvent?.type === 'tool_call_started') {
        for (const p of progressEvents) {
          if (p.type === 'tool_progress') {
            expect(p.timestamp).toBeGreaterThanOrEqual(startedEvent.timestamp)
          }
        }
      }
    }
  })

  it('single concurrency-safe tool falls through to serial path (no Promise.all)', async () => {
    // A batch of one tool — even if concurrency-safe — runs through the
    // serial `streamToolUse` path, not the parallel buffered path. This
    // preserves byte-equivalent behavior for existing single-tool tests.
    const runTool: RunToolFn = async () => ({ content: 'single', isError: false })

    const callModel = sequenceResponses(
      multiToolUseResponse([{ id: 'tu-1', name: 'Glob' }]),
      textResponse('Done.'),
    )

    const { events, terminal } = await collectEvents({
      messages: [userMsg],
      systemPromptParts: [],
      deps: {
        callModel,
        toolRegistry: createDefaultRegistry(),
        ...adaptRunTool(runTool),
      },
    })

    expect(terminal.reason).toBe('end_turn')
    expect(events.filter((e) => e.type === 'tool_result').length).toBe(1)
  })
})
