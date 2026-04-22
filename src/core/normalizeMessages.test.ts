import { describe, it, expect } from 'vitest'

import {
  stripMetaMessages,
  ensureToolResultPairing,
  stripOrphanedToolResults,
  enforceRoleAlternation,
  stripStaleThinkingBlocks,
  normalizeMessages,
} from './normalizeMessages.js'
import {
  createUserMessage,
  createAssistantMessage,
  messageId,
  toolUseId,
} from './messages.js'
import type { Message, ContentBlock } from './messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function user(content: string | ContentBlock[], id: string, flags?: Record<string, unknown>): Message {
  return createUserMessage(content, { id: messageId(id), timestamp: 1, flags: flags as any })
}

function assistant(content: ContentBlock[], id: string): Message {
  return createAssistantMessage(content, { id: messageId(id), timestamp: 1 })
}

function text(t: string): ContentBlock {
  return { type: 'text', text: t }
}

function toolUse(id: string, name: string): ContentBlock {
  return { type: 'tool_use', id: toolUseId(id), name, input: {} }
}

function toolResult(tuId: string, content = 'ok'): ContentBlock {
  return { type: 'tool_result', toolUseId: toolUseId(tuId), content, isError: false }
}

function thinking(t: string): ContentBlock {
  return { type: 'thinking', thinking: t, signature: 'sig' }
}

// ---------------------------------------------------------------------------
// Step 1: stripMetaMessages
// ---------------------------------------------------------------------------

describe('stripMetaMessages', () => {
  it('strips messages with isMeta flag', () => {
    const msgs = [
      user('meta msg', 'm1', { isMeta: true }),
      assistant([text('reply')], 'a1'),
      user('real msg', 'm2'),
    ]
    const result = stripMetaMessages(msgs)
    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe('a1')
    expect(result[1]!.id).toBe('m2')
  })

  it('keeps messages without flags or with other flags', () => {
    const msgs = [
      user('no flags', 'm1'),
      user('other flags', 'm2', { isAttachment: true }),
    ]
    const result = stripMetaMessages(msgs)
    expect(result).toHaveLength(2)
  })

  it('returns empty for empty input', () => {
    expect(stripMetaMessages([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Step 2: ensureToolResultPairing
// ---------------------------------------------------------------------------

describe('ensureToolResultPairing', () => {
  it('leaves paired tool_use/result unchanged', () => {
    const msgs: Message[] = [
      assistant([toolUse('tu1', 'FileRead')], 'a1'),
      user([toolResult('tu1')], 'u1'),
    ]
    const result = ensureToolResultPairing(msgs)
    expect(result).toHaveLength(2)
  })

  it('injects synthetic error for unpaired tool_use', () => {
    const msgs: Message[] = [
      assistant([toolUse('tu1', 'FileRead')], 'a1'),
    ]
    const result = ensureToolResultPairing(msgs)
    expect(result).toHaveLength(2)
    const injected = result[1]!
    expect(injected.role).toBe('user')
    const block = injected.content[0]!
    expect(block.type).toBe('tool_result')
    if (block.type === 'tool_result') {
      expect(block.toolUseId).toBe('tu1')
      expect(block.isError).toBe(true)
    }
  })

  it('injects one synthetic per unpaired tool_use', () => {
    const msgs: Message[] = [
      assistant([toolUse('tu1', 'FileRead'), toolUse('tu2', 'Glob')], 'a1'),
    ]
    const result = ensureToolResultPairing(msgs)
    // Original + 2 synthetics
    expect(result.length).toBeGreaterThanOrEqual(3)
  })

  it('does not inject duplicates when already paired', () => {
    const msgs: Message[] = [
      assistant([toolUse('tu1', 'FileRead')], 'a1'),
      user([toolResult('tu1')], 'u1'),
    ]
    const before = msgs.length
    const result = ensureToolResultPairing(msgs)
    expect(result).toHaveLength(before)
  })
})

// ---------------------------------------------------------------------------
// Step 3: stripOrphanedToolResults
// ---------------------------------------------------------------------------

describe('stripOrphanedToolResults', () => {
  it('removes tool_result with no matching tool_use', () => {
    const msgs: Message[] = [
      assistant([toolUse('tu1', 'FileRead')], 'a1'),
      user([toolResult('tu1'), toolResult('orphan')], 'u1'),
    ]
    const result = stripOrphanedToolResults(msgs)
    expect(result).toHaveLength(2)
    const userMsg = result[1]!
    expect(userMsg.content).toHaveLength(1)
    if (userMsg.content[0]!.type === 'tool_result') {
      expect(userMsg.content[0]!.toolUseId).toBe('tu1')
    }
  })

  it('keeps properly paired results', () => {
    const msgs: Message[] = [
      assistant([toolUse('tu1', 'FileRead')], 'a1'),
      user([toolResult('tu1')], 'u1'),
    ]
    const result = stripOrphanedToolResults(msgs)
    expect(result).toHaveLength(2)
    expect(result[1]!.content).toHaveLength(1)
  })

  it('drops user message entirely when all content is orphaned', () => {
    const msgs: Message[] = [
      user([toolResult('orphan1')], 'u1'),
    ]
    const result = stripOrphanedToolResults(msgs)
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Step 4: enforceRoleAlternation
// ---------------------------------------------------------------------------

describe('enforceRoleAlternation', () => {
  it('merges consecutive same-role messages', () => {
    const msgs: Message[] = [
      user('first', 'u1'),
      user('second', 'u2'),
      assistant([text('reply')], 'a1'),
    ]
    const result = enforceRoleAlternation(msgs)
    expect(result).toHaveLength(2)
    expect(result[0]!.content).toHaveLength(2) // merged content
  })

  it('preserves alternating messages unchanged', () => {
    const msgs: Message[] = [
      user('hi', 'u1'),
      assistant([text('hello')], 'a1'),
      user('bye', 'u2'),
    ]
    const result = enforceRoleAlternation(msgs)
    expect(result).toHaveLength(3)
  })

  it('preserves first message metadata when merging', () => {
    const msgs: Message[] = [
      createUserMessage('first', { id: messageId('u1'), timestamp: 100 }),
      createUserMessage('second', { id: messageId('u2'), timestamp: 200 }),
    ]
    const result = enforceRoleAlternation(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('u1')
    expect(result[0]!.timestamp).toBe(100)
    expect(result[0]!.content).toHaveLength(2)
  })

  it('handles single message', () => {
    const msgs: Message[] = [user('only', 'u1')]
    const result = enforceRoleAlternation(msgs)
    expect(result).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Step 5: stripStaleThinkingBlocks
// ---------------------------------------------------------------------------

describe('stripStaleThinkingBlocks', () => {
  it('preserves thinking in current trajectory', () => {
    const msgs: Message[] = [
      user('prompt', 'u1'),
      assistant([thinking('hmm'), text('answer')], 'a1'),
    ]
    const result = stripStaleThinkingBlocks(msgs)
    expect(result[1]!.content).toHaveLength(2)
    expect(result[1]!.content[0]!.type).toBe('thinking')
  })

  it('strips thinking from older turns', () => {
    const msgs: Message[] = [
      user('first prompt', 'u1'),
      assistant([thinking('old thought'), text('old answer')], 'a1'),
      user('second prompt', 'u2'),
      assistant([thinking('new thought'), text('new answer')], 'a2'),
    ]
    const result = stripStaleThinkingBlocks(msgs)
    // Old assistant: thinking stripped
    expect(result[1]!.content).toHaveLength(1)
    expect(result[1]!.content[0]!.type).toBe('text')
    // New assistant: thinking preserved
    expect(result[3]!.content).toHaveLength(2)
    expect(result[3]!.content[0]!.type).toBe('thinking')
  })

  it('inserts placeholder when stripping leaves empty content', () => {
    const msgs: Message[] = [
      user('prompt', 'u1'),
      assistant([thinking('only thinking')], 'a1'),
      user('next', 'u2'),
      assistant([text('final')], 'a2'),
    ]
    const result = stripStaleThinkingBlocks(msgs)
    // Old assistant had only thinking → should have placeholder
    expect(result[1]!.content).toHaveLength(1)
    expect(result[1]!.content[0]!.type).toBe('text')
  })
})

// ---------------------------------------------------------------------------
// Composed normalizeMessages
// ---------------------------------------------------------------------------

describe('normalizeMessages', () => {
  it('handles a realistic multi-turn conversation', () => {
    const msgs: Message[] = [
      user('edit foo.ts', 'u1'),
      assistant([text('I will edit the file.'), toolUse('tu1', 'FileEdit')], 'a1'),
      user([toolResult('tu1', 'Edit applied')], 'u2'),
      assistant([text('Done!')], 'a2'),
    ]
    const result = normalizeMessages(msgs)
    expect(result.length).toBeGreaterThanOrEqual(4)
    // All roles alternate
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.role).not.toBe(result[i - 1]!.role)
    }
  })

  it('cleans up pathological input', () => {
    const msgs: Message[] = [
      // Meta message — should be stripped
      user('system info', 'meta1', { isMeta: true }),
      // Real user
      user('hello', 'u1'),
      // Assistant with thinking (will become stale)
      assistant([thinking('old'), text('first reply')], 'a1'),
      // Consecutive user messages — should merge
      user('follow up 1', 'u2'),
      user('follow up 2', 'u3'),
      // Current assistant with unpaired tool_use
      assistant([thinking('current'), toolUse('tu1', 'Bash')], 'a2'),
    ]

    const result = normalizeMessages(msgs)

    // Meta stripped, users merged, synthetic result injected, alternation enforced
    // Old thinking stripped, current thinking preserved
    expect(result.length).toBeGreaterThan(0)

    // Should alternate roles
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.role).not.toBe(result[i - 1]!.role)
    }

    // Unpaired tu1 should have a synthetic result
    const toolResultBlocks = result.flatMap((m) =>
      m.content.filter((b) => b.type === 'tool_result'),
    )
    expect(toolResultBlocks.some((b) => b.type === 'tool_result' && b.toolUseId === 'tu1')).toBe(true)
  })
})
