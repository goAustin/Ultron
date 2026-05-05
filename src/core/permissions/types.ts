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

/**
 * v3 Phase 4·1 — structured payload riding alongside a `safetyCheck` reason.
 * Lets the cascade thread risk-classifier evidence end-to-end (audit log
 * `safetyMetadata` + `formatApprovalPrompt` rich rendering) without parsing
 * the human-facing `message` string.
 *
 * `checkName` is open-ended now because Computer-Use is the only safety check
 * that emits structured metadata today. Future safety checks can add their
 * own discriminator value without breaking existing readers.
 */
export type SafetyMetadata = {
  readonly checkName: string
  readonly riskLevel: 0 | 1 | 2 | 3 | 4
  readonly riskCategory: string
  readonly evidence?: {
    readonly nearbyText?: string
    readonly fieldType?: string
  }
}

export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'safetyCheck'; message: string; metadata?: SafetyMetadata }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'toolCheck'; message: string }
  | { type: 'toolCheck' }
  | { type: 'headlessEscalation'; original: PermissionDecisionReason }
  | { type: 'skillScope'; toolName: string; allowed: readonly string[] }
  | { type: 'agentScope'; toolName: string; allowed: readonly string[] }
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

/**
 * Callback to prompt the user for a permission decision.
 *
 * Phase 4·1 widened the signature with an optional fifth `opts` arg that
 * carries `safetyMetadata` for Computer-Use risk decisions (so the prompt
 * UI can render risk level, nearby text, etc.). All existing callers can
 * ignore `opts`; new callers populate it from `decision.reason.metadata`
 * when the reason is a `safetyCheck`.
 */
export type AskUserFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
  opts?: {
    readonly metadata?: SafetyMetadata
  },
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
   * Phase 5b / 7a: when present, the cascade denies any tool not in the list.
   * Runs AFTER explicit deny rules (user explicit deny still wins) and
   * BEFORE explicit ask / mode resolution (scope wins over
   * `bypassPermissions`). Skill activation and subagent forks both populate
   * this — `scopeSource` discriminates the deny reason variant.
   */
  scopedToolAllowlist?: readonly string[]
  /**
   * Phase 7a: discriminator for the deny reason emitted when a tool is
   * outside `scopedToolAllowlist`. Defaults to `'skill'` for back-compat
   * with Phase 5b call sites that set the allowlist without specifying a
   * source. Subagents pass `'agent'` so the cascade emits `agentScope`
   * instead of `skillScope`.
   */
  scopeSource?: 'skill' | 'agent'
  /**
   * Domain-prompt UX — invoked after `askUser` resolves to `allow_once` or
   * `allow_by_rule` for a tool whose `getDomain` returns a usable host. Lets
   * the QueryEngine wire Computer-Use approvals to the SessionManager
   * (overlay + persistence) without dragging the manager type into the
   * cascade. The callback inspects `toolName` to decide what to do (e.g.
   * no-op for non-Computer tools).
   *
   * Errors are swallowed in `authorizeToolUse` (warned to stderr) — a
   * failed persist must not block the tool call the user just authorized.
   */
  approvedDomainHook?: (params: {
    readonly toolName: string
    readonly input: Record<string, unknown>
    readonly host: string
    readonly response: 'allow_once' | 'allow_by_rule'
  }) => Promise<void> | void
}

export const DEFAULT_PERMISSION_OPTIONS: PermissionOptions = {
  headless: false,
  safetyChecks: [],
}
