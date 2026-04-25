import type { ToolUseBlock } from '../core/messages.js'
import type { QueryEvent } from '../core/queryEvents.js'
import {
  makeHookStartedEvent,
  makeHookFinishedEvent,
} from '../core/queryEventFactories.js'
import { makeErrorResult } from '../core/tools/toolExecution.js'

import type { HookContext, PreHookOutcome } from './types.js'
import { hookMatches } from './matcher.js'
import { runHook } from './runHook.js'

/**
 * Run every PreToolUse hook whose matcher applies to this tool_use, in order.
 *
 * - Emits hook_started / hook_finished pairs as an async-generator stream.
 * - A hook returning outcome:'block' short-circuits; later hooks do NOT run.
 * - A hook returning a valid `updatedInput` mutates the stream for subsequent
 *   hooks — the last survivor wins.
 * - 'error' / 'timeout' outcomes are logged and do NOT block (fail-open).
 */
export async function* runPreToolUseHooks(
  toolUse: ToolUseBlock,
  context: HookContext,
  signal: AbortSignal,
): AsyncGenerator<QueryEvent, PreHookOutcome> {
  const matching = context.hookConfig.hooks.PreToolUse.filter((h) =>
    hookMatches(h, toolUse.name),
  )

  let currentInput = toolUse.input

  for (let i = 0; i < matching.length; i++) {
    if (signal.aborted) break

    const def = matching[i]!
    yield makeHookStartedEvent('PreToolUse', i, toolUse, def)

    const res = await runHook(
      def,
      {
        hook_event_name: 'PreToolUse',
        tool_name: toolUse.name,
        tool_input: currentInput,
        session_id: context.sessionId,
        cwd: context.cwd,
      },
      signal,
    )

    const mutated = res.outcome === 'ok' && res.updatedInput !== undefined
    yield makeHookFinishedEvent('PreToolUse', i, toolUse, def, res, {
      mutatedInput: mutated,
    })

    if (res.outcome === 'block') {
      return {
        kind: 'block',
        syntheticResult: makeErrorResult('hook_blocked', res.reason),
      }
    }

    if (mutated && res.outcome === 'ok' && res.updatedInput !== undefined) {
      currentInput = res.updatedInput
    }
    // 'error' / 'timeout' — already logged on hook_finished, continue to next.
  }

  return currentInput === toolUse.input
    ? { kind: 'continue' }
    : { kind: 'continue', updatedInput: currentInput }
}
