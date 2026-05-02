/**
 * v3 Phase 4·1: structured ARIA snapshots for risk classification, verification,
 * and Phase 4b's atom path.
 *
 * Capture flow:
 *   1. Run `extractAriaTreeInBrowser` inside `page.evaluate(...)` to walk the DOM
 *      and produce a normalized `AriaNode` tree.
 *   2. The caller (PlaywrightBrowserSession) wraps that tree in an
 *      `AriaTreeSnapshot` with a YAML serialization and a stable hash.
 *
 * The `AriaNode` shape is intentionally narrow:
 * - `role` / `name` drive the dangerous-label classifier (`policy.classifyAction`).
 * - `bbox` (CSS pixels in the page viewport) drives `findAtPoint(tree, point)`.
 * - `disabled` / `focused` are kept because the classifier eventually treats
 *   disabled controls as level-0 (no real action).
 *
 * The serialized YAML is for model display (Phase 5) and is hashed for
 * verify.ts diffing in Batch 4·2. Hashing the YAML rather than the tree gives
 * us a stable, human-readable diff key.
 */

import { createHash } from 'node:crypto'

import type { ComputerViewport, NormalizedPoint } from './types.js'

export type BoundingBox = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type AriaNode = {
  readonly role: string
  readonly name: string | null
  readonly bbox: BoundingBox | null
  readonly focused: boolean
  readonly disabled: boolean
  /**
   * `<input>`'s `type` attribute — `password`, `tel`, `text`, `email`, etc.
   * Surfaced for the safety check's sensitive-field detector. `select` /
   * `textarea` get synthetic values for symmetry.
   */
  readonly fieldType?: string
  /**
   * `<input>`'s `autocomplete` attribute, normalized to lowercase. Browsers
   * carry the semantic intent for sensitive fields here (e.g.,
   * `current-password`, `one-time-code`, `cc-number`, `cc-csc`) even when
   * `type="text"`. The safety check matches against this for fields whose
   * `fieldType` alone doesn't indicate sensitivity.
   */
  readonly autocomplete?: string
  /**
   * `<input>`'s `name` attribute, lowercased. Used to catch ssn-style
   * patterns (`ssn`, `social-security-number`, `taxid`, etc.) that browsers
   * don't surface a dedicated autocomplete token for.
   */
  readonly fieldName?: string
  readonly children: readonly AriaNode[]
}

export type AriaTreeSnapshot = {
  readonly tree: AriaNode
  readonly yaml: string
  readonly hash: string
}

// ---------------------------------------------------------------------------
// In-browser DOM walker
//
// This function is `.toString()`-ed and passed to `page.evaluate()` from
// `playwrightBrowserSession.ariaSnapshot()`. It must be a self-contained
// function — no closure references, no imports.
//
// Exported as a value (not a string) so unit tests can run it under JSDOM
// without going through Playwright.
// ---------------------------------------------------------------------------

const INTERESTING_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'option',
  'heading',
  'banner',
  'navigation',
  'main',
  'contentinfo',
  'form',
  'dialog',
  'alertdialog',
  'alert',
  'img',
  'list',
  'listitem',
])

export function extractAriaTreeInBrowser(): AriaNode {
  // Implicit-role lookup keyed by tag name. Not exhaustive — only covers
  // landmarks and interactive controls the classifier cares about.
  function implicitRole(el: Element): string {
    const tag = el.tagName.toLowerCase()
    switch (tag) {
      case 'button':
        return 'button'
      case 'a':
        return (el as HTMLAnchorElement).hasAttribute('href') ? 'link' : 'generic'
      case 'input': {
        const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image')
          return 'button'
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (type === 'search') return 'searchbox'
        // password, text, email, tel, url, number, date, time, etc. all map to textbox
        return 'textbox'
      }
      case 'select':
        return 'combobox'
      case 'textarea':
        return 'textbox'
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading'
      case 'nav':
        return 'navigation'
      case 'main':
        return 'main'
      case 'header':
        return 'banner'
      case 'footer':
        return 'contentinfo'
      case 'form':
        return 'form'
      case 'dialog':
        return 'dialog'
      case 'img':
        return 'img'
      case 'ul':
      case 'ol':
        return 'list'
      case 'li':
        return 'listitem'
      default:
        return 'generic'
    }
  }

  function role(el: Element): string {
    const explicit = el.getAttribute('role')
    if (explicit !== null && explicit.length > 0) return explicit.split(/\s+/)[0] ?? 'generic'
    return implicitRole(el)
  }

  function name(el: Element): string | null {
    const ariaLabel = el.getAttribute('aria-label')
    if (ariaLabel !== null && ariaLabel.trim().length > 0) return ariaLabel.trim()
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy !== null) {
      const ids = labelledBy.split(/\s+/).filter((s) => s.length > 0)
      const parts: string[] = []
      for (const id of ids) {
        const ref = el.ownerDocument.getElementById(id)
        if (ref !== null) {
          const text = ref.textContent
          if (text !== null && text.trim().length > 0) parts.push(text.trim())
        }
      }
      if (parts.length > 0) return parts.join(' ')
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const id = (el as HTMLInputElement).id
      if (id.length > 0) {
        const lbl = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (lbl !== null) {
          const text = lbl.textContent
          if (text !== null && text.trim().length > 0) return text.trim()
        }
      }
      const placeholder = (el as HTMLInputElement).placeholder
      if (placeholder !== undefined && placeholder.trim().length > 0) return placeholder.trim()
    }
    if (el.tagName === 'IMG') {
      const alt = (el as HTMLImageElement).alt
      if (alt.length > 0) return alt
      return null
    }
    const text = el.textContent
    if (text === null) return null
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (trimmed.length === 0) return null
    return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed
  }

  function fieldType(el: Element): string | undefined {
    if (el.tagName === 'INPUT') return ((el as HTMLInputElement).type || 'text').toLowerCase()
    if (el.tagName === 'SELECT') return 'select'
    if (el.tagName === 'TEXTAREA') return 'textarea'
    return undefined
  }

  function fieldAutocomplete(el: Element): string | undefined {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
      return undefined
    }
    const v = el.getAttribute('autocomplete')
    if (v === null) return undefined
    const trimmed = v.trim().toLowerCase()
    return trimmed.length > 0 ? trimmed : undefined
  }

  function fieldName(el: Element): string | undefined {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
      return undefined
    }
    const v = (el as HTMLInputElement).name
    if (v === undefined || v === null) return undefined
    const trimmed = v.trim().toLowerCase()
    return trimmed.length > 0 ? trimmed : undefined
  }

  function bbox(el: Element): BoundingBox | null {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }

  function isHidden(el: Element): boolean {
    if (!el.ownerDocument.defaultView) return false
    const style = el.ownerDocument.defaultView.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return true
    if (el.getAttribute('aria-hidden') === 'true') return true
    return false
  }

  // Same set as INTERESTING_ROLES at the module scope — duplicated here because
  // this function is serialized into the page and must be self-contained.
  const INTERESTING = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'option',
    'heading',
    'banner',
    'navigation',
    'main',
    'contentinfo',
    'form',
    'dialog',
    'alertdialog',
    'alert',
    'img',
    'list',
    'listitem',
  ])

  function build(el: Element): AriaNode | null {
    if (isHidden(el)) return null
    const r = role(el)
    // Recurse first so generic wrappers can still surface their interesting
    // descendants without inflating the tree.
    const children: AriaNode[] = []
    for (let i = 0; i < el.children.length; i++) {
      const childEl = el.children.item(i)
      if (childEl === null) continue
      const child = build(childEl)
      if (child !== null) children.push(child)
    }
    const isInteresting = INTERESTING.has(r)
    if (!isInteresting) {
      // Promote children up to the next interesting ancestor — flattens
      // <div><div><button>X</button></div></div> down to <button>X</button>.
      if (children.length === 1) return children[0] ?? null
      if (children.length === 0) return null
      // Multiple children with no interesting wrapper: keep a generic group so
      // tree shape is preserved. Bbox is null for the synthetic group.
      return {
        role: 'group',
        name: null,
        bbox: null,
        focused: false,
        disabled: false,
        children,
      }
    }
    const ft = fieldType(el)
    const ac = fieldAutocomplete(el)
    const fn = fieldName(el)
    const node: AriaNode = {
      role: r,
      name: name(el),
      bbox: bbox(el),
      focused: el.ownerDocument.activeElement === el,
      disabled:
        (el as HTMLInputElement).disabled === true ||
        el.getAttribute('aria-disabled') === 'true',
      ...(ft !== undefined && { fieldType: ft }),
      ...(ac !== undefined && { autocomplete: ac }),
      ...(fn !== undefined && { fieldName: fn }),
      children,
    }
    return node
  }

  const root = build(document.body) ?? {
    role: 'group',
    name: null,
    bbox: null,
    focused: false,
    disabled: false,
    children: [],
  }
  return root
}

// ---------------------------------------------------------------------------
// Pure utilities (no DOM, no Playwright)
// ---------------------------------------------------------------------------

/**
 * Build an `AriaTreeSnapshot` from a tree. Pure — used by both the Playwright
 * adapter and tests.
 */
export function buildSnapshot(
  tree: AriaNode,
  opts?: { tokenBudget?: number },
): AriaTreeSnapshot {
  const yaml = serializeToYaml(tree, { tokenBudget: opts?.tokenBudget ?? Infinity })
  const hash = hashYaml(yaml)
  return { tree, yaml, hash }
}

/**
 * Serialize the tree to a YAML-style listing. Token budget is approximated as
 * one token per 4 characters (matches Anthropic / OpenAI tokenizer averages
 * for English text — exact enough for a budget cap).
 *
 * Format example:
 *   - main
 *     - heading "Settings" [level=1]
 *     - form "Account"
 *       - textbox "Email"
 *       - textbox "Password" [type=password]
 *       - button "Sign in"
 */
export function serializeToYaml(
  tree: AriaNode,
  opts: { tokenBudget?: number },
): string {
  const budget = opts.tokenBudget ?? Infinity
  const maxChars = Number.isFinite(budget) ? Math.max(0, Math.floor(budget * 4)) : Infinity
  const lines: string[] = []
  let charCount = 0
  let truncated = false

  function visit(node: AriaNode, depth: number): void {
    if (truncated) return
    const indent = '  '.repeat(depth)
    const parts: string[] = [`${indent}- ${node.role}`]
    if (node.name !== null) {
      const escaped = node.name.replace(/"/g, '\\"')
      parts.push(`"${escaped}"`)
    }
    const attrs: string[] = []
    if (node.fieldType !== undefined && node.fieldType !== 'text') {
      attrs.push(`type=${node.fieldType}`)
    }
    if (node.disabled) attrs.push('disabled')
    if (node.focused) attrs.push('focused')
    if (attrs.length > 0) parts.push(`[${attrs.join(', ')}]`)
    const line = parts.join(' ')
    if (charCount + line.length + 1 > maxChars) {
      lines.push(`${indent}- ... (truncated for token budget)`)
      truncated = true
      return
    }
    lines.push(line)
    charCount += line.length + 1
    for (const child of node.children) {
      visit(child, depth + 1)
      if (truncated) return
    }
  }

  visit(tree, 0)
  return lines.join('\n')
}

/** SHA-256 hex of the YAML serialization. Stable, deterministic, short. */
export function hashYaml(yaml: string): string {
  return createHash('sha256').update(yaml).digest('hex').slice(0, 16)
}

/** Convenience: hash a tree directly via its YAML. */
export function hashTree(tree: AriaNode): string {
  return hashYaml(serializeToYaml(tree, { tokenBudget: Infinity }))
}

/**
 * Find the deepest interesting node whose bbox contains `pointPx` (CSS px
 * relative to the viewport). Returns null if no interesting node covers the
 * point. The classifier in `policy.classifyAction` uses this to find the
 * accessible name of a click target.
 *
 * "Deepest" = rightmost in document order under bbox-hit set, since later
 * children typically render on top.
 */
export function findAtPoint(tree: AriaNode, pointPx: { x: number; y: number }): AriaNode | null {
  let best: AriaNode | null = null

  function visit(node: AriaNode): void {
    if (node.bbox !== null && contains(node.bbox, pointPx)) {
      best = node
    }
    for (const child of node.children) {
      visit(child)
    }
  }

  visit(tree)
  return best
}

function contains(box: BoundingBox, p: { x: number; y: number }): boolean {
  return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height
}

/**
 * Convert a NormalizedPoint into the CSS-pixel coords `findAtPoint` expects.
 * Mirrors `coordinates.normalizedToCssPx` but kept here so callers don't need
 * to know about the viewport conversion when they have a viewport handy.
 */
export function normalizedToFindPoint(
  point: NormalizedPoint,
  viewport: ComputerViewport,
): { x: number; y: number } {
  return {
    x: Math.round(point.x * (viewport.width - 1)),
    y: Math.round(point.y * (viewport.height - 1)),
  }
}

/**
 * Replace the `name` field of any node matching a sensitive pattern. Extra
 * predicates can be supplied from settings.
 *
 * Phase 4·1 ships the built-in detector keyed on the AriaNode's `fieldType` /
 * `autocomplete` / `fieldName` (see `isSensitiveNode` for coverage). The full
 * selector-based pipeline (predicate functions sourced from
 * `computerUseSettings.redactionSelectors`) lands in Batch 4·2 alongside
 * `redaction.ts`.
 */
export function redactNodes(
  tree: AriaNode,
  extraPredicates: readonly ((node: AriaNode) => boolean)[] = [],
): AriaNode {
  function isSensitive(node: AriaNode): boolean {
    if (isSensitiveNode(node)) return true
    for (const pred of extraPredicates) {
      if (pred(node)) return true
    }
    return false
  }
  function visit(node: AriaNode): AriaNode {
    const redacted = isSensitive(node)
    return {
      ...node,
      name: redacted ? '[REDACTED]' : node.name,
      children: node.children.map(visit),
    }
  }
  return visit(tree)
}

// HTML `type` values that are inherently sensitive. Note: there is NO
// `type="creditcard"` in the spec — credit-card fields are `type="text"` with
// `autocomplete="cc-number"` / `cc-csc`. The earlier draft included
// 'creditcard' here as a misread of the v3 spec; corrected by Phase 4·1
// review feedback.
const BUILT_IN_SENSITIVE_FIELD_TYPES = new Set(['password', 'tel'])

// Sensitive `autocomplete` tokens. See WHATWG HTML §autofill for the full
// taxonomy. We match the explicit semantic intents the design listed:
// passwords, MFA one-time codes, payment-card details. `autocomplete` may
// be a space-separated list (e.g., "shipping cc-number"), so we tokenize
// before matching.
const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
])

// Sensitive name-attr patterns. Browsers don't have a dedicated SSN
// autocomplete token, so this is the practical fallback. Lowercase match
// (the AriaNode normalizes name + autocomplete to lowercase at capture).
const SENSITIVE_NAME_PATTERNS: readonly RegExp[] = [
  /\bssn\b/,
  /social[_-]?security/,
  /\btax[_-]?id\b/,
  /\bnational[_-]?id\b/,
]

/**
 * Built-in "is this an AriaNode the model should not type into / observe
 * unredacted?" predicate. Reads `fieldType` (input.type) AND `autocomplete`
 * AND `fieldName` so MFA / payment / SSN fields disguised as `type="text"`
 * still get caught.
 *
 * Exported for the safety check (`computerSafetyChecks.ts`) to share the
 * same detection logic without duplicating the lists.
 */
export function isSensitiveNode(node: AriaNode): boolean {
  if (node.fieldType !== undefined && BUILT_IN_SENSITIVE_FIELD_TYPES.has(node.fieldType)) {
    return true
  }
  if (node.autocomplete !== undefined) {
    const tokens = node.autocomplete.split(/\s+/).filter((t) => t.length > 0)
    for (const t of tokens) {
      if (SENSITIVE_AUTOCOMPLETE_TOKENS.has(t)) return true
    }
  }
  if (node.fieldName !== undefined) {
    for (const re of SENSITIVE_NAME_PATTERNS) {
      if (re.test(node.fieldName)) return true
    }
  }
  return false
}

/**
 * Describe WHY a node is sensitive — used by the safety check to populate
 * `evidence.fieldType` for audit metadata. Returns the most specific marker
 * available: the matching autocomplete token, then field name match, then
 * input type.
 */
export function describeSensitiveSignal(node: AriaNode): string | undefined {
  if (node.autocomplete !== undefined) {
    for (const t of node.autocomplete.split(/\s+/)) {
      if (SENSITIVE_AUTOCOMPLETE_TOKENS.has(t)) return t
    }
  }
  if (node.fieldName !== undefined) {
    for (const re of SENSITIVE_NAME_PATTERNS) {
      if (re.test(node.fieldName)) return `name:${node.fieldName}`
    }
  }
  if (node.fieldType !== undefined && BUILT_IN_SENSITIVE_FIELD_TYPES.has(node.fieldType)) {
    return node.fieldType
  }
  return undefined
}

/**
 * @deprecated Use `isSensitiveNode(node)` — `fieldType` alone misses
 * one-time-code / cc-number fields disguised as `type="text"`. Kept for the
 * Phase 4·1 transition; remove once consumers migrate.
 */
export function isSensitiveFieldType(fieldType: string | undefined): boolean {
  if (fieldType === undefined) return false
  return BUILT_IN_SENSITIVE_FIELD_TYPES.has(fieldType)
}

/**
 * `INTERESTING_ROLES` is exported so the safety check can ignore non-interactive
 * containers when classifying.
 */
export { INTERESTING_ROLES }
