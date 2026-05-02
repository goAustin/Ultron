/**
 * Factory functions for QueryEvent variants introduced by Phase 2a.
 * Centralizing construction keeps field population type-checked in one place
 * and lets the query loop stay terse.
 */

import type { ToolUseBlock } from './messages.js'
import type { ToolResult } from './tools/types.js'
import type { PermissionRule, SafetyMetadata } from './permissions/types.js'
import type {
  PermissionDecisionEvent,
  ToolCallStartedEvent,
  ToolCallFinishedEvent,
  ToolCallOutcome,
  ToolProgressEvent,
  CompactionStartedEvent,
  CompactionFinishedEvent,
  CompactionTrigger,
  HookStartedEvent,
  HookFinishedEvent,
  HookEventName,
  MemoryEntryWrittenEvent,
  MemoryEntryDeletedEvent,
  MemoryEntryType,
  SkillWrittenEvent,
  SkillDeletedEvent,
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  WebBackendResolvedEvent,
} from './queryEvents.js'
import type { ToolUseId } from './messages.js'
import type { HookDefinition, HookInvocationResult } from '../hooks/types.js'

const RESULT_PREVIEW_MAX = 200

export function makePermissionDecisionEvent(
  toolUse: ToolUseBlock,
  decision: 'allow' | 'deny' | 'ask',
  reason: string,
  extra?: {
    userResponse?: PermissionDecisionEvent['userResponse']
    ruleCreated?: PermissionRule
    safetyMetadata?: SafetyMetadata
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
    ...(extra?.safetyMetadata !== undefined && { safetyMetadata: extra.safetyMetadata }),
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

export function makeToolProgressEvent(args: {
  toolUseId: ToolUseId
  progress: number
  total: number | null
  message: string | null
}): ToolProgressEvent {
  return {
    type: 'tool_progress',
    toolUseId: args.toolUseId,
    progress: args.progress,
    total: args.total,
    message: args.message,
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

export function makeHookStartedEvent(
  hookEvent: HookEventName,
  hookIndex: number,
  toolUse: ToolUseBlock,
  def: HookDefinition,
): HookStartedEvent {
  return {
    type: 'hook_started',
    hookEvent,
    hookIndex,
    toolUseId: toolUse.id,
    toolName: toolUse.name,
    matcher: def.matcher,
    command: def.command,
    timestamp: Date.now(),
  }
}

export function makeMemoryEntryWrittenEvent(args: {
  id: string
  entryType: MemoryEntryType
  name: string
  bytes: number
  isNew: boolean
}): MemoryEntryWrittenEvent {
  return {
    type: 'memory_entry_written',
    id: args.id,
    entryType: args.entryType,
    name: args.name,
    bytes: args.bytes,
    isNew: args.isNew,
    timestamp: Date.now(),
  }
}

export function makeMemoryEntryDeletedEvent(args: {
  id: string
  entryType: MemoryEntryType
}): MemoryEntryDeletedEvent {
  return {
    type: 'memory_entry_deleted',
    id: args.id,
    entryType: args.entryType,
    timestamp: Date.now(),
  }
}

export function makeSkillWrittenEvent(args: {
  id: string
  name: string
  bytes: number
  hasAllowedTools: boolean
  isNew: boolean
}): SkillWrittenEvent {
  return {
    type: 'skill_written',
    id: args.id,
    name: args.name,
    bytes: args.bytes,
    hasAllowedTools: args.hasAllowedTools,
    isNew: args.isNew,
    timestamp: Date.now(),
  }
}

export function makeSkillDeletedEvent(args: {
  id: string
  name: string
}): SkillDeletedEvent {
  return {
    type: 'skill_deleted',
    id: args.id,
    name: args.name,
    timestamp: Date.now(),
  }
}

export function makeSkillActivatedEvent(args: {
  id: string
  name: string
  turns: number
  hasAllowedTools: boolean
  hasArgs: boolean
}): SkillActivatedEvent {
  return {
    type: 'skill_activated',
    id: args.id,
    name: args.name,
    turns: args.turns,
    hasAllowedTools: args.hasAllowedTools,
    hasArgs: args.hasArgs,
    timestamp: Date.now(),
  }
}

export function makeSkillDeactivatedEvent(args: {
  id: string
  name: string
  reason: 'turns_exhausted' | 'user_deactivated' | 'error' | 'secret_refused'
}): SkillDeactivatedEvent {
  return {
    type: 'skill_deactivated',
    id: args.id,
    name: args.name,
    reason: args.reason,
    timestamp: Date.now(),
  }
}

export function makeWebBackendResolvedEvent(args: {
  backend: 'duckduckgo' | 'brave' | 'tavily'
  source: 'env' | 'settings' | 'default'
}): WebBackendResolvedEvent {
  return {
    type: 'web_backend_resolved',
    backend: args.backend,
    source: args.source,
    timestamp: Date.now(),
  }
}

export function makeHookFinishedEvent(
  hookEvent: HookEventName,
  hookIndex: number,
  toolUse: ToolUseBlock,
  def: HookDefinition,
  result: HookInvocationResult,
  extra: { mutatedInput: boolean },
): HookFinishedEvent {
  const exitCode =
    result.outcome === 'ok' || result.outcome === 'block'
      ? result.exitCode
      : result.outcome === 'error'
        ? result.exitCode
        : undefined
  const reason = result.outcome === 'block' ? result.reason : undefined

  return {
    type: 'hook_finished',
    hookEvent,
    hookIndex,
    toolUseId: toolUse.id,
    toolName: toolUse.name,
    matcher: def.matcher,
    outcome: result.outcome,
    ...(reason !== undefined && { decisionReason: reason }),
    mutatedInput: extra.mutatedInput,
    outputTruncated: result.outputTruncated,
    ...(exitCode !== undefined && { exitCode }),
    durationMs: result.durationMs,
    ...(result.stderrPreview.length > 0 && { stderrPreview: result.stderrPreview }),
    timestamp: Date.now(),
  }
}
