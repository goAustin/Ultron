import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  validateComputerUseSettings,
  defaultComputerUseSettings,
  derivePersistencePatterns,
  type ComputerUseSettings,
} from './computerUseSettings.js'

// vi.spyOn(process.stderr, 'write') — keep the spy loosely typed; the SDK's
// MockInstance generic doesn't accept the method overload shape directly.
// Same workaround as src/core/providers/warnOnce.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any

describe('validateComputerUseSettings', () => {
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('returns defaults for undefined input with no warnings', () => {
    const out = validateComputerUseSettings(undefined)
    expect(out).toEqual(defaultComputerUseSettings)
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('returns a fresh viewport object so mutating the result does not poison defaults', () => {
    const out = validateComputerUseSettings(undefined) as ComputerUseSettings
    expect(out.viewport).not.toBe(defaultComputerUseSettings.viewport)
  })

  it('passes a fully-valid input through unchanged', () => {
    const valid = {
      enabled: true,
      defaultEnvironment: 'browser' as const,
      viewport: { width: 1280, height: 720 },
      displaySize: { width: 1024, height: 768 },
      maxSteps: 50,
      maxDurationMs: 600_000,
      maxScreenshotBytes: 3_000_000,
      maxScreenshotDimensions: { width: 1280, height: 800 },
      ariaSnapshotMaxTokens: 8000,
      allowedDomains: ['example.com'],
      deniedDomains: ['evil.com'],
      persistProfiles: true,
      allowDownloads: true,
      allowUploads: true,
      allowAuthHandoff: true,
      debugPersistScreenshots: true,
      redactionSelectors: ['.secret-input'],
      verifyActions: false,
      watchMode: true,
      requireAllowlistAtStart: true,
      cdpAssumeVisible: true,
    }
    const out = validateComputerUseSettings(valid)
    expect(out).toEqual(valid)
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['string', 'not-an-object'],
    ['number', 42],
    ['array', []],
  ])('non-object root (%s) warns once and returns defaults', (_label, raw) => {
    const out = validateComputerUseSettings(raw)
    expect(out).toEqual(defaultComputerUseSettings)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('non-boolean enabled warns and falls back to default false', () => {
    const out = validateComputerUseSettings({ enabled: 'yes' })
    expect(out.enabled).toBe(false)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('out-of-range viewport.width warns and falls back; sibling height is unaffected', () => {
    const out = validateComputerUseSettings({
      viewport: { width: -1, height: 720 },
    })
    expect(out.viewport).toEqual({ width: 1024, height: 720 })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('non-integer viewport.width warns and falls back', () => {
    const out = validateComputerUseSettings({ viewport: { width: 1024.5 } })
    expect(out.viewport.width).toBe(1024)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('non-object viewport warns once and falls back to default object', () => {
    const out = validateComputerUseSettings({ viewport: 'huge' })
    expect(out.viewport).toEqual({ width: 1024, height: 768 })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('maxSteps = 0 warns and falls back to default 30', () => {
    const out = validateComputerUseSettings({ maxSteps: 0 })
    expect(out.maxSteps).toBe(30)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('maxScreenshotDimensions exceeding the 1280x800 cap warns and falls back', () => {
    const out = validateComputerUseSettings({
      maxScreenshotDimensions: { width: 9999, height: 9999 },
    })
    expect(out.maxScreenshotDimensions).toEqual({ width: 1024, height: 768 })
    expect(stderrSpy).toHaveBeenCalledTimes(2) // one per leaf
  })

  it('maxScreenshotDimensions accepts the cap exactly', () => {
    const out = validateComputerUseSettings({
      maxScreenshotDimensions: { width: 1280, height: 800 },
    })
    expect(out.maxScreenshotDimensions).toEqual({ width: 1280, height: 800 })
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('defaultEnvironment must be browser or desktop', () => {
    const out = validateComputerUseSettings({ defaultEnvironment: 'mobile' })
    expect(out.defaultEnvironment).toBe('browser')
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('allowedDomains: lowercases valid entries and drops bad ones individually', () => {
    const out = validateComputerUseSettings({
      allowedDomains: ['Good.COM', 42, 'bad..com', 'github.com'],
    })
    expect(out.allowedDomains).toEqual(['good.com', 'github.com'])
    expect(stderrSpy).toHaveBeenCalledTimes(2) // one for the number, one for bad..com
  })

  it('non-array allowedDomains warns and falls back to empty list', () => {
    const out = validateComputerUseSettings({ allowedDomains: 'just-one.com' })
    expect(out.allowedDomains).toEqual([])
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('deniedDomains follows the same rules as allowedDomains', () => {
    const out = validateComputerUseSettings({ deniedDomains: ['EVIL.com'] })
    expect(out.deniedDomains).toEqual(['evil.com'])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('one bad leaf does not poison sibling leaves', () => {
    const out = validateComputerUseSettings({
      enabled: 'yes', // bad → default false
      maxSteps: 50, // good → kept
      allowedDomains: ['kept.com'], // good → kept (lowercased)
    })
    expect(out.enabled).toBe(false)
    expect(out.maxSteps).toBe(50)
    expect(out.allowedDomains).toEqual(['kept.com'])
    expect(stderrSpy).toHaveBeenCalledTimes(1) // only `enabled`
  })

  it('non-boolean persistProfiles / allowDownloads / allowUploads / allowAuthHandoff / debugPersistScreenshots all warn and default to false', () => {
    const out = validateComputerUseSettings({
      persistProfiles: 1,
      allowDownloads: 'yes',
      allowUploads: null,
      allowAuthHandoff: 'true',
      debugPersistScreenshots: [],
    })
    expect(out.persistProfiles).toBe(false)
    expect(out.allowDownloads).toBe(false)
    expect(out.allowUploads).toBe(false)
    expect(out.allowAuthHandoff).toBe(false)
    expect(out.debugPersistScreenshots).toBe(false)
    expect(stderrSpy).toHaveBeenCalledTimes(5)
  })

  // -------------------------------------------------------------------------
  // Phase 4·2 settings — redactionSelectors + verifyActions
  // -------------------------------------------------------------------------

  describe('redactionSelectors (Phase 4·2)', () => {
    it('defaults to []', () => {
      expect(validateComputerUseSettings({}).redactionSelectors).toEqual([])
    })

    it('accepts an array of CSS selectors', () => {
      const out = validateComputerUseSettings({
        redactionSelectors: ['.secret', '#card-number', 'input[data-sensitive]'],
      })
      expect(out.redactionSelectors).toEqual([
        '.secret',
        '#card-number',
        'input[data-sensitive]',
      ])
    })

    it('warns and falls back to [] when not an array', () => {
      const out = validateComputerUseSettings({ redactionSelectors: '.secret' })
      expect(out.redactionSelectors).toEqual([])
      expect(stderrSpy).toHaveBeenCalled()
    })

    it('skips non-string entries with a warn', () => {
      const out = validateComputerUseSettings({
        redactionSelectors: ['.kept', 42, null, '#also-kept'],
      })
      expect(out.redactionSelectors).toEqual(['.kept', '#also-kept'])
      expect(stderrSpy).toHaveBeenCalledTimes(2)
    })

    it('trims and skips empty / whitespace-only entries', () => {
      const out = validateComputerUseSettings({
        redactionSelectors: ['  .padded  ', '', '   ', '.kept'],
      })
      expect(out.redactionSelectors).toEqual(['.padded', '.kept'])
    })

    it('deduplicates exact-match entries', () => {
      const out = validateComputerUseSettings({
        redactionSelectors: ['.dup', '.dup', '.unique'],
      })
      expect(out.redactionSelectors).toEqual(['.dup', '.unique'])
    })
  })

  describe('verifyActions (Phase 4·2)', () => {
    it('defaults to true', () => {
      expect(validateComputerUseSettings({}).verifyActions).toBe(true)
    })

    it('accepts true / false', () => {
      expect(validateComputerUseSettings({ verifyActions: true }).verifyActions).toBe(true)
      expect(validateComputerUseSettings({ verifyActions: false }).verifyActions).toBe(false)
    })

    it('warns and defaults to true when non-boolean', () => {
      expect(validateComputerUseSettings({ verifyActions: 'yes' }).verifyActions).toBe(true)
      expect(stderrSpy).toHaveBeenCalled()
    })
  })

  describe('watchMode (Phase 4·3)', () => {
    it('defaults to false', () => {
      expect(validateComputerUseSettings({}).watchMode).toBe(false)
    })

    it('accepts true / false', () => {
      expect(validateComputerUseSettings({ watchMode: true }).watchMode).toBe(true)
      expect(validateComputerUseSettings({ watchMode: false }).watchMode).toBe(false)
    })

    it('warns and defaults to false when non-boolean', () => {
      expect(validateComputerUseSettings({ watchMode: 'on' }).watchMode).toBe(false)
      expect(stderrSpy).toHaveBeenCalled()
    })
  })

  describe('requireAllowlistAtStart (domain-prompt UX)', () => {
    it('defaults to false', () => {
      expect(validateComputerUseSettings({}).requireAllowlistAtStart).toBe(false)
    })

    it('accepts true / false', () => {
      expect(
        validateComputerUseSettings({ requireAllowlistAtStart: true }).requireAllowlistAtStart,
      ).toBe(true)
      expect(
        validateComputerUseSettings({ requireAllowlistAtStart: false }).requireAllowlistAtStart,
      ).toBe(false)
    })

    it('warns and defaults to false when non-boolean', () => {
      expect(
        validateComputerUseSettings({ requireAllowlistAtStart: 'yes' }).requireAllowlistAtStart,
      ).toBe(false)
      expect(stderrSpy).toHaveBeenCalled()
    })
  })

  describe('cdpEndpoint (CDP backend)', () => {
    it('defaults to undefined (omitted)', () => {
      const out = validateComputerUseSettings({})
      expect(out.cdpEndpoint).toBeUndefined()
      expect(stderrSpy).not.toHaveBeenCalled()
    })

    it('accepts http://127.0.0.1:9222', () => {
      const out = validateComputerUseSettings({ cdpEndpoint: 'http://127.0.0.1:9222' })
      expect(out.cdpEndpoint).toBe('http://127.0.0.1:9222/')
      expect(stderrSpy).not.toHaveBeenCalled()
    })

    it('accepts https:// and ws:// and wss://', () => {
      expect(
        validateComputerUseSettings({ cdpEndpoint: 'https://localhost:9222' }).cdpEndpoint,
      ).toBe('https://localhost:9222/')
      expect(
        validateComputerUseSettings({ cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc' })
          .cdpEndpoint,
      ).toBe('ws://127.0.0.1:9222/devtools/browser/abc')
      expect(
        validateComputerUseSettings({ cdpEndpoint: 'wss://example.com:9222' }).cdpEndpoint,
      ).toBe('wss://example.com:9222/')
      expect(stderrSpy).not.toHaveBeenCalled()
    })

    it('rejects non-string with a warn', () => {
      const out = validateComputerUseSettings({ cdpEndpoint: 9222 })
      expect(out.cdpEndpoint).toBeUndefined()
      expect(stderrSpy).toHaveBeenCalledTimes(1)
    })

    it('rejects empty string with a warn', () => {
      const out = validateComputerUseSettings({ cdpEndpoint: '' })
      expect(out.cdpEndpoint).toBeUndefined()
      expect(stderrSpy).toHaveBeenCalledTimes(1)
    })

    it('rejects malformed URL with a warn', () => {
      const out = validateComputerUseSettings({ cdpEndpoint: 'not a url' })
      expect(out.cdpEndpoint).toBeUndefined()
      expect(stderrSpy).toHaveBeenCalledTimes(1)
    })

    it('rejects javascript: scheme with a warn', () => {
      const out = validateComputerUseSettings({ cdpEndpoint: 'javascript:alert(1)' })
      expect(out.cdpEndpoint).toBeUndefined()
      expect(stderrSpy).toHaveBeenCalledTimes(1)
    })

    it('rejects file: scheme with a warn', () => {
      const out = validateComputerUseSettings({ cdpEndpoint: 'file:///tmp/x' })
      expect(out.cdpEndpoint).toBeUndefined()
      expect(stderrSpy).toHaveBeenCalledTimes(1)
    })
  })
})

describe('derivePersistencePatterns', () => {
  it('strips leading www. and returns [apex, *.apex]', () => {
    expect(derivePersistencePatterns('www.youtube.com')).toEqual([
      'youtube.com',
      '*.youtube.com',
    ])
  })

  it('returns [apex, *.apex] when no www. prefix', () => {
    expect(derivePersistencePatterns('youtube.com')).toEqual(['youtube.com', '*.youtube.com'])
  })

  it('does NOT strip non-www subdomains (narrower scope is intentional)', () => {
    expect(derivePersistencePatterns('studio.youtube.com')).toEqual([
      'studio.youtube.com',
      '*.studio.youtube.com',
    ])
  })

  it('lowercases the input', () => {
    expect(derivePersistencePatterns('WWW.YouTube.com')).toEqual([
      'youtube.com',
      '*.youtube.com',
    ])
  })

  it('returns [apex, *.apex] for eTLD hosts (over-broad; documented limitation)', () => {
    // No PSL — github.io is treated as a regular domain, producing a wildcard
    // that matches all of GitHub Pages. Documented in the design doc.
    expect(derivePersistencePatterns('github.io')).toEqual(['github.io', '*.github.io'])
  })

  it('returns [] for empty input', () => {
    expect(derivePersistencePatterns('')).toEqual([])
  })

  it('returns [] for whitespace input (fails isValidDomainPattern)', () => {
    expect(derivePersistencePatterns(' ')).toEqual([])
  })

  it('drops the apex when single-label (apex fails isValidDomainPattern; wildcard form passes)', () => {
    // 'localhost' has only one label → fails the pattern check; '*.localhost'
    // has two labels → passes. Output is just the wildcard. This is a
    // degenerate edge — `localhost` itself never appears in production
    // settings — but we lock in the current shape so a future helper change
    // is intentional.
    expect(derivePersistencePatterns('localhost')).toEqual(['*.localhost'])
  })
})
