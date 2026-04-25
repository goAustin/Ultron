/**
 * Memory injection into the system prompt (Phase 4d).
 *
 * Reads the on-disk memory store (Phase 4a) and produces a single
 * `SystemPromptPart` with `cacheHint: 'org'` that is inserted between
 * the Ultron preamble (`'global'`) and the volatile date/env tail by
 * `cacheHints.ts`. The wrapper is a `<system-reminder>` block so the
 * model frames it as persistent memory, not chat history.
 *
 * `baseDir` is the **Ultron root** (e.g. `~/.ultron`) — the same value
 * `QueryEngine._memoryBaseDir` holds. The store joins `memory/` onto
 * it internally; do NOT pre-join `memory/` here.
 */

import type { SystemPromptPart } from './systemPromptParts.js'
import { listEntries, readIndex } from '../memory/store.js'
import type { MemoryEntry, MemoryType } from '../memory/entry.js'
import { MEMORY_TYPES } from '../memory/entry.js'
import { CHARS_PER_TOKEN } from './tokenEstimator.js'

const HEADER = [
  '<system-reminder>',
  'Persistent memory entries from earlier sessions. Use them to inform',
  'your responses without waiting for the user to repeat context. These',
  'are authoritative statements of user preferences, project facts, and',
  'references — not ephemeral chat history.',
  '',
].join('\n')

const FOOTER = '</system-reminder>'

/**
 * Build the memory injection block for the system prompt.
 *
 * - Empty store, missing dir, or zero/negative budget → `[]`.
 * - Otherwise, returns exactly one `'org'` part whose content wraps the
 *   regenerated index + all entries (grouped by `MEMORY_TYPES` order,
 *   newest `updatedAt` first within each group) in a `<system-reminder>`.
 * - Trims oldest entries (by `updatedAt`) when over the token budget.
 *   The injected index is regenerated from the trimmed set, so a dropped
 *   entry never appears in the index either.
 */
export async function buildMemoryInjectionParts(
  baseDir: string,
  budgetTokens: number,
): Promise<readonly SystemPromptPart[]> {
  if (budgetTokens <= 0) return []

  const index = await readIndex(baseDir)
  if (index.length === 0) return []

  const all = await listEntries(baseDir)
  if (all.length === 0) return []

  // Trim order: oldest first by updatedAt (drops oldest when budget tight).
  const byAgeAsc = [...all].sort((a, b) => a.updatedAt - b.updatedAt)

  const included = new Set(all.map((e) => e.id))
  let block = renderBlock(filterAndOrder(all, included))

  while (estimateTokens(block) > budgetTokens && included.size > 0) {
    for (const e of byAgeAsc) {
      if (included.has(e.id)) {
        included.delete(e.id)
        break
      }
    }
    if (included.size === 0) return []
    block = renderBlock(filterAndOrder(all, included))
  }

  if (estimateTokens(block) > budgetTokens) return []
  return [{ content: block, cacheHint: 'org' }]
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function filterAndOrder(
  all: readonly MemoryEntry[],
  included: ReadonlySet<string>,
): MemoryEntry[] {
  const typeOrder = new Map<MemoryType, number>(
    MEMORY_TYPES.map((t, i) => [t, i]),
  )
  return [...all]
    .filter((e) => included.has(e.id))
    .sort((a, b) => {
      const ta = typeOrder.get(a.type) ?? 999
      const tb = typeOrder.get(b.type) ?? 999
      if (ta !== tb) return ta - tb
      return b.updatedAt - a.updatedAt
    })
}

function renderBlock(entries: readonly MemoryEntry[]): string {
  const lines: string[] = [HEADER]
  lines.push('Index:')
  for (const e of entries) {
    lines.push(`- [${e.type}] ${e.name} — ${e.description}`)
  }
  lines.push('', '---', '')

  let lastType: MemoryType | null = null
  for (const e of entries) {
    if (e.type !== lastType) {
      lines.push(`## ${e.type}`, '')
      lastType = e.type
    }
    lines.push(`### ${e.name}`, '')
    lines.push(e.description, '')
    lines.push(e.content, '')
  }
  lines.push(FOOTER)
  return lines.join('\n')
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN)
}
