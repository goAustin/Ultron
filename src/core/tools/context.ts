/**
 * ToolUseContext — the bag of capabilities passed to every tool call.
 * Add fields when required, not speculatively.
 */

import type { Message } from '../messages.js'
import type { Store, AppState } from '../state.js'
import type { ToolRegistry } from './registry.js'
import type { ForkSubagentFn } from '../../agents/runAgent.js'

// ---------------------------------------------------------------------------
// Read file state — cache of recently read files for stale-edit detection
// ---------------------------------------------------------------------------

export type ReadFileState = Map<string, { content: string; mtime: number }>

// ---------------------------------------------------------------------------
// ToolUseContext
// ---------------------------------------------------------------------------

export type ToolUseContext = {
  /** Mutable application state store */
  appState: Store<AppState>

  /** Abort controller for the current query */
  abortController: AbortController

  /** Current conversation messages (read-only snapshot) */
  messages: readonly Message[]

  /** Cache of recently read files (for stale-edit detection) */
  readFileState: ReadFileState

  /** Access to the tool registry (for tools that need to discover other tools) */
  toolRegistry: ToolRegistry

  /** Fork a subagent query — only available when AgentTool is wired */
  forkSubagent?: ForkSubagentFn
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createToolUseContext(opts: {
  appState: Store<AppState>
  abortController: AbortController
  messages: readonly Message[]
  readFileState?: ReadFileState
  toolRegistry: ToolRegistry
  forkSubagent?: ForkSubagentFn
}): ToolUseContext {
  return {
    appState: opts.appState,
    abortController: opts.abortController,
    messages: opts.messages,
    readFileState: opts.readFileState ?? new Map(),
    toolRegistry: opts.toolRegistry,
    ...(opts.forkSubagent && { forkSubagent: opts.forkSubagent }),
  }
}
