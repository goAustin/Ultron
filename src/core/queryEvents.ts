import type { AssistantMessage, ToolUseId, UserMessage } from './messages.js'
import type { ToolErrorKind } from './tools/types.js'
import type { PermissionRule } from './permissions/types.js'

// ---------------------------------------------------------------------------
// Streaming events yielded by query()
// ---------------------------------------------------------------------------

export type RequestStartEvent = {
  readonly type: 'request_start'
}

export type TextDeltaEvent = {
  readonly type: 'text_delta'
  readonly text: string
}

export type ThinkingDeltaEvent = {
  readonly type: 'thinking_delta'
  readonly thinking: string
}

/**
 * Model has announced a new tool_use block during SSE streaming.
 * Fires early — before execution. See also `ToolCallStartedEvent` for the
 * execution-boundary event.
 */
export type ToolUseStartEvent = {
  readonly type: 'tool_use_start'
  readonly id: ToolUseId
  readonly name: string
}

export type ToolResultEvent = {
  readonly type: 'tool_result'
  readonly message: UserMessage
}

export type TurnEvent = {
  readonly type: 'turn'
  readonly message: AssistantMessage
}

export type ErrorEvent = {
  readonly type: 'error'
  readonly error: Error
  readonly recoverable: boolean
}

export type AttachmentEvent = {
  readonly type: 'attachment'
  readonly message: UserMessage
}

// ---------------------------------------------------------------------------
// Audit spine events (Phase 2a)
// ---------------------------------------------------------------------------

export type PermissionDecisionEvent = {
  readonly type: 'permission_decision'
  readonly toolUseId: ToolUseId
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly decision: 'allow' | 'deny' | 'ask'
  readonly reason: string
  readonly userResponse?: 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'
  readonly ruleCreated?: PermissionRule
  readonly timestamp: number
}

/**
 * Outcome of a tool's execution phase. Note: the permission-deny case never
 * reaches `tool_call_finished` — the query loop emits only `permission_decision`
 * then `tool_result` for denials. `aborted` is reported only when the tool
 * itself aborted during `tool.call` (not when authorization aborted).
 */
export type ToolCallOutcome = 'ok' | 'error' | 'aborted'

export type ToolCallStartedEvent = {
  readonly type: 'tool_call_started'
  readonly toolUseId: ToolUseId
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly timestamp: number
}

export type ToolCallFinishedEvent = {
  readonly type: 'tool_call_finished'
  readonly toolUseId: ToolUseId
  readonly toolName: string
  readonly outcome: ToolCallOutcome
  readonly errorKind?: ToolErrorKind
  readonly durationMs: number
  readonly resultPreview: string
  readonly timestamp: number
}

export type CompactionTrigger = 'pre_request' | 'post_turn' | 'prompt_too_long_recovery'

export type CompactionStartedEvent = {
  readonly type: 'compaction_started'
  readonly trigger: CompactionTrigger
  readonly messagesBefore: number
  readonly timestamp: number
}

export type CompactionFinishedEvent = {
  readonly type: 'compaction_finished'
  readonly outcome: 'ok' | 'error'
  readonly messagesBefore: number
  readonly messagesAfter: number
  readonly errorMessage?: string
  readonly durationMs: number
  readonly timestamp: number
}

export type QueryEvent =
  | RequestStartEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolUseStartEvent
  | ToolResultEvent
  | TurnEvent
  | ErrorEvent
  | AttachmentEvent
  | PermissionDecisionEvent
  | ToolCallStartedEvent
  | ToolCallFinishedEvent
  | CompactionStartedEvent
  | CompactionFinishedEvent

// ---------------------------------------------------------------------------
// State machine (for documentation / future validation):
//
// RequestStart -> (TextDelta | ThinkingDelta | ToolUseStart)* -> Turn
//   -> if tool_use blocks:
//        for each tool_use:
//          PermissionDecision
//          if decision.outcome === 'authorized':
//            ToolCallStarted -> ToolCallFinished -> ToolResult
//          else:
//            ToolResult (synthetic error)
//        (Attachment)* -> RequestStart
//   -> if no tool_use blocks: Terminal
//   -> on compaction: CompactionStarted -> CompactionFinished
//   -> on error: Error -> (recovery continue | Terminal)
// ---------------------------------------------------------------------------
