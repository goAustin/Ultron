/**
 * v3 Phase 4b: pure atom-catalog primitives for the DOM-first action path.
 *
 * `assignAtomIds(snapshot)` walks the raw `AriaTreeSnapshot` in DFS order,
 * picks `ACTIONABLE_ROLES` nodes, and emits one `AtomEntry` per match. The
 * model gets `displayName` (redacted by `isSensitiveNode` and by user
 * `redactionSelectors` via the optional `sensitiveRegions` predicate);
 * Playwright gets `locatorName` (raw accessible name) so `getByRole({name})`
 * actually resolves.
 *
 * `bboxesMatch` powers the post-resolution drift check inside
 * `BrowserSession.actOnAtom` — it converts the silent-retarget class
 * ("safety check classified node A; .nth() ran on node B after a
 * duplicate-name shuffle") into a clean `'atom_locator_failed'` the model
 * can recover from.
 *
 * No Playwright import, no I/O. Unit-tested under Node against fixture
 * `AriaTreeSnapshot` values.
 *
 * See `docs/ultron_v3/v3-phase4b-design.md`.
 */

import type { AriaNode, AriaTreeSnapshot, BoundingBox } from './ariaSnapshot.js'
import { isSensitiveNode } from './ariaSnapshot.js'

/**
 * Subset of `INTERESTING_ROLES` that are actually click/fill/select/toggle
 * targets. `INTERESTING_ROLES` (`ariaSnapshot.ts:79-103`) is broader — it
 * includes `heading`, `landmark`, `list`, `img`, etc., useful for observation
 * + risk classification but noisy as atom-catalog entries.
 *
 * `treeitem` is included because tree widgets are commonly clickable; `tab`
 * and `option` cover ARIA tablist and listbox patterns. `menuitemcheckbox`
 * and `menuitemradio` are the two ARIA-only menu variants.
 */
export const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'treeitem',
])

/**
 * Tolerance for the post-resolution bbox-drift check. ±8 CSS pixels covers
 * normal reflow (font-metric variance, sticky-bar shift, hover-state padding)
 * without admitting a different element with a different layout position.
 */
export const BBOX_TOLERANCE_PX = 8

const REDACTED = '[REDACTED]'

export type AtomEntry = {
  /** `'a-' + dfsIndex` — stable for the lifetime of the snapshot. */
  readonly atomId: string
  readonly role: string
  /** REDACTED — the only name field `serializeAtoms` emits to the model. */
  readonly displayName: string | null
  /** RAW accessible name — passed to Playwright `getByRole({name})`. NEVER serialized. */
  readonly locatorName: string | null
  /** Optional disambiguation hint, e.g. `'form: Sign in'`. Already redacted. */
  readonly hint?: string
  /** Cached bbox at observation; used for the drift check inside `actOnAtom`. */
  readonly bbox?: BoundingBox
  /** Raw node — for the safety check (carries raw name + sensitive signals). */
  readonly node: AriaNode
  /** Diagnostics — chain of `'<role>:"<name>"'` strings from `<body>` down. Raw, not redacted. */
  readonly ancestorPath: readonly string[]
  /** Disambiguates duplicate `(role, locatorName)` pairs — index of this match within the same key. */
  readonly nth: number
}

export type AtomLocator = {
  readonly role: string
  readonly locatorName: string | null
  readonly nth: number
  /** Cached bbox; the implementation rejects post-resolution drift past `BBOX_TOLERANCE_PX`. */
  readonly expectedBbox: BoundingBox | null
}

export type AtomAction =
  | { readonly type: 'click'; readonly button?: 'left' | 'middle' | 'right'; readonly double?: boolean }
  | { readonly type: 'fill'; readonly text: string; readonly sensitive?: boolean }
  | { readonly type: 'select'; readonly value: string }

export type AssignAtomsOptions = {
  /**
   * Bboxes returned by `BrowserSession.getSensitiveRegions(redactionSelectors)`.
   * Any node whose bbox intersects ANY of these regions gets `displayName: REDACTED`,
   * even if `isSensitiveNode` returns false. Lets user `redactionSelectors` flow
   * into the atom catalog the same way they flow into the screenshot redactor.
   */
  readonly sensitiveRegions?: readonly BoundingBox[]
}

/**
 * Walk the raw tree, pick `ACTIONABLE_ROLES` nodes in DFS order, return one
 * `AtomEntry` per match. `nth` disambiguates duplicate `(role, locatorName)`
 * pairs.
 *
 * `displayName` is redacted when `isSensitiveNode(node)` matches OR when
 * `node.bbox` intersects any of `opts.sensitiveRegions`. Nodes with `bbox === null`
 * that would otherwise be region-eligible (i.e., user supplied any
 * `sensitiveRegions`) get redacted fail-closed — we can't intersection-check
 * an unmappable node, so we assume the worst.
 */
export function assignAtomIds(
  snapshot: AriaTreeSnapshot,
  opts?: AssignAtomsOptions,
): readonly AtomEntry[] {
  const sensitiveRegions = opts?.sensitiveRegions ?? []
  const hasUserRegions = sensitiveRegions.length > 0
  const entries: AtomEntry[] = []
  const nthCounter = new Map<string, number>()

  function visit(
    node: AriaNode,
    ancestorPath: readonly string[],
    hintCandidate: AriaNode | null,
  ): void {
    const isActionable = ACTIONABLE_ROLES.has(node.role)
    if (isActionable) {
      const locatorName = node.name
      const key = `${node.role}\u0000${locatorName ?? ''}`
      const nth = nthCounter.get(key) ?? 0
      nthCounter.set(key, nth + 1)

      const sensitiveByNode = isSensitiveNode(node)
      const sensitiveByRegion =
        node.bbox === null ? hasUserRegions : intersectsAny(node.bbox, sensitiveRegions)
      const redacted = sensitiveByNode || sensitiveByRegion
      const displayName = redacted ? REDACTED : node.name

      // Phase 4b — hint comes from the nearest named non-`generic` non-`group`
      // ancestor we've passed through. The ancestor itself is checked against
      // the SAME combined predicate as `displayName` (HTML-semantic sensitive
      // OR intersects a user `sensitiveRegion`); if it qualifies we omit the
      // hint rather than emit `[REDACTED]` as the source. Omission is the
      // safer default because emitting `hint: "form: [REDACTED]"` still
      // signals that a sensitive container exists.
      const hint = computeHint(hintCandidate, sensitiveRegions, hasUserRegions)

      const entry: AtomEntry = {
        atomId: `a-${entries.length}`,
        role: node.role,
        displayName,
        locatorName,
        ...(hint !== undefined ? { hint } : {}),
        ...(node.bbox !== null ? { bbox: node.bbox } : {}),
        node,
        ancestorPath,
        nth,
      }
      entries.push(entry)
    }

    if (node.children.length === 0) return
    const nextPath = pushAncestorPath(ancestorPath, node)
    const nextHint = isHintCandidate(node) ? node : hintCandidate
    for (const child of node.children) {
      visit(child, nextPath, nextHint)
    }
  }

  visit(snapshot.tree, [], null)
  return entries
}

/**
 * Build an `AtomLocator` from a cached entry. `expectedBbox` is null when the
 * entry didn't carry one (rare for visible interactive elements but possible
 * for off-screen / `display:none`-toggled nodes); the impl falls back to
 * count-only resolution in that case.
 */
export function buildLocator(entry: AtomEntry): AtomLocator {
  return {
    role: entry.role,
    locatorName: entry.locatorName,
    nth: entry.nth,
    expectedBbox: entry.bbox ?? null,
  }
}

/**
 * YAML-style serialization for the model. Emits `displayName` (the redacted
 * name) and never `locatorName`. `node`, `ancestorPath`, `nth`, and `bbox`
 * are diagnostic / locator-internal — also omitted.
 */
export function serializeAtoms(entries: readonly AtomEntry[]): string {
  if (entries.length === 0) return '(no actionable atoms on this page)'
  const lines: string[] = []
  for (const e of entries) {
    lines.push(`- id: ${e.atomId}`)
    lines.push(`  role: ${e.role}`)
    if (e.displayName === null) {
      lines.push(`  name: null`)
    } else {
      lines.push(`  name: "${escapeYamlString(e.displayName)}"`)
    }
    if (e.hint !== undefined) {
      lines.push(`  hint: "${escapeYamlString(e.hint)}"`)
    }
  }
  return lines.join('\n')
}

/**
 * Tolerance check for the post-resolution drift gate inside `actOnAtom`.
 * Returns true iff every (x, y, width, height) component of `a` is within
 * `tolerancePx` of the corresponding component of `b`.
 */
export function bboxesMatch(a: BoundingBox, b: BoundingBox, tolerancePx: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerancePx &&
    Math.abs(a.y - b.y) <= tolerancePx &&
    Math.abs(a.width - b.width) <= tolerancePx &&
    Math.abs(a.height - b.height) <= tolerancePx
  )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function intersectsAny(box: BoundingBox, regions: readonly BoundingBox[]): boolean {
  for (const r of regions) {
    if (rectsIntersect(box, r)) return true
  }
  return false
}

function rectsIntersect(a: BoundingBox, b: BoundingBox): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  if (a.x + a.width <= b.x) return false
  if (b.x + b.width <= a.x) return false
  if (a.y + a.height <= b.y) return false
  if (b.y + b.height <= a.y) return false
  return true
}

function pushAncestorPath(path: readonly string[], node: AriaNode): readonly string[] {
  // Skip generic / group wrappers — they're synthetic flatten artifacts and
  // would clutter the diagnostics path without aiding identification.
  if (node.role === 'generic' || node.role === 'group') return path
  if (node.name === null || node.name.length === 0) {
    return [...path, node.role]
  }
  return [...path, `${node.role}:"${node.name}"`]
}

/**
 * Predicate matching `pushAncestorPath`'s "promoted into the path" rule:
 * named, non-`generic`, non-`group`. Drives both the `ancestorPath`
 * diagnostics and the `hintCandidate` carried through `assignAtomIds`'s
 * recursion.
 */
function isHintCandidate(node: AriaNode): boolean {
  if (node.role === 'generic' || node.role === 'group') return false
  return node.name !== null && node.name.length > 0
}

/**
 * Compute the model-visible hint for an atom. The source `ancestor` is the
 * nearest enclosing named non-generic node (passed through the recursion as
 * `hintCandidate`). The combined sensitive predicate matches `displayName`'s:
 * HTML-semantic sensitive OR the ancestor's bbox intersects a user
 * `sensitiveRegion` OR the ancestor lacks a bbox while the user supplied any
 * region (fail-closed for unmappable ancestors).
 *
 * When the ancestor is sensitive we OMIT the hint entirely. Emitting
 * `hint: "form: [REDACTED]"` would still leak that a sensitive form
 * container exists at the atom's location; omission is strictly safer.
 */
function computeHint(
  ancestor: AriaNode | null,
  sensitiveRegions: readonly BoundingBox[],
  hasUserRegions: boolean,
): string | undefined {
  if (ancestor === null || ancestor.name === null) return undefined
  const sensitiveByNode = isSensitiveNode(ancestor)
  const sensitiveByRegion =
    ancestor.bbox === null
      ? hasUserRegions
      : intersectsAny(ancestor.bbox, sensitiveRegions)
  if (sensitiveByNode || sensitiveByRegion) return undefined
  return `${ancestor.role}: ${ancestor.name}`
}

function escapeYamlString(s: string): string {
  // Minimal escaping for the double-quoted YAML scalar form: backslash + quote.
  // Newlines in accessible names are rare; if they appear, replace with space
  // to keep one entry per line.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, ' ')
}
