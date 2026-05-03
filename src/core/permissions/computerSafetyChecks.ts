/**
 * v3 Phase 4·1 — Computer-Use safety check.
 *
 * `makeComputerUseSafetyCheck(deps)` returns a `SafetyCheck` that the
 * `QueryEngine` registers into `permissionOpts.safetyChecks`. The cascade
 * (`permissions.ts:111-117`) runs it at step 4 — BEFORE explicit allow rules
 * (step 6) and BEFORE permission-mode bypass (step 5). That makes the check
 * non-bypassable: even `bypassPermissions` mode cannot escape an `ask` for
 * level 2/3 actions or a `deny` for level 4.
 *
 * Behavior table (from the design doc):
 *   level 0 (observation)   → null  (defer to cascade — fall through to allow rules / fallback ask)
 *   level 1 (reversible_ui) → null  (defer)
 *   level 2 (sensitive)     → 'ask' with structured metadata
 *   level 3 (irreversible)  → 'ask' with structured metadata
 *   level 4 (prohibited)    → 'deny' with structured metadata
 *
 * The check reads the most recent ARIA snapshot via
 * `BrowserSession.lastAriaSnapshot()` — which is synchronous by design so the
 * SafetyCheck contract (sync, returns immediately) holds. If no session can
 * be resolved (e.g., `ComputerStart` before any session exists), the check
 * still classifies the action and emits structured metadata for audit.
 */

import { classifyAction, type RiskAssessment } from '../computer/policy.js'
import type {
  ComputerSessionId,
  ComputerSessionManager,
} from '../computer/types.js'

import type { PermissionDecision, SafetyCheck, SafetyMetadata } from './types.js'

const CHECK_NAME = 'computerUseSafetyCheck'

export type ComputerUseSafetyCheckDeps = {
  /**
   * Used to resolve the session referenced by `input.sessionId` and read its
   * `lastAriaSnapshot()` + viewport. Optional — when omitted (e.g., SDK
   * caller didn't enable Computer-Use), the safety check is a no-op for
   * every input.
   */
  readonly sessionManager: ComputerSessionManager | null
}

export function makeComputerUseSafetyCheck(
  deps: ComputerUseSafetyCheckDeps,
): SafetyCheck {
  return (tool, input, _context) => {
    if (!tool.name.startsWith('Computer')) return null
    if (deps.sessionManager === null) return null

    const sessionId = input.sessionId
    const session =
      typeof sessionId === 'string'
        ? deps.sessionManager.get(sessionId as ComputerSessionId)
        : undefined

    const ariaSnapshot = session?.lastAriaSnapshot() ?? null
    const viewport = session?.viewport
    const currentUrl = session?.currentUrl() ?? null

    // Phase 4b — `ComputerActAtom` carries `input.atomId` which the safety
    // check resolves to the cached `AriaNode` so the classifier reads the
    // node directly (no coordinate lookup). On cache miss `targetNode` stays
    // null and `classifyActAtom` defers to level 1; the tool body returns
    // 'atom_resolution_failed' at execute time.
    const atomEntry =
      tool.name === 'ComputerActAtom' && typeof input.atomId === 'string'
        ? (session?.lookupAtom(input.atomId) ?? null)
        : null
    const targetNode = atomEntry?.node ?? null

    const assessment = classifyAction({
      toolName: tool.name,
      input,
      currentUrl,
      ariaSnapshot,
      ...(viewport !== undefined && { viewport }),
      targetNode,
    })

    return decisionFromAssessment(tool.name, assessment)
  }
}

function decisionFromAssessment(
  toolName: string,
  assessment: RiskAssessment,
): PermissionDecision | null {
  if (assessment.level <= 1) return null

  const metadata: SafetyMetadata = {
    checkName: CHECK_NAME,
    riskLevel: assessment.level,
    riskCategory: assessment.category,
    ...(assessment.evidence !== undefined && { evidence: assessment.evidence }),
  }

  if (assessment.level === 4) {
    return {
      behavior: 'deny',
      reason: {
        type: 'safetyCheck',
        message: `${toolName}: denied (level 4 ${assessment.category}) — ${assessment.reason}`,
        metadata,
      },
    }
  }

  // levels 2 and 3 → ask
  return {
    behavior: 'ask',
    reason: {
      type: 'safetyCheck',
      message: `${toolName}: requires approval (level ${assessment.level} ${assessment.category}) — ${assessment.reason}`,
      metadata,
    },
  }
}
