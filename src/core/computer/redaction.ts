/**
 * v3 Phase 4·2 — screenshot redaction.
 *
 * Two halves:
 * - The `SENSITIVE_SELECTORS` list — CSS selectors for fields whose pixels
 *   should be blacked out before the screenshot reaches the model. The list
 *   mirrors `ariaSnapshot.isSensitiveNode` so detection logic stays
 *   consistent across the ARIA classifier and the pixel redactor.
 * - `blackoutRegions(pngBuffer, bboxes)` — pure PNG transform. Decode →
 *   fill bboxes with black → re-encode. No DOM access; the BrowserSession
 *   captures bboxes via `page.locator(...).boundingBox()` and hands them in.
 *
 * Why blackout AFTER capture, not CSS overlay BEFORE:
 * - CSS overlays mutate the page Playwright observes — race-prone with
 *   page mutation.
 * - Post-capture redaction is deterministic and lives entirely in our
 *   pixel layer.
 * - Cost: ~2-4ms per screenshot for the decode/encode round-trip on a
 *   1024×768 image (acceptable per design).
 */

import { decodePng, encodePng } from './pngCodec.js'
import type { BoundingBox } from './ariaSnapshot.js'

/**
 * CSS selectors for fields whose pixels are sensitive. Mirrors the
 * `isSensitiveNode` predicate in `ariaSnapshot.ts` — keep these two
 * detection lists in sync.
 *
 * We expand `autocomplete~="..."` because Playwright's CSS engine matches
 * tokens — the same way browsers match the `autocomplete` token list.
 */
export const SENSITIVE_SELECTORS: readonly string[] = [
  'input[type="password"]',
  'input[type="tel"]',
  'input[autocomplete~="current-password" i]',
  'input[autocomplete~="new-password" i]',
  'input[autocomplete~="one-time-code" i]',
  'input[autocomplete~="cc-number" i]',
  'input[autocomplete~="cc-csc" i]',
  'input[autocomplete~="cc-exp" i]',
  'input[autocomplete~="cc-exp-month" i]',
  'input[autocomplete~="cc-exp-year" i]',
  'input[name*="ssn" i]',
  'input[name*="social-security" i]',
  'input[name*="social_security" i]',
  'input[name*="tax-id" i]',
  'input[name*="tax_id" i]',
  'input[name*="taxid" i]',
  'input[name*="national-id" i]',
  'input[name*="national_id" i]',
]

/**
 * Build the effective CSS selector list for a session: the built-ins above
 * plus any user-configured extras from `computerUseSettings.redactionSelectors`.
 *
 * Empty/whitespace-only extras are skipped. Order is preserved so duplicates
 * don't matter for `page.locator(',').all()` semantics.
 */
export function buildSelectorList(extras: readonly string[]): readonly string[] {
  const out: string[] = [...SENSITIVE_SELECTORS]
  for (const e of extras) {
    if (typeof e === 'string' && e.trim().length > 0) {
      out.push(e.trim())
    }
  }
  return out
}

/**
 * Apply blackout rectangles to a PNG. Returns a fresh PNG with the same
 * dimensions; pixels inside any bbox are replaced with opaque black.
 *
 * Bboxes are clipped to the image bounds — out-of-bounds bboxes (e.g., from
 * a viewport-resize race) don't crash. An empty bbox list still incurs the
 * decode + encode cost; callers should short-circuit with the original
 * buffer when no regions are present.
 */
export function blackoutRegions(
  pngBuffer: Uint8Array,
  bboxes: readonly BoundingBox[],
): Uint8Array {
  const decoded = decodePng(pngBuffer)
  const { width, height } = decoded
  // Copy so we don't mutate the input.
  const rgba = new Uint8Array(decoded.rgba)

  for (const bbox of bboxes) {
    const x0 = clampInt(Math.floor(bbox.x), 0, width)
    const y0 = clampInt(Math.floor(bbox.y), 0, height)
    const x1 = clampInt(Math.ceil(bbox.x + bbox.width), 0, width)
    const y1 = clampInt(Math.ceil(bbox.y + bbox.height), 0, height)
    if (x1 <= x0 || y1 <= y0) continue

    for (let y = y0; y < y1; y++) {
      const rowStart = y * width * 4
      for (let x = x0; x < x1; x++) {
        const off = rowStart + x * 4
        rgba[off] = 0
        rgba[off + 1] = 0
        rgba[off + 2] = 0
        rgba[off + 3] = 255
      }
    }
  }

  return encodePng(width, height, rgba)
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}
