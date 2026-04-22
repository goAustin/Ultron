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
  const matching = findMatchingRules(rules, toolUse.name, toolPath)

  // 1. Explicit deny rules
  const denyRule = matching.find((r) => r.behavior === 'deny')
  if (denyRule) {
    return { behavior: 'deny', reason: { type: 'rule', rule: denyRule } }
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

function findMatchingRules(
  rules: readonly PermissionRule[],
  toolName: string,
  toolPath: string | undefined,
): PermissionRule[] {
  return rules.filter((rule) => {
    if (rule.toolName !== toolName) return false
    // Rule with a path only matches if tool resolved to that exact path
    if (rule.path !== undefined) {
      return toolPath !== undefined && rule.path === toolPath
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// Decision message formatting
// ---------------------------------------------------------------------------

export function formatDecisionMessage(decision: PermissionDecision): string {
  const reason = decision.reason
  switch (reason.type) {
    case 'rule':
      return `${reason.rule.behavior} by ${reason.rule.source} rule for ${reason.rule.toolName}${reason.rule.path ? ` (${reason.rule.path})` : ''}`
    case 'safetyCheck':
      return reason.message
    case 'mode':
      return `${decision.behavior} by permission mode: ${reason.mode}`
    case 'toolCheck':
      return 'message' in reason ? reason.message : 'tool check'
    case 'headlessEscalation':
      return `denied in headless mode (original: ${formatDecisionMessage({ behavior: 'ask', reason: reason.original })})`
    case 'fallback':
      return 'no matching rule; requires approval'
  }
}
