/**
 * Boot-time seeding helpers for permission rules from settings.json (Phase 6b).
 *
 * Three pure functions, no I/O:
 *   - validateAndNormalizeRules — sanity-check + lowercase + default source
 *   - compileWebPolicy          — translate webPolicy.{allowlist,denylist}
 *                                  into WebFetch domain rules
 *   - dedupeRules               — drop equivalent rules (same triple)
 *
 * The contract is "boot must never throw": invalid entries warn to stderr
 * and are skipped; valid entries pass through unchanged. The QueryEngine
 * constructor calls these once and seeds AppState with the result.
 */

import type {
  PermissionRule,
  PermissionRuleBehavior,
  PermissionRuleSource,
} from '../core/permissions/types.js'
import type { SettingsConfig } from '../config/settingsConfig.js'
import { isValidDomainPattern } from './domainPolicy.js'

const VALID_BEHAVIORS: ReadonlySet<PermissionRuleBehavior> = new Set(['allow', 'deny', 'ask'])
const VALID_SOURCES: ReadonlySet<PermissionRuleSource> = new Set([
  'userSettings',
  'projectSettings',
  'session',
  'cliArg',
])

function warn(msg: string): void {
  process.stderr.write(`[ultron] settings.json: ${msg}\n`)
}

export function validateAndNormalizeRules(
  raw: readonly unknown[],
): PermissionRule[] {
  const out: PermissionRule[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (entry === null || typeof entry !== 'object') {
      warn(`permissionRules[${i}] is not an object; skipping`)
      continue
    }
    const obj = entry as Record<string, unknown>

    const toolName = typeof obj.toolName === 'string' ? obj.toolName.trim() : ''
    if (toolName === '') {
      warn(`permissionRules[${i}] has no toolName; skipping`)
      continue
    }

    const behavior = obj.behavior
    if (typeof behavior !== 'string' || !VALID_BEHAVIORS.has(behavior as PermissionRuleBehavior)) {
      warn(`permissionRules[${i}] has invalid behavior "${String(behavior)}"; skipping`)
      continue
    }

    let domain: string | undefined
    if (obj.domain !== undefined) {
      if (typeof obj.domain !== 'string') {
        warn(`permissionRules[${i}] has non-string domain; skipping`)
        continue
      }
      const lowered = obj.domain.toLowerCase()
      if (!isValidDomainPattern(lowered)) {
        warn(`permissionRules[${i}] has invalid domain "${obj.domain}"; skipping`)
        continue
      }
      domain = lowered
    }

    let path: string | undefined
    if (obj.path !== undefined) {
      if (typeof obj.path !== 'string' || obj.path === '') {
        warn(`permissionRules[${i}] has invalid path; skipping`)
        continue
      }
      path = obj.path
    }

    let source: PermissionRuleSource = 'userSettings'
    if (obj.source !== undefined) {
      if (typeof obj.source !== 'string' || !VALID_SOURCES.has(obj.source as PermissionRuleSource)) {
        warn(`permissionRules[${i}] has invalid source "${String(obj.source)}"; defaulting to userSettings`)
      } else {
        source = obj.source as PermissionRuleSource
      }
    }

    const rule: PermissionRule = {
      toolName,
      behavior: behavior as PermissionRuleBehavior,
      source,
      ...(domain !== undefined && { domain }),
      ...(path !== undefined && { path }),
    }
    out.push(rule)
  }
  return out
}

export function compileWebPolicy(policy: SettingsConfig['webPolicy']): PermissionRule[] {
  if (!policy) return []
  const rules: PermissionRule[] = []
  const compileList = (
    list: readonly string[] | undefined,
    behavior: 'allow' | 'deny',
    label: string,
  ) => {
    if (!list) return
    for (let i = 0; i < list.length; i++) {
      const raw = list[i]
      if (typeof raw !== 'string') {
        warn(`webPolicy.${label}[${i}] is not a string; skipping`)
        continue
      }
      const lowered = raw.toLowerCase()
      if (!isValidDomainPattern(lowered)) {
        warn(`webPolicy.${label}[${i}] = "${raw}" is not a valid host pattern; skipping`)
        continue
      }
      rules.push({
        toolName: 'WebFetch',
        behavior,
        domain: lowered,
        source: 'userSettings',
      })
    }
  }
  compileList(policy.allowlist, 'allow', 'allowlist')
  compileList(policy.denylist, 'deny', 'denylist')
  return rules
}

/**
 * Removes entries with the same (toolName, behavior, path?, domain?) tuple.
 * Preserves order — first occurrence wins.
 */
export function dedupeRules(rules: readonly PermissionRule[]): PermissionRule[] {
  const seen = new Set<string>()
  const out: PermissionRule[] = []
  for (const r of rules) {
    const key = `${r.toolName}|${r.behavior}|${r.path ?? ''}|${r.domain ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}
