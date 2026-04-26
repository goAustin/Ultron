/**
 * Audit tree reconstruction (Phase 7c).
 *
 * Pure utility for rebuilding the parent → child subagent call tree from a
 * single-session slice of audit envelopes. Used by tests and (in the
 * future) any production caller that wants to render or analyze a
 * subagent fan-out — most concretely a `/audit tree` slash command.
 *
 * Scope contract: callers MUST pass a slice from one session. The audit
 * envelope carries no session id today; mixing envelopes from multiple
 * sessions can mislink children to stale parents because `ToolUseBlock.id`
 * is unique per request, not per machine-lifetime.
 */

import type { ToolUseId } from '../core/messages.js'
import type { QueryEvent } from '../core/queryEvents.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of a parsed audit envelope (one JSONL line). Lines off disk are
 * `JSON.parse()`'d into this shape; live captures (test fixtures) build it
 * directly.
 */
export type AuditEnvelope = {
  readonly schemaVersion: number
  readonly tsIso: string
  readonly origin?: string
  readonly parentToolUseId?: ToolUseId
  readonly type: QueryEvent['type']
} & Record<string, unknown>

export type AuditTreeNode = {
  /** Subagent id for non-root subtrees; `null` for the synthetic root. */
  readonly origin: string | null
  /**
   * Parent's `Agent` `ToolUseBlock.id` for non-root subtrees; `null` for
   * the synthetic root.
   */
  readonly parentToolUseId: ToolUseId | null
  readonly events: readonly AuditEnvelope[]
  readonly children: readonly AuditTreeNode[]
}

// ---------------------------------------------------------------------------
// buildAuditTree
// ---------------------------------------------------------------------------

const ROOT_KEY = '_|_'

/**
 * Build a tree from a single-session slice of audit envelopes.
 *
 * Grouping is by the pair `(origin, parentToolUseId)`, NOT by `origin`
 * alone — under a correct producer the two are equivalent (every origin
 * maps to exactly one parentToolUseId), but grouping by both surfaces a
 * buggy producer that reused an origin under two different parents as
 * separate subtrees rather than collapsing them into one mislinked
 * subtree. Pure — no I/O.
 *
 * - Empty input returns an empty root subtree.
 * - Envelopes with no `origin` form a single synthetic root subtree.
 * - Each `(origin, parentToolUseId)` pair becomes one child subtree of
 *   whichever ancestor subtree contains a `tool_call_started.toolUseId`
 *   matching that `parentToolUseId`.
 * - Throws if a subtree's `parentToolUseId` has no matching
 *   `tool_call_started` in any ancestor (orphan), if `origin` and
 *   `parentToolUseId` are not both present or both absent on an envelope
 *   (malformed), or if origin'd envelopes exist with no root subtree
 *   (caller violated the single-session slice contract).
 */
export function buildAuditTree(envelopes: readonly AuditEnvelope[]): AuditTreeNode {
  if (envelopes.length === 0) {
    return { origin: null, parentToolUseId: null, events: [], children: [] }
  }

  // 1. Group envelopes by (origin, parentToolUseId) pair.
  const groups = new Map<string, AuditEnvelope[]>()
  for (const env of envelopes) {
    const hasOrigin = env.origin !== undefined
    const hasParent = env.parentToolUseId !== undefined
    if (hasOrigin !== hasParent) {
      throw new Error(
        `buildAuditTree: malformed envelope — origin and parentToolUseId must both be present or both absent (origin=${String(env.origin)}, parentToolUseId=${String(env.parentToolUseId)})`,
      )
    }
    const key = hasOrigin
      ? `${env.origin}|${env.parentToolUseId}`
      : ROOT_KEY
    let arr = groups.get(key)
    if (arr === undefined) {
      arr = []
      groups.set(key, arr)
    }
    arr.push(env)
  }

  // 2. Index `tool_call_started.toolUseId` → group key, so each non-root
  //    group can find its parent in O(1).
  const toolUseIdToGroup = new Map<ToolUseId, string>()
  for (const [key, envs] of groups) {
    for (const env of envs) {
      if (env.type !== 'tool_call_started') continue
      const toolUseId = env.toolUseId
      if (typeof toolUseId === 'string') {
        toolUseIdToGroup.set(toolUseId as ToolUseId, key)
      }
    }
  }

  // 3. Find the root group. Required if any non-root groups exist.
  if (!groups.has(ROOT_KEY)) {
    throw new Error(
      'buildAuditTree: no root subtree (no envelopes without origin) — ' +
        'callers must pass a single-session slice including parent envelopes',
    )
  }

  // 4. Compute parent → children edges. Throw on orphans.
  const childrenByParent = new Map<string, string[]>()
  for (const key of groups.keys()) {
    if (key === ROOT_KEY) continue
    const envs = groups.get(key)!
    const parentToolUseId = envs[0]!.parentToolUseId!
    const parentKey = toolUseIdToGroup.get(parentToolUseId)
    if (parentKey === undefined) {
      throw new Error(
        `buildAuditTree: orphan subtree — no tool_call_started event found for parentToolUseId "${parentToolUseId}". ` +
          'Either the audit slice is incomplete or it spans multiple sessions.',
      )
    }
    let arr = childrenByParent.get(parentKey)
    if (arr === undefined) {
      arr = []
      childrenByParent.set(parentKey, arr)
    }
    arr.push(key)
  }

  // 5. Build the tree recursively from the root.
  const buildNode = (key: string): AuditTreeNode => {
    const envs = groups.get(key)!
    const first = envs[0]!
    const childKeys = childrenByParent.get(key) ?? []
    return {
      origin: first.origin ?? null,
      parentToolUseId: first.parentToolUseId ?? null,
      events: envs,
      children: childKeys.map(buildNode),
    }
  }
  return buildNode(ROOT_KEY)
}
