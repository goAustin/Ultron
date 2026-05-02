/**
 * v3 Phase 2: pure coordinate math for Computer-Use.
 *
 * NormalizedPoint is the canonical model/tool-boundary representation in `[0, 1]`.
 * Native provider bridges convert pixel coords against `displaySize` into
 * NormalizedPoint at the bridge layer (the inbound half of the bridge translation
 * contract — see docs/ultron_v3/v3-computer-use-plan.md:413-431). The runtime
 * converts NormalizedPoint into CSS pixels inside `viewport` for `page.mouse`.
 *
 * Out-of-range and non-finite inputs are REJECTED, not clamped. Clamping silently
 * absorbs model bugs (e.g., a coord emitted for the wrong viewport) into "click
 * the edge"; rejection surfaces them.
 *
 * No Playwright import here — this module must stay pure so it can be unit-tested
 * without a browser dependency.
 */

import type {
  ComputerDisplaySize,
  ComputerViewport,
  NormalizedPoint,
} from './types.js'

export type NormalizedPointError = {
  readonly ok: false
  readonly reason:
    | 'not_an_object'
    | 'missing_field'
    | 'wrong_type'
    | 'not_finite'
    | 'out_of_range'
  readonly message: string
}

export type NormalizedPointResult =
  | { readonly ok: true; readonly point: NormalizedPoint }
  | NormalizedPointError

/**
 * Validate an unknown value as a NormalizedPoint.
 * Rejects (no clamping):
 * - non-objects
 * - missing or wrong-type x/y fields
 * - NaN, +/-Infinity
 * - x or y outside [0, 1] (0 and 1 are inclusive)
 */
export function validateNormalizedPoint(p: unknown): NormalizedPointResult {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    return {
      ok: false,
      reason: 'not_an_object',
      message: 'NormalizedPoint must be an object with x and y',
    }
  }
  const obj = p as Record<string, unknown>
  if (!('x' in obj) || !('y' in obj)) {
    return {
      ok: false,
      reason: 'missing_field',
      message: 'NormalizedPoint must have x and y fields',
    }
  }
  if (typeof obj.x !== 'number' || typeof obj.y !== 'number') {
    return {
      ok: false,
      reason: 'wrong_type',
      message: 'NormalizedPoint x and y must be numbers',
    }
  }
  if (!Number.isFinite(obj.x) || !Number.isFinite(obj.y)) {
    return {
      ok: false,
      reason: 'not_finite',
      message: 'NormalizedPoint x and y must be finite (no NaN/Infinity)',
    }
  }
  if (obj.x < 0 || obj.x > 1 || obj.y < 0 || obj.y > 1) {
    return {
      ok: false,
      reason: 'out_of_range',
      message: `NormalizedPoint x and y must be in [0, 1]; got x=${obj.x}, y=${obj.y}`,
    }
  }
  return { ok: true, point: { x: obj.x, y: obj.y } }
}

/**
 * Convert NormalizedPoint -> CSS pixel coordinates inside `viewport`.
 *
 * Mapping: cssX = round(x * (viewport.width  - 1))
 *          cssY = round(y * (viewport.height - 1))
 *
 * CSS pixels in a width-W viewport are indexed 0..W-1. x=0 maps to 0
 * (left edge); x=1 maps to W-1 (last in-bounds pixel). This guarantees
 * `page.mouse.click(cssX, cssY)` is always in-bounds — no off-by-one click
 * outside the viewport when the model emits 1.0.
 *
 * DSF (`viewport.deviceScaleFactor`) is intentionally NOT multiplied in:
 * Playwright's `page.mouse` API takes CSS pixels, not device pixels.
 *
 * Caller must validate `point` first (e.g., via validateNormalizedPoint).
 */
export function normalizedToCssPx(
  point: NormalizedPoint,
  viewport: ComputerViewport,
): { x: number; y: number } {
  return {
    x: Math.round(point.x * (viewport.width - 1)),
    y: Math.round(point.y * (viewport.height - 1)),
  }
}

/**
 * Convert pixel coordinates emitted by a native provider (against `displaySize`)
 * -> NormalizedPoint. Inverse of normalizedToCssPx, parameterized by displaySize.
 *
 * Mapping: normX = px.x / (displaySize.width  - 1)
 *          normY = px.y / (displaySize.height - 1)
 *
 * This is the "bridge inbound" half of the bridge translation contract
 * (docs/ultron_v3/v3-computer-use-plan.md:413-431). Phase 2 ships it now so the
 * Stretch Phase native bridges and Phase 3 tools' coordinate validators share
 * the same primitive.
 *
 * Pixel inputs outside [0, displaySize.{width,height} - 1] are REJECTED, not
 * clamped — a model that emits an out-of-bounds pixel coord is a bug worth
 * surfacing.
 */
export function pixelToNormalized(
  point: { x: number; y: number },
  displaySize: ComputerDisplaySize,
): NormalizedPointResult {
  if (typeof point.x !== 'number' || typeof point.y !== 'number') {
    return {
      ok: false,
      reason: 'wrong_type',
      message: 'pixel point x and y must be numbers',
    }
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return {
      ok: false,
      reason: 'not_finite',
      message: 'pixel point x and y must be finite (no NaN/Infinity)',
    }
  }
  // A 1-pixel display would make maxX/maxY zero and divide-by-zero would yield
  // NaN even for the only "valid" input (0, 0). Require at least 2x2 so the
  // [0..maxX] range is non-degenerate and division is well-defined. Settings
  // accept dimensions as low as 1 (computerUseSettings.ts validateDimensions)
  // so this guard is the load-bearing one for that edge case.
  if (displaySize.width < 2 || displaySize.height < 2) {
    return {
      ok: false,
      reason: 'out_of_range',
      message: `displaySize too small for normalization; got ${displaySize.width}x${displaySize.height}, need at least 2x2`,
    }
  }
  const maxX = displaySize.width - 1
  const maxY = displaySize.height - 1
  if (point.x < 0 || point.x > maxX || point.y < 0 || point.y > maxY) {
    return {
      ok: false,
      reason: 'out_of_range',
      message: `pixel point out of range; got (${point.x}, ${point.y}), expected (0..${maxX}, 0..${maxY})`,
    }
  }
  return {
    ok: true,
    point: { x: point.x / maxX, y: point.y / maxY },
  }
}
