/**
 * Shared types and helpers for the tool execution boundary.
 * Both runToolUse.ts and toolOrchestration.ts import from here.
 */

import type { ToolUseBlock, ToolUseId } from '../messages.js'
import type { ToolResult } from './types.js'
import type { ToolUseContext } from './context.js'
import type { RunToolFn } from '../queryDeps.js'
import type { PermissionOptions } from '../permissions/types.js'
import { runToolUse } from './runToolUse.js'

// ---------------------------------------------------------------------------
// Error kinds
// ---------------------------------------------------------------------------

export type ToolErrorKind =
  | 'tool_not_found'
  | 'validation_failed'
  | 'permission_denied'
  | 'permission_ask'
  | 'execution_error'
  | 'aborted'

// ---------------------------------------------------------------------------
// Error & abort helpers
// ---------------------------------------------------------------------------

export function makeErrorResult(kind: ToolErrorKind, message: string): ToolResult {
  return { content: `[${kind}] ${message}`, isError: true }
}

export function makeAbortResult(): ToolResult {
  return { content: '[aborted] Interrupted by user', isError: true }
}

/**
 * Check signal and return abort result if aborted, otherwise undefined.
 */
export function checkAbort(signal: AbortSignal): ToolResult | undefined {
  if (signal.aborted) return makeAbortResult()
  return undefined
}

// ---------------------------------------------------------------------------
// Result pair — associates a tool_use id with its result
// ---------------------------------------------------------------------------

export type ToolResultPair = {
  toolUseId: ToolUseId
  result: ToolResult
}

// ---------------------------------------------------------------------------
// RunToolFn adapter — drop-in replacement for the Phase 1 stub
// ---------------------------------------------------------------------------

export function createRunToolFn(context: ToolUseContext, permissionOpts?: PermissionOptions): RunToolFn {
  return async (toolUse: ToolUseBlock, signal: AbortSignal) => {
    return runToolUse(toolUse, context, signal, permissionOpts)
  }
}
