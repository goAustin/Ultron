/**
 * System-prompt parts builder.
 *
 * Composes the ordered `SystemPromptPart[]` that flows through the agent loop:
 *
 *   1. `'global'`  — Ultron preamble sections (one part per section so a
 *                    single section's change doesn't invalidate the rest).
 *   2. `'org'`     — memory injection (Phase 4d) and, eventually, skills
 *                    (Phase 5b). One injection part per source today.
 *   3. `'volatile'`— current date + env info.
 *
 * No empty part is emitted; an empty part would make a bad Anthropic
 * `cache_control` target.
 */

import type { SystemPromptPart } from './systemPromptParts.js'
import { buildSystemPrompt } from './systemPrompt.js'
import { getSystemContext } from './systemContext.js'
import { buildMemoryInjectionParts } from './memoryInjection.js'
import { buildSkillInjectionParts } from './skillInjection.js'
import { MEMORY_INJECTION_TOKEN_BUDGET } from './tokenBudget.js'
import type { ActiveSkill } from '../skills/router.js'

export type BuildSystemPromptPartsOpts = {
  /**
   * Ultron base dir (e.g. `~/.ultron`) — same value
   * `QueryEngine._memoryBaseDir` holds. When set, memory entries are
   * injected as a single `'org'` part at the seam between the preamble
   * and the volatile tail. When `null`/`undefined`, the injection step
   * no-ops and behavior is byte-identical to pre-4d.
   */
  readonly memoryBaseDir?: string | null
  /**
   * Phase 5b: when an `ActiveSkill` snapshot is provided, the skill body
   * is injected as a single `'org'` part placed AFTER the memory block.
   * The Anthropic adapter's Pass 2 (last `'org'` part) lands on the
   * skill body during an activation window — stable bytes within the
   * window mean a cache hit on the org segment for subsequent turns.
   * `null`/`undefined` no-ops (no skill injection).
   */
  readonly activeSkill?: ActiveSkill | null
  /**
   * v3 Phase 5: when `true`, the static preamble includes the Computer-Use
   * guidance section. Threaded through to `buildSystemPrompt`. Defaults to
   * the byte-identical pre-Phase-5 preamble when omitted/false.
   */
  readonly computerUseEnabled?: boolean
}

export async function buildSystemPromptParts(
  cwd: string,
  opts: BuildSystemPromptPartsOpts = {},
): Promise<SystemPromptPart[]> {
  const staticSections = buildSystemPrompt({ computerUseEnabled: opts.computerUseEnabled })
  const systemCtx = await getSystemContext(cwd)
  const currentDate = `Today's date is ${new Date().toISOString().slice(0, 10)}.`

  const parts: SystemPromptPart[] = []

  for (const section of staticSections) {
    if (section.length > 0) {
      parts.push({ content: section, cacheHint: 'global' })
    }
  }

  // Memory/skills injection seam — Phase 4d injects memory as 'org' parts
  // here; Phase 5b appends the active skill body as a single 'org' part
  // AFTER the memory block. The Anthropic adapter emits a separate cache
  // breakpoint on the last 'org' part so memory changes leave the 'global'
  // preamble cache intact, and a skill activation pins the breakpoint on
  // the skill body for the duration of the window.
  if (opts.memoryBaseDir) {
    const memParts = await buildMemoryInjectionParts(
      opts.memoryBaseDir,
      MEMORY_INJECTION_TOKEN_BUDGET,
    )
    parts.push(...memParts)
  }

  if (opts.activeSkill) {
    parts.push(...buildSkillInjectionParts(opts.activeSkill))
  }

  parts.push({ content: currentDate, cacheHint: 'volatile' })
  parts.push({ content: systemCtx.envInfo, cacheHint: 'volatile' })

  return parts
}
