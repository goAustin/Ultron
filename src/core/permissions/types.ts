/**
 * Permission engine types.
 *
 * Rule, decision, safety check, and options types used by the
 * permission cascade in permissions.ts.
 */

import type { PermissionMode } from '../state.js'
import type { Tool } from '../tools/types.js'
import type { ToolUseContext } from '../tools/context.js'

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

export type PermissionRuleBehavior = 'allow' | 'deny' | 'ask'

export type PermissionRuleSource = 'userSettings' | 'projectSettings' | 'session' | 'cliArg'

export type PermissionRule = {
  toolName: string
  behavior: PermissionRuleBehavior
  path?: string                   // exact match, not a glob
  source: PermissionRuleSource
}

// ---------------------------------------------------------------------------
// Decision reasons
// ---------------------------------------------------------------------------

export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'safetyCheck'; message: string }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'toolCheck'; message: string }
  | { type: 'toolCheck' }
  | { type: 'headlessEscalation'; original: PermissionDecisionReason }
  | { type: 'fallback' }

export type PermissionDecision = {
  behavior: PermissionRuleBehavior
  reason: PermissionDecisionReason
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

/**
 * A safety check returns a PermissionDecision if it has an opinion,
 * or null if it doesn't apply to this tool/input.
 */
export type SafetyCheck = (
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
) => PermissionDecision | null

// ---------------------------------------------------------------------------
// Approval & logging callbacks
// ---------------------------------------------------------------------------

/** Callback to prompt the user for a permission decision. */
export type AskUserFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
) => Promise<'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'>

/** Callback to log a permission decision for audit. */
export type LogPermissionDecisionFn = (
  entry: import('./logging.js').PermissionLogEntry,
) => Promise<void>

// ---------------------------------------------------------------------------
// Permission options — runtime execution flags, not stored in AppState
// ---------------------------------------------------------------------------

export type PermissionOptions = {
  headless: boolean
  safetyChecks: SafetyCheck[]
  askUser?: AskUserFn
  logDecision?: LogPermissionDecisionFn
}

export const DEFAULT_PERMISSION_OPTIONS: PermissionOptions = {
  headless: false,
  safetyChecks: [],
}
