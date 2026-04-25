import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'

import { runPreToolUseHooks } from './runPreToolUseHooks.js'
import type { HookConfig, HookContext } from './types.js'
import { emptyHookConfig } from './types.js'
import type { ToolUseBlock } from '../core/messages.js'
import { toolUseId } from '../core/messages.js'
import type { QueryEvent } from '../core/queryEvents.js'

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/hooks')
const script = (name: string): string => resolve(FIXTURES, name)

const SIGNAL_NEVER = new AbortController().signal

function tu(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId('tu_1'), name, input }
}

function ctx(config: HookConfig): HookContext {
  return { sessionId: 'test-session', cwd: process.cwd(), hookConfig: config }
}

async function drain<T>(gen: AsyncGenerator<QueryEvent, T>): Promise<{ events: QueryEvent[]; value: T }> {
  const events: QueryEvent[] = []
  let result = await gen.next()
  while (!result.done) {
    events.push(result.value)
    result = await gen.next()
  }
  return { events, value: result.value }
}

function configWith(pre: HookConfig['hooks']['PreToolUse']): HookConfig {
  return { schemaVersion: 1, hooks: { PreToolUse: pre, PostToolUse: [] } }
}

describe('runPreToolUseHooks', () => {
  it('empty config → no events, returns continue', async () => {
    const { events, value } = await drain(
      runPreToolUseHooks(tu('Bash'), ctx(emptyHookConfig()), SIGNAL_NEVER),
    )
    expect(events).toEqual([])
    expect(value).toEqual({ kind: 'continue' })
  })

  it('one ok hook → exactly one started + one finished(ok)', async () => {
    const { events, value } = await drain(
      runPreToolUseHooks(
        tu('Bash'),
        ctx(configWith([{ matcher: 'Bash', command: script('exit-0.sh') }])),
        SIGNAL_NEVER,
      ),
    )
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('hook_started')
    expect(events[1]?.type).toBe('hook_finished')
    if (events[1]?.type === 'hook_finished') {
      expect(events[1].outcome).toBe('ok')
      expect(events[1].mutatedInput).toBe(false)
    }
    expect(value).toEqual({ kind: 'continue' })
  })

  it('block hook → returns block with synthetic hook_blocked result', async () => {
    const { events, value } = await drain(
      runPreToolUseHooks(
        tu('Bash'),
        ctx(configWith([{ matcher: 'Bash', command: script('exit-2.sh') }])),
        SIGNAL_NEVER,
      ),
    )
    const finished = events.find((e) => e.type === 'hook_finished')
    expect(finished?.type).toBe('hook_finished')
    if (finished?.type === 'hook_finished') {
      expect(finished.outcome).toBe('block')
      expect(finished.decisionReason).toBe('denied')
    }
    expect(value.kind).toBe('block')
    if (value.kind === 'block') {
      expect(value.syntheticResult.isError).toBe(true)
      expect(value.syntheticResult.errorKind).toBe('hook_blocked')
      expect(value.syntheticResult.content).toContain('denied')
    }
  })

  it('mutating hook → propagates updatedInput; hook_finished.mutatedInput=true', async () => {
    const { events, value } = await drain(
      runPreToolUseHooks(
        tu('Bash', { original: true }),
        ctx(configWith([{ matcher: 'Bash', command: script('mutate-input.sh') }])),
        SIGNAL_NEVER,
      ),
    )
    const finished = events.find((e) => e.type === 'hook_finished')
    if (finished?.type === 'hook_finished') {
      expect(finished.mutatedInput).toBe(true)
    }
    expect(value).toEqual({ kind: 'continue', updatedInput: { foo: 'bar' } })
  })

  it('first hook blocks → second hook NOT invoked', async () => {
    const { events } = await drain(
      runPreToolUseHooks(
        tu('Bash'),
        ctx(
          configWith([
            { matcher: 'Bash', command: script('exit-2.sh') },
            { matcher: 'Bash', command: script('exit-0.sh') },
          ]),
        ),
        SIGNAL_NEVER,
      ),
    )
    // Only one started + one finished for the blocking first hook.
    const starts = events.filter((e) => e.type === 'hook_started')
    const finishes = events.filter((e) => e.type === 'hook_finished')
    expect(starts).toHaveLength(1)
    expect(finishes).toHaveLength(1)
  })

  it('first hook error, second hook block → both run; second wins', async () => {
    const { events, value } = await drain(
      runPreToolUseHooks(
        tu('Bash'),
        ctx(
          configWith([
            { matcher: 'Bash', command: script('exit-nonzero.sh') },
            { matcher: 'Bash', command: script('exit-2.sh') },
          ]),
        ),
        SIGNAL_NEVER,
      ),
    )
    const starts = events.filter((e) => e.type === 'hook_started')
    expect(starts).toHaveLength(2)
    expect(value.kind).toBe('block')
  })

  it('non-matching hook is skipped', async () => {
    const { events } = await drain(
      runPreToolUseHooks(
        tu('Read'),
        ctx(configWith([{ matcher: 'Bash', command: script('exit-2.sh') }])),
        SIGNAL_NEVER,
      ),
    )
    expect(events).toHaveLength(0)
  })
})
