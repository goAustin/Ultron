/**
 * Subagent execution — fork a query() call with isolated state.
 *
 * createForkSubagent() returns a ForkSubagentFn bound to the parent context.
 * The returned function runs a forked query loop with:
 * - Cloned AppState (mutations don't affect parent)
 * - Fresh ReadFileState
 * - Filtered tool registry (read-only tools only, no Agent)
 * - Linked abort (parent abort cascades to child)
 * - Separate transcript subdirectory
 * - Initial attachments for workspace context
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { query } from '../core/query.js'
import type { Terminal } from '../core/queryTypes.js'
import type {
  QueryDeps,
  CallModelFn,
  RunPreToolUseHooksFn,
  RunPostToolUseHooksFn,
} from '../core/queryDeps.js'
import type { SystemPromptPart } from '../context/systemPromptParts.js'
import type { Message, MessageId, ToolUseId } from '../core/messages.js'
import { createUserMessage, messageId } from '../core/messages.js'
import type { Store, AppState } from '../core/state.js'
import type { ToolRegistry } from '../core/tools/registry.js'
import { createToolUseContext } from '../core/tools/context.js'
import {
  createAuthorizeToolUseFn,
  createExecuteToolUseFn,
} from '../core/tools/toolExecution.js'
import type { PermissionOptions } from '../core/permissions/types.js'
import type { AuditWriter } from '../audit/types.js'
import { createCompactFn } from '../context/compact.js'
import { getInitialAttachments } from '../context/attachments.js'
import { appendMessage, getEventMessage } from '../session/transcript.js'
import { buildSubagentSystemPrompt } from './agentPrompt.js'
import { createSandboxContext, buildFilteredRegistry } from './sandboxContext.js'

// Re-export so existing imports of `buildFilteredRegistry` from `runAgent`
// keep working without churning unrelated tests.
export { buildFilteredRegistry }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Tool-facing fork fn — unary; populated per-call by `executeToolUse`,
 * which binds the parent `ToolUseBlock.id` into the closure so AgentTool
 * can stay unaware of the correlation plumbing.
 */
export type ForkSubagentFn = (prompt: string) => Promise<SubagentResult>

/**
 * Engine-level fork fn (Phase 7c) — widened with `parentToolUseId` so
 * subagent audit envelopes can be correlated back to the parent's
 * `tool_call_started` for the spawning `Agent` block. Stored on the
 * static `ToolUseContext.engineForkSubagent`; never read by tools
 * directly — `executeToolUse` rebinds it into the per-call unary
 * `forkSubagent` view.
 */
export type EngineForkSubagentFn = (
  prompt: string,
  parentToolUseId: ToolUseId,
) => Promise<SubagentResult>

export type SubagentOptions = {
  readonly callModel: CallModelFn
  readonly compactCallModel: CallModelFn
  readonly parentToolRegistry: ToolRegistry
  readonly parentAppState: Store<AppState>
  readonly parentSystemPromptParts: readonly SystemPromptPart[]
  readonly parentSignal: AbortSignal
  readonly cwd: string
  readonly sessionDir: string
  readonly permissionOpts: PermissionOptions
  /** Audit writer shared with the parent — every subagent event lands on the parent's audit log. */
  readonly auditWriter: AuditWriter
  /** PreToolUse hook runner — inherited from the parent QueryEngine (2b). */
  readonly runPreToolUseHooks: RunPreToolUseHooksFn
  /** PostToolUse hook runner — inherited from the parent QueryEngine (2b). */
  readonly runPostToolUseHooks: RunPostToolUseHooksFn
  readonly allowedTools?: readonly string[]
  readonly maxTurns?: number
  readonly parentThinkingBudget?: number
  readonly parentInterleavedThinking?: boolean
}

export type SubagentResult = {
  readonly text: string
  readonly terminal: Terminal
  readonly subagentId: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOWED_TOOLS = ['FileRead', 'Glob', 'Grep'] as const
const DEFAULT_MAX_TURNS = 30

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an EngineForkSubagentFn bound to the given parent context.
 * Each invocation forks an isolated query() call.
 *
 * `parentToolUseId` is the `ToolUseBlock.id` of the parent's `Agent`
 * tool_use that's spawning this subagent. The sandbox stamps it onto
 * every audit envelope the subagent emits via `withOrigin(subagentId,
 * { parentToolUseId })`, so a downstream consumer can correlate
 * subagent events back to the parent-side `tool_call_started`.
 */
export function createForkSubagent(opts: SubagentOptions): EngineForkSubagentFn {
  return async (prompt: string, parentToolUseId: ToolUseId): Promise<SubagentResult> => {
    const subagentId = randomUUID()
    const transcriptDir = join(opts.sessionDir, 'agents', subagentId)
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
    const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS

    // Phase 7a — extract the isolated execution surface (cloned AppState,
    // fresh ReadFileState, filtered registry, linked abort, scoped
    // permission opts, origin-tagged audit writer) into one place.
    // Phase 7c — also threads parentToolUseId so the subagent's audit
    // envelopes carry parent → child correlation.
    const sandbox = createSandboxContext({
      parentAppState: opts.parentAppState,
      parentToolRegistry: opts.parentToolRegistry,
      parentSignal: opts.parentSignal,
      parentPermissionOpts: opts.permissionOpts,
      parentAuditWriter: opts.auditWriter,
      allowedTools,
      subagentId,
      parentToolUseId,
    })

    try {
      // Build tool context (no forkSubagent — prevents recursion)
      const toolUseContext = createToolUseContext({
        appState: sandbox.appState,
        abortController: sandbox.abortController,
        messages: [],
        readFileState: sandbox.readFileState,
        toolRegistry: sandbox.toolRegistry,
      })

      // Use the sandbox's permissionOpts so the cascade and the
      // pre-resolution gate in authorizeToolUse both deny out-of-scope
      // calls with `agentScope` reason.
      const authorizeToolUse = createAuthorizeToolUseFn(toolUseContext, sandbox.permissionOpts)
      const executeToolUse = createExecuteToolUseFn(toolUseContext)
      const uuid = (): MessageId => messageId(randomUUID())

      // System prompt with subagent preamble
      const systemPromptParts = buildSubagentSystemPrompt(opts.parentSystemPromptParts)

      // Initial attachments — same workspace context as parent
      const initialAttachments = await getInitialAttachments(opts.cwd)

      // User message from prompt
      const userMsg = createUserMessage(prompt, { id: uuid() })

      // Build messages array
      const messages: Message[] = [...initialAttachments, userMsg]

      // Assemble deps
      const deps: Partial<QueryDeps> = {
        callModel: opts.callModel,
        authorizeToolUse,
        executeToolUse,
        runPreToolUseHooks: opts.runPreToolUseHooks,
        runPostToolUseHooks: opts.runPostToolUseHooks,
        compact: createCompactFn(opts.compactCallModel, uuid),
        uuid,
        toolRegistry: sandbox.toolRegistry,
        // No getAttachments — read-only subagents don't trigger per-turn refreshes
      }

      // Run the subagent query loop
      const gen = query({
        messages,
        systemPromptParts,
        deps,
        signal: sandbox.abortController.signal,
        maxTurns,
        thinkingBudget: opts.parentThinkingBudget,
        interleavedThinking: opts.parentInterleavedThinking,
      })

      // Collect events, persist transcript, extract final text
      let lastAssistantText = ''
      let result = await gen.next()

      while (!result.done) {
        const event = result.value

        // Tee every event into the parent's shared audit log (with origin stamp).
        sandbox.auditWriter.write(event)

        // Persist persistable messages to subagent transcript
        const msg = getEventMessage(event)
        if (msg) {
          await appendMessage(transcriptDir, msg)
        }

        // Collect last assistant text from turn events
        if (event.type === 'turn') {
          const textBlocks = event.message.content.filter(
            (b): b is { type: 'text'; text: string } => b.type === 'text',
          )
          if (textBlocks.length > 0) {
            lastAssistantText = textBlocks.map((b) => b.text).join('\n')
          }
        }

        result = await gen.next()
      }

      const terminal: Terminal = result.value

      return {
        text: lastAssistantText || '(subagent produced no text output)',
        terminal,
        subagentId,
      }
    } finally {
      sandbox.cleanup()
    }
  }
}
