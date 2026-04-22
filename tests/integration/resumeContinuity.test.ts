import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { appendMessage, readTranscript } from '../../src/session/transcript.js'
import { normalizeMessages } from '../../src/core/normalizeMessages.js'
import {
  createUserMessage,
  createAssistantMessage,
  messageId,
  toolUseId,
} from '../../src/core/messages.js'
import type { Message } from '../../src/core/messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-resume-int-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resume continuity', () => {
  it('messages round-trip through persist and resume', async () => {
    await withTmpDir(async (dir) => {
      const m1 = createUserMessage('Hello', { id: messageId('u1'), timestamp: 100 })
      const m2 = createAssistantMessage(
        [{ type: 'text', text: 'Hi there!' }],
        { id: messageId('a1'), timestamp: 200 },
      )
      const m3 = createUserMessage('Edit foo.ts', { id: messageId('u2'), timestamp: 300 })

      await appendMessage(dir, m1)
      await appendMessage(dir, m2)
      await appendMessage(dir, m3)

      const resumed = await readTranscript(dir)
      expect(resumed).toHaveLength(3)
      expect(resumed[0]!.id).toBe('u1')
      expect(resumed[1]!.id).toBe('a1')
      expect(resumed[2]!.id).toBe('u2')
      expect(resumed[0]!.timestamp).toBe(100)
    })
  })

  it('compact boundary is first in resumed result (inclusive)', async () => {
    await withTmpDir(async (dir) => {
      const m1 = createUserMessage('old message', { id: messageId('u1'), timestamp: 100 })
      const m2 = createAssistantMessage(
        [{ type: 'text', text: 'old reply' }],
        { id: messageId('a1'), timestamp: 200 },
      )
      const boundary = createUserMessage('Summary of prior conversation.', {
        id: messageId('cb1'),
        timestamp: 300,
        flags: { isCompactBoundary: true },
      })
      const m3 = createUserMessage('new message', { id: messageId('u2'), timestamp: 400 })
      const m4 = createAssistantMessage(
        [{ type: 'text', text: 'new reply' }],
        { id: messageId('a2'), timestamp: 500 },
      )

      for (const m of [m1, m2, boundary, m3, m4]) {
        await appendMessage(dir, m)
      }

      const allMessages = await readTranscript(dir)

      // Find last compact boundary
      let boundaryIndex = -1
      for (let i = allMessages.length - 1; i >= 0; i--) {
        if (allMessages[i]!.flags?.isCompactBoundary) {
          boundaryIndex = i
          break
        }
      }

      const resumed = boundaryIndex >= 0
        ? allMessages.slice(boundaryIndex)
        : allMessages

      // Boundary message is first (inclusive)
      expect(resumed).toHaveLength(3)
      expect(resumed[0]!.id).toBe('cb1')
      expect(resumed[0]!.flags?.isCompactBoundary).toBe(true)
      expect(resumed[1]!.id).toBe('u2')
      expect(resumed[2]!.id).toBe('a2')
    })
  })

  it('attachment messages survive round-trip with isAttachment flag', async () => {
    await withTmpDir(async (dir) => {
      const attachment = createUserMessage(
        '<system-reminder>Git status updated</system-reminder>',
        { id: messageId('att-1'), timestamp: 100, flags: { isAttachment: true } },
      )

      await appendMessage(dir, attachment)
      const resumed = await readTranscript(dir)

      expect(resumed).toHaveLength(1)
      expect(resumed[0]!.flags?.isAttachment).toBe(true)
      const block = resumed[0]!.content[0]!
      if (block.type === 'text') {
        expect(block.text).toContain('system-reminder')
      }
    })
  })

  it('resumed tool_use/tool_result messages pass normalizeMessages', async () => {
    await withTmpDir(async (dir) => {
      const userMsg = createUserMessage('edit file', { id: messageId('u1'), timestamp: 100 })
      const assistantMsg = createAssistantMessage(
        [
          { type: 'text', text: 'I will edit the file.' },
          { type: 'tool_use', id: toolUseId('tu-1'), name: 'FileEdit', input: { file_path: '/tmp/x' } },
        ],
        { id: messageId('a1'), timestamp: 200 },
      )
      const toolResult = createUserMessage(
        [{ type: 'tool_result', toolUseId: toolUseId('tu-1'), content: 'Edit applied', isError: false }],
        { id: messageId('tr-1'), timestamp: 300 },
      )
      const finalReply = createAssistantMessage(
        [{ type: 'text', text: 'Done!' }],
        { id: messageId('a2'), timestamp: 400 },
      )

      for (const m of [userMsg, assistantMsg, toolResult, finalReply]) {
        await appendMessage(dir, m)
      }

      const resumed = await readTranscript(dir)

      // normalizeMessages should not alter properly paired messages
      const normalized = normalizeMessages(resumed)
      expect(normalized).toHaveLength(4)
      // Roles alternate
      expect(normalized[0]!.role).toBe('user')
      expect(normalized[1]!.role).toBe('assistant')
      expect(normalized[2]!.role).toBe('user')
      expect(normalized[3]!.role).toBe('assistant')
    })
  })
})
