import type { Message, ToolUseBlock, ToolResultBlock, MessageId, UserMessage } from './messages.js'
import type { ToolExecution } from '../context/attachmentTypes.js'
import { messageId } from './messages.js'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Raw stream events from the API (subset we consume)
// ---------------------------------------------------------------------------

export type RawContentBlockStart = {
  readonly type: 'content_block_start'
  readonly index: number
  readonly content_block:
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'redacted_thinking' }
}

export type RawContentBlockDelta = {
  readonly type: 'content_block_delta'
  readonly index: number
  readonly delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'signature_delta'; signature: string }
}

export type RawContentBlockStop = {
  readonly type: 'content_block_stop'
  readonly index: number
}

export type RawMessageStart = {
  readonly type: 'message_start'
  readonly message: { usage?: { input_tokens: number; output_tokens: number } }
}

export type RawMessageDelta = {
  readonly type: 'message_delta'
  readonly delta: { stop_reason: string | null }
  readonly usage?: { output_tokens: number }
}

export type RawMessageStop = {
  readonly type: 'message_stop'
}

export type RawStreamEvent =
  | RawContentBlockStart
  | RawContentBlockDelta
  | RawContentBlockStop
  | RawMessageStart
  | RawMessageDelta
  | RawMessageStop

// ---------------------------------------------------------------------------
// API response metadata (returned from the callModel generator)
// ---------------------------------------------------------------------------

export type ApiResponseMeta = {
  readonly stopReason: string | null
  readonly model?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

// ---------------------------------------------------------------------------
// Call model options
// ---------------------------------------------------------------------------

export type CallModelOptions = {
  readonly maxOutputTokens?: number
}

// ---------------------------------------------------------------------------
// Dependency function signatures
// ---------------------------------------------------------------------------

/**
 * Streams raw events from the model API.
 * The generator's return value carries response-level metadata.
 */
export type CallModelFn = (
  messages: unknown[], // Anthropic API message params (typed in apiAdapter)
  systemPrompt: string,
  options: CallModelOptions,
  signal: AbortSignal,
) => AsyncGenerator<RawStreamEvent, ApiResponseMeta>

/**
 * Executes a single tool call and returns the result.
 * Phase 1 provides a stub; Phase 3 plugs in the real implementation.
 */
export type RunToolFn = (
  toolUse: ToolUseBlock,
  signal: AbortSignal,
) => Promise<{ content: string; isError: boolean }>

/**
 * Compacts a message history to fit within context limits.
 * Phase 1 provides a stub; Phase 10 plugs in the real implementation.
 */
export type CompactFn = (
  messages: Message[],
) => Promise<Message[]>

/**
 * Generates attachment messages after tool execution.
 * Phase 8 provides the implementation via buildGetAttachments().
 */
export type GetAttachmentsFn = (
  executions: readonly ToolExecution[],
) => Promise<UserMessage[]>

// ---------------------------------------------------------------------------
// Aggregate dependency interface
// ---------------------------------------------------------------------------

export type QueryDeps = {
  readonly callModel: CallModelFn
  readonly runTool: RunToolFn
  readonly compact: CompactFn
  readonly uuid: () => MessageId
  readonly getAttachments?: GetAttachmentsFn
}

// ---------------------------------------------------------------------------
// Stub implementations (for Phase 1 and testing)
// ---------------------------------------------------------------------------

const stubCallModel: CallModelFn = async function* (_messages, _systemPrompt, _options, _signal) {
  return { stopReason: 'end_turn' }
}

const stubRunTool: RunToolFn = async (_toolUse, _signal) => {
  return { content: 'Tool execution not implemented', isError: true }
}

const stubCompact: CompactFn = async (_messages) => {
  throw new Error('Compaction not implemented')
}

export function stubDeps(overrides?: Partial<QueryDeps>): QueryDeps {
  return {
    callModel: stubCallModel,
    runTool: stubRunTool,
    compact: stubCompact,
    uuid: () => messageId('00000000-0000-0000-0000-000000000000'),
    ...overrides,
  }
}

export function productionDeps(overrides?: Partial<QueryDeps>): QueryDeps {
  return {
    callModel: stubCallModel, // replaced by apiAdapter.createAnthropicCallModel()
    runTool: stubRunTool,     // replaced by Phase 3
    compact: stubCompact,     // replaced by Phase 10
    uuid: () => messageId(randomUUID()),
    ...overrides,
  }
}
