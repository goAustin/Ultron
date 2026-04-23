/**
 * Integration test: compaction continuity.
 *
 * Verifies that the query loop can trigger compaction and continue
 * working with the compacted message history.
 */

import { describe, it, expect } from 'vitest'

import { query } from '../../src/core/query.js'
import { stubDeps, adaptRunTool } from '../../src/core/queryDeps.js'
import { createUserMessage, messageId } from '../../src/core/messages.js'
import type { QueryEvent } from '../../src/core/queryEvents.js'
import type {
  CallModelFn,
  RawStreamEvent,
  ApiResponseMeta,
  CompactFn,
} from '../../src/core/queryDeps.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string, inputTokens = 10): CallModelFn {
  return async function* () {
    yield { type: 'message_start', message: { usage: { input_tokens: inputTokens, output_tokens: 0 } } } as RawStreamEvent
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason: 'end_turn', inputTokens, outputTokens: 5 } as ApiResponseMeta
  }
}

async function collectEvents(gen: AsyncGenerator<QueryEvent, unknown>): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  let result = await gen.next()
  while (!result.done) {
    events.push(result.value)
    result = await gen.next()
  }
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compaction continuity', () => {
  it('compact event is yielded when post-turn compaction triggers', async () => {
    let callCount = 0
    // First call: return high inputTokens to trigger compaction
    // Second call (after compaction): normal
    const callModel: CallModelFn = async function* (_msgs, _sys, _opts, _signal) {
      callCount++
      const inputTokens = callCount === 1 ? 200_000 : 100
      yield { type: 'message_start', message: { usage: { input_tokens: inputTokens, output_tokens: 0 } } } as RawStreamEvent
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'response' } } as RawStreamEvent
      yield { type: 'content_block_stop', index: 0 } as RawStreamEvent

      // First call: model requests a tool to force continuation
      const stopReason = callCount === 1 ? 'end_turn' : 'end_turn'
      yield {
        type: 'content_block_start', index: 1,
        content_block: { type: 'tool_use', id: `tu-${callCount}`, name: 'FileRead', input: '' },
      } as RawStreamEvent
      yield {
        type: 'content_block_delta', index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/test.txt"}' },
      } as RawStreamEvent
      yield { type: 'content_block_stop', index: 1 } as RawStreamEvent
      yield { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 10 } } as RawStreamEvent
      yield { type: 'message_stop' } as RawStreamEvent
      return { stopReason, inputTokens, outputTokens: 10 } as ApiResponseMeta
    }

    let compactCalled = false
    const compact: CompactFn = async (messages) => {
      compactCalled = true
      // Return a simplified version — just keep last 2 messages
      const boundary = createUserMessage('Summary of prior conversation.', {
        id: messageId('compact-boundary'),
        flags: { isCompactBoundary: true },
      })
      return [boundary, ...messages.slice(-2)]
    }

    const gen = query({
      messages: [createUserMessage('Hello', { id: messageId('u1') })],
      systemPrompt: 'Test',
      deps: {
        callModel,
        ...adaptRunTool(async () => ({ content: 'file content', isError: false })),
        compact,
      },
      maxTurns: 3,
    })

    const events = await collectEvents(gen)

    expect(compactCalled).toBe(true)
    expect(events.some((e) => e.type === 'compaction_finished')).toBe(true)

    const compactEvent = events.find((e) => e.type === 'compaction_finished')!
    expect(compactEvent.type).toBe('compaction_finished')
  })

  it('reactive compaction triggers on prompt_too_long error', async () => {
    let callCount = 0
    const callModel: CallModelFn = async function* () {
      callCount++
      if (callCount === 1) {
        // Simulate prompt_too_long error
        throw Object.assign(new Error('prompt is too long'), { status: 413 })
      }
      // After compaction, succeed
      yield { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } } as RawStreamEvent
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'After compaction' } } as RawStreamEvent
      yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as RawStreamEvent
      yield { type: 'message_stop' } as RawStreamEvent
      return { stopReason: 'end_turn', inputTokens: 50, outputTokens: 5 } as ApiResponseMeta
    }

    let compactCalled = false
    const compact: CompactFn = async (messages) => {
      compactCalled = true
      const boundary = createUserMessage('Compacted summary.', {
        id: messageId('compact-b'),
        flags: { isCompactBoundary: true },
      })
      return [boundary]
    }

    const gen = query({
      messages: [createUserMessage('Hello', { id: messageId('u1') })],
      systemPrompt: 'Test',
      deps: { callModel, compact },
    })

    const events = await collectEvents(gen)

    expect(compactCalled).toBe(true)
    expect(events.some((e) => e.type === 'compaction_finished')).toBe(true)
    // Should have a successful turn after compaction
    expect(events.some((e) => e.type === 'turn')).toBe(true)
  })
})
