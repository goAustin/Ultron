import { describe, it, expect } from 'vitest'
import {
  afterDateForRecency,
  parseDuckDuckGoHtml,
  unwrapDDGRedirect,
} from './duckduckgo.js'

describe('unwrapDDGRedirect', () => {
  it('extracts the real URL from a /l/?uddg= wrapper', () => {
    const wrapper =
      'https://duckduckgo.com/l/?uddg=' + encodeURIComponent('https://github.com/foo/bar')
    expect(unwrapDDGRedirect(wrapper)).toEqual({
      url: 'https://github.com/foo/bar',
      unwrapped: true,
    })
  })

  it('handles double-encoded uddg', () => {
    const inner = encodeURIComponent('https://example.com/path?x=1')
    const wrapper = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(inner)}`
    const got = unwrapDDGRedirect(wrapper)
    expect(got.url).toBe('https://example.com/path?x=1')
    expect(got.unwrapped).toBe(true)
  })

  it('normalizes scheme-relative wrapper hrefs', () => {
    const wrapper = '//duckduckgo.com/l/?uddg=' + encodeURIComponent('https://news.ycombinator.com/')
    const got = unwrapDDGRedirect(wrapper)
    expect(got.url).toBe('https://news.ycombinator.com/')
    expect(got.unwrapped).toBe(true)
  })

  it('falls back when uddg is missing', () => {
    const got = unwrapDDGRedirect('https://duckduckgo.com/l/?other=1')
    expect(got.unwrapped).toBe(false)
    expect(got.url).toContain('duckduckgo.com')
  })

  it('falls back when uddg is empty', () => {
    const got = unwrapDDGRedirect('https://duckduckgo.com/l/?uddg=')
    expect(got.unwrapped).toBe(false)
  })

  it('passes through non-redirect URLs', () => {
    const got = unwrapDDGRedirect('https://github.com/foo')
    expect(got.url).toBe('https://github.com/foo')
    expect(got.unwrapped).toBe(true)
  })

  it('falls back when uddg target is not http(s)', () => {
    const wrapper = 'https://duckduckgo.com/l/?uddg=' + encodeURIComponent('javascript:alert(1)')
    const got = unwrapDDGRedirect(wrapper)
    expect(got.unwrapped).toBe(false)
  })

  it('returns unwrapped=false for malformed input', () => {
    const got = unwrapDDGRedirect('not a url at all')
    expect(got.unwrapped).toBe(false)
    expect(got.url).toBe('not a url at all')
  })
})

describe('parseDuckDuckGoHtml', () => {
  const fixture = `
    <html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/a')}">First &amp; Title</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/a')}">Snippet for <b>first</b> result.</a>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.org/b')}">Second Title</a>
        <a class="result__snippet" href="...">Snippet two.</a>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.net/c')}">Third Title</a>
        <a class="result__snippet" href="...">Snippet three.</a>
      </div>
    </body></html>
  `

  it('extracts title, url, and snippet for each result', () => {
    const results = parseDuckDuckGoHtml(fixture, 10)
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({
      title: 'First & Title',
      url: 'https://example.com/a',
      snippet: 'Snippet for first result.',
      unwrapped: true,
    })
    expect(results[1].url).toBe('https://example.org/b')
    expect(results[2].url).toBe('https://example.net/c')
  })

  it('respects the limit parameter', () => {
    const results = parseDuckDuckGoHtml(fixture, 2)
    expect(results).toHaveLength(2)
  })

  it('decodes named and numeric HTML entities', () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://e.com/')}">A &amp; B &#62; C</a>
      <a class="result__snippet" href="...">Snippet</a>
    `
    const got = parseDuckDuckGoHtml(html, 10)
    expect(got[0].title).toBe('A & B > C')
  })

  it('handles results with no snippet (empty string)', () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://e.com/')}">Lone Title</a>
    `
    const got = parseDuckDuckGoHtml(html, 10)
    expect(got[0].title).toBe('Lone Title')
    expect(got[0].snippet).toBe('')
  })

  it('returns empty array on input with no results', () => {
    expect(parseDuckDuckGoHtml('<html><body>no results</body></html>', 10)).toEqual([])
  })
})

describe('afterDateForRecency', () => {
  // Fixed clock at 2026-05-04 noon UTC so the rolling-window math is
  // deterministic regardless of the developer's wall clock.
  const NOON_2026_05_04 = Date.UTC(2026, 4, 4, 12, 0, 0)

  it('day → yesterday', () => {
    expect(afterDateForRecency('day', NOON_2026_05_04)).toBe('2026-05-03')
  })

  it('week → seven days ago', () => {
    expect(afterDateForRecency('week', NOON_2026_05_04)).toBe('2026-04-27')
  })

  it('month → thirty days ago', () => {
    expect(afterDateForRecency('month', NOON_2026_05_04)).toBe('2026-04-04')
  })

  it('year → 365 days ago', () => {
    expect(afterDateForRecency('year', NOON_2026_05_04)).toBe('2025-05-04')
  })

  it('returns ISO YYYY-MM-DD format (no time component)', () => {
    expect(afterDateForRecency('week', NOON_2026_05_04)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
