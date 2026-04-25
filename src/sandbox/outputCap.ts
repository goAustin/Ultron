/**
 * Head-preserving byte cap for sandbox stdout/stderr capture.
 *
 * Two layers:
 *   - `ByteBudget` — a shared remaining-bytes counter. One budget across
 *     stdout AND stderr means the 64 KB cap is a TOTAL ceiling, not a
 *     per-stream ceiling.
 *   - `CappedAppender` — wraps a budget and accumulates UTF-8 bytes.
 *
 * `createHeadCap(maxBytes)` is sugar for one budget + one appender, kept
 * for callers that don't need to share.
 *
 * UTF-8 safety: when a slice would land mid-sequence, we walk back to the
 * lead byte and cut before it. Without this, `Buffer.toString('utf8')`
 * decodes the partial sequence as U+FFFD (3 bytes), which can push the
 * resulting string past the byte cap.
 */

export interface ByteBudget {
  remaining: number
  truncated: boolean
}

export function createByteBudget(maxBytes: number): ByteBudget {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error(`maxBytes must be a non-negative number, got ${maxBytes}`)
  }
  return { remaining: maxBytes, truncated: false }
}

export interface CappedAppender {
  append(s: string): void
  value(): string
}

export function createCappedAppender(budget: ByteBudget): CappedAppender {
  const chunks: Buffer[] = []
  return {
    append(s: string): void {
      if (s.length === 0) return
      if (budget.remaining <= 0) {
        budget.truncated = true
        return
      }
      const buf = Buffer.from(s, 'utf8')
      if (buf.length <= budget.remaining) {
        chunks.push(buf)
        budget.remaining -= buf.length
      } else {
        const cut = utf8SafeBoundary(buf, budget.remaining)
        if (cut > 0) chunks.push(buf.subarray(0, cut))
        budget.remaining = 0
        budget.truncated = true
      }
    },
    value(): string {
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

/**
 * Find the largest byte position ≤ max where `buf[0..n]` decodes as a
 * complete UTF-8 string (no trailing partial multi-byte sequence).
 */
export function utf8SafeBoundary(buf: Buffer, max: number): number {
  if (max <= 0) return 0
  if (max >= buf.length) return buf.length
  // If the byte AT `max` is not a continuation byte, the slice ends cleanly
  // before a fresh character. Cut at `max`.
  if ((buf[max]! & 0xc0) !== 0x80) return max
  // Otherwise we'd cut mid-sequence. Walk back to the lead byte and drop it
  // entirely so the sequence isn't truncated.
  let i = max - 1
  while (i > 0 && (buf[i]! & 0xc0) === 0x80) i--
  return i
}

// Backwards-compatible single-stream cap used by callers that don't need
// a shared budget.
export interface HeadCap extends CappedAppender {
  readonly truncated: boolean
}

export function createHeadCap(maxBytes: number): HeadCap {
  const budget = createByteBudget(maxBytes)
  const appender = createCappedAppender(budget)
  return {
    append: appender.append,
    value: appender.value,
    get truncated() {
      return budget.truncated
    },
  }
}
