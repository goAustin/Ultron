import type { AssistantMessage, ToolUseId, UserMessage } from './messages.js'

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

export type CompactEvent = {
  readonly type: 'compact'
  readonly messagesBefore: number
  readonly messagesAfter: number
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
  | CompactEvent

// ---------------------------------------------------------------------------
// State machine (for documentation / future validation):
//
// RequestStart -> (TextDelta | ThinkingDelta | ToolUseStart)* -> Turn
//   -> if tool_use blocks: (ToolResult)* -> (Attachment)* -> RequestStart
//   -> if no tool_use blocks: Terminal (return from generator)
//   -> on error: Error -> (recovery continue | Terminal)
// ---------------------------------------------------------------------------
