/**
 * ToolUseContext — the bag of capabilities passed to every tool call.
 * Add fields when required, not speculatively.
 */

import type { Message } from '../messages.js'
import type { Store, AppState } from '../state.js'
import type { ToolRegistry } from './registry.js'
import type {
  ForkSubagentFn,
  EngineForkSubagentFn,
} from '../../agents/runAgent.js'

// ---------------------------------------------------------------------------
// Read file state — cache of recently read files for stale-edit detection
// ---------------------------------------------------------------------------

export type ReadFileState = Map<string, { content: string; mtime: number }>

// ---------------------------------------------------------------------------
// Progress callback (Phase 3d) — producer-facing payload
// ---------------------------------------------------------------------------

/**
 * What a tool implementation passes to `ctx.onProgress(...)`. The bridge in
 * `streamToolUse` fills in `toolUseId` and `timestamp` and emits the typed
 * `ToolProgressEvent` on the QueryEvent stream — never on the message array.
 */
export type ToolProgressInput = {
  readonly progress: number
  readonly total?: number
  readonly message?: string
}

// ---------------------------------------------------------------------------
// Notify channel (Phase 6b) — for cross-cutting one-shot tool events
// ---------------------------------------------------------------------------

/**
 * Tool-emitted events that don't fit progress (which is per-tool-call) or
 * tool_result (which is per-tool-call). Currently used by WebSearch to
 * announce backend resolution once per session. The CLI subscriber dedups
 * by event type; tools may emit naively.
 */
export type NotifyEvent = {
  readonly type: 'web_backend_resolved'
  readonly backend: 'duckduckgo' | 'brave' | 'tavily'
  readonly source: 'env' | 'settings' | 'default'
}

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

  /**
   * Engine-level fork fn — set once by the QueryEngine, takes the parent
   * `ToolUseBlock.id` as a second arg for audit correlation (Phase 7c).
   * Tools never read this directly. `executeToolUse` rebinds it per-call
   * into the unary `forkSubagent` below, capturing the current
   * `toolUse.id` in a closure so AgentTool's `call()` body stays unaware
   * of the correlation plumbing.
   */
  engineForkSubagent?: EngineForkSubagentFn

  /**
   * Per-call unary view of `engineForkSubagent`, populated by
   * `executeToolUse` for each `tool.call`. AgentTool reads this; the
   * closure has already captured the parent `toolUse.id`. Undefined on
   * the static context — only set on the per-call `callContext`.
   */
  forkSubagent?: ForkSubagentFn

  /**
   * Optional side-channel progress sink (Phase 3d). Tools that perform
   * long-running work may invoke this to surface intermediate progress.
   * When undefined, tools should skip emitting progress entirely.
   */
  onProgress?: (progress: ToolProgressInput) => void

  /**
   * Optional cross-cutting notification sink (Phase 6b). Tools may emit
   * a typed NotifyEvent; the runtime decides how to render and audit it.
   * Dedup is the runtime's responsibility — tools may emit on every call.
   */
  notify?: (event: NotifyEvent) => void
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
  engineForkSubagent?: EngineForkSubagentFn
  onProgress?: (progress: ToolProgressInput) => void
  notify?: (event: NotifyEvent) => void
}): ToolUseContext {
  return {
    appState: opts.appState,
    abortController: opts.abortController,
    messages: opts.messages,
    readFileState: opts.readFileState ?? new Map(),
    toolRegistry: opts.toolRegistry,
    ...(opts.engineForkSubagent && { engineForkSubagent: opts.engineForkSubagent }),
    ...(opts.onProgress && { onProgress: opts.onProgress }),
    ...(opts.notify && { notify: opts.notify }),
  }
}
