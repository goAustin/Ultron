/**
 * v3 Phase 1: pre-audit filter that strips raw base64 image bytes from any
 * value before it lands in the audit JSONL.
 *
 * Walks an arbitrary value tree (mirroring `redactSecrets`) and replaces
 * image-shaped nodes — `{ type: 'image', mediaType, data: <base64>, ... }` —
 * with metadata-only summaries: `{ type: 'image', mediaType, byteSize,
 * width?, height?, redacted: true }`.
 *
 * Runs **before** `redactSecrets` in `auditLog.serialize()` so that the
 * resulting (now-textual) metadata still flows through secret detection.
 *
 * Phase 1 deliberately does NOT compute a hash here — Phase 4 owns
 * redaction-aware hashing alongside selector-based redaction. Byte size
 * and dimensions are sufficient for Phase 1's audit envelope.
 */

const MAX_DEPTH = 16

type ImageLike = {
  type: 'image'
  mediaType?: unknown
  data?: unknown
  width?: unknown
  height?: unknown
}

function isImageLike(v: unknown): v is ImageLike {
  return (
    v !== null
    && typeof v === 'object'
    && (v as { type?: unknown }).type === 'image'
    && typeof (v as { data?: unknown }).data === 'string'
  )
}

function summarizeImage(v: ImageLike): Record<string, unknown> {
  const data = v.data as string
  const byteSize = Buffer.byteLength(data, 'base64')
  const out: Record<string, unknown> = {
    type: 'image',
    byteSize,
    redacted: true,
  }
  if (typeof v.mediaType === 'string') out.mediaType = v.mediaType
  if (typeof v.width === 'number') out.width = v.width
  if (typeof v.height === 'number') out.height = v.height
  return out
}

export function redactImageData(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value

  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value

  if (Array.isArray(value)) {
    return value.map(v => redactImageData(v, depth + 1))
  }

  // Preserve Error shape — secret-redactor does the same.
  if (value instanceof Error) return value

  // Non-plain objects (Buffer, Date) — leave as-is; redactSecrets will
  // stringify them downstream.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value

  if (isImageLike(value)) return summarizeImage(value)

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = redactImageData(v, depth + 1)
  }
  return out
}
