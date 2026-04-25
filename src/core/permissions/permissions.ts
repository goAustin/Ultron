/**
 * Permission engine — centralized policy cascade.
 *
 * Decision order:
 *   1. Explicit deny rules
 *   2. Explicit ask rules
 *   3. Tool-specific permission check (tool.checkPermissions)
 *   4. Safety checks (non-bypassable)
 *   5. Mode-based resolution (bypassPermissions, acceptEdits)
 *   6. Explicit allow rules
 *   7. Fallback → ask
 *
 * Headless escalation (ask → deny) is a boundary transformation applied
 * after the cascade, preserving the original reason.
 */

import type { ToolUseBlock } from '../messages.js'
import type { Tool } from '../tools/types.js'
import type { ToolUseContext } from '../tools/context.js'
import type {
  PermissionRule,
  PermissionDecision,
  PermissionOptions,
} from './types.js'
import { matchDomain } from '../../web/domainPolicy.js'

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function hasPermissionsToUseTool(
  tool: Tool,
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  opts: PermissionOptions,
): Promise<PermissionDecision> {
  const decision = await runCascade(tool, toolUse, context, opts)

  // Headless escalation: ask → deny, preserving original reason
  if (opts.headless && decision.behavior === 'ask') {
    return {
      behavior: 'deny',
      reason: { type: 'headlessEscalation', original: decision.reason },
    }
  }

  return decision
}

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

async function runCascade(
  tool: Tool,
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  opts: PermissionOptions,
): Promise<PermissionDecision> {
  const rules = context.appState.getState().permissionRules
  const toolPath = tool.getPath?.(toolUse.input)
  const toolHost = tool.getDomain?.(toolUse.input)
  const matching = findMatchingRules(rules, toolUse.name, toolPath, toolHost)

  // 1. Explicit deny rules — user explicit deny ALWAYS wins, even over
  //    skill scope (step 1.5) and mode bypass (step 5).
  const denyRule = matching.find((r) => r.behavior === 'deny')
  if (denyRule) {
    return { behavior: 'deny', reason: { type: 'rule', rule: denyRule } }
  }

  // 1.5. Skill scope (Phase 5b) — when an activation is in flight with a
  //      narrowed tool list, any tool outside the list denies here. Runs
  //      AFTER explicit deny (user always wins) and BEFORE explicit ask /
  //      mode bypass (skill scope wins over `bypassPermissions`).
  if (
    opts.scopedToolAllowlist !== undefined &&
    !opts.scopedToolAllowlist.includes(toolUse.name)
  ) {
    return {
      behavior: 'deny',
      reason: {
        type: 'skillScope',
        toolName: toolUse.name,
        allowed: opts.scopedToolAllowlist,
      },
    }
  }

  // 2. Explicit ask rules
  const askRule = matching.find((r) => r.behavior === 'ask')
  if (askRule) {
    return { behavior: 'ask', reason: { type: 'rule', rule: askRule } }
  }

  // 3. Tool-specific permission check
  try {
    const toolResult = await tool.checkPermissions(toolUse.input, context)
    if (toolResult.behavior === 'deny') {
      return {
        behavior: 'deny',
        reason: { type: 'toolCheck', message: toolResult.message },
      }
    }
    if (toolResult.behavior === 'ask') {
      return {
        behavior: 'ask',
        reason: { type: 'toolCheck', message: toolResult.message },
      }
    }
    // allow → continue through cascade
  } catch (err) {
    // Tool permission check crashed → treat as deny (same as Phase 3)
    return {
      behavior: 'deny',
      reason: { type: 'toolCheck', message: err instanceof Error ? err.message : String(err) },
    }
  }

  // 4. Safety checks (non-bypassable)
  for (const check of opts.safetyChecks) {
    const result = check(tool, toolUse.input, context)
    if (result !== null) {
      return result
    }
  }

  // 5. Mode-based resolution
  const mode = context.appState.getState().permissionMode
  if (mode === 'bypassPermissions') {
    return { behavior: 'allow', reason: { type: 'mode', mode } }
  }
  if (mode === 'acceptEdits' && tool.getPath !== undefined) {
    return { behavior: 'allow', reason: { type: 'mode', mode } }
  }

  // 6. Explicit allow rules
  const allowRule = matching.find((r) => r.behavior === 'allow')
  if (allowRule) {
    return { behavior: 'allow', reason: { type: 'rule', rule: allowRule } }
  }

  // 7. Fallback
  return { behavior: 'ask', reason: { type: 'fallback' } }
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

export function findMatchingRules(
  rules: readonly PermissionRule[],
  toolName: string,
  toolPath: string | undefined,
  toolHost: string | undefined,
): PermissionRule[] {
  return rules.filter((rule) => {
    if (!matchesToolName(rule.toolName, toolName)) return false
    // Rule with a path only matches if tool resolved to that exact path
    if (rule.path !== undefined) {
      if (toolPath === undefined || rule.path !== toolPath) return false
    }
    // Rule with a domain only matches if tool resolved to a host that
    // satisfies the pattern (exact or `*.suffix`).
    if (rule.domain !== undefined) {
      if (toolHost === undefined || !matchDomain(rule.domain, toolHost)) return false
    }
    return true
  })
}

// Suffix-`*` wildcard: `mcp__github__*` matches any name starting with
// `mcp__github__`. Bare `*` fails closed — safer than allow-all. Literal
// names fall back to exact equality.
function matchesToolName(ruleToolName: string, toolName: string): boolean {
  if (!ruleToolName.endsWith('*')) return ruleToolName === toolName
  const prefix = ruleToolName.slice(0, -1)
  if (prefix.length === 0) return false
  return toolName.startsWith(prefix)
}

// ---------------------------------------------------------------------------
// Decision message formatting
// ---------------------------------------------------------------------------

export function formatDecisionMessage(decision: PermissionDecision): string {
  const reason = decision.reason
  switch (reason.type) {
    case 'rule': {
      const scope = [
        reason.rule.path ? reason.rule.path : undefined,
        reason.rule.domain ? reason.rule.domain : undefined,
      ].filter((s): s is string => s !== undefined).join(', ')
      return `${reason.rule.behavior} by ${reason.rule.source} rule for ${reason.rule.toolName}${scope ? ` (${scope})` : ''}`
    }
    case 'safetyCheck':
      return reason.message
    case 'mode':
      return `${decision.behavior} by permission mode: ${reason.mode}`
    case 'toolCheck':
      return 'message' in reason ? reason.message : 'tool check'
    case 'headlessEscalation':
      return `denied in headless mode (original: ${formatDecisionMessage({ behavior: 'ask', reason: reason.original })})`
    case 'skillScope':
      return `tool not in active skill's allowed-tools (allowed: ${reason.allowed.join(', ')})`
    case 'fallback':
      return 'no matching rule; requires approval'
  }
}
