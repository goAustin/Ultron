/**
 * Audit spine types.
 *
 * The AuditWriter is a fire-and-forget sink for QueryEvents: the SDK tees every
 * event it yields through the writer, which serializes to ~/.ultron/audit.jsonl
 * with redaction + rotation.
 */

import type { QueryEvent } from '../core/queryEvents.js'
import type { ToolUseId } from '../core/messages.js'
import type { PermissionRule } from '../core/permissions/types.js'

export type AuditWriter = {
  readonly write: (event: QueryEvent) => void
  readonly close: () => Promise<void>
  /**
   * Returns a handle that shares this writer's underlying chain + byte accounting
   * but stamps every envelope on disk with the given `origin` tag and (optionally)
   * a `parentToolUseId` linking events to the parent-side `tool_call_started` that
   * spawned the writer's owner. Used to mark subagent provenance when multiple
   * query loops share one audit file (Phase 7a) and to correlate parent → child
   * subagent events even under parallel fan-out (Phase 7c).
   *
   * The returned handle is NOT chainable (no nested origins).
   */
  readonly withOrigin: (
    origin: string,
    opts?: { readonly parentToolUseId: ToolUseId },
  ) => AuditWriter
}

export type AuditWriterOptions = {
  readonly dir?: string
  readonly maxBytes?: number
  readonly keep?: number
}

/**
 * Retained for back-compat — some legacy tests and external callers imported
 * this type from src/core/permissions/logging.ts, which Phase 2a removes.
 * The audit log itself does NOT write entries in this shape; structured
 * permission events flow through PermissionDecisionEvent instead.
 */
export type PermissionLogEntry = {
  readonly timestamp: number
  readonly toolName: string
  readonly inputSummary: string
  readonly decision: 'allow' | 'deny' | 'ask'
  readonly reason: string
  readonly userResponse?: 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'
  readonly ruleCreated?: PermissionRule
}
