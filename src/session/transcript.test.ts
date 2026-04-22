import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  serializeMessage,
  deserializeMessage,
  appendMessage,
  readTranscript,
  getEventMessage,
} from './transcript.js'
import {
  createUserMessage,
  createAssistantMessage,
  messageId,
  toolUseId,
} from '../core/messages.js'
import type { Message, UserMessage, AssistantMessage } from '../core/messages.js'
import type { QueryEvent } from '../core/queryEvents.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-transcript-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe('serialize / deserialize round-trip', () => {
  it('UserMessage with text block preserves branded MessageId', () => {
    const msg = createUserMessage('hello world', {
      id: messageId('msg-001'),
      timestamp: 1000,
    })
    const line = serializeMessage(msg)
    const result = deserializeMessage(line)

    expect(result.id).toBe('msg-001')
    expect(result.role).toBe('user')
    expect(result.timestamp).toBe(1000)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello world' })
  })

  it('AssistantMessage with tool_use blocks preserves ToolUseId', () => {
    const msg = createAssistantMessage(
      [
        { type: 'text', text: 'Let me edit that file.' },
        {
          type: 'tool_use',
          id: toolUseId('tu-001'),
          name: 'FileEdit',
          input: { file_path: '/tmp/foo.ts', old_string: 'a', new_string: 'b' },
        },
      ],
      { id: messageId('msg-002'), timestamp: 2000 },
    )

    const result = deserializeMessage(serializeMessage(msg))
    expect(result.role).toBe('assistant')
    const toolBlock = result.content[1]!
    expect(toolBlock.type).toBe('tool_use')
    if (toolBlock.type === 'tool_use') {
      expect(toolBlock.id).toBe('tu-001')
      expect(toolBlock.name).toBe('FileEdit')
      expect(toolBlock.input).toEqual({ file_path: '/tmp/foo.ts', old_string: 'a', new_string: 'b' })
    }
  })

  it('UserMessage with tool_result preserves toolUseId in block', () => {
    const msg = createUserMessage(
      [{ type: 'tool_result', toolUseId: toolUseId('tu-002'), content: 'OK', isError: false }],
      { id: messageId('msg-003'), timestamp: 3000 },
    )

    const result = deserializeMessage(serializeMessage(msg))
    const block = result.content[0]!
    expect(block.type).toBe('tool_result')
    if (block.type === 'tool_result') {
      expect(block.toolUseId).toBe('tu-002')
      expect(block.content).toBe('OK')
      expect(block.isError).toBe(false)
    }
  })

  it('Message with flags round-trips', () => {
    const msg = createUserMessage('summary', {
      id: messageId('msg-004'),
      timestamp: 4000,
      flags: { isAttachment: true, isCompactBoundary: true },
    })

    const result = deserializeMessage(serializeMessage(msg))
    expect(result.flags?.isAttachment).toBe(true)
    expect(result.flags?.isCompactBoundary).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Validation strictness
// ---------------------------------------------------------------------------

describe('deserializeMessage validation', () => {
  it('rejects missing role', () => {
    expect(() => deserializeMessage('{"id":"x","timestamp":1,"content":[]}')).toThrow('role')
  })

  it('rejects tool_use block without name', () => {
    const line = JSON.stringify({
      id: 'x', timestamp: 1, role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu-1', input: {} }],
    })
    expect(() => deserializeMessage(line)).toThrow('name')
  })

  it('rejects tool_result block without toolUseId', () => {
    const line = JSON.stringify({
      id: 'x', timestamp: 1, role: 'user',
      content: [{ type: 'tool_result', content: 'ok', isError: false }],
    })
    expect(() => deserializeMessage(line)).toThrow('toolUseId')
  })
})

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe('appendMessage', () => {
  it('creates directory and file on first write, returns true', async () => {
    await withTmpDir(async (base) => {
      const sessionDir = join(base, 'new-session')
      const msg = createUserMessage('hello', { id: messageId('m1') })

      const ok = await appendMessage(sessionDir, msg)
      expect(ok).toBe(true)

      const messages = await readTranscript(sessionDir)
      expect(messages).toHaveLength(1)
      expect(messages[0]!.content[0]).toEqual({ type: 'text', text: 'hello' })
    })
  })

  it('returns false on write error', async () => {
    await withTmpDir(async (base) => {
      // Create a read-only directory to force write failure
      const sessionDir = join(base, 'readonly')
      mkdirSync(sessionDir)
      // Create a directory where the file should be — can't write a file over a directory
      mkdirSync(join(sessionDir, 'transcript.jsonl'))

      const msg = createUserMessage('hello', { id: messageId('m1') })
      const ok = await appendMessage(sessionDir, msg)
      expect(ok).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// readTranscript
// ---------------------------------------------------------------------------

describe('readTranscript', () => {
  it('reads messages in order', async () => {
    await withTmpDir(async (dir) => {
      const m1 = createUserMessage('first', { id: messageId('m1'), timestamp: 100 })
      const m2 = createAssistantMessage(
        [{ type: 'text', text: 'second' }],
        { id: messageId('m2'), timestamp: 200 },
      )
      await appendMessage(dir, m1)
      await appendMessage(dir, m2)

      const messages = await readTranscript(dir)
      expect(messages).toHaveLength(2)
      expect(messages[0]!.role).toBe('user')
      expect(messages[1]!.role).toBe('assistant')
    })
  })

  it('returns empty array for non-existent file', async () => {
    await withTmpDir(async (dir) => {
      const messages = await readTranscript(join(dir, 'no-such-session'))
      expect(messages).toEqual([])
    })
  })

  it('skips trailing incomplete line silently', async () => {
    await withTmpDir(async (dir) => {
      const m1 = createUserMessage('hello', { id: messageId('m1') })
      await appendMessage(dir, m1)

      // Append a corrupt trailing line
      const { appendFileSync } = await import('fs')
      appendFileSync(join(dir, 'transcript.jsonl'), '{"broken json\n')

      const messages = await readTranscript(dir)
      expect(messages).toHaveLength(1)
      expect(messages[0]!.id).toBe('m1')
    })
  })

  it('warns on mid-file corrupt line but returns valid messages', async () => {
    await withTmpDir(async (dir) => {
      const m1 = createUserMessage('first', { id: messageId('m1'), timestamp: 100 })
      const m2 = createUserMessage('third', { id: messageId('m3'), timestamp: 300 })

      // Write m1, a corrupt line, then m2
      const { writeFileSync } = await import('fs')
      const lines = [
        serializeMessage(m1),
        '{"totally":"broken"}',
        serializeMessage(m2),
      ].join('\n') + '\n'
      writeFileSync(join(dir, 'transcript.jsonl'), lines)

      const messages = await readTranscript(dir)
      expect(messages).toHaveLength(2)
      expect(messages[0]!.id).toBe('m1')
      expect(messages[1]!.id).toBe('m3')
    })
  })
})

// ---------------------------------------------------------------------------
// getEventMessage
// ---------------------------------------------------------------------------

describe('getEventMessage', () => {
  it('returns message for turn/tool_result/attachment, null for others', () => {
    const userMsg = createUserMessage('hi', { id: messageId('u1') })
    const assistantMsg = createAssistantMessage(
      [{ type: 'text', text: 'hello' }],
      { id: messageId('a1') },
    )

    expect(getEventMessage({ type: 'turn', message: assistantMsg })).toBe(assistantMsg)
    expect(getEventMessage({ type: 'tool_result', message: userMsg })).toBe(userMsg)
    expect(getEventMessage({ type: 'attachment', message: userMsg })).toBe(userMsg)

    expect(getEventMessage({ type: 'request_start' })).toBeNull()
    expect(getEventMessage({ type: 'text_delta', text: 'hi' })).toBeNull()
    expect(getEventMessage({ type: 'thinking_delta', thinking: 'hmm' })).toBeNull()
    expect(getEventMessage({
      type: 'tool_use_start',
      id: toolUseId('tu-1'),
      name: 'FileRead',
    })).toBeNull()
    expect(getEventMessage({
      type: 'error',
      error: new Error('fail'),
      recoverable: false,
    })).toBeNull()
  })
})
