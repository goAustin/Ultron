import { describe, expect, it } from 'vitest'

import { isDomainAllowed, isUrlSchemeAllowed } from './policy.js'

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
