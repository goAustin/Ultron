/**
 * Token budget — threshold constants and compaction decision.
 *
 * Simple constants for v1. No per-model config.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total context window size in tokens. */
export const CONTEXT_WINDOW_TOKENS = 200_000

/** Tokens reserved for model output. */
export const RESERVED_OUTPUT_TOKENS = 20_000

/** Compact when input tokens reach this fraction of the effective window. */
export const COMPACT_THRESHOLD_RATIO = 0.80

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Usable context window after reserving space for output. */
export function getEffectiveContextWindow(): number {
  return CONTEXT_WINDOW_TOKENS - RESERVED_OUTPUT_TOKENS
}

/** Token count at which compaction should trigger. */
export function getCompactThreshold(): number {
  return Math.floor(getEffectiveContextWindow() * COMPACT_THRESHOLD_RATIO)
}

/** Returns true if the given token count is at or above the compaction threshold. */
export function shouldCompact(inputTokens: number): boolean {
  return inputTokens >= getCompactThreshold()
}
