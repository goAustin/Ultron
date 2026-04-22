/**
 * Token estimation — character-ratio heuristic for when no API count is available.
 *
 * Used as a fallback before the first API call (e.g. resumed session).
 * The authoritative count comes from ApiResponseMeta.inputTokens.
 */

import type { Message, ContentBlock } from '../core/messages.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Approximate characters per token for the heuristic estimator. */
export const CHARS_PER_TOKEN = 4

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Estimate the total token count for a message array using a character-ratio heuristic.
 * Walks all content blocks and sums character lengths, then divides by CHARS_PER_TOKEN.
 */
export function estimateTokens(messages: readonly Message[]): number {
  let totalChars = 0

  for (const message of messages) {
    for (const block of message.content) {
      totalChars += estimateBlockChars(block)
    }
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN)
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function estimateBlockChars(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length
    case 'tool_use':
      return block.name.length + JSON.stringify(block.input).length
    case 'tool_result':
      return block.content.length
    case 'thinking':
      return block.thinking.length
    case 'image':
      return 100 // fixed estimate — images are token-heavy but we can't measure from base64
    case 'redacted_thinking':
      return 10 // minimal placeholder
  }
}
