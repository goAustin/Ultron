import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'

import { runPostToolUseHooks } from './runPostToolUseHooks.js'
import type { HookConfig, HookContext } from './types.js'
import { emptyHookConfig } from './types.js'
import type { ToolUseBlock } from '../core/messages.js'
import { toolUseId } from '../core/messages.js'
import type { QueryEvent } from '../core/queryEvents.js'
import type { ToolResult } from '../core/tools/types.js'

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/hooks')
const script = (name: string): string => resolve(FIXTURES, name)

const SIGNAL_NEVER = new AbortController().signal

function tu(name: string): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId('tu_1'), name, input: {} }
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

function configWith(post: HookConfig['hooks']['PostToolUse']): HookConfig {
  return { schemaVersion: 1, hooks: { PreToolUse: [], PostToolUse: post } }
}

const baseResult: ToolResult = { content: 'orig', isError: false }

describe('runPostToolUseHooks', () => {
  it('empty config → no events, result unchanged', async () => {
    const { events, value } = await drain(
      runPostToolUseHooks(tu('Bash'), baseResult, ctx(emptyHookConfig()), SIGNAL_NEVER),
    )
    expect(events).toEqual([])
    expect(value.result).toBe(baseResult)
  })

  it('additionalContext hook appends to result content', async () => {
    const { value } = await drain(
      runPostToolUseHooks(
        tu('Bash'),
        baseResult,
        ctx(configWith([{ matcher: 'Bash', command: script('post-additional-context.sh') }])),
        SIGNAL_NEVER,
      ),
    )
    expect(value.result.content).toBe('orig\n\nnote')
    expect(value.result.isError).toBe(false)
  })

  it('post hook cannot block — block decision on stdout is ignored', async () => {
    const { events, value } = await drain(
      runPostToolUseHooks(
        tu('Bash'),
        baseResult,
        ctx(configWith([{ matcher: 'Bash', command: script('exit-0-stdout-block.sh') }])),
        SIGNAL_NEVER,
      ),
    )
    // runHook still reports outcome:'block' on hook_finished (transparency),
    // but the orchestrator returns the original result unchanged.
    const finished = events.find((e) => e.type === 'hook_finished')
    expect(finished?.type).toBe('hook_finished')
    expect(value.result).toBe(baseResult)
  })
})
