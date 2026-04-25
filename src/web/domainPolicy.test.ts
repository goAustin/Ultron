import { describe, expect, it } from 'vitest'
import { extractHost, isValidDomainPattern, matchDomain } from './domainPolicy.js'

describe('extractHost', () => {
  it('returns lowercased host', () => {
    expect(extractHost('https://github.com/foo')).toBe('github.com')
    expect(extractHost('https://GitHub.com/foo')).toBe('github.com')
    expect(extractHost('https://API.GitHub.COM/x')).toBe('api.github.com')
  })

  it('strips port', () => {
    expect(extractHost('https://github.com:8080/foo')).toBe('github.com')
  })

  it('rejects URLs with userinfo', () => {
    expect(extractHost('https://user:pass@github.com/foo')).toBeNull()
    expect(extractHost('https://user@github.com/foo')).toBeNull()
  })

  it('returns null for unparseable URLs', () => {
    expect(extractHost('not-a-url')).toBeNull()
    expect(extractHost('')).toBeNull()
    expect(extractHost('http:')).toBeNull()
  })

  it('handles IPv6 literal', () => {
    expect(extractHost('https://[::1]/')).toBe('[::1]')
  })
})

describe('isValidDomainPattern', () => {
  it('accepts exact hosts', () => {
    expect(isValidDomainPattern('github.com')).toBe(true)
    expect(isValidDomainPattern('a.b.example.com')).toBe(true)
    expect(isValidDomainPattern('x-y.example.com')).toBe(true)
  })

  it('accepts leftmost wildcard', () => {
    expect(isValidDomainPattern('*.github.com')).toBe(true)
    expect(isValidDomainPattern('*.a.b.example.com')).toBe(true)
  })

  it('rejects bare wildcard', () => {
    expect(isValidDomainPattern('*')).toBe(false)
  })

  it('rejects multi-wildcard patterns', () => {
    expect(isValidDomainPattern('*.*.example.com')).toBe(false)
    expect(isValidDomainPattern('a.*.example.com')).toBe(false)
  })

  it('rejects empty', () => {
    expect(isValidDomainPattern('')).toBe(false)
  })

  it('rejects single-label hosts', () => {
    expect(isValidDomainPattern('localhost')).toBe(false)
  })

  it('rejects patterns with whitespace', () => {
    expect(isValidDomainPattern(' github.com')).toBe(false)
    expect(isValidDomainPattern('github .com')).toBe(false)
  })

  it('rejects malformed labels', () => {
    expect(isValidDomainPattern('-bad.com')).toBe(false)
    expect(isValidDomainPattern('bad-.com')).toBe(false)
    expect(isValidDomainPattern('a..b.com')).toBe(false)
    expect(isValidDomainPattern('*.')).toBe(false)
  })
})

describe('matchDomain', () => {
  it('matches exact host', () => {
    expect(matchDomain('github.com', 'github.com')).toBe(true)
    expect(matchDomain('github.com', 'a.github.com')).toBe(false)
    expect(matchDomain('github.com', 'evil.com')).toBe(false)
  })

  it('matches subdomains for *.suffix', () => {
    expect(matchDomain('*.github.com', 'a.github.com')).toBe(true)
    expect(matchDomain('*.github.com', 'a.b.github.com')).toBe(true)
  })

  it('excludes apex from *.suffix', () => {
    expect(matchDomain('*.github.com', 'github.com')).toBe(false)
  })

  it('does not match unrelated suffixes', () => {
    expect(matchDomain('*.github.com', 'evilgithub.com')).toBe(false)
    expect(matchDomain('*.github.com', 'evil.com')).toBe(false)
    expect(matchDomain('*.github.com', 'githubXcom')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(matchDomain('GitHub.com', 'github.com')).toBe(true)
    expect(matchDomain('*.GITHUB.com', 'a.GitHub.com')).toBe(true)
  })
})
