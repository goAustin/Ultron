/**
 * Redaction helpers for the audit spine.
 *
 * Walks an arbitrary value and replaces any detected-secret substrings with
 * `[REDACTED:<kind>]`. Used at the audit-write boundary only; the in-memory
 * QueryEvent stream keeps raw data so future 2b hooks can inspect it.
 */

import { detectSecrets, type SecretMatch } from './secretScanner.js'

const MAX_DEPTH = 16

export function redactString(s: string): string {
  const matches = detectSecrets(s)
  if (matches.length === 0) return s

  // Walk in reverse index order so earlier indices stay valid during replacement.
  const sorted = [...matches].sort((a, b) => b.index - a.index)

  let out = s
  for (const m of sorted) {
    out = out.slice(0, m.index) + `[REDACTED:${m.type}]` + out.slice(m.index + m.length)
  }
  return out
}

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[REDACTED:depth]'

  if (typeof value === 'string') return redactString(value)

  if (Array.isArray(value)) {
    return value.map(v => redactSecrets(v, depth + 1))
  }

  if (value && typeof value === 'object') {
    // Plain objects and class instances both get walked; we preserve Error shape below.
    if (value instanceof Error) {
      return { name: value.name, message: redactString(value.message) }
    }

    if (value.constructor === Object || value.constructor === undefined) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        out[k] = redactSecrets(v, depth + 1)
      }
      return out
    }

    // Non-plain object (Buffer, Date, etc.) — stringify and scan once.
    try {
      return redactString(String(value))
    } catch {
      return '[REDACTED:unserializable]'
    }
  }

  return value
}

export type { SecretMatch }
