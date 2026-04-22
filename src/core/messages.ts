// Internal message representation for Ultron.
// No Anthropic SDK imports — this is the single source of truth for message shape.

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

declare const MessageIdBrand: unique symbol
declare const ToolUseIdBrand: unique symbol

export type MessageId = string & { readonly [MessageIdBrand]: typeof MessageIdBrand }
export type ToolUseId = string & { readonly [ToolUseIdBrand]: typeof ToolUseIdBrand }

export function messageId(raw: string): MessageId {
  return raw as MessageId
}

export function toolUseId(raw: string): ToolUseId {
  return raw as ToolUseId
}

// ---------------------------------------------------------------------------
// Content Blocks — discriminated union on `type`
// ---------------------------------------------------------------------------

export type TextBlock = {
  readonly type: 'text'
  readonly text: string
}

export type ThinkingBlock = {
  readonly type: 'thinking'
  readonly thinking: string
  readonly signature: string
}

export type RedactedThinkingBlock = {
  readonly type: 'redacted_thinking'
}

export type ToolUseBlock = {
  readonly type: 'tool_use'
  readonly id: ToolUseId
  readonly name: string
  readonly input: Record<string, unknown>
}

export type ToolResultBlock = {
  readonly type: 'tool_result'
  readonly toolUseId: ToolUseId
  readonly content: string
  readonly isError: boolean
}

export type ImageBlock = {
  readonly type: 'image'
  readonly mediaType: string
  readonly data: string // base64
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock

// ---------------------------------------------------------------------------
// Message metadata & flags
// ---------------------------------------------------------------------------

export type MessageMeta = {
  readonly id: MessageId
  readonly timestamp: number
}

export type MessageFlags = {
  readonly isMeta?: boolean
  readonly isApiError?: boolean
  readonly apiErrorKind?: 'max_output_tokens' | 'prompt_too_long'
  readonly stopReason?: string
  readonly model?: string
  readonly isCompactBoundary?: boolean
  readonly isAttachment?: boolean
}

// ---------------------------------------------------------------------------
// Messages — discriminated union on `role`
// ---------------------------------------------------------------------------

export type UserMessage = MessageMeta & {
  readonly role: 'user'
  readonly content: readonly ContentBlock[]
  readonly flags?: MessageFlags
}

export type AssistantMessage = MessageMeta & {
  readonly role: 'assistant'
  readonly content: readonly ContentBlock[]
  readonly flags?: MessageFlags
}

export type Message = UserMessage | AssistantMessage

// ---------------------------------------------------------------------------
// Factory functions — the only way to construct messages
// ---------------------------------------------------------------------------

export function createUserMessage(
  content: readonly ContentBlock[] | string,
  opts: {
    id: MessageId
    flags?: MessageFlags
    timestamp?: number
  },
): UserMessage {
  return {
    id: opts.id,
    timestamp: opts.timestamp ?? Date.now(),
    role: 'user',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    ...(opts.flags && { flags: opts.flags }),
  }
}

export function createAssistantMessage(
  content: readonly ContentBlock[],
  opts: {
    id: MessageId
    flags?: MessageFlags
    timestamp?: number
  },
): AssistantMessage {
  return {
    id: opts.id,
    timestamp: opts.timestamp ?? Date.now(),
    role: 'assistant',
    content,
    ...(opts.flags && { flags: opts.flags }),
  }
}

/**
 * Build a UserMessage containing a single tool_result block
 * paired to the given tool_use.
 */
export function createToolResultMessage(
  toolUse: ToolUseBlock,
  result: { content: string; isError: boolean },
  id: MessageId,
  timestamp?: number,
): UserMessage {
  return createUserMessage(
    [
      {
        type: 'tool_result',
        toolUseId: toolUse.id,
        content: result.content,
        isError: result.isError,
      },
    ],
    { id, timestamp },
  )
}

/**
 * Build a synthetic error tool_result for an aborted or missing tool call.
 */
export function createErrorToolResult(
  toolUseId: ToolUseId,
  errorMessage: string,
  id: MessageId,
  timestamp?: number,
): UserMessage {
  return createUserMessage(
    [
      {
        type: 'tool_result',
        toolUseId,
        content: errorMessage,
        isError: true,
      },
    ],
    { id, timestamp },
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getToolUseBlocks(message: Message): readonly ToolUseBlock[] {
  return message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
}

export function getToolResultBlocks(message: Message): readonly ToolResultBlock[] {
  return message.content.filter((b): b is ToolResultBlock => b.type === 'tool_result')
}

export function hasToolUse(message: Message): boolean {
  return message.content.some((b) => b.type === 'tool_use')
}
