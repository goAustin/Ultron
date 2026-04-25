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

/**
 * Token cap for memory injection into the system prompt (Phase 4d).
 *
 * Memory has its own budget — separate from the main context window — because
 * it lives in the cache-friendly prefix and we want a hard ceiling regardless
 * of model. 8192 tokens at the 4-chars-per-token heuristic ≈ 32 KB, which is
 * the same order of magnitude as a single entry's 32 KB cap from Phase 4a.
 *
 * Attachments will get their own per-pillar budget when that work lands.
 */
export const MEMORY_INJECTION_TOKEN_BUDGET = 8192

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
