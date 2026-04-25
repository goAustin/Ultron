/**
 * Skill activation router (Phase 5b) — stateless helpers used by QueryEngine.
 *
 * No singleton, no module-level state. The engine owns activation state
 * (`_activeSkill`, `_remainingTurns`, `_activeCallModel`); this module
 * provides pure functions for the activation-time secret re-scan, the
 * tool-def filter, and the active-skill snapshot type.
 */

import type { Skill } from './skill.js'
import type { ApiToolDefinition } from '../core/tools/registry.js'
import { detectSecrets, type SecretMatch } from '../memory/secretScanner.js'
import { serializeSkill } from './skill.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Frozen snapshot captured at activation time. The body and `allowedTools`
 * are captured here so a later `/skill edit` (or any disk mutation) cannot
 * mutate an in-flight activation.
 */
export type ActiveSkill = {
  readonly id: string
  readonly name: string
  readonly body: string
  readonly allowedTools?: readonly string[]
  readonly args: string
  readonly activatedAt: number
}

export type ActivationScanResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly kind: 'high' | 'low'
      readonly matches: readonly SecretMatch[]
    }

// ---------------------------------------------------------------------------
// Secret re-scan
// ---------------------------------------------------------------------------

/**
 * Re-scan a skill's serialized form for secrets at activation time.
 *
 * Hand-authored SKILL.md bypasses 5a's `writeSkill` gate; this is the
 * second checkpoint before bytes reach the model. High-confidence →
 * refuse outright; low-confidence → caller askUser then refuse-or-proceed.
 *
 * Scan target is `serializeSkill(skill)` — same string the write gate
 * scans, so a body that round-trips `writeSkill` identically round-trips
 * the activation scan.
 */
export function scanForActivation(skill: Skill): ActivationScanResult {
  const matches = detectSecrets(serializeSkill(skill))
  if (matches.length === 0) return { ok: true }
  const highs = matches.filter((m) => m.confidence === 'high')
  if (highs.length > 0) return { ok: false, kind: 'high', matches: highs }
  return { ok: false, kind: 'low', matches }
}

/** Comma-separate distinct match types for user-facing messages. */
export function summarizeMatches(matches: readonly SecretMatch[]): string {
  return [...new Set(matches.map((m) => m.type))].join(', ')
}

// ---------------------------------------------------------------------------
// Tool def filter
// ---------------------------------------------------------------------------

/**
 * Filter a list of API tool definitions to those named in `allowedTools`.
 * Order of returned defs matches the original (deterministic for caching).
 * Empty `allowedTools` → empty result (instruction-only skill).
 */
export function filterToolDefs(
  defs: readonly ApiToolDefinition[],
  allowedTools: readonly string[],
): ApiToolDefinition[] {
  const allow = new Set(allowedTools)
  return defs.filter((d) => allow.has(d.name))
}

// ---------------------------------------------------------------------------
// ActiveSkill snapshot
// ---------------------------------------------------------------------------

/**
 * Build an `ActiveSkill` snapshot from a parsed `Skill` plus activation args.
 *
 * The TypeScript `readonly` modifier is compile-time only; we additionally
 * `Object.freeze` the snapshot and the captured `allowedTools` array so
 * external code holding a reference (e.g. via `engine.activeSkill`) cannot
 * mutate the live activation underneath the running turn. A push or splice
 * into `allowedTools` would otherwise widen the cascade scope at runtime
 * while leaving the send-side `_activeCallModel` untouched.
 */
export function makeActiveSkill(skill: Skill, args: string): ActiveSkill {
  const allowedTools =
    skill.allowedTools !== undefined
      ? Object.freeze([...skill.allowedTools])
      : undefined
  return Object.freeze({
    id: skill.id,
    name: skill.name,
    body: skill.content,
    ...(allowedTools !== undefined && { allowedTools }),
    args,
    activatedAt: Date.now(),
  })
}
