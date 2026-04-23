/**
 * System-prompt parts builder.
 *
 * Composes the ordered `SystemPromptPart[]` that flows through the agent loop.
 * Static Ultron preamble sections come first (one part per section so a single
 * section's change doesn't invalidate caching of the rest); volatile date +
 * env info come last.
 *
 * Memory/skills injection (phases 4d/5b) will insert static parts between the
 * preamble and the dynamic tail — the seam is documented below. No empty part
 * is emitted; an empty part would make a bad Anthropic `cache_control` target.
 */

import type { SystemPromptPart } from './systemPromptParts.js'
import { buildSystemPrompt } from './systemPrompt.js'
import { getSystemContext } from './systemContext.js'

export async function buildSystemPromptParts(
  cwd: string,
): Promise<SystemPromptPart[]> {
  const staticSections = buildSystemPrompt()
  const systemCtx = await getSystemContext(cwd)
  const currentDate = `Today's date is ${new Date().toISOString().slice(0, 10)}.`

  const parts: SystemPromptPart[] = []

  for (const section of staticSections) {
    if (section.length > 0) {
      parts.push({ content: section, cacheHint: 'static' })
    }
  }

  // Memory/skills injection seam — phases 4d / 5b insert static parts here.
  // NOTE: when 4d lands, widen `CacheHint` to distinguish globally-shared
  // static (preamble above) from org/user-scoped static (memory, CLAUDE.md).
  // Today both collapse to 'static'; that's fine while the seam is empty.

  parts.push({ content: currentDate, cacheHint: 'volatile' })
  parts.push({ content: systemCtx.envInfo, cacheHint: 'volatile' })

  return parts
}
