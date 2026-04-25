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
  domain?: string                 // exact host or `*.suffix` (Phase 6a)
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
  | { type: 'skillScope'; toolName: string; allowed: readonly string[] }
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
// Approval callbacks
// ---------------------------------------------------------------------------

/** Callback to prompt the user for a permission decision. */
export type AskUserFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
) => Promise<'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'>

// ---------------------------------------------------------------------------
// Permission options — runtime execution flags, not stored in AppState
//
// Note: the Phase 1 `logDecision` callback has been retired. Every permission
// decision now surfaces as a `permission_decision` QueryEvent through the Phase 2a
// audit spine; structured persistence happens in `~/.ultron/audit.jsonl`.
// ---------------------------------------------------------------------------

export type PermissionOptions = {
  headless: boolean
  safetyChecks: SafetyCheck[]
  askUser?: AskUserFn
  /**
   * Phase 5b: when present, the cascade denies any tool not in the list.
   * Runs AFTER explicit deny rules (user explicit deny still wins) and
   * BEFORE explicit ask / mode resolution (skill scope wins over
   * `bypassPermissions`). Skill activation populates this for the duration
   * of the activation window.
   */
  scopedToolAllowlist?: readonly string[]
}

export const DEFAULT_PERMISSION_OPTIONS: PermissionOptions = {
  headless: false,
  safetyChecks: [],
}
