import { describe, it, expect } from 'vitest'
import { toolUseId, type ToolUseBlock } from './messages.js'
import {
  makePermissionDecisionEvent,
  makeToolCallStartedEvent,
  makeToolCallFinishedEvent,
  makeCompactionStartedEvent,
  makeCompactionFinishedEvent,
} from './queryEventFactories.js'

function tu(name = 'TestTool', input: Record<string, unknown> = { x: 1 }): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId('tu-1'), name, input }
}

describe('makePermissionDecisionEvent', () => {
  it('populates required fields and omits optionals when absent', () => {
    const e = makePermissionDecisionEvent(tu(), 'allow', 'rule:allow')
    expect(e.type).toBe('permission_decision')
    expect(e.toolUseId).toBe('tu-1')
    expect(e.toolName).toBe('TestTool')
    expect(e.input).toEqual({ x: 1 })
    expect(e.decision).toBe('allow')
    expect(e.reason).toBe('rule:allow')
    expect(e.userResponse).toBeUndefined()
    expect(e.ruleCreated).toBeUndefined()
    expect(typeof e.timestamp).toBe('number')
  })

  it('carries userResponse and ruleCreated when provided', () => {
    const rule = { toolName: 'TestTool', behavior: 'allow', source: 'session' } as const
    const e = makePermissionDecisionEvent(tu(), 'ask', 'prompt', {
      userResponse: 'allow_by_rule',
      ruleCreated: rule,
    })
    expect(e.userResponse).toBe('allow_by_rule')
    expect(e.ruleCreated).toEqual(rule)
  })
})

describe('makeToolCallStartedEvent', () => {
  it('copies toolUseId, name, and input verbatim', () => {
    const e = makeToolCallStartedEvent(tu('Bash', { command: 'ls' }))
    expect(e.type).toBe('tool_call_started')
    expect(e.toolUseId).toBe('tu-1')
    expect(e.toolName).toBe('Bash')
    expect(e.input).toEqual({ command: 'ls' })
  })
})

describe('makeToolCallFinishedEvent outcome derivation', () => {
  const toolUse = tu()

  it('ok on success', () => {
    const e = makeToolCallFinishedEvent(toolUse, { content: 'done', isError: false }, 5)
    expect(e.outcome).toBe('ok')
    expect(e.errorKind).toBeUndefined()
    expect(e.durationMs).toBe(5)
  })

  it('error on permission_denied (never emitted by loop; defensive only)', () => {
    // The query loop short-circuits denies at permission_decision and never
    // emits tool_call_finished for them. If someone constructs the event
    // defensively from a permission_denied result, it collapses to 'error'.
    const e = makeToolCallFinishedEvent(
      toolUse,
      { content: '[permission_denied] nope', isError: true, errorKind: 'permission_denied' },
      2,
    )
    expect(e.outcome).toBe('error')
    expect(e.errorKind).toBe('permission_denied')
  })

  it('aborted on aborted', () => {
    const e = makeToolCallFinishedEvent(
      toolUse,
      { content: '[aborted]', isError: true, errorKind: 'aborted' },
      1,
    )
    expect(e.outcome).toBe('aborted')
    expect(e.errorKind).toBe('aborted')
  })

  it('error on generic error', () => {
    const e = makeToolCallFinishedEvent(
      toolUse,
      { content: '[execution_error] boom', isError: true, errorKind: 'execution_error' },
      1,
    )
    expect(e.outcome).toBe('error')
    expect(e.errorKind).toBe('execution_error')
  })

  it('error on isError without errorKind (defensive)', () => {
    const e = makeToolCallFinishedEvent(toolUse, { content: 'fail', isError: true }, 1)
    expect(e.outcome).toBe('error')
    expect(e.errorKind).toBeUndefined()
  })

  it('truncates resultPreview to 200 chars', () => {
    const long = 'a'.repeat(500)
    const e = makeToolCallFinishedEvent(toolUse, { content: long, isError: false }, 1)
    expect(e.resultPreview.length).toBe(200)
    expect(e.resultPreview).toBe('a'.repeat(200))
  })

  it('leaves short content intact', () => {
    const e = makeToolCallFinishedEvent(toolUse, { content: 'short', isError: false }, 1)
    expect(e.resultPreview).toBe('short')
  })
})

describe('compaction factories', () => {
  it('makeCompactionStartedEvent', () => {
    const e = makeCompactionStartedEvent('pre_request', 12)
    expect(e.type).toBe('compaction_started')
    expect(e.trigger).toBe('pre_request')
    expect(e.messagesBefore).toBe(12)
  })

  it('makeCompactionFinishedEvent ok path', () => {
    const e = makeCompactionFinishedEvent(12, 3, 42)
    expect(e.type).toBe('compaction_finished')
    expect(e.outcome).toBe('ok')
    expect(e.messagesBefore).toBe(12)
    expect(e.messagesAfter).toBe(3)
    expect(e.durationMs).toBe(42)
    expect(e.errorMessage).toBeUndefined()
  })

  it('makeCompactionFinishedEvent error path', () => {
    const e = makeCompactionFinishedEvent(12, 12, 5, new Error('kaboom'))
    expect(e.outcome).toBe('error')
    expect(e.messagesAfter).toBe(12)
    expect(e.errorMessage).toBe('kaboom')
  })
})
