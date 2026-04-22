/**
 * Query context orchestrator — the single entry point for system prompt assembly.
 *
 * The system prompt contains only static policy sections + env info + date.
 * Volatile state (git status, project instructions) is provided via
 * attachments (see attachments.ts) — not baked into the system prompt.
 */

import {
  buildSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from './systemPrompt.js'
import { getSystemContext } from './systemContext.js'

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './systemPrompt.js'
export { buildSystemPrompt } from './systemPrompt.js'
export { getProjectInstructions, clearUserContextCache } from './userContext.js'
export { getSystemContext, clearSystemContextCache } from './systemContext.js'
export {
  buildGetAttachments,
  getInitialAttachments,
  renderAttachment,
  type GetAttachmentsFn,
} from './attachments.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for a query() call.
 *
 * Contains static policy sections (sync, pure), the current date (fresh),
 * and environment info (platform, shell, cwd). Git status and project
 * instructions are NOT included — they are provided via attachments.
 */
export async function buildFullSystemPrompt(cwd: string): Promise<string> {
  // Static sections (sync)
  const staticSections = buildSystemPrompt()

  // Environment info (cached by cwd)
  const systemCtx = await getSystemContext(cwd)

  // Date — always fresh
  const currentDate = `Today's date is ${new Date().toISOString().slice(0, 10)}.`

  // Assemble: static + date + env info (no git status, no project instructions)
  const dynamicSections: string[] = [currentDate, systemCtx.envInfo]

  // Join all, filtering out the boundary marker
  return [...staticSections, ...dynamicSections]
    .filter((s) => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .join('\n\n')
}
