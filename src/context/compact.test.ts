import { describe, it, expect, beforeEach } from 'vitest'

import {
  findCompactSplitPoint,
  buildSummarizationPrompt,
  buildCompactedMessages,
  createCompactFn,
  MIN_SUMMARY_LENGTH,
} from './compact.js'
import {
  createUserMessage,
  createAssistantMessage,
  messageId,
  toolUseId,
} from '../core/messages.js'
import type { Message, ContentBlock, MessageId } from '../core/messages.js'
import type { CallModelFn, RawStreamEvent, ApiResponseMeta } from '../core/queryDeps.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function user(text: string, id: string): Message {
  return createUserMessage(text, { id: messageId(id), timestamp: 1 })
}

function assistant(content: ContentBlock[], id: string): Message {
  return createAssistantMessage(content, { id: messageId(id), timestamp: 1 })
}

function textBlock(t: string): ContentBlock {
  return { type: 'text', text: t }
}

function toolUse(tuId: string, name: string): ContentBlock {
  return { type: 'tool_use', id: toolUseId(tuId), name, input: {} }
}

function toolResult(tuId: string, content = 'ok'): ContentBlock {
  return { type: 'tool_result', toolUseId: toolUseId(tuId), content, isError: false }
}

let uuidCounter = 0
function testUuid(): MessageId {
  return messageId(`gen-${++uuidCounter}`)
}

/** Mock callModel that returns a text response. */
function mockCallModel(responseText: string): CallModelFn {
  return async function* (_msgs, _sys, _opts, _signal) {
    yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: responseText } } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason: 'end_turn', inputTokens: 10, outputTokens: 50 } as ApiResponseMeta
  }
}

// ---------------------------------------------------------------------------
// findCompactSplitPoint
// ---------------------------------------------------------------------------

describe('findCompactSplitPoint', () => {
  it('returns -1 for empty messages', () => {
    expect(findCompactSplitPoint([])).toBe(-1)
  })

  it('returns -1 for a single message', () => {
    expect(findCompactSplitPoint([user('hi', 'u1')])).toBe(-1)
  })

  it('returns -1 when only one exchange exists', () => {
    const msgs: Message[] = [
      user('hello', 'u1'),
      assistant([textBlock('hi back')], 'a1'),
    ]
    expect(findCompactSplitPoint(msgs)).toBe(-1)
  })

  it('splits at the last exchange boundary', () => {
    const msgs: Message[] = [
      user('first question', 'u1'),
      assistant([textBlock('first answer')], 'a1'),
      user('second question', 'u2'),
      assistant([textBlock('second answer')], 'a2'),
    ]
    // Should keep the last exchange (u2, a2), summarize (u1, a1)
    expect(findCompactSplitPoint(msgs)).toBe(2)
  })

  it('keeps complete exchange with tool_result messages together', () => {
    const msgs: Message[] = [
      user('old question', 'u1'),
      assistant([textBlock('old answer')], 'a1'),
      user('edit foo.ts', 'u2'),
      assistant([toolUse('tu-1', 'FileEdit')], 'a2'),
      // tool_result is a user message with only tool_result blocks
      createUserMessage([toolResult('tu-1', 'Edit applied')], { id: messageId('tr-1'), timestamp: 1 }),
      assistant([textBlock('Done editing')], 'a3'),
    ]
    // The last "real" user turn is u2 at index 2. tool_result at index 4 is a
    // tool_result carrier, not an exchange start. So split at index 2.
    expect(findCompactSplitPoint(msgs)).toBe(2)
  })

  it('never splits between tool_use and tool_result', () => {
    const msgs: Message[] = [
      user('old', 'u1'),
      assistant([textBlock('old reply')], 'a1'),
      user('do something', 'u2'),
      assistant([toolUse('tu-1', 'Bash')], 'a2'),
      createUserMessage([toolResult('tu-1')], { id: messageId('tr-1'), timestamp: 1 }),
      assistant([textBlock('done')], 'a3'),
      user('next task', 'u3'),
      assistant([textBlock('ok')], 'a4'),
    ]
    // Split should be at u3 (index 6), keeping the last exchange
    // The tool trajectory (u2, a2, tr-1, a3) stays in the summarized portion
    expect(findCompactSplitPoint(msgs)).toBe(6)
  })

  it('handles three exchanges — keeps only the last', () => {
    const msgs: Message[] = [
      user('q1', 'u1'),
      assistant([textBlock('a1')], 'a1'),
      user('q2', 'u2'),
      assistant([textBlock('a2')], 'a2'),
      user('q3', 'u3'),
      assistant([textBlock('a3')], 'a3'),
    ]
    // Keep last exchange starting at u3 (index 4)
    expect(findCompactSplitPoint(msgs)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// buildSummarizationPrompt
// ---------------------------------------------------------------------------

describe('buildSummarizationPrompt', () => {
  it('includes text from messages', () => {
    const msgs = [user('hello world', 'u1')]
    const prompt = buildSummarizationPrompt(msgs)
    expect(prompt).toContain('hello world')
    expect(prompt).toContain('[user]')
  })

  it('includes tool names and results', () => {
    const msgs: Message[] = [
      assistant([toolUse('tu-1', 'FileEdit')], 'a1'),
      createUserMessage([toolResult('tu-1', 'Edit applied')], { id: messageId('tr-1'), timestamp: 1 }),
    ]
    const prompt = buildSummarizationPrompt(msgs)
    expect(prompt).toContain('FileEdit')
    expect(prompt).toContain('Edit applied')
  })

  it('marks error results', () => {
    const msgs: Message[] = [
      createUserMessage(
        [{ type: 'tool_result', toolUseId: toolUseId('tu-1'), content: 'failed', isError: true }],
        { id: messageId('tr-1'), timestamp: 1 },
      ),
    ]
    const prompt = buildSummarizationPrompt(msgs)
    expect(prompt).toContain('(error)')
    expect(prompt).toContain('failed')
  })
})

// ---------------------------------------------------------------------------
// buildCompactedMessages
// ---------------------------------------------------------------------------

describe('buildCompactedMessages', () => {
  it('produces boundary message + recent messages', () => {
    const recent = [user('recent', 'u1'), assistant([textBlock('reply')], 'a1')]
    const result = buildCompactedMessages('Summary of old conversation.', recent, testUuid)

    expect(result).toHaveLength(3)
    expect(result[0]!.role).toBe('user')
    expect(result[1]!.id).toBe('u1')
    expect(result[2]!.id).toBe('a1')
  })

  it('boundary message has isCompactBoundary flag', () => {
    const result = buildCompactedMessages('Summary text here.', [], testUuid)
    expect(result[0]!.flags?.isCompactBoundary).toBe(true)
  })

  it('boundary message role is user', () => {
    const result = buildCompactedMessages('Summary.', [], testUuid)
    expect(result[0]!.role).toBe('user')
  })

  it('recent messages are preserved verbatim', () => {
    const recent = [
      user('keep this', 'u-keep'),
      assistant([textBlock('and this')], 'a-keep'),
    ]
    const result = buildCompactedMessages('Summary.', recent, testUuid)
    expect(result[1]!.id).toBe('u-keep')
    expect(result[2]!.id).toBe('a-keep')
    // Content is the same reference
    expect(result[1]!.content).toBe(recent[0]!.content)
    expect(result[2]!.content).toBe(recent[1]!.content)
  })
})

// ---------------------------------------------------------------------------
// createCompactFn
// ---------------------------------------------------------------------------

describe('createCompactFn', () => {
  beforeEach(() => {
    uuidCounter = 0
  })

  it('returns compacted messages with fewer items', async () => {
    const summaryText = 'This is a sufficiently long summary of the conversation that covers all the important points discussed.'
    const compact = createCompactFn(mockCallModel(summaryText), testUuid)

    const msgs: Message[] = [
      user('old question', 'u1'),
      assistant([textBlock('old answer')], 'a1'),
      user('new question', 'u2'),
      assistant([textBlock('new answer')], 'a2'),
    ]

    const result = await compact(msgs)
    // boundary + last exchange (u2, a2) = 3 messages, fewer than original 4
    expect(result.length).toBeLessThan(msgs.length)
    expect(result[0]!.flags?.isCompactBoundary).toBe(true)
  })

  it('throws when only one exchange exists', async () => {
    const compact = createCompactFn(mockCallModel('summary'), testUuid)

    const msgs: Message[] = [
      user('only question', 'u1'),
      assistant([textBlock('only answer')], 'a1'),
    ]

    await expect(compact(msgs)).rejects.toThrow('Nothing to compact')
  })

  it('throws when summarizer returns empty text', async () => {
    const compact = createCompactFn(mockCallModel(''), testUuid)

    const msgs: Message[] = [
      user('q1', 'u1'),
      assistant([textBlock('a1')], 'a1'),
      user('q2', 'u2'),
      assistant([textBlock('a2')], 'a2'),
    ]

    await expect(compact(msgs)).rejects.toThrow('unusable summary')
  })

  it('throws when summarizer returns too-short text', async () => {
    const compact = createCompactFn(mockCallModel('Short.'), testUuid)

    const msgs: Message[] = [
      user('q1', 'u1'),
      assistant([textBlock('a1')], 'a1'),
      user('q2', 'u2'),
      assistant([textBlock('a2')], 'a2'),
    ]

    await expect(compact(msgs)).rejects.toThrow('unusable summary')
  })

  it('preserves recent messages verbatim', async () => {
    const summaryText = 'A comprehensive summary that describes the old conversation with enough detail to be useful for context.'
    const compact = createCompactFn(mockCallModel(summaryText), testUuid)

    const msgs: Message[] = [
      user('old', 'u1'),
      assistant([textBlock('old reply')], 'a1'),
      user('recent', 'u2'),
      assistant([textBlock('recent reply')], 'a2'),
    ]

    const result = await compact(msgs)
    // Last two messages should be the recent exchange
    expect(result[result.length - 2]!.id).toBe('u2')
    expect(result[result.length - 1]!.id).toBe('a2')
  })
})
