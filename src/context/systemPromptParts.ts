/**
 * Structured system-prompt parts.
 *
 * The system prompt flows through the agent loop as an ordered array of parts.
 * Each part carries an optional generic `cacheHint`; adapters translate hints
 * to their native prompt-cache shape (Anthropic: `cache_control` on the last
 * static part; OpenAI/MiniMax: concatenate in stable order and rely on
 * implicit prefix caching).
 *
 * The static → volatile transition in the array is the structural cut point
 * that earlier versions encoded as a magic boundary string.
 */

export type CacheHint = 'static' | 'volatile'

export type SystemPromptPart = {
  readonly content: string
  readonly cacheHint?: CacheHint
}
