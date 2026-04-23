/**
 * Factory functions for QueryEvent variants introduced by Phase 2a.
 * Centralizing construction keeps field population type-checked in one place
 * and lets the query loop stay terse.
 */

import type { ToolUseBlock } from './messages.js'
import type { ToolResult } from './tools/types.js'
import type { PermissionRule } from './permissions/types.js'
import type {
  PermissionDecisionEvent,
  ToolCallStartedEvent,
  ToolCallFinishedEvent,
  ToolCallOutcome,
  CompactionStartedEvent,
  CompactionFinishedEvent,
  CompactionTrigger,
} from './queryEvents.js'

const RESULT_PREVIEW_MAX = 200

export function makePermissionDecisionEvent(
  toolUse: ToolUseBlock,
  decision: 'allow' | 'deny' | 'ask',
  reason: string,
  extra?: {
    userResponse?: PermissionDecisionEvent['userResponse']
    ruleCreated?: PermissionRule
  },
): PermissionDecisionEvent {
  return {
    type: 'permission_decision',
    toolUseId: toolUse.id,
    toolName: toolUse.name,
    input: toolUse.input,
    decision,
    reason,
    ...(extra?.userResponse !== undefined && { userResponse: extra.userResponse }),
    ...(extra?.ruleCreated !== undefined && { ruleCreated: extra.ruleCreated }),
    timestamp: Date.now(),
  }
}

export function makeToolCallStartedEvent(toolUse: ToolUseBlock): ToolCallStartedEvent {
  return {
    type: 'tool_call_started',
    toolUseId: toolUse.id,
    toolName: toolUse.name,
    input: toolUse.input,
    timestamp: Date.now(),
  }
}

export function makeToolCallFinishedEvent(
  toolUse: ToolUseBlock,
  result: ToolResult,
  durationMs: number,
): ToolCallFinishedEvent {
  const outcome = deriveOutcome(result)
  return {
    type: 'tool_call_finished',
    toolUseId: toolUse.id,
    toolName: toolUse.name,
    outcome,
    ...(result.errorKind !== undefined && { errorKind: result.errorKind }),
    durationMs,
    resultPreview: result.content.slice(0, RESULT_PREVIEW_MAX),
    timestamp: Date.now(),
  }
}

function deriveOutcome(result: ToolResult): ToolCallOutcome {
  if (!result.isError) return 'ok'
  if (result.errorKind === 'aborted') return 'aborted'
  // Note: the query loop never emits tool_call_finished for permission_denied
  // / permission_ask synthetic results (they short-circuit at permission_decision).
  // Any other isError path — including a tool that produced a permission-shaped
  // error itself — collapses to 'error'.
  return 'error'
}

export function makeCompactionStartedEvent(
  trigger: CompactionTrigger,
  messagesBefore: number,
): CompactionStartedEvent {
  return {
    type: 'compaction_started',
    trigger,
    messagesBefore,
    timestamp: Date.now(),
  }
}

export function makeCompactionFinishedEvent(
  messagesBefore: number,
  messagesAfter: number,
  durationMs: number,
  error?: Error,
): CompactionFinishedEvent {
  return {
    type: 'compaction_finished',
    outcome: error ? 'error' : 'ok',
    messagesBefore,
    messagesAfter,
    ...(error && { errorMessage: error.message }),
    durationMs,
    timestamp: Date.now(),
  }
}
