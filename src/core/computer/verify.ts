/**
 * v3 Phase 4·2 — post-action verification.
 *
 * `verify({ before, after })` returns a verdict + per-signal evidence so
 * action tools can append a WARNING to the result text when neither signal
 * detected change. The action still ships its screenshot — verification is
 * informational, never blocking.
 *
 * Signals:
 * - **ARIA hash** (primary). Compares before/after `ariaSnapshot.hash`. Catches
 *   the common "no DOM mutation" failure mode (overlay-blocked clicks,
 *   button without click handler, etc.).
 * - **pHash** (backstop). 8×8 average-hash hamming-distance over the screenshot
 *   pixels. Catches canvas/image swaps + other pure-visual changes the ARIA
 *   tree can't surface.
 *
 * Either signal can degrade to "unavailable" when the input is null/missing
 * (e.g., capture failed). An unavailable signal contributes neither a
 * positive nor negative vote — only the available signals decide the verdict.
 *
 * Verdict logic:
 * - `verified = true` iff at least one available signal reports `changed`.
 * - `verified = false` iff every available signal reports `unchanged`.
 * - When NO signal is available, `verified = false` (conservative default —
 *   the model gets the WARNING and re-observes).
 */

import {
  aHash8x8,
  DEFAULT_PHASH_THRESHOLD,
  hammingDistance,
} from './pHash.js'

export type VerifySignalAvailability = 'available' | 'unavailable'

export type VerifySignal = {
  readonly availability: VerifySignalAvailability
  readonly changed: boolean
  readonly evidence: string
}

export type VerifyResult = {
  readonly verified: boolean
  readonly signals: {
    readonly aria: VerifySignal
    readonly pHash: VerifySignal
  }
}

export type VerifyInput = {
  readonly ariaHash: string | null
  readonly pngBuffer: Uint8Array | null
}

export type VerifyOpts = {
  /**
   * Hamming-distance threshold for "different enough." Defaults to
   * `DEFAULT_PHASH_THRESHOLD` (4). Tunable via Phase 6 evals.
   */
  readonly pHashThreshold?: number
}

export function verify(
  before: VerifyInput,
  after: VerifyInput,
  opts: VerifyOpts = {},
): VerifyResult {
  const aria = compareAria(before.ariaHash, after.ariaHash)
  const pHash = comparePHash(before.pngBuffer, after.pngBuffer, opts.pHashThreshold ?? DEFAULT_PHASH_THRESHOLD)
  const verified =
    (aria.availability === 'available' && aria.changed) ||
    (pHash.availability === 'available' && pHash.changed)
  return { verified, signals: { aria, pHash } }
}

function compareAria(before: string | null, after: string | null): VerifySignal {
  if (before === null || after === null) {
    return {
      availability: 'unavailable',
      changed: false,
      evidence: 'aria hash missing on at least one side',
    }
  }
  if (before === after) {
    return {
      availability: 'available',
      changed: false,
      evidence: `aria hash unchanged (${before})`,
    }
  }
  return {
    availability: 'available',
    changed: true,
    evidence: `aria hash changed (${before} → ${after})`,
  }
}

function comparePHash(
  before: Uint8Array | null,
  after: Uint8Array | null,
  threshold: number,
): VerifySignal {
  if (before === null || after === null) {
    return {
      availability: 'unavailable',
      changed: false,
      evidence: 'png buffer missing on at least one side',
    }
  }
  let beforeHash: bigint
  let afterHash: bigint
  try {
    beforeHash = aHash8x8(before)
    afterHash = aHash8x8(after)
  } catch (err) {
    return {
      availability: 'unavailable',
      changed: false,
      evidence: `pHash failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const dist = hammingDistance(beforeHash, afterHash)
  return {
    availability: 'available',
    changed: dist >= threshold,
    evidence: `pHash hamming distance ${dist} (threshold ${threshold})`,
  }
}
