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
import type { QueryDeps, CallModelFn } from '../core/queryDeps.js'
import type { Message, MessageId } from '../core/messages.js'
import { createUserMessage, messageId } from '../core/messages.js'
import type { Store, AppState } from '../core/state.js'
import { createStore } from '../core/state.js'
import type { ToolRegistry } from '../core/tools/registry.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { createToolUseContext } from '../core/tools/context.js'
import type { ReadFileState } from '../core/tools/context.js'
import { createRunToolFn } from '../core/tools/toolExecution.js'
import type { PermissionOptions } from '../core/permissions/types.js'
import { createCompactFn } from '../context/compact.js'
import { getInitialAttachments } from '../context/attachments.js'
import { appendMessage, getEventMessage } from '../session/transcript.js'
import { buildSubagentSystemPrompt } from './agentPrompt.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function to fork a subagent. Prompt is purely the task description. */
export type ForkSubagentFn = (prompt: string) => Promise<SubagentResult>

export type SubagentOptions = {
  readonly callModel: CallModelFn
  readonly compactCallModel: CallModelFn
  readonly parentToolRegistry: ToolRegistry
  readonly parentAppState: Store<AppState>
  readonly parentSystemPrompt: string
  readonly parentSignal: AbortSignal
  readonly cwd: string
  readonly sessionDir: string
  readonly permissionOpts: PermissionOptions
  readonly allowedTools?: readonly string[]
  readonly maxTurns?: number
}

export type SubagentResult = {
  readonly text: string
  readonly terminal: Terminal
  readonly subagentId: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_TOOLS = ['FileRead', 'Glob', 'Grep'] as const
const DEFAULT_MAX_TURNS = 30
const AGENT_TOOL_NAME = 'Agent'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a ForkSubagentFn bound to the given parent context.
 * Each invocation forks an isolated query() call.
 */
export function createForkSubagent(opts: SubagentOptions): ForkSubagentFn {
  return async (prompt: string): Promise<SubagentResult> => {
    const subagentId = randomUUID()
    const transcriptDir = join(opts.sessionDir, 'agents', subagentId)
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
    const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS

    // Linked abort — parent abort cascades to child
    const abortController = new AbortController()
    if (opts.parentSignal.aborted) {
      abortController.abort()
    }
    const onParentAbort = () => abortController.abort()
    opts.parentSignal.addEventListener('abort', onParentAbort, { once: true })

    try {
      // Clone AppState for isolation
      const parentState = opts.parentAppState.getState()
      const childAppState = createStore<AppState>({ ...parentState })

      // Fresh read file state
      const readFileState: ReadFileState = new Map()

      // Filtered tool registry — only allowed tools, never Agent
      const childRegistry = buildFilteredRegistry(
        opts.parentToolRegistry,
        allowedTools,
      )

      // Build tool context (no forkSubagent — prevents recursion)
      const toolUseContext = createToolUseContext({
        appState: childAppState,
        abortController,
        messages: [],
        readFileState,
        toolRegistry: childRegistry,
      })

      const runTool = createRunToolFn(toolUseContext, opts.permissionOpts)
      const uuid = (): MessageId => messageId(randomUUID())

      // System prompt with subagent preamble
      const systemPrompt = buildSubagentSystemPrompt(opts.parentSystemPrompt)

      // Initial attachments — same workspace context as parent
      const initialAttachments = await getInitialAttachments(opts.cwd)

      // User message from prompt
      const userMsg = createUserMessage(prompt, { id: uuid() })

      // Build messages array
      const messages: Message[] = [...initialAttachments, userMsg]

      // Assemble deps
      const deps: Partial<QueryDeps> = {
        callModel: opts.callModel,
        runTool,
        compact: createCompactFn(opts.compactCallModel, uuid),
        uuid,
        // No getAttachments — read-only subagents don't trigger per-turn refreshes
      }

      // Run the subagent query loop
      const gen = query({
        messages,
        systemPrompt,
        deps,
        signal: abortController.signal,
        maxTurns,
      })

      // Collect events, persist transcript, extract final text
      let lastAssistantText = ''
      let result = await gen.next()

      while (!result.done) {
        const event = result.value

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
      opts.parentSignal.removeEventListener('abort', onParentAbort)
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a filtered tool registry containing only the named tools.
 * Always excludes 'Agent' to prevent recursive subagents.
 */
function buildFilteredRegistry(
  parentRegistry: ToolRegistry,
  allowedTools: readonly string[],
): ToolRegistry {
  const filtered = createToolRegistry()

  for (const name of allowedTools) {
    if (name === AGENT_TOOL_NAME) continue // never allow recursion
    const tool = parentRegistry.get(name)
    if (tool) {
      filtered.register(tool)
    }
  }

  return filtered
}
