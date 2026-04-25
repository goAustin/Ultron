import type { HookDefinition } from './types.js'

/**
 * Match a hook definition against a tool name.
 *
 * Matcher syntax (v2b):
 * - "*"           — matches every tool
 * - "Bash"        — exact match
 * - "Write|Edit"  — alternation (either exact match)
 *
 * No regex, no argument-level matchers. Forward-compatible: a future version
 * can recognize leading "/" for regex or "(" for argument selectors without
 * breaking existing configs.
 */
export function hookMatches(def: HookDefinition, toolName: string): boolean {
  if (def.matcher === '*') return true
  const alternatives = def.matcher.split('|').map((s) => s.trim())
  return alternatives.includes(toolName)
}
