import { describe, it, expect } from 'vitest'

import { query } from '../../src/core/query.js'
import { stubDeps, adaptRunTool } from '../../src/core/queryDeps.js'
import { createUserMessage, messageId, toolUseId } from '../../src/core/messages.js'
import type { Message, UserMessage } from '../../src/core/messages.js'
import type { QueryEvent } from '../../src/core/queryEvents.js'
import type {
  CallModelFn,
  RawStreamEvent,
  ApiResponseMeta,
  RunToolFn,
} from '../../src/core/queryDeps.js'

// ---------------------------------------------------------------------------
// Helpers — raw stream event emitters
// ---------------------------------------------------------------------------

/**
 * Emit raw Anthropic-like stream events for a text-only response.
 */
function textResponse(text: string, stopReason = 'end_turn'): CallModelFn {
  return async function* (_msgs, _sys, _opts, _signal) {
    yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 10 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason, inputTokens: 10, outputTokens: 10 } as ApiResponseMeta
  }
}

/**
 * Emit raw stream events for a tool_use response.
 */
function toolUseResponse(
  tuId: string,
  toolName: string,
  input: Record<string, unknown>,
  stopReason = 'end_turn',
): CallModelFn {
  const inputJson = JSON.stringify(input)
  return async function* (_msgs, _sys, _opts, _signal) {
    yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
    yield {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: tuId, name: toolName, input: '' },
    } as RawStreamEvent
    yield {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason, inputTokens: 10, outputTokens: 5 } as ApiResponseMeta
  }
}

/**
 * Sequence multiple callModel responses.
 */
function sequenceResponses(...fns: CallModelFn[]): CallModelFn {
  let idx = 0
  return async function* (msgs, sys, opts, signal) {
    const fn = fns[idx++]!
    return yield* fn(msgs, sys, opts, signal)
  }
}

/** Collect all events from query() */
async function collectEvents(
  params: Parameters<typeof query>[0],
): Promise<{ events: QueryEvent[]; terminal: ReturnType<typeof query> extends AsyncGenerator<any, infer R> ? R : never }> {
  const events: QueryEvent[] = []
  const gen = query(params)
  let result = await gen.next()
  while (!result.done) {
    events.push(result.value)
    result = await gen.next()
  }
  return { events, terminal: result.value }
}

const userMsg = createUserMessage('Hello', { id: messageId('u1') })

// ---------------------------------------------------------------------------
// Basic flow
// ---------------------------------------------------------------------------

describe('query loop — basic flow', () => {
  it('text-only response returns end_turn', async () => {
    const { events, terminal } = await collectEvents({
      messages: [userMsg],
      systemPrompt: 'You are a test.',
      deps: { callModel: textResponse('Hello back!') },
    })

    expect(terminal.reason).toBe('end_turn')
    expect(events.some((e) => e.type === 'request_start')).toBe(true)
    expect(events.some((e) => e.type === 'turn')).toBe(true)
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
  })

  it('tool call → result → continuation → end', async () => {
    const runTool: RunToolFn = async (toolUse, _signal) => ({
      content: `Ran ${toolUse.name}`,
      isError: false,
    })

    const callModel = sequenceResponses(
      toolUseResponse('tu-1', 'FileRead', { file_path: '/tmp/x' }),
      textResponse('Done reading the file.'),
    )

    const { events, terminal } = await collectEvents({
      messages: [userMsg],
      systemPrompt: 'Test',
      deps: { callModel, ...adaptRunTool(runTool) },
    })

    expect(terminal.reason).toBe('end_turn')
    // Should have 2 request_start events (2 model calls)
    expect(events.filter((e) => e.type === 'request_start')).toHaveLength(2)
    // Should have a tool_result event
    expect(events.some((e) => e.type === 'tool_result')).toBe(true)
  })

  it('multiple tool_use blocks in one turn', async () => {
    const toolCalls: string[] = []
    const runTool: RunToolFn = async (toolUse, _signal) => {
      toolCalls.push(toolUse.name)
      return { content: 'ok', isError: false }
    }

    // Build a response with 2 tool_use blocks
    const callModel = sequenceResponses(
      async function* (_m, _s, _o, _sig) {
        yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
        // Tool 1
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-1', name: 'FileRead', input: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        // Tool 2
        yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu-2', name: 'Glob', input: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 1 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn' } as ApiResponseMeta
      },
      textResponse('All done.'),
    )

    const { terminal } = await collectEvents({
      messages: [userMsg],
      systemPrompt: 'Test',
      deps: { callModel, ...adaptRunTool(runTool) },
    })

    expect(terminal.reason).toBe('end_turn')
    expect(toolCalls).toEqual(['FileRead', 'Glob'])
  })
})

// ---------------------------------------------------------------------------
// Limits and recovery
// ---------------------------------------------------------------------------

describe('query loop — limits and recovery', () => {
  it('max_turns terminates the loop', async () => {
    const runTool: RunToolFn = async () => ({ content: 'ok', isError: false })
    // Every response triggers a tool call → infinite loop without max_turns
    const callModel = sequenceResponses(
      toolUseResponse('tu-1', 'FileRead', {}),
      textResponse('Done'), // This won't be reached with maxTurns: 1
    )

    const { terminal } = await collectEvents({
      messages: [userMsg],
      systemPrompt: 'Test',
      deps: { callModel, ...adaptRunTool(runTool) },
      maxTurns: 1,
    })

    expect(terminal.reason).toBe('max_turns')
  })

  it('max_output_tokens triggers escalation', async () => {
    const callModel = sequenceResponses(
      textResponse('partial...', 'max_tokens'),
      textResponse('complete answer', 'end_turn'),
    )

    const { terminal } = await collectEvents({
      messages: [userMsg],
      systemPrompt: 'Test',
      deps: { callModel },
    })

    // Should recover and end normally
    expect(terminal.reason).toBe('end_turn')
  })
})

// ---------------------------------------------------------------------------
// Abort handling
// ---------------------------------------------------------------------------

describe('query loop — abort', () => {
  it('abort before tool execution yields synthetic results', async () => {
    const ac = new AbortController()

    const callModel = toolUseResponse('tu-1', 'FileRead', {})
    const runTool: RunToolFn = async () => {
      // Should not be reached — abort fires after turn
      throw new Error('Should not execute')
    }

    // Abort after the turn event
    const events: QueryEvent[] = []
    const gen = query({
      messages: [userMsg],
      systemPrompt: 'Test',
      deps: { callModel, ...adaptRunTool(runTool) },
      signal: ac.signal,
    })

    let result = await gen.next()
    while (!result.done) {
      events.push(result.value)
      if (result.value.type === 'turn') {
        ac.abort()
      }
      result = await gen.next()
    }

    expect(result.value.reason).toBe('aborted')
    // Should have a tool_result for the synthetic error
    const toolResults = events.filter((e) => e.type === 'tool_result')
    expect(toolResults.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe('query loop — attachments', () => {
  it('yields AttachmentEvent when getAttachments is defined', async () => {
    const attachmentMsg = createUserMessage('<system-reminder>Git updated</system-reminder>', {
      id: messageId('att-1'),
      flags: { isAttachment: true },
    })

    const runTool: RunToolFn = async () => ({ content: 'ok', isError: false })
    const getAttachments = async () => [attachmentMsg]

    const callModel = sequenceResponses(
      toolUseResponse('tu-1', 'FileEdit', { file_path: '/tmp/x' }),
      textResponse('Done.'),
    )

    const { events, terminal } = await collectEvents({
      messages: [userMsg],
      systemPrompt: 'Test',
      deps: { callModel, ...adaptRunTool(runTool), getAttachments },
    })

    expect(terminal.reason).toBe('end_turn')
    const attachmentEvents = events.filter((e) => e.type === 'attachment')
    expect(attachmentEvents.length).toBeGreaterThanOrEqual(1)
    if (attachmentEvents[0]!.type === 'attachment') {
      expect(attachmentEvents[0]!.message.flags?.isAttachment).toBe(true)
    }
  })

  it('no attachment events when getAttachments is undefined', async () => {
    const runTool: RunToolFn = async () => ({ content: 'ok', isError: false })
    const callModel = sequenceResponses(
      toolUseResponse('tu-1', 'FileRead', {}),
      textResponse('Done.'),
    )

    const { events } = await collectEvents({
      messages: [userMsg],
      systemPrompt: 'Test',
      deps: { callModel, ...adaptRunTool(runTool) },
    })

    expect(events.filter((e) => e.type === 'attachment')).toHaveLength(0)
  })
})
