/**
 * Content safety check — scans file write content for secrets.
 *
 * Separate from filesystem path safety (filesystem.ts handles paths,
 * this module handles content inspection).
 *
 * Two-tier response:
 * - High-confidence secret matches → deny
 * - Low-confidence matches only → ask
 */

import type { SafetyCheck } from '../core/permissions/types.js'
import { detectSecrets } from './secretScanner.js'
import type { SecretMatch } from './secretScanner.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Safety check that scans file content for secrets.
 * Fires for FileWrite (scans content) and FileEdit (scans post-edit content).
 */
export const secretContentSafetyCheck: SafetyCheck = (tool, input, context) => {
  if (tool.name !== 'FileWrite' && tool.name !== 'FileEdit') return null

  const textToScan = getTextToScan(tool.name, input, context)
  if (!textToScan) return null

  const matches = detectSecrets(textToScan)
  if (matches.length === 0) return null

  const hasHighConfidence = matches.some((m) => m.confidence === 'high')
  const types = [...new Set(matches.map((m) => m.type))].join(', ')

  return {
    behavior: hasHighConfidence ? 'deny' : 'ask',
    reason: {
      type: 'safetyCheck',
      message: `Content contains potential secrets: ${types}`,
    },
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text to scan for secrets.
 * - FileWrite: scan the content field directly
 * - FileEdit: compute post-edit content from readFileState if available,
 *   otherwise fall back to scanning new_string alone
 */
function getTextToScan(
  toolName: string,
  input: Record<string, unknown>,
  context: { readFileState: Map<string, { content: string; mtime: number }> },
): string | null {
  if (toolName === 'FileWrite') {
    const content = input.content
    return typeof content === 'string' ? content : null
  }

  if (toolName === 'FileEdit') {
    const newString = input.new_string
    if (typeof newString !== 'string') return null

    const oldString = input.old_string
    const filePath = input.file_path

    // Try to compute post-edit content from readFileState
    if (
      typeof filePath === 'string' &&
      typeof oldString === 'string' &&
      context.readFileState
    ) {
      const cached = context.readFileState.get(filePath)
      if (cached) {
        // Apply the replacement to get the full post-edit content
        const postEdit = cached.content.replace(oldString, newString)
        return postEdit
      }
    }

    // Fallback: scan new_string alone
    return newString
  }

  return null
}
