import { describe, it, expect } from 'vitest'

import { checkToolRepetition } from './repetitionGuard.js'
import {
  createAssistantMessage,
  messageId,
  toolUseId,
} from '../messages.js'
import type { Message, ToolUseBlock } from '../messages.js'

function tu(name: string, input: Record<string, unknown>, id = 'cur'): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId(id), name, input }
}

function assistantWith(blocks: ToolUseBlock[], idx: number): Message {
  return createAssistantMessage(blocks, { id: messageId(`m-${idx}`), timestamp: idx })
}

function history(...blocks: ToolUseBlock[]): readonly Message[] {
  return blocks.map((b, i) => assistantWith([b], i))
}

describe('checkToolRepetition', () => {
  it('does not trip on the first call', () => {
    const result = checkToolRepetition(tu('FileRead', { file_path: '/a' }), [])
    expect(result.tripped).toBe(false)
  })

  it('does not trip when only different tools precede', () => {
    const msgs = history(
      tu('FileRead', { file_path: '/a' }, 'p1'),
      tu('Grep', { pattern: 'x' }, 'p2'),
      tu('Glob', { pattern: '*.ts' }, 'p3'),
    )
    const result = checkToolRepetition(tu('FileRead', { file_path: '/b' }), msgs)
    expect(result.tripped).toBe(false)
  })

  it('does not trip on three identical calls (under the threshold of four)', () => {
    const msgs = history(
      tu('Grep', { pattern: 'x' }, 'p1'),
      tu('Grep', { pattern: 'x' }, 'p2'),
      tu('Grep', { pattern: 'x' }, 'p3'),
    )
    // Caller is the FOURTH attempt with a DIFFERENT pattern — no match.
    const result = checkToolRepetition(tu('Grep', { pattern: 'y' }), msgs)
    expect(result.tripped).toBe(false)
  })

  it('trips on the fourth structurally identical call', () => {
    const msgs = history(
      tu('Grep', { pattern: 'x' }, 'p1'),
      tu('Grep', { pattern: 'x' }, 'p2'),
      tu('Grep', { pattern: 'x' }, 'p3'),
    )
    const result = checkToolRepetition(tu('Grep', { pattern: 'x' }), msgs)
    expect(result.tripped).toBe(true)
    if (result.tripped) {
      expect(result.reason).toContain('Grep')
      expect(result.reason).toContain('OpenInBrowser')
    }
  })

  describe('ComputerClick coordinate similarity', () => {
    it('treats clicks within ±0.02 as the same place', () => {
      const msgs = history(
        tu('ComputerClick', { sessionId: 's', x: 0.388, y: 0.303, button: 'left' }, 'p1'),
        tu('ComputerClick', { sessionId: 's', x: 0.389, y: 0.282, button: 'left' }, 'p2'),
        tu('ComputerClick', { sessionId: 's', x: 0.389, y: 0.282, button: 'left' }, 'p3'),
      )
      const result = checkToolRepetition(
        tu('ComputerClick', { sessionId: 's', x: 0.380, y: 0.283, button: 'left' }),
        msgs,
      )
      expect(result.tripped).toBe(true)
    })

    it('does not trip when coords are far apart', () => {
      const msgs = history(
        tu('ComputerClick', { sessionId: 's', x: 0.1, y: 0.1, button: 'left' }, 'p1'),
        tu('ComputerClick', { sessionId: 's', x: 0.5, y: 0.5, button: 'left' }, 'p2'),
        tu('ComputerClick', { sessionId: 's', x: 0.9, y: 0.9, button: 'left' }, 'p3'),
      )
      const result = checkToolRepetition(
        tu('ComputerClick', { sessionId: 's', x: 0.3, y: 0.3, button: 'left' }),
        msgs,
      )
      expect(result.tripped).toBe(false)
    })
  })

  describe('ComputerActAtom atomId similarity', () => {
    it('trips on four ActAtom calls against the same atomId, regardless of action.type', () => {
      const msgs = history(
        tu('ComputerActAtom', { sessionId: 's', atomId: 'a-8', action: { type: 'click' } }, 'p1'),
        tu('ComputerActAtom', { sessionId: 's', atomId: 'a-8', action: { type: 'click' } }, 'p2'),
        tu('ComputerActAtom', { sessionId: 's', atomId: 'a-8', action: { type: 'fill', text: 'x' } }, 'p3'),
      )
      const result = checkToolRepetition(
        tu('ComputerActAtom', { sessionId: 's', atomId: 'a-8', action: { type: 'click' } }),
        msgs,
      )
      expect(result.tripped).toBe(true)
    })

    it('does not trip when atomIds differ', () => {
      const msgs = history(
        tu('ComputerActAtom', { sessionId: 's', atomId: 'a-1', action: { type: 'click' } }, 'p1'),
        tu('ComputerActAtom', { sessionId: 's', atomId: 'a-2', action: { type: 'click' } }, 'p2'),
        tu('ComputerActAtom', { sessionId: 's', atomId: 'a-3', action: { type: 'click' } }, 'p3'),
      )
      const result = checkToolRepetition(
        tu('ComputerActAtom', { sessionId: 's', atomId: 'a-4', action: { type: 'click' } }),
        msgs,
      )
      expect(result.tripped).toBe(false)
    })
  })

  it('skips the in-flight tool_use if it already appears in messages', () => {
    // Edge case: the current tool_use is committed to messages before
    // executeToolUse runs. We must not double-count it.
    const sameId = 'in-flight'
    const msgs = history(
      tu('Grep', { pattern: 'x' }, 'p1'),
      tu('Grep', { pattern: 'x' }, 'p2'),
      tu('Grep', { pattern: 'x' }, sameId),
    )
    const result = checkToolRepetition(tu('Grep', { pattern: 'x' }, sameId), msgs)
    // Counts only p1 + p2 = 2 prior matches; +1 self = 3 total < threshold 4.
    expect(result.tripped).toBe(false)
  })

  it('respects window: only the last N prior tool_uses count', () => {
    // Five matches in history but window=3 → only the latest 3 prior visible
    // → 3 prior + 1 current = 4 → trips.
    const msgs = history(
      tu('Grep', { pattern: 'x' }, 'p1'),
      tu('Grep', { pattern: 'x' }, 'p2'),
      tu('Grep', { pattern: 'x' }, 'p3'),
      tu('Grep', { pattern: 'x' }, 'p4'),
      tu('Grep', { pattern: 'x' }, 'p5'),
    )
    const tight = checkToolRepetition(tu('Grep', { pattern: 'x' }), msgs, {
      window: 3,
    })
    expect(tight.tripped).toBe(true)
    // Verify matching window cap: with very tight bounds, count plateaus.
    const reason = tight.tripped ? tight.reason : ''
    expect(reason).toContain('4 times')
  })
})
