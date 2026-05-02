/**
 * v3 Phase 4·2 — perceptual-hash backstop for `verify.ts`.
 *
 * The Phase 4 verify stack is `ARIA diff (primary) + pHash (backstop)`. ARIA
 * diff catches the common "no DOM change" failure mode; pHash catches
 * canvas/image swaps + other pure-pixel changes the ARIA tree can't see.
 *
 * Implementation: 8×8 average hash (aHash). Decode PNG → grayscale →
 * resize to 8×8 by averaging blocks → compute mean → 64-bit fingerprint
 * where bit i = `(gray[i] > mean ? 1 : 0)`.
 *
 * Why average-hash and not DCT-pHash:
 * - aHash is ~50 LOC of math; DCT-pHash needs a 32×32 DCT and is ~150 LOC.
 * - For our use case (fixed 1024x768 PNG screenshots, lossless source) the
 *   DCT's robustness to JPEG artifacts is wasted.
 * - Hamming-distance threshold of 4 (out of 64) is the empirical default —
 *   tunable via `DEFAULT_PHASH_THRESHOLD`.
 *
 * NOT exported from the package — verify.ts re-exports the surface it needs.
 */

import { decodePng, type DecodedPng } from './pngCodec.js'

/**
 * 64-bit average-hash of a PNG. Encoded as a `bigint` so we can XOR + popcount
 * portably without dragging in a `BigInt` wrapper.
 */
export function aHash8x8(png: Uint8Array): bigint {
  const decoded = decodePng(png)
  return aHash8x8FromDecoded(decoded)
}

export function aHash8x8FromDecoded(decoded: DecodedPng): bigint {
  const { width, height, rgba } = decoded
  // Bin the image into an 8×8 grid; each bin's value is the average grayscale
  // luminance across all source pixels that map into it.
  const sums = new Float64Array(64)
  const counts = new Uint32Array(64)

  for (let y = 0; y < height; y++) {
    // Map source y to bin row 0..7. Floor by integer division.
    const binY = Math.min(7, Math.floor((y * 8) / height))
    for (let x = 0; x < width; x++) {
      const binX = Math.min(7, Math.floor((x * 8) / width))
      const off = (y * width + x) * 4
      const r = rgba[off]!
      const g = rgba[off + 1]!
      const b = rgba[off + 2]!
      // ITU-R BT.601 luminance — close enough for hashing; alpha is ignored.
      const gray = 0.299 * r + 0.587 * g + 0.114 * b
      const idx = binY * 8 + binX
      sums[idx]! += gray
      counts[idx]! += 1
    }
  }

  // Bin averages. Empty bins (only happen when an axis is < 8) get 0; matches
  // the expectation that uniformly-empty bins compare as "below mean."
  const bins = new Float64Array(64)
  let total = 0
  let nonEmpty = 0
  for (let i = 0; i < 64; i++) {
    if (counts[i]! > 0) {
      bins[i] = sums[i]! / counts[i]!
      total += bins[i]!
      nonEmpty++
    }
  }
  const mean = nonEmpty > 0 ? total / nonEmpty : 0

  // Build 64-bit fingerprint: bit i set iff bin i > mean. Use `>` (strict)
  // so a uniform image hashes to all-zero, which is at least stable.
  let hash = 0n
  for (let i = 0; i < 64; i++) {
    if (bins[i]! > mean) {
      hash |= 1n << BigInt(i)
    }
  }
  return hash
}

/** Bit-count of `a XOR b`. The verify-side comparison primitive. */
export function hammingDistance(a: bigint, b: bigint): number {
  let n = a ^ b
  let count = 0
  while (n !== 0n) {
    count += Number(n & 1n)
    n >>= 1n
  }
  return count
}

/**
 * Default Hamming threshold for "different enough to be considered changed."
 * The Phase 4·2 design's Open Question 6 calls this out explicitly — tune
 * during Phase 6 evals if false-negatives appear.
 */
export const DEFAULT_PHASH_THRESHOLD = 4
