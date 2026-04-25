/**
 * DuckDuckGo HTML backend — no API key, no signup.
 *
 * Calls https://html.duckduckgo.com/html/?q=<query>, parses the response
 * with a regex extractor (mirrors htmlToText.ts's "good enough" posture
 * — not a full HTML parser, sufficient for an LLM to read).
 *
 * Critical: DDG wraps every result href as
 *   https://duckduckgo.com/l/?uddg=<percent-encoded-target>&rut=...
 * The parser extracts and percent-decodes `uddg` so SearchResult.url is
 * the actual destination. Without this, every result would report host
 * `duckduckgo.com` and downstream WebFetch domain rules would be
 * useless. When `uddg` is absent or unparseable, the parser falls back
 * to the wrapper URL with `unwrapped: false` flagged.
 *
 * Network is via fetchWeb (Phase 6a) — inherits SSRF protection,
 * redirect re-check, content-type allowlist, and 30 s timeout.
 */

import { fetchWeb, WebFetchTimeoutError } from '../fetcher.js'
import type { SearchBackend, SearchOptions, SearchResult } from '../searchBackend.js'

const DDG_HTML_HOST = 'html.duckduckgo.com'
const DDG_REDIRECT_HOST = 'duckduckgo.com'

export class DuckDuckGoBackendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DuckDuckGoBackendError'
  }
}

/**
 * Permissive checkPolicy used for DDG's own request: DDG hosts are
 * always allowed regardless of user rules. Users who want to disable
 * web search entirely add a deny rule on `WebSearch` (the tool itself),
 * not on duckduckgo.com (which would also break the no-key default).
 */
function alwaysAllowDDG(host: string): 'allow' | 'deny' | 'ask' {
  return host === DDG_HTML_HOST || host === DDG_REDIRECT_HOST ? 'allow' : 'ask'
}

export function createDuckDuckGoBackend(): SearchBackend {
  return {
    id: 'duckduckgo',
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const url = `https://${DDG_HTML_HOST}/html/?q=${encodeURIComponent(query)}&kl=us-en`
      let body: string
      try {
        const result = await fetchWeb(url, {
          signal: opts.signal,
          checkPolicy: alwaysAllowDDG,
        })
        body = result.body
      } catch (err) {
        if (err instanceof WebFetchTimeoutError) {
          throw new DuckDuckGoBackendError('DuckDuckGo timed out')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new DuckDuckGoBackendError(`DuckDuckGo request failed: ${msg}`)
      }

      const limit = opts.limit ?? 10
      return parseDuckDuckGoHtml(body, limit)
    },
  }
}

/**
 * Extract result blocks from DDG HTML. Each result has the shape:
 *
 *   <a class="result__a" href="...uddg=...">TITLE</a>
 *   ...
 *   <a class="result__snippet" ...>SNIPPET</a>
 *
 * Exported for tests against recorded fixtures.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  // Match anchor tags with class result__a (title + href) and capture both.
  // The href is the wrapper URL we'll unwrap.
  const titleRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  // Snippets — match anything with class containing result__snippet.
  const snippetRe = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g

  const titleMatches: Array<{ href: string; title: string }> = []
  let m: RegExpExecArray | null
  while ((m = titleRe.exec(html)) !== null) {
    titleMatches.push({ href: m[1], title: stripTags(decodeEntities(m[2])).trim() })
    if (titleMatches.length >= limit) break
  }

  const snippetMatches: string[] = []
  while ((m = snippetRe.exec(html)) !== null) {
    snippetMatches.push(stripTags(decodeEntities(m[1])).trim())
    if (snippetMatches.length >= limit) break
  }

  for (let i = 0; i < titleMatches.length; i++) {
    const { href, title } = titleMatches[i]
    const snippet = snippetMatches[i] ?? ''
    const unwrap = unwrapDDGRedirect(href)
    results.push({
      title,
      url: unwrap.url,
      snippet,
      unwrapped: unwrap.unwrapped,
    })
  }

  return results
}

/**
 * Extract the real target URL from a DDG `/l/?uddg=...` redirect
 * wrapper. Returns the canonicalized target on success, falls back to
 * the original href with `unwrapped: false` on failure.
 *
 * Exported for tests.
 */
export function unwrapDDGRedirect(href: string): { url: string; unwrapped: boolean } {
  // DDG's hrefs are sometimes scheme-relative (`//duckduckgo.com/l/?...`).
  // Normalize to absolute https for URL parsing. Only use the DDG base
  // for scheme-relative inputs — bare strings like "not a url" must NOT
  // be silently resolved against duckduckgo.com.
  const normalized = href.startsWith('//') ? `https:${href}` : href

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return { url: href, unwrapped: false }
  }

  // Only unwrap if it's actually a DDG redirect URL.
  if (parsed.hostname !== DDG_REDIRECT_HOST || parsed.pathname !== '/l/') {
    return { url: parsed.toString(), unwrapped: true }
  }

  const uddg = parsed.searchParams.get('uddg')
  if (uddg === null || uddg === '') {
    return { url: parsed.toString(), unwrapped: false }
  }

  // uddg is already decoded by URLSearchParams.get(), but DDG sometimes
  // double-encodes. Try a second decode pass; if it fails, use what we have.
  let target = uddg
  try {
    const second = decodeURIComponent(uddg)
    if (second !== uddg && /^https?:\/\//i.test(second)) {
      target = second
    }
  } catch {
    // Malformed percent-sequence; keep the first-pass decode.
  }

  if (!/^https?:\/\//i.test(target)) {
    return { url: parsed.toString(), unwrapped: false }
  }

  return { url: target, unwrapped: true }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}
