import { describe, it, expect } from 'vitest'

import { estimateTokens, CHARS_PER_TOKEN } from './tokenEstimator.js'
import { createUserMessage, createAssistantMessage, messageId, toolUseId } from '../core/messages.js'
import type { Message, ContentBlock } from '../core/messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function user(content: ContentBlock[]): Message {
  return createUserMessage(content, { id: messageId('u1'), timestamp: 1 })
}

function assistant(content: ContentBlock[]): Message {
  return createAssistantMessage(content, { id: messageId('a1'), timestamp: 1 })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateTokens([])).toBe(0)
  })

  it('estimates text-only messages as chars / 4 rounded up', () => {
    const text = 'Hello, world!' // 13 chars → ceil(13/4) = 4
    const msgs = [user([{ type: 'text', text }])]
    expect(estimateTokens(msgs)).toBe(Math.ceil(text.length / CHARS_PER_TOKEN))
  })

  it('includes tool_use name and stringified input', () => {
    const input = { file_path: '/tmp/foo.ts', content: 'bar' }
    const inputJson = JSON.stringify(input)
    const name = 'FileWrite'
    const msgs = [
      assistant([
        { type: 'tool_use', id: toolUseId('tu-1'), name, input },
      ]),
    ]
    const expectedChars = name.length + inputJson.length
    expect(estimateTokens(msgs)).toBe(Math.ceil(expectedChars / CHARS_PER_TOKEN))
  })

  it('includes tool_result content string', () => {
    const content = 'File written successfully to /tmp/foo.ts'
    const msgs = [
      user([
        { type: 'tool_result', toolUseId: toolUseId('tu-1'), content, isError: false },
      ]),
    ]
    expect(estimateTokens(msgs)).toBe(Math.ceil(content.length / CHARS_PER_TOKEN))
  })

  it('includes thinking block text', () => {
    const thinking = 'Let me think about this problem carefully...'
    const msgs = [
      assistant([
        { type: 'thinking', thinking, signature: 'sig' },
      ]),
    ]
    expect(estimateTokens(msgs)).toBe(Math.ceil(thinking.length / CHARS_PER_TOKEN))
  })

  it('accumulates across mixed content blocks and multiple messages', () => {
    const text1 = 'Hello' // 5
    const text2 = 'World' // 5
    const toolContent = 'result' // 6
    const totalChars = text1.length + text2.length + toolContent.length // 16
    const msgs = [
      user([{ type: 'text', text: text1 }]),
      assistant([{ type: 'text', text: text2 }]),
      user([
        { type: 'tool_result', toolUseId: toolUseId('tu-1'), content: toolContent, isError: false },
      ]),
    ]
    expect(estimateTokens(msgs)).toBe(Math.ceil(totalChars / CHARS_PER_TOKEN))
  })

  it('uses fixed estimates for image and redacted_thinking', () => {
    const msgs = [
      user([{ type: 'image', mediaType: 'image/png', data: 'base64data' }]),
      assistant([{ type: 'redacted_thinking' }]),
    ]
    // 100 + 10 = 110 → ceil(110/4) = 28
    expect(estimateTokens(msgs)).toBe(Math.ceil(110 / CHARS_PER_TOKEN))
  })
})
