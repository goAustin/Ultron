/**
 * Structured system-prompt parts.
 *
 * The system prompt flows through the agent loop as an ordered array of parts.
 * Each part carries an optional `cacheHint` that classifies its scope:
 *
 * - `'global'`   — content byte-identical across all Ultron installs (the
 *                  Ultron policy preamble). Eligible for provider global-cache
 *                  lookup where supported.
 * - `'org'`      — content stable within one user but per-install (memory
 *                  entries; future: skills, CLAUDE.md if it ever migrates off
 *                  the attachment path). Gets its own cache breakpoint so
 *                  changes don't invalidate the preamble cache.
 * - `'volatile'` — changes every turn (date, env info). No breakpoint.
 *
 * Adapters translate hints to their native prompt-cache shape. The Anthropic
 * adapter emits one `cache_control` breakpoint on the last `'global'` part
 * and a second on the last `'org'` part (Anthropic allows up to 4). OpenAI
 * and MiniMax concatenate parts in stable order and rely on implicit prefix
 * caching — they ignore the hint but benefit from the deterministic ordering.
 *
 * The global → org → volatile transition in the array is the structural cut
 * point that earlier versions encoded as a magic boundary string.
 */

export type CacheHint = 'global' | 'org' | 'volatile'

export type SystemPromptPart = {
  readonly content: string
  readonly cacheHint?: CacheHint
}
