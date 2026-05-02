/**
 * v3 Phase 2 + 4·1: Computer-Use policy primitives.
 *
 * Phase 2 (slice 1):
 * - `isDomainAllowed`: routing-time domain check, used both at the navigate()
 *   pre-flight stage and at the page.route() interceptor stage.
 * - `isUrlSchemeAllowed`: URL-scheme check (HTTPS-only with a test-only http
 *   escape; data:/file:/javascript:/etc. always rejected).
 *
 * Phase 4·1 (slice 2):
 * - `classifyAction`: synchronous risk classifier read by
 *   `computerUseSafetyCheck` at cascade step 4. Level 0/1 fall through to the
 *   rest of the cascade; level 2/3 force `ask` (non-bypassable); level 4
 *   forces `deny`. Coordinate-based classifications walk the cached
 *   `AriaTreeSnapshot` via `findAtPoint` to read the accessible name/role at
 *   the click target.
 *
 * Reuses `extractHost` and `matchDomain` from `src/web/domainPolicy.ts` so the
 * domain pattern syntax is identical to webPolicy: exact host or `*.host`.
 */

import { extractHost, matchDomain } from '../../web/domainPolicy.js'

import {
  describeSensitiveSignal,
  findAtPoint,
  isSensitiveNode,
  normalizedToFindPoint,
  type AriaNode,
  type AriaTreeSnapshot,
} from './ariaSnapshot.js'
import type { ComputerViewport, NormalizedPoint } from './types.js'

export type DomainCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly reason: 'denied' | 'not_in_allowlist' | 'malformed_url'
    }

/**
 * Decide whether a URL's host is allowed under this session's domain policy.
 *
 * Rules:
 * 1. Malformed URL (cannot extract host) -> `malformed_url`.
 * 2. Denylist hit beats everything -> `denied`.
 * 3. If `requireAllowlist` and allowlist is non-empty: host must match at least
 *    one entry, else `not_in_allowlist`.
 * 4. If `requireAllowlist` is false (test-only): allow.
 * 5. Otherwise: allow.
 *
 * The empty-allowlist case with `requireAllowlist: true` is intentionally NOT
 * handled here — `navigate()` rejects with `allowlist_empty` before reaching
 * this function.
 */
export function isDomainAllowed(
  url: string,
  settings: { allowedDomains: readonly string[]; deniedDomains: readonly string[] },
  opts: { requireAllowlist: boolean },
): DomainCheck {
  const host = extractHost(url)
  if (host === null) {
    return { allowed: false, reason: 'malformed_url' }
  }
  for (const pattern of settings.deniedDomains) {
    if (matchDomain(pattern, host)) {
      return { allowed: false, reason: 'denied' }
    }
  }
  if (opts.requireAllowlist) {
    if (settings.allowedDomains.length === 0) {
      // Caller should have rejected earlier with allowlist_empty.
      // Treat as not_in_allowlist defensively.
      return { allowed: false, reason: 'not_in_allowlist' }
    }
    for (const pattern of settings.allowedDomains) {
      if (matchDomain(pattern, host)) {
        return { allowed: true }
      }
    }
    return { allowed: false, reason: 'not_in_allowlist' }
  }
  return { allowed: true }
}

export type SchemeCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly reason: 'unsupported_scheme' | 'malformed_url'
    }

/**
 * Decide whether a URL's scheme is allowed.
 *
 * - `https:` always allowed.
 * - `http:` allowed only when `allowHttpForTest === true` (integration tests).
 * - All other schemes (`data:`, `file:`, `javascript:`, `chrome:`, `blob:`,
 *   `ws:`, `wss:`, `ftp:`, ...) always rejected.
 */
export function isUrlSchemeAllowed(
  url: string,
  opts: { allowHttpForTest: boolean },
): SchemeCheck {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: 'malformed_url' }
  }
  if (parsed.protocol === 'https:') return { allowed: true }
  if (parsed.protocol === 'http:' && opts.allowHttpForTest) return { allowed: true }
  return { allowed: false, reason: 'unsupported_scheme' }
}

// ===========================================================================
// Phase 4·1 — Risk classifier
// ===========================================================================

export type RiskLevel = 0 | 1 | 2 | 3 | 4

export type RiskCategory =
  | 'observation'        // level 0: screenshot, wait
  | 'reversible_ui'      // level 1: scroll, navigate, harmless click
  | 'sensitive_input'    // level 2: password, MFA, payment, PII
  | 'irreversible'       // level 3: Submit / Delete / Send / Pay / Confirm / etc.
  | 'prohibited'         // level 4: explicitly banned (CAPTCHA evasion, etc.)

export type RiskAssessment = {
  readonly level: RiskLevel
  readonly category: RiskCategory
  readonly reason: string
  readonly evidence?: {
    readonly nearbyText?: string
    readonly fieldType?: string
  }
}

export type ClassifyContext = {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly currentUrl: string | null
  /**
   * Most recent ARIA snapshot for the session. The classifier walks this with
   * `findAtPoint` to find the role/name of a click target; without it, click
   * classification falls back to level 1 ("can't see the target — defer to the
   * rest of the cascade"). The synchronous safety check obtains this from
   * `BrowserSession.lastAriaSnapshot()`.
   */
  readonly ariaSnapshot?: AriaTreeSnapshot | null
  /** Required only for tools that use NormalizedPoint coordinates. */
  readonly viewport?: ComputerViewport
}

// Dangerous-label regex. Matches at the START of an accessible name so the
// classifier doesn't false-positive on strings like "How to delete files"
// (heading) or "subscribe" (button). The leading `\b` lets multi-word labels
// like "submit form" still match.
//
// `i` flag — case-insensitive. The `\b` word-boundary plus `(?:\b|$)` after
// the verb avoids matching mid-word (e.g., "Resubmit" should still match
// "submit"; the leading `\b` allows that).
const DANGEROUS_LABEL_RE = /\b(?:submit|delete|send|pay|purchase|buy|confirm|invite|publish|transfer|disable|remove|cancel\s*subscription|unsubscribe|deactivate|wipe|reset|destroy)\b/i

const ALWAYS_OBSERVATION_TOOLS = new Set([
  'ComputerObserve',
  'ComputerWait',
])

const ALWAYS_REVERSIBLE_TOOLS = new Set([
  'ComputerScroll',
  'ComputerStart',
  'ComputerStop',
])

/**
 * Classify the risk of a proposed Computer-Use action.
 *
 * Returns the lowest applicable level — `null` is not a return value. The
 * caller (the safety check) decides what behavior corresponds to the level:
 * 0/1 → null (defer); 2/3 → ask; 4 → deny.
 *
 * Synchronous by contract — the cascade calls SafetyChecks synchronously
 * (`permissions.ts:112-117`).
 */
export function classifyAction(ctx: ClassifyContext): RiskAssessment {
  const { toolName, input } = ctx

  // Tools that have no risk regardless of input.
  if (ALWAYS_OBSERVATION_TOOLS.has(toolName)) {
    return { level: 0, category: 'observation', reason: 'observation tool' }
  }

  // ComputerHandoffToUser handles its own gating in `checkPermissions`. The
  // cascade reaches the safety check only after Phase 3's `checkPermissions`
  // returned `'ask'`/`'deny'`/`'allow'`. We classify it as level 2 so the
  // cascade still threads `safetyMetadata` for audit.
  if (toolName === 'ComputerHandoffToUser') {
    return {
      level: 2,
      category: 'sensitive_input',
      reason: 'handoff exposes the visible browser to the user',
    }
  }

  // ComputerNavigate: level depends on whether the URL host is already in
  // the session's allowlist (Phase 2's domain check is the load-bearing
  // gate; Phase 4 only adds a soft "ask the user about a brand-new host"
  // signal). For now we classify all navigates as level 1 — the domain
  // allowlist is enforced at the BrowserSession layer.
  if (toolName === 'ComputerNavigate') {
    return { level: 1, category: 'reversible_ui', reason: 'navigation to allowed host' }
  }

  // Tools that are level 1 by construction.
  if (ALWAYS_REVERSIBLE_TOOLS.has(toolName)) {
    return { level: 1, category: 'reversible_ui', reason: `${toolName} is always level 1` }
  }

  // ComputerType / ComputerKey: text-driven, no coords needed.
  if (toolName === 'ComputerType') {
    return classifyType(input, ctx.ariaSnapshot ?? null)
  }
  if (toolName === 'ComputerKey') {
    return classifyKey(input, ctx.ariaSnapshot ?? null)
  }

  // ComputerClick / ComputerDoubleClick / ComputerDrag: walk the ARIA tree
  // at the click target.
  if (toolName === 'ComputerClick' || toolName === 'ComputerDoubleClick') {
    return classifyClick(input, ctx.ariaSnapshot ?? null, ctx.viewport)
  }
  if (toolName === 'ComputerDrag') {
    // Drag's risk lives at the drop target. Use `to` if present, fall back
    // to `from`. If neither is parseable, defer to level 1.
    return classifyDrag(input, ctx.ariaSnapshot ?? null, ctx.viewport)
  }

  // Unknown Computer* tool — level 1 by default.
  return { level: 1, category: 'reversible_ui', reason: `${toolName}: no specific classification` }
}

function classifyType(
  input: Record<string, unknown>,
  ariaSnapshot: AriaTreeSnapshot | null,
): RiskAssessment {
  // Advisory `sensitive` flag — the model declares this when typing a
  // password/token. Phase 3 stored the flag as advisory-only; Phase 4·1
  // honors it.
  if (input.sensitive === true) {
    return {
      level: 2,
      category: 'sensitive_input',
      reason: 'model marked the input as sensitive',
      evidence: { fieldType: 'sensitive-flag' },
    }
  }
  // Inspect the focused field via the richer sensitive-node predicate.
  // This catches MFA / cc-number / cc-csc / ssn fields disguised as
  // `type="text"` that the old `fieldType`-only check missed.
  if (ariaSnapshot !== null) {
    const focused = findFocused(ariaSnapshot.tree)
    if (focused !== null && isSensitiveNode(focused)) {
      const signal = describeSensitiveSignal(focused) ?? focused.fieldType ?? 'unknown'
      return {
        level: 2,
        category: 'sensitive_input',
        reason: `typing into a sensitive ${signal} field`,
        evidence: {
          fieldType: signal,
          ...(focused.name !== null && { nearbyText: focused.name }),
        },
      }
    }
  }
  return { level: 1, category: 'reversible_ui', reason: 'plain text input' }
}

function classifyClick(
  input: Record<string, unknown>,
  ariaSnapshot: AriaTreeSnapshot | null,
  viewport: ComputerViewport | undefined,
): RiskAssessment {
  if (ariaSnapshot === null) {
    return {
      level: 1,
      category: 'reversible_ui',
      reason: 'no ARIA context available; deferring to cascade',
    }
  }
  const point = readNormalizedPoint(input.x, input.y)
  if (point === null) {
    return {
      level: 1,
      category: 'reversible_ui',
      reason: 'click coordinates unparseable; deferring to cascade',
    }
  }
  const vp = viewport ?? { width: 1024, height: 768, deviceScaleFactor: 1 }
  const pixelPoint = normalizedToFindPoint(point, vp)
  const target = findAtPoint(ariaSnapshot.tree, pixelPoint)
  return classifyTarget(target, 'click')
}

function classifyDrag(
  input: Record<string, unknown>,
  ariaSnapshot: AriaTreeSnapshot | null,
  viewport: ComputerViewport | undefined,
): RiskAssessment {
  if (ariaSnapshot === null) {
    return { level: 1, category: 'reversible_ui', reason: 'no ARIA context for drag' }
  }
  const target = readNormalizedPoint(input.toX, input.toY) ?? readNormalizedPoint(input.fromX, input.fromY)
  if (target === null) {
    return { level: 1, category: 'reversible_ui', reason: 'drag coordinates unparseable' }
  }
  const vp = viewport ?? { width: 1024, height: 768, deviceScaleFactor: 1 }
  const pixelPoint = normalizedToFindPoint(target, vp)
  const node = findAtPoint(ariaSnapshot.tree, pixelPoint)
  return classifyTarget(node, 'drag')
}

// Activation keys that, when pressed on a focused activatable element, fire
// the same handler as a click. Browsers handle this at the platform level
// for `<button>` / `<a>` and ARIA roles like menuitem/option.
const ACTIVATION_KEYS = new Set(['Enter', 'Space'])

// Roles whose `activate` semantic is a click-equivalent. Checkbox / radio /
// switch are intentionally NOT here — Space toggles their state, which is a
// reversible UI mutation. The dangerous-label regex would rarely match a
// checkbox name, but if it does, classifyTarget at the click site catches it.
const ACTIVATABLE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'option',
  'tab',
])

// Roles where focus typically lands during text entry. Enter on these inside
// a form usually submits the form's default button — that's where the
// "form-submit-via-Enter" risk lives.
const TEXTBOX_ROLES = new Set(['textbox', 'searchbox', 'combobox'])

/**
 * Phase 4·1 fix #6 — `ComputerKey` classifier.
 *
 * Without this, pressing Enter or Space on a focused Delete/Pay/Submit
 * button proceeds at level 1 and bypasses approval under permissive modes.
 * The fix mirrors the click classifier:
 *
 * 1. Bare Enter/Space + focused activatable element (button/link/etc.) →
 *    reuse `classifyTarget` so dangerous labels and sensitive fields produce
 *    the same prompt as a `ComputerClick` would.
 * 2. Bare Enter + focused input/searchbox/combobox inside a `<form>` →
 *    walk to the enclosing form, scan its descendants for a dangerous-
 *    labeled submit button, and classify as if clicking that button. This
 *    catches "fill payment form, press Enter to submit."
 * 3. Anything else (other keys, chord-prefixed activation, no focused
 *    element, no enclosing form) → level 1.
 *
 * Documented gaps (Phase 6 evals can refine):
 * - Chord activation like `Control+Enter` is treated as level 1 because
 *   modifier semantics are app-specific (often bypass form-submit).
 * - A page with global keyboard shortcuts (`/` for search, `?` for help)
 *   isn't classified — but those are typically benign anyway.
 */
function classifyKey(
  input: Record<string, unknown>,
  ariaSnapshot: AriaTreeSnapshot | null,
): RiskAssessment {
  const key = typeof input.key === 'string' ? input.key : ''

  if (!ACTIVATION_KEYS.has(key)) {
    return { level: 1, category: 'reversible_ui', reason: `key(${key})` }
  }

  if (ariaSnapshot === null) {
    return {
      level: 1,
      category: 'reversible_ui',
      reason: `${key} pressed; no ARIA context to classify the focused target`,
    }
  }

  const focused = findFocused(ariaSnapshot.tree)
  if (focused === null) {
    return { level: 1, category: 'reversible_ui', reason: `${key} with no focused element` }
  }

  // (1) Activation key on an activatable role — same outcome as a click.
  if (ACTIVATABLE_ROLES.has(focused.role)) {
    return classifyTarget(focused, `${key} activation`)
  }

  // (2) Enter on a focused input inside a form — find the form's dangerous
  // submit button if present. Space inside a textbox just inserts a space,
  // so this branch is Enter-only.
  if (key === 'Enter' && TEXTBOX_ROLES.has(focused.role)) {
    const form = findEnclosingForm(ariaSnapshot.tree, focused)
    if (form !== null) {
      const dangerousSubmit = findDangerousButton(form)
      if (dangerousSubmit !== null) {
        return classifyTarget(dangerousSubmit, `Enter submits form`)
      }
    }
  }

  return { level: 1, category: 'reversible_ui', reason: `${key} on ${focused.role}` }
}

/**
 * Find the innermost ancestor with role 'form' that contains `target`.
 * Returns null when the target isn't inside any form (or when the target
 * itself isn't reachable from `tree`). Pre-Phase-4b we don't store parent
 * pointers on AriaNode, so this is a single traversal threading the
 * current form ancestor through the recursion.
 */
function findEnclosingForm(tree: AriaNode, target: AriaNode): AriaNode | null {
  function visit(node: AriaNode, formAncestor: AriaNode | null): AriaNode | null {
    if (node === target) return formAncestor
    const nextForm = node.role === 'form' ? node : formAncestor
    for (const child of node.children) {
      const hit = visit(child, nextForm)
      if (hit !== null) return hit
    }
    return null
  }
  return visit(tree, null)
}

/**
 * Find the first descendant button whose accessible name matches the
 * dangerous-action regex. Used to detect "form submit goes to a Delete /
 * Pay / Send button" when the model presses Enter inside a form input.
 */
function findDangerousButton(node: AriaNode): AriaNode | null {
  if (
    node.role === 'button' &&
    node.name !== null &&
    DANGEROUS_LABEL_RE.test(node.name)
  ) {
    return node
  }
  for (const child of node.children) {
    const hit = findDangerousButton(child)
    if (hit !== null) return hit
  }
  return null
}

function classifyTarget(node: AriaNode | null, action: string): RiskAssessment {
  if (node === null) {
    return { level: 1, category: 'reversible_ui', reason: `${action} target not found in ARIA` }
  }
  if (node.disabled) {
    return {
      level: 0,
      category: 'observation',
      reason: `${action} target is disabled — no real action`,
    }
  }
  // Sensitive field at the click target — uses the richer predicate so
  // cc-number / one-time-code / ssn fields disguised as `type="text"` still
  // classify as level 2.
  if (isSensitiveNode(node)) {
    const signal = describeSensitiveSignal(node) ?? node.fieldType ?? 'unknown'
    return {
      level: 2,
      category: 'sensitive_input',
      reason: `${action} on a sensitive ${signal} field`,
      evidence: {
        fieldType: signal,
        ...(node.name !== null && { nearbyText: node.name }),
      },
    }
  }
  if (node.name !== null && DANGEROUS_LABEL_RE.test(node.name)) {
    return {
      level: 3,
      category: 'irreversible',
      reason: `${action} target labeled "${node.name}" matches a dangerous-action pattern`,
      evidence: { nearbyText: node.name },
    }
  }
  return { level: 1, category: 'reversible_ui', reason: `${action} on benign target` }
}

function findFocused(tree: AriaNode): AriaNode | null {
  if (tree.focused) return tree
  for (const child of tree.children) {
    const hit = findFocused(child)
    if (hit !== null) return hit
  }
  return null
}

function readNormalizedPoint(xRaw: unknown, yRaw: unknown): NormalizedPoint | null {
  if (typeof xRaw !== 'number' || typeof yRaw !== 'number') return null
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return null
  if (xRaw < 0 || xRaw > 1 || yRaw < 0 || yRaw > 1) return null
  return { x: xRaw, y: yRaw }
}

// `extractHost` is re-exported so the safety check can use the same host
// extractor for `currentUrl` parsing without importing webPolicy directly.
export { extractHost as extractHostForPolicy }
