/**
 * Brave Search API backend.
 *
 * Uses the public Web Search endpoint:
 *   https://api.search.brave.com/res/v1/web/search?q=<query>&count=<n>
 *
 * Free tier: 2000 queries/month with the Subscription Token header
 * (X-Subscription-Token). The key is read from BRAVE_SEARCH_API_KEY env
 * var or settings.json (resolved upstream in searchBackend.ts).
 *
 * Brave returns JSON; we hit the API directly via https.request so we
 * are not subject to fetcher.ts's HTML/text content-type allowlist.
 */

import https from 'node:https'
import type { SearchBackend, SearchOptions, SearchResult } from '../searchBackend.js'

export class BraveBackendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BraveBackendError'
  }
}
export class BraveAuthError extends BraveBackendError {
  constructor() {
    super('Brave Search rejected the API key (HTTP 401/403)')
    this.name = 'BraveAuthError'
  }
}
export class BraveRateLimitError extends BraveBackendError {
  constructor() {
    super('Brave Search rate limit exceeded (HTTP 429)')
    this.name = 'BraveRateLimitError'
  }
}

const HOST = 'api.search.brave.com'
const PATH_PREFIX = '/res/v1/web/search'
const TIMEOUT_MS = 30_000

type BraveApiResult = {
  title?: string
  url?: string
  description?: string
}
type BraveApiResponse = {
  web?: { results?: BraveApiResult[] }
}

export function createBraveBackend(apiKey: string): SearchBackend {
  return {
    id: 'brave',
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const limit = Math.max(1, Math.min(opts.limit ?? 10, 20))
      const params = new URLSearchParams({ q: query, count: String(limit) })
      const path = `${PATH_PREFIX}?${params.toString()}`

      const json = await httpsGetJson({
        host: HOST,
        path,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'identity',
          'X-Subscription-Token': apiKey,
          'User-Agent': 'Ultron/0.1 (+local CLI agent)',
        },
        signal: opts.signal,
      })

      const parsed = json as BraveApiResponse
      const results = parsed.web?.results ?? []
      return results.slice(0, limit).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? '',
        unwrapped: true,
      }))
    },
  }
}

type GetOpts = {
  host: string
  path: string
  headers: Record<string, string>
  signal: AbortSignal
}

async function httpsGetJson(opts: GetOpts): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new BraveBackendError('aborted'))
      return
    }

    const req = https.request(
      {
        hostname: opts.host,
        path: opts.path,
        method: 'GET',
        headers: opts.headers,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new BraveAuthError())
            return
          }
          if (res.statusCode === 429) {
            reject(new BraveRateLimitError())
            return
          }
          if (res.statusCode === undefined || res.statusCode >= 400) {
            reject(new BraveBackendError(`Brave Search HTTP ${res.statusCode ?? '?'}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch (err) {
            reject(new BraveBackendError(`Brave Search returned non-JSON: ${(err as Error).message}`))
          }
        })
      },
    )

    const onAbort = () => {
      req.destroy(new BraveBackendError('aborted'))
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    req.on('timeout', () => {
      req.destroy(new BraveBackendError('Brave Search timed out'))
    })
    req.on('error', (err) => {
      opts.signal.removeEventListener('abort', onAbort)
      if (err instanceof BraveBackendError) reject(err)
      else reject(new BraveBackendError(err.message))
    })
    req.on('close', () => {
      opts.signal.removeEventListener('abort', onAbort)
    })

    req.end()
  })
}
