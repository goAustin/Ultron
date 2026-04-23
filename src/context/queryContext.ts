/**
 * Query context orchestrator — the single entry point for system prompt assembly.
 *
 * The system prompt contains only static policy sections + env info + date.
 * Volatile state (git status, project instructions) is provided via
 * attachments (see attachments.ts) — not baked into the system prompt.
 */

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { buildSystemPrompt } from './systemPrompt.js'
export { getProjectInstructions, clearUserContextCache } from './userContext.js'
export { getSystemContext, clearSystemContextCache } from './systemContext.js'
export {
  buildGetAttachments,
  getInitialAttachments,
  renderAttachment,
  type GetAttachmentsFn,
} from './attachments.js'
export { buildSystemPromptParts as buildFullSystemPromptParts } from './cacheHints.js'
export type { SystemPromptPart, CacheHint } from './systemPromptParts.js'
