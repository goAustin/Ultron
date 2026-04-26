import { describe, it, expect } from 'vitest'

import { buildAuditTree, type AuditEnvelope } from './auditTree.js'
import { toolUseId } from '../core/messages.js'

const NOW = '2026-04-26T00:00:00.000Z'

function rootEnv(
  type: AuditEnvelope['type'],
  fields: Record<string, unknown> = {},
): AuditEnvelope {
  return {
    schemaVersion: 1,
    tsIso: NOW,
    type,
    ...fields,
  }
}

function childEnv(
  origin: string,
  parentToolUseId: string,
  type: AuditEnvelope['type'],
  fields: Record<string, unknown> = {},
): AuditEnvelope {
  return {
    schemaVersion: 1,
    tsIso: NOW,
    type,
    origin,
    parentToolUseId: toolUseId(parentToolUseId),
    ...fields,
  }
}

describe('buildAuditTree', () => {
  it('returns an empty root for empty input', () => {
    const tree = buildAuditTree([])
    expect(tree.origin).toBeNull()
    expect(tree.parentToolUseId).toBeNull()
    expect(tree.events).toEqual([])
    expect(tree.children).toEqual([])
  })

  it('groups all root envelopes (no origin) into the synthetic root subtree', () => {
    const envelopes = [
      rootEnv('request_start'),
      rootEnv('turn'),
      rootEnv('error', { error: { message: 'x' }, recoverable: false }),
    ]
    const tree = buildAuditTree(envelopes)
    expect(tree.origin).toBeNull()
    expect(tree.events).toHaveLength(3)
    expect(tree.children).toEqual([])
  })

  it('links one child subtree to a parent tool_call_started by toolUseId', () => {
    const envelopes = [
      rootEnv('tool_call_started', {
        toolUseId: 'tu_parent_1',
        toolName: 'Agent',
        input: {},
        timestamp: 0,
      }),
      childEnv('sub-1', 'tu_parent_1', 'request_start'),
      childEnv('sub-1', 'tu_parent_1', 'turn'),
    ]
    const tree = buildAuditTree(envelopes)
    expect(tree.children).toHaveLength(1)
    const child = tree.children[0]!
    expect(child.origin).toBe('sub-1')
    expect(child.parentToolUseId).toBe('tu_parent_1')
    expect(child.events).toHaveLength(2)
    expect(child.children).toEqual([])
  })

  it('two parallel children with interleaved events resolve to distinct subtrees', () => {
    const envelopes = [
      rootEnv('tool_call_started', {
        toolUseId: 'tu_A',
        toolName: 'Agent',
        input: {},
        timestamp: 0,
      }),
      rootEnv('tool_call_started', {
        toolUseId: 'tu_B',
        toolName: 'Agent',
        input: {},
        timestamp: 0,
      }),
      // Interleaved:
      childEnv('sub-A', 'tu_A', 'request_start'),
      childEnv('sub-B', 'tu_B', 'request_start'),
      childEnv('sub-A', 'tu_A', 'turn'),
      childEnv('sub-B', 'tu_B', 'turn'),
    ]
    const tree = buildAuditTree(envelopes)
    expect(tree.children).toHaveLength(2)
    const byOrigin = new Map(tree.children.map((c) => [c.origin, c]))
    const childA = byOrigin.get('sub-A')!
    const childB = byOrigin.get('sub-B')!
    expect(childA.events).toHaveLength(2)
    expect(childB.events).toHaveLength(2)
    expect(childA.events.every((e) => e.parentToolUseId === 'tu_A')).toBe(true)
    expect(childB.events.every((e) => e.parentToolUseId === 'tu_B')).toBe(true)
  })

  it('same origin reused under two parentToolUseIds → two distinct subtrees (defense-in-depth)', () => {
    // A buggy producer reuses "sub-X" under both tu_A and tu_B. Grouping
    // by (origin, parentToolUseId) surfaces the bug as two separate
    // subtrees rather than collapsing into one mislinked subtree.
    const envelopes = [
      rootEnv('tool_call_started', {
        toolUseId: 'tu_A',
        toolName: 'Agent',
        input: {},
        timestamp: 0,
      }),
      rootEnv('tool_call_started', {
        toolUseId: 'tu_B',
        toolName: 'Agent',
        input: {},
        timestamp: 0,
      }),
      childEnv('sub-X', 'tu_A', 'turn'),
      childEnv('sub-X', 'tu_B', 'turn'),
    ]
    const tree = buildAuditTree(envelopes)
    expect(tree.children).toHaveLength(2)
    const parents = tree.children.map((c) => c.parentToolUseId).sort()
    expect(parents).toEqual(['tu_A', 'tu_B'])
    // Both subtrees claim origin "sub-X" — that's the bug-surface.
    for (const child of tree.children) {
      expect(child.origin).toBe('sub-X')
    }
  })

  it('throws when a child parentToolUseId has no matching tool_call_started anywhere', () => {
    const envelopes = [
      rootEnv('request_start'),
      childEnv('sub-orphan', 'tu_missing', 'turn'),
    ]
    expect(() => buildAuditTree(envelopes)).toThrowError(/orphan subtree/)
  })

  it('throws when an envelope has origin but no parentToolUseId (malformed)', () => {
    const envelopes: AuditEnvelope[] = [
      rootEnv('request_start'),
      {
        schemaVersion: 1,
        tsIso: NOW,
        type: 'turn',
        origin: 'sub-malformed',
        // missing parentToolUseId
      },
    ]
    expect(() => buildAuditTree(envelopes)).toThrowError(/malformed envelope/)
  })

  it('throws when an envelope has parentToolUseId but no origin (malformed)', () => {
    const envelopes: AuditEnvelope[] = [
      rootEnv('request_start'),
      {
        schemaVersion: 1,
        tsIso: NOW,
        type: 'turn',
        parentToolUseId: toolUseId('tu_X'),
        // missing origin
      },
    ]
    expect(() => buildAuditTree(envelopes)).toThrowError(/malformed envelope/)
  })

  it('throws when origin envelopes exist but no root subtree (caller violated single-session contract)', () => {
    const envelopes = [childEnv('sub-Y', 'tu_Y', 'turn')]
    expect(() => buildAuditTree(envelopes)).toThrowError(/no root subtree/)
  })

  it('handles a nested grandchild subtree via repeated lookup', () => {
    // Today subagents can't fork further, but the contract supports it.
    // A grandchild's parentToolUseId points at a tool_call_started event
    // emitted from inside its parent subtree.
    const envelopes = [
      rootEnv('tool_call_started', {
        toolUseId: 'tu_parent',
        toolName: 'Agent',
        input: {},
        timestamp: 0,
      }),
      childEnv('sub-1', 'tu_parent', 'tool_call_started', {
        toolUseId: 'tu_child_inner',
        toolName: 'Agent',
        input: {},
        timestamp: 0,
      }),
      childEnv('sub-grandchild', 'tu_child_inner', 'turn'),
    ]
    const tree = buildAuditTree(envelopes)
    expect(tree.children).toHaveLength(1)
    const child = tree.children[0]!
    expect(child.origin).toBe('sub-1')
    expect(child.children).toHaveLength(1)
    const grandchild = child.children[0]!
    expect(grandchild.origin).toBe('sub-grandchild')
    expect(grandchild.parentToolUseId).toBe('tu_child_inner')
  })
})
