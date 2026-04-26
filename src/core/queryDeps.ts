import type { Message, ToolUseBlock, ToolResultBlock, MessageId, UserMessage } from './messages.js'
import type { ToolExecution } from '../context/attachmentTypes.js'
import type { SystemPromptPart } from '../context/systemPromptParts.js'
import type { ToolResult } from './tools/types.js'
import type { ToolProgressInput } from './tools/context.js'
import type { ToolRegistry } from './tools/registry.js'
import { createToolRegistry } from './tools/registry.js'
import type { PermissionRule } from './permissions/types.js'
import type { QueryEvent } from './queryEvents.js'
import type { PreHookOutcome, PostHookOutcome } from '../hooks/types.js'
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
  readonly thinkingBudget?: number      // tokens; 0 / undefined = no thinking
  readonly interleavedThinking?: boolean
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
  systemPromptParts: readonly SystemPromptPart[],
  options: CallModelOptions,
  signal: AbortSignal,
) => AsyncGenerator<RawStreamEvent, ApiResponseMeta>

/**
 * Result of authorizing a tool call.
 *
 * The outcome distinguishes three cases so the caller can emit the right
 * audit events:
 *
 * - `authorized`: the permission engine (or a user responding to an `ask` prompt)
 *   said allow. The caller emits `permission_decision` and proceeds to execute.
 * - `denied`: the permission engine said deny, or the user said deny_once/abort
 *   in response to an `ask` prompt. The caller emits `permission_decision(deny)`
 *   and short-circuits with `syntheticResult`.
 * - `precondition_failed`: the call failed BEFORE reaching the permission engine
 *   (tool not found, validation failed, or pre-authorization abort). NOT a
 *   policy denial — the caller should NOT emit `permission_decision`, only a
 *   `tool_result` carrying the synthetic error.
 */
export type AuthorizeDecisionPayload = {
  readonly decision: 'allow' | 'deny' | 'ask'
  readonly reason: string
  readonly userResponse?: 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'
  readonly ruleCreated?: PermissionRule
}

export type AuthorizeToolOutcome =
  | { readonly outcome: 'authorized'; readonly decision: AuthorizeDecisionPayload }
  | {
      readonly outcome: 'denied'
      readonly decision: AuthorizeDecisionPayload
      readonly syntheticResult: ToolResult
    }
  | {
      readonly outcome: 'precondition_failed'
      readonly syntheticResult: ToolResult
    }

/**
 * Authorize a tool call. Runs resolve → validate → permission engine → askUser (if needed).
 * Does NOT execute the tool.
 */
export type AuthorizeToolUseFn = (
  toolUse: ToolUseBlock,
  signal: AbortSignal,
) => Promise<AuthorizeToolOutcome>

/**
 * Execute a previously-authorized tool call. Performs only tool.call() + error wrapping.
 * Does NOT re-check permissions; the caller is responsible for authorizing first.
 *
 * The optional `onProgress` callback (Phase 3d) is plumbed into the per-call
 * `ToolUseContext` so that tools (e.g., MCP) can surface intermediate progress
 * on the QueryEvent stream. It must not affect the returned `ToolResult`.
 */
export type ExecuteToolUseFn = (
  toolUse: ToolUseBlock,
  signal: AbortSignal,
  onProgress?: (progress: ToolProgressInput) => void,
) => Promise<ToolResult>

/**
 * Run PreToolUse hooks (Phase 2b). Async-generator: yields hook_started /
 * hook_finished events as subprocesses run; returns whether to block or
 * continue (with possibly-mutated input).
 */
export type RunPreToolUseHooksFn = (
  toolUse: ToolUseBlock,
  signal: AbortSignal,
) => AsyncGenerator<QueryEvent, PreHookOutcome>

/**
 * Run PostToolUse hooks (Phase 2b). Async-generator: yields hook_started /
 * hook_finished events; returns a (possibly content-augmented) ToolResult.
 */
export type RunPostToolUseHooksFn = (
  toolUse: ToolUseBlock,
  result: ToolResult,
  signal: AbortSignal,
) => AsyncGenerator<QueryEvent, PostHookOutcome>

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
  readonly authorizeToolUse: AuthorizeToolUseFn
  readonly executeToolUse: ExecuteToolUseFn
  readonly runPreToolUseHooks: RunPreToolUseHooksFn
  readonly runPostToolUseHooks: RunPostToolUseHooksFn
  readonly compact: CompactFn
  readonly uuid: () => MessageId
  readonly getAttachments?: GetAttachmentsFn
  /**
   * The tool registry the loop uses for batch partitioning (Phase 7b).
   * `partitionIntoBatches` looks up `isConcurrencySafe` per tool to decide
   * which tool_uses can fan out concurrently. Defaults to an empty registry
   * in the stubs; production wiring threads in the engine's real registry.
   */
  readonly toolRegistry: ToolRegistry
}

// ---------------------------------------------------------------------------
// Stub implementations (for Phase 1 and testing)
// ---------------------------------------------------------------------------

const stubCallModel: CallModelFn = async function* (_messages, _systemPromptParts, _options, _signal) {
  return { stopReason: 'end_turn' }
}

const stubAuthorize: AuthorizeToolUseFn = async (_toolUse, _signal) => ({
  outcome: 'authorized',
  decision: { decision: 'allow', reason: 'stub' },
})

const stubExecute: ExecuteToolUseFn = async (_toolUse, _signal) => ({
  content: 'Tool execution not implemented',
  isError: true,
  errorKind: 'execution_error',
})

const stubCompact: CompactFn = async (_messages) => {
  throw new Error('Compaction not implemented')
}

// No-op hook runners. The async-generator yields nothing and returns a
// continue/pass-through outcome. Used when hookConfig has no matching hooks,
// which is the common case.
const noopPreHooks: RunPreToolUseHooksFn = async function* (_toolUse, _signal) {
  return { kind: 'continue' }
}

const noopPostHooks: RunPostToolUseHooksFn = async function* (_toolUse, result, _signal) {
  return { result }
}

export function stubDeps(overrides?: Partial<QueryDeps>): QueryDeps {
  return {
    callModel: stubCallModel,
    authorizeToolUse: stubAuthorize,
    executeToolUse: stubExecute,
    runPreToolUseHooks: noopPreHooks,
    runPostToolUseHooks: noopPostHooks,
    compact: stubCompact,
    uuid: () => messageId('00000000-0000-0000-0000-000000000000'),
    toolRegistry: createToolRegistry(),
    ...overrides,
  }
}

export function productionDeps(overrides?: Partial<QueryDeps>): QueryDeps {
  return {
    callModel: stubCallModel, // replaced by apiAdapter.createAnthropicCallModel()
    authorizeToolUse: stubAuthorize, // replaced by Phase 3
    executeToolUse: stubExecute,     // replaced by Phase 3
    runPreToolUseHooks: noopPreHooks,   // replaced by QueryEngine when hooks.json present
    runPostToolUseHooks: noopPostHooks,
    compact: stubCompact,     // replaced by Phase 10
    uuid: () => messageId(randomUUID()),
    toolRegistry: createToolRegistry(), // replaced by QueryEngine / runAgent with the real registry
    ...overrides,
  }
}

/**
 * Test helper: build matching authorize/execute pair that always returns a static result.
 * Tests that don't care about authorization can pass a ToolResult and get both halves wired.
 */
export function makeStaticToolDeps(result: ToolResult): Pick<QueryDeps, 'authorizeToolUse' | 'executeToolUse'> {
  return {
    authorizeToolUse: async () => ({
      outcome: 'authorized',
      decision: { decision: 'allow', reason: 'static' },
    }),
    executeToolUse: async () => result,
  }
}

/**
 * Legacy shape (pre-2a). Kept purely as a test convenience: existing integration
 * tests written against the single `runTool` fn can adapt their stub via
 * `adaptRunTool` below without rewriting every case.
 */
export type RunToolFn = (
  toolUse: ToolUseBlock,
  signal: AbortSignal,
) => Promise<ToolResult>

/**
 * Test helper: wrap a legacy `RunToolFn` into the new authorize/execute pair.
 * Authorizes everything and routes execution through the provided fn.
 */
export function adaptRunTool(
  runTool: RunToolFn,
): Pick<QueryDeps, 'authorizeToolUse' | 'executeToolUse'> {
  return {
    authorizeToolUse: async () => ({
      outcome: 'authorized',
      decision: { decision: 'allow', reason: 'test-adapter' },
    }),
    executeToolUse: runTool,
  }
}
