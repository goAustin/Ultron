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

/**
 * Side-channel progress emitted during tool execution.
 *
 * Phase 3d: tools (today, MCP) can call `ctx.onProgress(...)` to surface
 * intermediate signal during a long-running call. The bridge in
 * `streamToolUse` turns each call into one of these events, correlated to
 * the originating `tool_use` by `toolUseId`. Progress is **observability,
 * not transcript** — it flows on the QueryEvent stream and is never inserted
 * into the message array, never seen by `normalizeMessages` or compaction,
 * never persisted into the on-disk session.
 */
export type ToolProgressEvent = {
  readonly type: 'tool_progress'
  readonly toolUseId: ToolUseId
  readonly progress: number
  readonly total: number | null
  readonly message: string | null
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Hook events (Phase 2b) — emitted around every PreToolUse / PostToolUse
// subprocess invocation.
// ---------------------------------------------------------------------------

export type HookEventName = 'PreToolUse' | 'PostToolUse'

export type HookOutcome = 'ok' | 'block' | 'error' | 'timeout'

export type HookStartedEvent = {
  readonly type: 'hook_started'
  readonly hookEvent: HookEventName
  readonly hookIndex: number
  readonly toolUseId: ToolUseId
  readonly toolName: string
  readonly matcher: string
  readonly command: string
  readonly timestamp: number
}

export type HookFinishedEvent = {
  readonly type: 'hook_finished'
  readonly hookEvent: HookEventName
  readonly hookIndex: number
  readonly toolUseId: ToolUseId
  readonly toolName: string
  readonly matcher: string
  readonly outcome: HookOutcome
  readonly decisionReason?: string
  readonly mutatedInput: boolean
  readonly outputTruncated: boolean
  readonly exitCode?: number
  readonly durationMs: number
  readonly stderrPreview?: string
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Memory events (Phase 4a) — emitted by the memory store for writes/deletes.
// Payload is metadata only; entry content is never on the event, even before
// the audit-boundary redactor runs.
// ---------------------------------------------------------------------------

export type MemoryEntryType = 'user' | 'feedback' | 'project' | 'reference'

export type MemoryEntryWrittenEvent = {
  readonly type: 'memory_entry_written'
  readonly id: string
  readonly entryType: MemoryEntryType
  readonly name: string
  readonly bytes: number
  readonly isNew: boolean
  readonly timestamp: number
}

export type MemoryEntryDeletedEvent = {
  readonly type: 'memory_entry_deleted'
  readonly id: string
  readonly entryType: MemoryEntryType
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Skill events (Phase 5a) — emitted by the skills store for writes/deletes.
// Payload is metadata only; skill content, description, argument-hint, and
// the allowed-tools list are never on the event.
// ---------------------------------------------------------------------------

export type SkillWrittenEvent = {
  readonly type: 'skill_written'
  readonly id: string
  readonly name: string
  readonly bytes: number
  readonly hasAllowedTools: boolean
  readonly isNew: boolean
  readonly timestamp: number
}

export type SkillDeletedEvent = {
  readonly type: 'skill_deleted'
  readonly id: string
  readonly name: string
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Skill activation events (Phase 5b) — emitted by QueryEngine on activate /
// deactivate. Payload is metadata only; body, args, and the allowed-tools
// list are never on the event. `secret_refused` is the deactivation reason
// emitted when activation is refused before any active state exists.
// ---------------------------------------------------------------------------

export type SkillActivatedEvent = {
  readonly type: 'skill_activated'
  readonly id: string
  readonly name: string
  readonly turns: number
  readonly hasAllowedTools: boolean
  readonly hasArgs: boolean
  readonly timestamp: number
}

export type SkillDeactivatedEvent = {
  readonly type: 'skill_deactivated'
  readonly id: string
  readonly name: string
  readonly reason:
    | 'turns_exhausted'
    | 'user_deactivated'
    | 'error'
    | 'secret_refused'
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Web events (Phase 6b) — emitted on first WebSearch invocation per session.
// Payload is metadata only; the user's query and any API key material are
// never on the event.
// ---------------------------------------------------------------------------

export type WebBackendResolvedEvent = {
  readonly type: 'web_backend_resolved'
  readonly backend: 'duckduckgo' | 'brave' | 'tavily'
  readonly source: 'env' | 'settings' | 'default'
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
  | ToolProgressEvent
  | ToolCallFinishedEvent
  | HookStartedEvent
  | HookFinishedEvent
  | CompactionStartedEvent
  | CompactionFinishedEvent
  | MemoryEntryWrittenEvent
  | MemoryEntryDeletedEvent
  | SkillWrittenEvent
  | SkillDeletedEvent
  | SkillActivatedEvent
  | SkillDeactivatedEvent
  | WebBackendResolvedEvent

// ---------------------------------------------------------------------------
// State machine (for documentation / future validation):
//
// RequestStart -> (TextDelta | ThinkingDelta | ToolUseStart)* -> Turn
//   -> if tool_use blocks:
//        for each tool_use:
//          PermissionDecision
//          if decision.outcome === 'authorized':
//            (HookStarted -> HookFinished)*        // PreToolUse
//            if any pre-hook blocked:
//              ToolResult (synthetic hook_blocked)
//            else:
//              ToolCallStarted -> ToolCallFinished
//              (HookStarted -> HookFinished)*      // PostToolUse
//              ToolResult
//          else:
//            ToolResult (synthetic error)
//        (Attachment)* -> RequestStart
//   -> if no tool_use blocks: Terminal
//   -> on compaction: CompactionStarted -> CompactionFinished
//   -> on error: Error -> (recovery continue | Terminal)
// ---------------------------------------------------------------------------
