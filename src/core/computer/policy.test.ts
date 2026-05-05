import { describe, expect, it } from 'vitest'

import { buildSnapshot, type AriaNode, type AriaTreeSnapshot } from './ariaSnapshot.js'
import { classifyAction, isDomainAllowed, isUrlSchemeAllowed } from './policy.js'
import type { ComputerViewport } from './types.js'

describe('isDomainAllowed', () => {
  describe('with requireAllowlist: true', () => {
    it('allows host matching exact entry', () => {
      const r = isDomainAllowed(
        'https://github.com/foo',
        { allowedDomains: ['github.com'], deniedDomains: [] },
        { requireAllowlist: true },
      )
      expect(r).toEqual({ allowed: true })
    })

    it('allows subdomain matching wildcard', () => {
      const r = isDomainAllowed(
        'https://gist.github.com/abc',
        { allowedDomains: ['*.github.com'], deniedDomains: [] },
        { requireAllowlist: true },
      )
      expect(r).toEqual({ allowed: true })
    })

    it('rejects apex when only wildcard is listed', () => {
      const r = isDomainAllowed(
        'https://github.com/',
        { allowedDomains: ['*.github.com'], deniedDomains: [] },
        { requireAllowlist: true },
      )
      expect(r).toEqual({ allowed: false, reason: 'not_in_allowlist' })
    })

    it('rejects host not in allowlist', () => {
      const r = isDomainAllowed(
        'https://evil.com/',
        { allowedDomains: ['github.com'], deniedDomains: [] },
        { requireAllowlist: true },
      )
      expect(r).toEqual({ allowed: false, reason: 'not_in_allowlist' })
    })

    it('denylist beats allowlist', () => {
      const r = isDomainAllowed(
        'https://github.com/',
        { allowedDomains: ['github.com'], deniedDomains: ['github.com'] },
        { requireAllowlist: true },
      )
      expect(r).toEqual({ allowed: false, reason: 'denied' })
    })

    it('empty allowlist returns not_in_allowlist', () => {
      const r = isDomainAllowed(
        'https://github.com/',
        { allowedDomains: [], deniedDomains: [] },
        { requireAllowlist: true },
      )
      expect(r).toEqual({ allowed: false, reason: 'not_in_allowlist' })
    })
  })

  describe('with requireAllowlist: false (test mode)', () => {
    it('allows any host when allowlist empty', () => {
      const r = isDomainAllowed(
        'https://anything.com/',
        { allowedDomains: [], deniedDomains: [] },
        { requireAllowlist: false },
      )
      expect(r).toEqual({ allowed: true })
    })

    it('still applies denylist', () => {
      const r = isDomainAllowed(
        'https://denied.com/',
        { allowedDomains: [], deniedDomains: ['denied.com'] },
        { requireAllowlist: false },
      )
      expect(r).toEqual({ allowed: false, reason: 'denied' })
    })
  })

  describe('malformed URLs', () => {
    it('rejects unparseable URL', () => {
      const r = isDomainAllowed(
        'not a url',
        { allowedDomains: ['github.com'], deniedDomains: [] },
        { requireAllowlist: true },
      )
      expect(r).toEqual({ allowed: false, reason: 'malformed_url' })
    })

    it('rejects URL with userinfo (security: extractHost returns null for these)', () => {
      const r = isDomainAllowed(
        'https://user:pass@github.com/',
        { allowedDomains: ['github.com'], deniedDomains: [] },
        { requireAllowlist: true },
      )
      expect(r).toEqual({ allowed: false, reason: 'malformed_url' })
    })
  })

  describe('case insensitivity', () => {
    it('lowercases host before matching', () => {
      const r = isDomainAllowed(
        'https://GitHub.com/',
        { allowedDomains: ['github.com'], deniedDomains: [] },
        { requireAllowlist: true },
      )
      expect(r).toEqual({ allowed: true })
    })
  })
})

describe('isUrlSchemeAllowed', () => {
  it('allows https with allowHttpForTest=false', () => {
    const r = isUrlSchemeAllowed('https://example.com/', { allowHttpForTest: false })
    expect(r).toEqual({ allowed: true })
  })

  it('allows https with allowHttpForTest=true', () => {
    const r = isUrlSchemeAllowed('https://example.com/', { allowHttpForTest: true })
    expect(r).toEqual({ allowed: true })
  })

  it('rejects http when allowHttpForTest=false', () => {
    const r = isUrlSchemeAllowed('http://example.com/', { allowHttpForTest: false })
    expect(r).toEqual({ allowed: false, reason: 'unsupported_scheme' })
  })

  it('allows http when allowHttpForTest=true', () => {
    const r = isUrlSchemeAllowed('http://example.com/', { allowHttpForTest: true })
    expect(r).toEqual({ allowed: true })
  })

  for (const scheme of [
    'data:image/png;base64,iVBORw0KGgo=',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'chrome://settings',
    'blob:https://example.com/uuid',
    'ws://example.com/',
    'wss://example.com/',
    'ftp://example.com/',
  ]) {
    it(`rejects scheme: ${scheme.split(':')[0]} (regardless of allowHttpForTest)`, () => {
      expect(isUrlSchemeAllowed(scheme, { allowHttpForTest: false })).toEqual({
        allowed: false,
        reason: 'unsupported_scheme',
      })
      expect(isUrlSchemeAllowed(scheme, { allowHttpForTest: true })).toEqual({
        allowed: false,
        reason: 'unsupported_scheme',
      })
    })
  }

  it('rejects malformed URL', () => {
    const r = isUrlSchemeAllowed('not a url', { allowHttpForTest: true })
    expect(r).toEqual({ allowed: false, reason: 'malformed_url' })
  })
})

// ===========================================================================
// Phase 4·1 — classifyAction
// ===========================================================================

const VIEWPORT_1024_768: ComputerViewport = {
  width: 1024,
  height: 768,
  deviceScaleFactor: 1,
}

function node(
  role: string,
  partial: Partial<AriaNode> = {},
): AriaNode {
  return {
    role,
    name: partial.name ?? null,
    bbox: partial.bbox ?? null,
    focused: partial.focused ?? false,
    disabled: partial.disabled ?? false,
    children: partial.children ?? [],
    ...(partial.fieldType !== undefined && { fieldType: partial.fieldType }),
    ...(partial.autocomplete !== undefined && { autocomplete: partial.autocomplete }),
    ...(partial.fieldName !== undefined && { fieldName: partial.fieldName }),
  }
}

function snap(tree: AriaNode): AriaTreeSnapshot {
  return buildSnapshot(tree, { tokenBudget: Infinity })
}

describe('classifyAction', () => {
  describe('observation tools (level 0)', () => {
    it.each(['ComputerObserve', 'ComputerWait'])('%s → level 0 observation', (toolName) => {
      const r = classifyAction({ toolName, input: {}, currentUrl: null })
      expect(r.level).toBe(0)
      expect(r.category).toBe('observation')
    })
  })

  describe('reversible UI tools (level 1)', () => {
    it.each(['ComputerScroll', 'ComputerStart', 'ComputerStop', 'ComputerNavigate'])(
      '%s → level 1 reversible_ui',
      (toolName) => {
        const r = classifyAction({ toolName, input: {}, currentUrl: null })
        expect(r.level).toBe(1)
        expect(r.category).toBe('reversible_ui')
      },
    )

    it('ComputerKey with no ARIA context → level 1 (deferred)', () => {
      const r = classifyAction({ toolName: 'ComputerKey', input: { key: 'Enter' }, currentUrl: null })
      expect(r.level).toBe(1)
    })

    it('ComputerKey navigation key (Tab) → level 1 even with focused dangerous button', () => {
      const tree = node('main', {
        children: [node('button', { name: 'Delete account', focused: true })],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Tab' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Phase 4·1 fix #6 — ComputerKey activation classifier
  // -------------------------------------------------------------------------

  describe('ComputerKey activation (fix #6)', () => {
    it('Enter on focused Delete button → level 3 (same as click)', () => {
      const tree = node('main', {
        children: [
          node('button', {
            name: 'Delete account',
            focused: true,
            bbox: { x: 0, y: 0, width: 100, height: 30 },
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(3)
      expect(r.evidence?.nearbyText).toBe('Delete account')
    })

    it('Space on focused Pay button → level 3', () => {
      const tree = node('main', {
        children: [node('button', { name: 'Pay now', focused: true })],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Space' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(3)
    })

    it('Enter on focused link with dangerous label → level 3', () => {
      const tree = node('main', {
        children: [node('link', { name: 'Delete', focused: true })],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(3)
    })

    it('Enter on focused benign button → level 1', () => {
      const tree = node('main', {
        children: [node('button', { name: 'Open menu', focused: true })],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(1)
    })

    it('Enter on focused input INSIDE a form with a Pay submit button → level 3 (form-submit-via-Enter)', () => {
      const tree = node('main', {
        children: [
          node('form', {
            children: [
              node('textbox', { name: 'Card number', focused: true }),
              node('button', { name: 'Pay $99' }),
            ],
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(3)
      expect(r.evidence?.nearbyText).toBe('Pay $99')
    })

    it('Enter on focused input inside a form WITHOUT a dangerous submit → level 1', () => {
      const tree = node('main', {
        children: [
          node('form', {
            children: [
              node('textbox', { name: 'Search', focused: true }),
              node('button', { name: 'Search' }),
            ],
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(1)
    })

    it('Enter on focused input OUTSIDE any form → level 1', () => {
      const tree = node('main', {
        children: [node('textbox', { name: 'Search', focused: true })],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(1)
    })

    it('Enter on disabled focused Delete button → level 0 (no real action)', () => {
      const tree = node('main', {
        children: [
          node('button', { name: 'Delete', focused: true, disabled: true }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(0)
    })

    it('Enter with no focused element → level 1', () => {
      const tree = node('main', {
        children: [node('button', { name: 'Delete', focused: false })],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(1)
    })

    it('chord-prefixed activation (Control+Enter) → level 1 (documented gap)', () => {
      const tree = node('main', {
        children: [node('button', { name: 'Delete', focused: true })],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Control+Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      // Modifier semantics are app-specific — defer.
      expect(r.level).toBe(1)
    })

    it('Space on focused TEXTBOX → level 1 (Space inserts a space, never submits)', () => {
      const tree = node('main', {
        children: [
          node('form', {
            children: [
              node('textbox', { name: 'Card number', focused: true }),
              node('button', { name: 'Pay' }),
            ],
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Space' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(1)
    })

    it('Enter on focused button inside form scans the BUTTON itself (not the form)', () => {
      // Sanity: when the focused element IS the dangerous button, we don't
      // want to double-count or misattribute via the form-walk path.
      const tree = node('main', {
        children: [
          node('form', {
            children: [
              node('textbox', { name: 'Email' }),
              node('button', { name: 'Confirm payment', focused: true }),
            ],
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerKey',
        input: { key: 'Enter' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(3)
      expect(r.evidence?.nearbyText).toBe('Confirm payment')
    })
  })

  describe('ComputerType', () => {
    it('plain text input → level 1', () => {
      const r = classifyAction({
        toolName: 'ComputerType',
        input: { text: 'hello' },
        currentUrl: null,
      })
      expect(r.level).toBe(1)
    })

    it('sensitive=true advisory flag → level 2', () => {
      const r = classifyAction({
        toolName: 'ComputerType',
        input: { text: 'hunter2', sensitive: true },
        currentUrl: null,
      })
      expect(r.level).toBe(2)
      expect(r.category).toBe('sensitive_input')
      expect(r.evidence?.fieldType).toBe('sensitive-flag')
    })

    it('focused password field detected via ARIA → level 2', () => {
      const tree = node('form', {
        children: [
          node('textbox', {
            name: 'Password',
            fieldType: 'password',
            focused: true,
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerType',
        input: { text: 'hunter2' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(2)
      expect(r.evidence?.fieldType).toBe('password')
      expect(r.evidence?.nearbyText).toBe('Password')
    })

    it('focused MFA one-time-code field (type=text + autocomplete) → level 2', () => {
      // Real MFA inputs are usually `type="text"` with
      // `autocomplete="one-time-code"`. The pre-fix narrow detector missed
      // these — Phase 4·1 review #5 caught the gap.
      const tree = node('form', {
        children: [
          node('textbox', {
            name: 'Verification code',
            fieldType: 'text',
            autocomplete: 'one-time-code',
            focused: true,
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerType',
        input: { text: '123456' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(2)
      expect(r.evidence?.fieldType).toBe('one-time-code')
    })

    it('focused cc-number field → level 2', () => {
      const tree = node('form', {
        children: [
          node('textbox', {
            name: 'Card number',
            fieldType: 'text',
            autocomplete: 'cc-number',
            focused: true,
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerType',
        input: { text: '4111-1111-1111-1111' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(2)
      expect(r.evidence?.fieldType).toBe('cc-number')
    })

    it('focused ssn field by name attribute → level 2', () => {
      const tree = node('form', {
        children: [
          node('textbox', {
            name: 'SSN',
            fieldType: 'text',
            fieldName: 'ssn',
            focused: true,
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerType',
        input: { text: '123-45-6789' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(2)
      expect(r.evidence?.fieldType).toBe('name:ssn')
    })

    it('focused benign field → level 1', () => {
      const tree = node('form', {
        children: [
          node('textbox', {
            name: 'Search',
            fieldType: 'text',
            focused: true,
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerType',
        input: { text: 'foo' },
        currentUrl: null,
        ariaSnapshot: snap(tree),
      })
      expect(r.level).toBe(1)
    })
  })

  describe('ComputerClick', () => {
    function deleteButtonTree(): AriaNode {
      return node('main', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('button', {
            name: 'Delete account',
            bbox: { x: 100, y: 100, width: 150, height: 30 },
          }),
        ],
      })
    }

    it.each([
      'Submit',
      'Submit form',
      'Delete account',
      'Send message',
      'Pay now',
      'Purchase',
      'Confirm payment',
      'Invite users',
      'Publish',
      'Transfer funds',
      'Disable',
      'Remove from list',
      'Cancel subscription',
      'Unsubscribe',
      'Deactivate',
      'Wipe data',
      'Reset password',
      'Destroy session',
    ])('"%s" label → level 3 irreversible', (label) => {
      const tree = node('main', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('button', {
            name: label,
            bbox: { x: 100, y: 100, width: 200, height: 30 },
          }),
        ],
      })
      const cssX = Math.round(0.15 * 1023)
      const cssY = Math.round(0.15 * 767)
      // Sanity check: the click coords must hit the button's bbox.
      expect(cssX).toBeGreaterThanOrEqual(100)
      expect(cssX).toBeLessThanOrEqual(300)
      expect(cssY).toBeGreaterThanOrEqual(100)
      expect(cssY).toBeLessThanOrEqual(130)
      const r = classifyAction({
        toolName: 'ComputerClick',
        input: { x: 0.15, y: 0.15 },
        currentUrl: null,
        ariaSnapshot: snap(tree),
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(3)
      expect(r.category).toBe('irreversible')
      expect(r.evidence?.nearbyText).toBe(label)
    })

    it('benign label ("Open menu") → level 1', () => {
      const tree = node('main', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('button', {
            name: 'Open menu',
            bbox: { x: 100, y: 100, width: 80, height: 30 },
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerClick',
        input: { x: 0.12, y: 0.15 },
        currentUrl: null,
        ariaSnapshot: snap(tree),
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(1)
    })

    it('disabled dangerous button → level 0 (no real action)', () => {
      const tree = node('main', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('button', {
            name: 'Delete',
            bbox: { x: 100, y: 100, width: 80, height: 30 },
            disabled: true,
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerClick',
        input: { x: 0.12, y: 0.15 },
        currentUrl: null,
        ariaSnapshot: snap(tree),
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(0)
    })

    it('clicking a sensitive password field → level 2', () => {
      const tree = node('form', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('textbox', {
            name: 'Password',
            fieldType: 'password',
            bbox: { x: 100, y: 100, width: 200, height: 30 },
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerClick',
        input: { x: 0.15, y: 0.15 },
        currentUrl: null,
        ariaSnapshot: snap(tree),
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(2)
      expect(r.evidence?.fieldType).toBe('password')
    })

    it('no ARIA snapshot → level 1 (deferred)', () => {
      const r = classifyAction({
        toolName: 'ComputerClick',
        input: { x: 0.5, y: 0.5 },
        currentUrl: null,
        ariaSnapshot: null,
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(1)
      expect(r.reason).toContain('no ARIA')
    })

    it('click target outside any bbox → level 1', () => {
      const r = classifyAction({
        toolName: 'ComputerClick',
        input: { x: 0.99, y: 0.99 },
        currentUrl: null,
        ariaSnapshot: snap(deleteButtonTree()),
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(1)
    })

    it('malformed coords → level 1 (deferred)', () => {
      const r = classifyAction({
        toolName: 'ComputerClick',
        input: { x: 'oops', y: 0.5 },
        currentUrl: null,
        ariaSnapshot: snap(deleteButtonTree()),
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(1)
    })

    it('word-boundary tightness — "Resubmit form" does NOT match (false-positive risk too high)', () => {
      // The leading `\b` in DANGEROUS_LABEL_RE requires a word boundary before
      // the verb. "Resubmit" contains "submit" without a leading boundary, so
      // it's level 1, not 3. Open Question 1 (level-4 tuning) and Phase 6
      // evals can revisit if real fixtures want this looser. Keeping the
      // tighter regex avoids false positives like "subscribe" / "deletion" /
      // "transferable" matching benign labels.
      const tree = node('main', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('button', {
            name: 'Resubmit form',
            bbox: { x: 100, y: 100, width: 200, height: 30 },
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerClick',
        input: { x: 0.12, y: 0.15 },
        currentUrl: null,
        ariaSnapshot: snap(tree),
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(1)
    })
  })

  describe('ComputerDoubleClick', () => {
    it('classified the same as ComputerClick at the same target', () => {
      const tree = node('main', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('button', {
            name: 'Delete',
            bbox: { x: 100, y: 100, width: 80, height: 30 },
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerDoubleClick',
        input: { x: 0.12, y: 0.15 },
        currentUrl: null,
        ariaSnapshot: snap(tree),
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(3)
    })
  })

  describe('ComputerDrag', () => {
    it('classifies on the drop target (toX/toY)', () => {
      const tree = node('main', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('button', {
            name: 'Submit form',
            bbox: { x: 100, y: 100, width: 150, height: 30 },
          }),
        ],
      })
      const r = classifyAction({
        toolName: 'ComputerDrag',
        input: { fromX: 0.5, fromY: 0.5, toX: 0.12, toY: 0.15 },
        currentUrl: null,
        ariaSnapshot: snap(tree),
        viewport: VIEWPORT_1024_768,
      })
      expect(r.level).toBe(3)
      expect(r.evidence?.nearbyText).toBe('Submit form')
    })
  })

  describe('ComputerHandoffToUser', () => {
    it('level 2 sensitive_input regardless of input', () => {
      const r = classifyAction({
        toolName: 'ComputerHandoffToUser',
        input: { sessionId: 'x', message: 'log in please' },
        currentUrl: null,
      })
      expect(r.level).toBe(2)
    })
  })

  describe('unknown Computer* tool', () => {
    it('falls back to level 1', () => {
      const r = classifyAction({
        toolName: 'ComputerWhatever',
        input: {},
        currentUrl: null,
      })
      expect(r.level).toBe(1)
    })
  })

  describe('Phase 4b — ComputerObserveActions', () => {
    it('classifies as level 0 observation', () => {
      const r = classifyAction({
        toolName: 'ComputerObserveActions',
        input: { sessionId: 's1' },
        currentUrl: null,
      })
      expect(r.level).toBe(0)
      expect(r.category).toBe('observation')
    })
  })

  describe('Phase 4b — ComputerActAtom', () => {
    function nodeFor(role: string, partial: Partial<AriaNode> = {}): AriaNode {
      return {
        role,
        name: partial.name ?? null,
        bbox: partial.bbox ?? null,
        focused: partial.focused ?? false,
        disabled: partial.disabled ?? false,
        children: partial.children ?? [],
        ...(partial.fieldType !== undefined && { fieldType: partial.fieldType }),
        ...(partial.autocomplete !== undefined && { autocomplete: partial.autocomplete }),
        ...(partial.fieldName !== undefined && { fieldName: partial.fieldName }),
      }
    }

    it('click on a Submit button → level 3 with nearbyText evidence', () => {
      const target = nodeFor('button', { name: 'Submit' })
      const r = classifyAction({
        toolName: 'ComputerActAtom',
        input: { sessionId: 's1', atomId: 'a-0', action: { type: 'click' } },
        currentUrl: null,
        targetNode: target,
      })
      expect(r.level).toBe(3)
      expect(r.category).toBe('irreversible')
      expect(r.evidence?.nearbyText).toBe('Submit')
    })

    it('click on a Delete account button → level 3', () => {
      const target = nodeFor('button', { name: 'Delete account' })
      const r = classifyAction({
        toolName: 'ComputerActAtom',
        input: { sessionId: 's1', atomId: 'a-0', action: { type: 'click' } },
        currentUrl: null,
        targetNode: target,
      })
      expect(r.level).toBe(3)
    })

    it('click on a Sign in button → level 1 (benign)', () => {
      const target = nodeFor('button', { name: 'Sign in' })
      const r = classifyAction({
        toolName: 'ComputerActAtom',
        input: { sessionId: 's1', atomId: 'a-0', action: { type: 'click' } },
        currentUrl: null,
        targetNode: target,
      })
      expect(r.level).toBe(1)
    })

    it('fill on a password textbox → level 2 with fieldType evidence', () => {
      const target = nodeFor('textbox', { name: 'Password', fieldType: 'password' })
      const r = classifyAction({
        toolName: 'ComputerActAtom',
        input: { sessionId: 's1', atomId: 'a-0', action: { type: 'fill', text: 'x' } },
        currentUrl: null,
        targetNode: target,
      })
      expect(r.level).toBe(2)
      expect(r.category).toBe('sensitive_input')
      expect(r.evidence?.fieldType).toBe('password')
    })

    it('fill on a cc-number text input → level 2 (autocomplete-driven)', () => {
      const target = nodeFor('textbox', {
        name: 'Card',
        fieldType: 'text',
        autocomplete: 'cc-number',
      })
      const r = classifyAction({
        toolName: 'ComputerActAtom',
        input: { sessionId: 's1', atomId: 'a-0', action: { type: 'fill', text: 'x' } },
        currentUrl: null,
        targetNode: target,
      })
      expect(r.level).toBe(2)
      expect(r.evidence?.fieldType).toBe('cc-number')
    })

    it('fill with sensitive=true on a benign textbox → level 2', () => {
      const target = nodeFor('textbox', { name: 'Notes', fieldType: 'text' })
      const r = classifyAction({
        toolName: 'ComputerActAtom',
        input: {
          sessionId: 's1',
          atomId: 'a-0',
          action: { type: 'fill', text: 'x', sensitive: true },
        },
        currentUrl: null,
        targetNode: target,
      })
      expect(r.level).toBe(2)
    })

    it('fill on a benign textbox → level 1', () => {
      const target = nodeFor('textbox', { name: 'Email', fieldType: 'text' })
      const r = classifyAction({
        toolName: 'ComputerActAtom',
        input: { sessionId: 's1', atomId: 'a-0', action: { type: 'fill', text: 'x' } },
        currentUrl: null,
        targetNode: target,
      })
      expect(r.level).toBe(1)
    })

    it('select → level 1 regardless of target', () => {
      const target = nodeFor('combobox', { name: 'Country' })
      const r = classifyAction({
        toolName: 'ComputerActAtom',
        input: { sessionId: 's1', atomId: 'a-0', action: { type: 'select', value: 'US' } },
        currentUrl: null,
        targetNode: target,
      })
      expect(r.level).toBe(1)
    })

    it('targetNode === null (cache miss) → level 1; cascade defers', () => {
      const r = classifyAction({
        toolName: 'ComputerActAtom',
        input: { sessionId: 's1', atomId: 'a-99', action: { type: 'click' } },
        currentUrl: null,
        targetNode: null,
      })
      expect(r.level).toBe(1)
      expect(r.reason).toContain('atomId not resolvable')
    })
  })

  // -------------------------------------------------------------------------
  // ComputerNavigate (domain-prompt UX)
  // -------------------------------------------------------------------------

  describe('ComputerNavigate', () => {
    it('without domain context → level 1 defer (legacy behavior)', () => {
      const r = classifyAction({
        toolName: 'ComputerNavigate',
        input: { sessionId: 's1', url: 'https://example.com/' },
        currentUrl: null,
      })
      expect(r.level).toBe(1)
      expect(r.category).toBe('reversible_ui')
    })

    it('host in deniedDomains → level 4 prohibited', () => {
      const r = classifyAction({
        toolName: 'ComputerNavigate',
        input: { sessionId: 's1', url: 'https://evil.com/foo' },
        currentUrl: null,
        allowedDomains: [],
        deniedDomains: ['evil.com'],
      })
      expect(r.level).toBe(4)
      expect(r.category).toBe('prohibited')
      expect(r.reason).toContain('evil.com')
    })

    it('host in persistent allowedDomains → level 0 known_domain', () => {
      const r = classifyAction({
        toolName: 'ComputerNavigate',
        input: { sessionId: 's1', url: 'https://m.youtube.com/watch?v=x' },
        currentUrl: null,
        allowedDomains: ['*.youtube.com'],
        deniedDomains: [],
      })
      expect(r.level).toBe(0)
      expect(r.category).toBe('known_domain')
      expect(r.reason).toContain('m.youtube.com')
    })

    it('host in session overlay → level 0 known_domain (allow_once carry)', () => {
      const r = classifyAction({
        toolName: 'ComputerNavigate',
        input: { sessionId: 's1', url: 'https://example.com/' },
        currentUrl: null,
        allowedDomains: [],
        deniedDomains: [],
        sessionAllowedHosts: new Set(['example.com']),
      })
      expect(r.level).toBe(0)
      expect(r.category).toBe('known_domain')
      expect(r.reason).toContain('approved earlier this session')
    })

    it('unknown host → level 2 unknown_domain (cascade asks)', () => {
      const r = classifyAction({
        toolName: 'ComputerNavigate',
        input: { sessionId: 's1', url: 'https://www.youtube.com/' },
        currentUrl: null,
        allowedDomains: [],
        deniedDomains: [],
      })
      expect(r.level).toBe(2)
      expect(r.category).toBe('unknown_domain')
      expect(r.reason).toContain('www.youtube.com')
      expect(r.reason).toContain('not in computerUse.allowedDomains')
    })

    it('denied beats allowed (defense in depth)', () => {
      const r = classifyAction({
        toolName: 'ComputerNavigate',
        input: { sessionId: 's1', url: 'https://evil.example.com/' },
        currentUrl: null,
        allowedDomains: ['*.example.com'],
        deniedDomains: ['evil.example.com'],
      })
      expect(r.level).toBe(4)
      expect(r.category).toBe('prohibited')
    })

    it('unparseable URL → level 1 defer', () => {
      const r = classifyAction({
        toolName: 'ComputerNavigate',
        input: { sessionId: 's1', url: 'not a url' },
        currentUrl: null,
        allowedDomains: [],
        deniedDomains: [],
      })
      expect(r.level).toBe(1)
      expect(r.reason).toContain('unparseable URL')
    })
  })
})
