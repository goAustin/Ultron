/**
 * Single tool execution pipeline — split for Phase 2a.
 *
 * `authorizeToolUse` runs resolve → validate → permissions (engine) → askUser
 * and returns either `{outcome: 'authorized', decision}` or
 * `{outcome: 'denied', decision, syntheticResult}`. It never runs `tool.call`.
 *
 * `executeToolUse` runs only `tool.call` (plus error wrapping). The caller is
 * responsible for authorizing first.
 *
 * `runToolUse` is kept as a compatibility wrapper: authorize → execute, with the
 * same external semantics as before 2a (returns a single `ToolResult`).
 *
 * No exceptions escape any of these — every path returns a typed value.
 */

import type { ToolUseBlock } from '../messages.js'
import type { ToolResult } from './types.js'
import type { ToolUseContext } from './context.js'
import type {
  PermissionOptions,
  PermissionRule,
} from '../permissions/types.js'
import type {
  AuthorizeDecisionPayload,
  AuthorizeToolOutcome,
} from '../queryDeps.js'
import { DEFAULT_PERMISSION_OPTIONS } from '../permissions/types.js'
import {
  hasPermissionsToUseTool,
  formatDecisionMessage,
} from '../permissions/permissions.js'
import { makeErrorResult, makeAbortResult, checkAbort } from './toolExecution.js'

// ---------------------------------------------------------------------------
// authorizeToolUse — resolve + validate + permissions + askUser
// ---------------------------------------------------------------------------

export async function authorizeToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
  permissionOpts: PermissionOptions = DEFAULT_PERMISSION_OPTIONS,
): Promise<AuthorizeToolOutcome> {
  // 1. Check abort — NOT a policy decision; fails the precondition.
  if (signal.aborted) {
    return precondition(makeAbortResult())
  }

  // 2. Resolve tool — NOT a policy decision.
  const tool = context.toolRegistry.get(toolUse.name)
  if (!tool) {
    return precondition(
      makeErrorResult('tool_not_found', `Tool "${toolUse.name}" not found`),
    )
  }

  // 3. Validate input — NOT a policy decision.
  try {
    const validation = await tool.validateInput(toolUse.input, context)
    if (!validation.valid) {
      return precondition(makeErrorResult('validation_failed', validation.message))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return precondition(makeErrorResult('validation_failed', msg))
  }

  // 4. Check abort — still pre-permission, not a policy decision.
  if (signal.aborted) {
    return precondition(makeAbortResult())
  }

  // 5. Check permissions via engine — this is the actual policy decision.
  const decision = await hasPermissionsToUseTool(tool, toolUse, context, permissionOpts)

  if (decision.behavior === 'deny') {
    const reason = formatDecisionMessage(decision)
    return denied(
      { decision: 'deny', reason },
      makeErrorResult('permission_denied', reason),
    )
  }

  if (decision.behavior === 'ask') {
    const reason = formatDecisionMessage(decision)

    if (!permissionOpts.askUser) {
      // No prompt function — preserve permission_ask for external handling.
      // This IS a policy-adjacent outcome: the engine asked, nobody answered,
      // so it's recorded as a deny on the permission event stream.
      return denied(
        { decision: 'ask', reason },
        makeErrorResult('permission_ask', reason),
      )
    }

    const response = await permissionOpts.askUser(toolUse.name, toolUse.input, reason, signal)

    const ruleCreated: PermissionRule | undefined =
      response === 'allow_by_rule'
        ? {
            toolName: toolUse.name,
            behavior: 'allow',
            ...(tool.getPath?.(toolUse.input) && { path: tool.getPath(toolUse.input) }),
            source: 'session',
          }
        : undefined

    const payload: AuthorizeDecisionPayload = {
      decision: 'ask',
      reason,
      userResponse: response,
      ...(ruleCreated && { ruleCreated }),
    }

    if (response === 'abort') {
      return denied(payload, makeAbortResult())
    }

    if (response === 'deny_once') {
      return denied(
        payload,
        makeErrorResult('permission_denied', `User denied: ${reason}`),
      )
    }

    if (response === 'allow_by_rule' && ruleCreated) {
      // Persist exact-match rule to AppState for this session
      const currentRules = context.appState.getState().permissionRules
      context.appState.setState({ permissionRules: [...currentRules, ruleCreated] })
    }

    // allow_once or allow_by_rule — fall through to authorized
    return { outcome: 'authorized', decision: payload }
  }

  // behavior === 'allow'
  return {
    outcome: 'authorized',
    decision: { decision: 'allow', reason: formatDecisionMessage(decision) },
  }
}

// ---------------------------------------------------------------------------
// executeToolUse — tool.call only (no permission check, no validation)
// ---------------------------------------------------------------------------

export async function executeToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
): Promise<ToolResult> {
  // Abort check immediately before dispatch — prevents racing into execution after cancel.
  const aborted = checkAbort(signal)
  if (aborted) return aborted

  const tool = context.toolRegistry.get(toolUse.name)
  if (!tool) {
    return makeErrorResult('tool_not_found', `Tool "${toolUse.name}" not found`)
  }

  try {
    return await tool.call(toolUse.input, context, signal)
  } catch (err) {
    return makeErrorResult(
      'execution_error',
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ---------------------------------------------------------------------------
// runToolUse — compatibility wrapper: authorize then execute
// ---------------------------------------------------------------------------

export async function runToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
  permissionOpts: PermissionOptions = DEFAULT_PERMISSION_OPTIONS,
): Promise<ToolResult> {
  const auth = await authorizeToolUse(toolUse, context, signal, permissionOpts)
  if (auth.outcome !== 'authorized') return auth.syntheticResult
  return executeToolUse(toolUse, context, signal)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function denied(
  decision: AuthorizeDecisionPayload,
  syntheticResult: ToolResult,
): AuthorizeToolOutcome {
  return { outcome: 'denied', decision, syntheticResult }
}

function precondition(syntheticResult: ToolResult): AuthorizeToolOutcome {
  return { outcome: 'precondition_failed', syntheticResult }
}
