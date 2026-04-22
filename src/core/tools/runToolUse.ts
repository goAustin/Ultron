/**
 * Single tool execution pipeline.
 *
 * resolve → abort check → validate → abort check → permissions (engine) → abort check → call
 *
 * Plain async function. No exceptions escape — every path returns a ToolResult.
 */

import type { ToolUseBlock } from '../messages.js'
import type { ToolResult } from './types.js'
import type { ToolUseContext } from './context.js'
import type { PermissionOptions, PermissionRule } from '../permissions/types.js'
import { DEFAULT_PERMISSION_OPTIONS } from '../permissions/types.js'
import { hasPermissionsToUseTool, formatDecisionMessage } from '../permissions/permissions.js'
import { summarizeInput } from '../permissions/logging.js'
import { makeErrorResult, makeAbortResult, checkAbort } from './toolExecution.js'

export async function runToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
  permissionOpts: PermissionOptions = DEFAULT_PERMISSION_OPTIONS,
): Promise<ToolResult> {
  // 1. Check abort
  const aborted1 = checkAbort(signal)
  if (aborted1) return aborted1

  // 2. Resolve tool
  const tool = context.toolRegistry.get(toolUse.name)
  if (!tool) {
    return makeErrorResult('tool_not_found', `Tool "${toolUse.name}" not found`)
  }

  // 3. Validate input
  try {
    const validation = await tool.validateInput(toolUse.input, context)
    if (!validation.valid) {
      return makeErrorResult('validation_failed', validation.message)
    }
  } catch (err) {
    return makeErrorResult('validation_failed', err instanceof Error ? err.message : String(err))
  }

  // 4. Check abort
  const aborted2 = checkAbort(signal)
  if (aborted2) return aborted2

  // 5. Check permissions via engine
  const decision = await hasPermissionsToUseTool(tool, toolUse, context, permissionOpts)
  if (decision.behavior === 'deny') {
    return makeErrorResult('permission_denied', formatDecisionMessage(decision))
  }
  if (decision.behavior === 'ask') {
    if (!permissionOpts.askUser) {
      // No prompt function — preserve permission_ask for external handling
      return makeErrorResult('permission_ask', formatDecisionMessage(decision))
    }

    const reason = formatDecisionMessage(decision)
    const response = await permissionOpts.askUser(toolUse.name, toolUse.input, reason, signal)

    // Log the decision (if logger provided)
    if (permissionOpts.logDecision) {
      const ruleCreated: PermissionRule | undefined =
        response === 'allow_by_rule'
          ? {
              toolName: toolUse.name,
              behavior: 'allow',
              ...(tool.getPath?.(toolUse.input) && { path: tool.getPath(toolUse.input) }),
              source: 'session',
            }
          : undefined

      await permissionOpts.logDecision({
        timestamp: Date.now(),
        toolName: toolUse.name,
        inputSummary: summarizeInput(toolUse.name, toolUse.input),
        decision: 'ask',
        reason,
        userResponse: response,
        ...(ruleCreated && { ruleCreated }),
      })
    }

    if (response === 'abort') {
      return makeAbortResult()
    }

    if (response === 'deny_once') {
      return makeErrorResult('permission_denied', `User denied: ${reason}`)
    }

    if (response === 'allow_by_rule') {
      // Persist exact-match rule to AppState for this session
      const rule: PermissionRule = {
        toolName: toolUse.name,
        behavior: 'allow',
        ...(tool.getPath?.(toolUse.input) && { path: tool.getPath(toolUse.input) }),
        source: 'session',
      }
      const currentRules = context.appState.getState().permissionRules
      context.appState.setState({ permissionRules: [...currentRules, rule] })
    }

    // allow_once or allow_by_rule — fall through to execution
  }

  // 6. Check abort — critical: prevents racing into execution after cancel
  const aborted3 = checkAbort(signal)
  if (aborted3) return aborted3

  // 7. Execute
  try {
    return await tool.call(toolUse.input, context, signal)
  } catch (err) {
    return makeErrorResult('execution_error', err instanceof Error ? err.message : String(err))
  }
}
