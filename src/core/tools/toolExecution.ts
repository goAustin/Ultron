/**
 * Shared types and helpers for the tool execution boundary.
 * Both runToolUse.ts and toolOrchestration.ts import from here.
 */

import type { ToolUseBlock, ToolUseId } from '../messages.js'
import type { ToolResult, ToolErrorKind } from './types.js'
import type { ToolUseContext } from './context.js'
import type {
  AuthorizeToolUseFn,
  ExecuteToolUseFn,
} from '../queryDeps.js'
import type { PermissionOptions } from '../permissions/types.js'
import {
  authorizeToolUse,
  executeToolUse,
} from './runToolUse.js'

// Re-export for call sites that previously imported ToolErrorKind from here.
export type { ToolErrorKind }

// ---------------------------------------------------------------------------
// Error & abort helpers
// ---------------------------------------------------------------------------

export function makeErrorResult(kind: ToolErrorKind, message: string): ToolResult {
  return { content: `[${kind}] ${message}`, isError: true, errorKind: kind }
}

export function makeAbortResult(): ToolResult {
  return { content: '[aborted] Interrupted by user', isError: true, errorKind: 'aborted' }
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
// Deps adapters — bind the pipeline halves against a ToolUseContext + permission opts
// ---------------------------------------------------------------------------

export function createAuthorizeToolUseFn(
  context: ToolUseContext,
  permissionOpts?: PermissionOptions,
): AuthorizeToolUseFn {
  return async (toolUse: ToolUseBlock, signal: AbortSignal) =>
    authorizeToolUse(toolUse, context, signal, permissionOpts)
}

export function createExecuteToolUseFn(context: ToolUseContext): ExecuteToolUseFn {
  return async (toolUse: ToolUseBlock, signal: AbortSignal) =>
    executeToolUse(toolUse, context, signal)
}
