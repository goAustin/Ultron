import { describe, it, expect } from 'vitest'

import {
  messageId,
  toolUseId,
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  createErrorToolResult,
  getToolUseBlocks,
  getToolResultBlocks,
  hasToolUse,
} from './messages.js'
import type { ToolUseBlock } from './messages.js'

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

describe('createUserMessage', () => {
  it('wraps string content in a TextBlock', () => {
    const msg = createUserMessage('hello', { id: messageId('m1') })
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('passes ContentBlock array through', () => {
    const blocks = [
      { type: 'text' as const, text: 'a' },
      { type: 'text' as const, text: 'b' },
    ]
    const msg = createUserMessage(blocks, { id: messageId('m2') })
    expect(msg.content).toEqual(blocks)
  })

  it('sets id and timestamp', () => {
    const msg = createUserMessage('hi', { id: messageId('m3'), timestamp: 42 })
    expect(msg.id).toBe('m3')
    expect(msg.timestamp).toBe(42)
  })

  it('defaults timestamp to Date.now()', () => {
    const before = Date.now()
    const msg = createUserMessage('hi', { id: messageId('m4') })
    expect(msg.timestamp).toBeGreaterThanOrEqual(before)
  })
})

describe('createAssistantMessage', () => {
  it('sets role, content, id, timestamp', () => {
    const content = [{ type: 'text' as const, text: 'reply' }]
    const msg = createAssistantMessage(content, {
      id: messageId('a1'),
      timestamp: 100,
    })
    expect(msg.role).toBe('assistant')
    expect(msg.content).toEqual(content)
    expect(msg.id).toBe('a1')
    expect(msg.timestamp).toBe(100)
  })
})

describe('createToolResultMessage', () => {
  it('creates tool_result block paired to ToolUseBlock', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: toolUseId('tu-1'),
      name: 'FileRead',
      input: { file_path: '/tmp/x' },
    }
    const msg = createToolResultMessage(
      toolUse,
      { content: 'file contents', isError: false },
      messageId('tr-1'),
    )
    expect(msg.role).toBe('user')
    expect(msg.content).toHaveLength(1)
    const block = msg.content[0]!
    expect(block.type).toBe('tool_result')
    if (block.type === 'tool_result') {
      expect(block.toolUseId).toBe('tu-1')
      expect(block.content).toBe('file contents')
      expect(block.isError).toBe(false)
    }
  })

  it('preserves single-block content shape when attachments is undefined', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: toolUseId('tu-undef'),
      name: 'Bash',
      input: {},
    }
    const msg = createToolResultMessage(
      toolUse,
      { content: 'ok', isError: false },
      messageId('tr-undef'),
    )
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0]!.type).toBe('tool_result')
  })

  it('preserves single-block content shape when attachments is empty', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: toolUseId('tu-empty'),
      name: 'Bash',
      input: {},
    }
    const msg = createToolResultMessage(
      toolUse,
      { content: 'ok', isError: false, attachments: [] },
      messageId('tr-empty'),
    )
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0]!.type).toBe('tool_result')
  })

  it('lays one attachment down as an adjacent ImageBlock after the ToolResultBlock', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: toolUseId('tu-2'),
      name: 'ComputerObserve',
      input: {},
    }
    const msg = createToolResultMessage(
      toolUse,
      {
        content: 'observed',
        isError: false,
        attachments: [{
          type: 'image',
          mediaType: 'image/png',
          data: 'AAAA',
          width: 100,
          height: 50,
          byteSize: 3,
        }],
      },
      messageId('tr-2'),
    )
    expect(msg.content).toHaveLength(2)
    expect(msg.content[0]!.type).toBe('tool_result')
    const img = msg.content[1]!
    expect(img.type).toBe('image')
    if (img.type === 'image') {
      expect(img.mediaType).toBe('image/png')
      expect(img.data).toBe('AAAA')
      // Dimensions/byteSize are forwarded so audit redaction can record them
      // without re-parsing the PNG.
      expect(img.width).toBe(100)
      expect(img.height).toBe(50)
      expect(img.byteSize).toBe(3)
    }
  })

  it('lays multiple attachments down in order', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: toolUseId('tu-3'),
      name: 'ComputerObserve',
      input: {},
    }
    const msg = createToolResultMessage(
      toolUse,
      {
        content: 'observed',
        isError: false,
        attachments: [
          { type: 'image', mediaType: 'image/png', data: 'A', width: 1, height: 1, byteSize: 1 },
          { type: 'image', mediaType: 'image/png', data: 'B', width: 2, height: 2, byteSize: 1 },
          { type: 'image', mediaType: 'image/png', data: 'C', width: 3, height: 3, byteSize: 1 },
        ],
      },
      messageId('tr-3'),
    )
    expect(msg.content).toHaveLength(4)
    expect(msg.content[0]!.type).toBe('tool_result')
    expect(msg.content[1]!.type).toBe('image')
    expect(msg.content[2]!.type).toBe('image')
    expect(msg.content[3]!.type).toBe('image')
    const datas = msg.content.slice(1).map(b => (b.type === 'image' ? b.data : ''))
    expect(datas).toEqual(['A', 'B', 'C'])
  })
})

describe('createErrorToolResult', () => {
  it('creates error result with isError true', () => {
    const msg = createErrorToolResult(
      toolUseId('tu-2'),
      'Something broke',
      messageId('err-1'),
    )
    expect(msg.role).toBe('user')
    const block = msg.content[0]!
    expect(block.type).toBe('tool_result')
    if (block.type === 'tool_result') {
      expect(block.toolUseId).toBe('tu-2')
      expect(block.content).toBe('Something broke')
      expect(block.isError).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('getToolUseBlocks', () => {
  it('extracts tool_use blocks, ignores others', () => {
    const msg = createAssistantMessage(
      [
        { type: 'text', text: 'thinking...' },
        { type: 'tool_use', id: toolUseId('tu-1'), name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: 'done' },
      ],
      { id: messageId('a1') },
    )
    const blocks = getToolUseBlocks(msg)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.name).toBe('Bash')
  })

  it('returns empty array when no tool_use', () => {
    const msg = createAssistantMessage(
      [{ type: 'text', text: 'just text' }],
      { id: messageId('a2') },
    )
    expect(getToolUseBlocks(msg)).toEqual([])
  })
})

describe('getToolResultBlocks', () => {
  it('extracts tool_result blocks, ignores others', () => {
    const msg = createUserMessage(
      [
        { type: 'tool_result', toolUseId: toolUseId('tu-1'), content: 'ok', isError: false },
        { type: 'text', text: 'extra' },
      ],
      { id: messageId('u1') },
    )
    const blocks = getToolResultBlocks(msg)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.content).toBe('ok')
  })
})

describe('hasToolUse', () => {
  it('returns true when tool_use present', () => {
    const msg = createAssistantMessage(
      [{ type: 'tool_use', id: toolUseId('tu-1'), name: 'Glob', input: {} }],
      { id: messageId('a1') },
    )
    expect(hasToolUse(msg)).toBe(true)
  })

  it('returns false when no tool_use', () => {
    const msg = createAssistantMessage(
      [{ type: 'text', text: 'no tools' }],
      { id: messageId('a2') },
    )
    expect(hasToolUse(msg)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

describe('branded types', () => {
  it('messageId returns a string-compatible type', () => {
    const id = messageId('abc-123')
    expect(typeof id).toBe('string')
    expect(id).toBe('abc-123')
    // Can be used wherever string is expected
    expect(`prefix-${id}`).toBe('prefix-abc-123')
  })

  it('toolUseId returns a string-compatible type', () => {
    const id = toolUseId('tu-456')
    expect(typeof id).toBe('string')
    expect(id).toBe('tu-456')
  })
})
