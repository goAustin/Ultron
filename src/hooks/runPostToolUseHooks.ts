import type { ToolUseBlock } from '../core/messages.js'
import type { QueryEvent } from '../core/queryEvents.js'
import {
  makeHookStartedEvent,
  makeHookFinishedEvent,
} from '../core/queryEventFactories.js'
import type { ToolResult } from '../core/tools/types.js'

import type { HookContext, PostHookOutcome } from './types.js'
import { hookMatches } from './matcher.js'
import { runHook } from './runHook.js'

const ADDITIONAL_CONTEXT_SEPARATOR = '\n\n'

/**
 * Run every PostToolUse hook whose matcher applies to this tool_use, in order.
 *
 * Post hooks cannot block. They can only append `additionalContext` to the
 * tool result's content. Concatenation order is tool.call output first,
 * then each hook's additionalContext separated by blank lines.
 *
 * If a post hook returns `{"decision":"block"}`, the runHook stage reports
 * `outcome:'block'` but this orchestrator ignores it — block semantics do
 * not apply after execution.
 */
export async function* runPostToolUseHooks(
  toolUse: ToolUseBlock,
  initialResult: ToolResult,
  context: HookContext,
  signal: AbortSignal,
): AsyncGenerator<QueryEvent, PostHookOutcome> {
  const matching = context.hookConfig.hooks.PostToolUse.filter((h) =>
    hookMatches(h, toolUse.name),
  )

  let result = initialResult

  for (let i = 0; i < matching.length; i++) {
    if (signal.aborted) break

    const def = matching[i]!
    yield makeHookStartedEvent('PostToolUse', i, toolUse, def)

    const res = await runHook(
      def,
      {
        hook_event_name: 'PostToolUse',
        tool_name: toolUse.name,
        tool_input: toolUse.input,
        tool_response: { content: result.content, is_error: result.isError },
        session_id: context.sessionId,
        cwd: context.cwd,
      },
      signal,
    )

    yield makeHookFinishedEvent('PostToolUse', i, toolUse, def, res, {
      mutatedInput: false,
    })

    if (res.outcome === 'ok' && res.additionalContext !== undefined) {
      result = {
        ...result,
        content: result.content + ADDITIONAL_CONTEXT_SEPARATOR + res.additionalContext,
      }
    }
    // 'block' / 'error' / 'timeout' — ignored for post hooks.
  }

  return { result }
}
