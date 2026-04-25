/**
 * Memory content safety check — scans MemoryWrite/MemoryEdit inputs for
 * secret patterns and routes the decision through the permission cascade.
 *
 * Pairs with the defense-in-depth check inside `writeEntry` in store.ts:
 * the safety check is policy (deny/ask at the cascade); the store layer
 * is enforcement (throws on high-confidence matches unconditionally).
 *
 * Two-tier response, matching `secretContentSafetyCheck`:
 * - High-confidence match → deny
 * - Low-confidence only → ask (user confirms via permissionOpts.askUser)
 */

import type { SafetyCheck } from '../core/permissions/types.js'
import { detectSecrets } from './secretScanner.js'
import {
  MEMORY_TYPES,
  serializeEntry,
  validateId,
  type MemoryEntry,
  type MemoryType,
} from './entry.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const memorySecretSafetyCheck: SafetyCheck = (tool, input, _context) => {
  if (tool.name !== 'MemoryWrite' && tool.name !== 'MemoryEdit') return null

  const preview = buildPreviewForScan(tool.name, input)
  if (preview === null) return null

  const matches = detectSecrets(preview)
  if (matches.length === 0) return null

  const hasHighConfidence = matches.some((m) => m.confidence === 'high')
  const types = [...new Set(matches.map((m) => m.type))].join(', ')

  return {
    behavior: hasHighConfidence ? 'deny' : 'ask',
    reason: {
      type: 'safetyCheck',
      message: `Memory entry contains potential secrets: ${types}`,
    },
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPreviewForScan(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName === 'MemoryWrite') {
    const id = input.id
    const type = input.type
    const name = input.name
    const description = input.description
    const content = input.content

    if (
      typeof id !== 'string' ||
      typeof type !== 'string' ||
      typeof name !== 'string' ||
      typeof description !== 'string' ||
      typeof content !== 'string'
    ) {
      return null
    }

    if (!validateId(id)) return null
    if (!(MEMORY_TYPES as readonly string[]).includes(type)) return null

    const entry: MemoryEntry = {
      schemaVersion: 1,
      id,
      type: type as MemoryType,
      name,
      description,
      content,
      createdAt: 0,
      updatedAt: 0,
    }

    try {
      return serializeEntry(entry)
    } catch {
      return null
    }
  }

  // MemoryEdit: scan whichever text fields are present. We can't merge the
  // edit against the prior body here (safety checks are synchronous; no
  // I/O). The partial scan mirrors contentSafety's FileEdit fallback.
  const parts: string[] = []
  for (const key of ['name', 'description', 'content', 'new_string']) {
    const v = input[key]
    if (typeof v === 'string') parts.push(v)
  }
  return parts.length > 0 ? parts.join('\n') : null
}
