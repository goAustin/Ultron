/**
 * Skill body injection into the system prompt (Phase 5b).
 *
 * Reads from the engine's `_activeSkill` snapshot and produces a single
 * `'org'`-bucket `SystemPromptPart` wrapping a `<system-reminder>`.
 * Inserted AFTER the memory block by `cacheHints.ts`, so the Anthropic
 * adapter's Pass 2 (last `'org'` part) lands on the skill body during an
 * activation window — stable bytes within the window mean a cache hit on
 * the org segment for subsequent turns.
 *
 * Pure module — no I/O, no globals. The test surface is the wrapper
 * template exactness and the args / allowed-tools branch matrix.
 */

import type { SystemPromptPart } from './systemPromptParts.js'
import type { ActiveSkill } from '../skills/router.js'

const HEADER_OPEN = '<system-reminder>'
const HEADER_LINE_1 =
  'A user-authored skill is active for this turn. The instructions below'
const HEADER_LINE_2 =
  'override your default response style for the duration; treat them as'
const HEADER_LINE_3 = 'authoritative within their scope.'

const FOOTER = '</system-reminder>'

/**
 * Build the skill injection block for the system prompt.
 *
 * - `null` → `[]` (no injection).
 * - Otherwise, returns exactly one `'org'` part whose content wraps the
 *   skill name/id, body, optional args, and optional allowed-tools list
 *   inside a `<system-reminder>` block.
 */
export function buildSkillInjectionParts(
  active: ActiveSkill | null,
): readonly SystemPromptPart[] {
  if (active === null) return []
  return [{ content: renderActiveSkill(active), cacheHint: 'org' }]
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function renderActiveSkill(active: ActiveSkill): string {
  const lines: string[] = [
    HEADER_OPEN,
    HEADER_LINE_1,
    HEADER_LINE_2,
    HEADER_LINE_3,
    '',
    `Active skill: ${active.name} (id: ${active.id})`,
    '',
    '## Instructions',
    '',
    active.body.replace(/\s+$/, ''),
    '',
  ]

  if (active.args.length > 0) {
    lines.push(
      '## Activation arguments',
      '',
      '<skill-args>',
      active.args,
      '</skill-args>',
      '',
    )
  }

  if (active.allowedTools !== undefined) {
    lines.push('## Tool scope', '')
    if (active.allowedTools.length === 0) {
      lines.push(
        'This skill is instruction-only. You may not invoke any tools',
        'while this skill is active.',
        '',
      )
    } else {
      lines.push(
        'You may only call the following tools while this skill is active:',
        '',
        '<allowed-tools>',
        ...active.allowedTools.map((t) => `- ${t}`),
        '</allowed-tools>',
        '',
        'Calls to any other tool will be denied at the permission boundary.',
        '',
      )
    }
  }

  lines.push(FOOTER)
  return lines.join('\n')
}
