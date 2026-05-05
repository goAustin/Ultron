/**
 * Tavily Search API backend.
 *
 * Endpoint: POST https://api.tavily.com/search
 * Auth: API key in JSON body (api_key field), per Tavily docs.
 *
 * Free tier: 1000 queries/month. Tavily returns AI-tuned snippets that
 * are often more directly useful than raw web results, at the cost of
 * a smaller free quota.
 */

import https from 'node:https'
import type { SearchBackend, SearchOptions, SearchResult } from '../searchBackend.js'

export class TavilyBackendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TavilyBackendError'
  }
}
export class TavilyAuthError extends TavilyBackendError {
  constructor() {
    super('Tavily rejected the API key (HTTP 401)')
    this.name = 'TavilyAuthError'
  }
}
export class TavilyRateLimitError extends TavilyBackendError {
  constructor() {
    super('Tavily rate limit exceeded (HTTP 429)')
    this.name = 'TavilyRateLimitError'
  }
}

const HOST = 'api.tavily.com'
const PATH = '/search'
const TIMEOUT_MS = 30_000

type TavilyApiResult = {
  title?: string
  url?: string
  content?: string
}
type TavilyApiResponse = {
  results?: TavilyApiResult[]
}

export function createTavilyBackend(apiKey: string): SearchBackend {
  return {
    id: 'tavily',
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const limit = Math.max(1, Math.min(opts.limit ?? 10, 10))
      const json = await httpsPostJson({
        host: HOST,
        path: PATH,
        signal: opts.signal,
        body: {
          api_key: apiKey,
          query,
          max_results: limit,
          search_depth: 'basic',
          // Tavily's `time_range` accepts the same `day|week|month|year`
          // values we expose on the tool, so we pass it through verbatim.
          ...(opts.recency !== undefined && { time_range: opts.recency }),
        },
      })

      const parsed = json as TavilyApiResponse
      const results = parsed.results ?? []
      return results.slice(0, limit).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.content ?? '',
        unwrapped: true,
      }))
    },
  }
}

type PostOpts = {
  host: string
  path: string
  body: Record<string, unknown>
  signal: AbortSignal
}

async function httpsPostJson(opts: PostOpts): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new TavilyBackendError('aborted'))
      return
    }

    const payload = Buffer.from(JSON.stringify(opts.body), 'utf8')

    const req = https.request(
      {
        hostname: opts.host,
        path: opts.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.byteLength),
          'Accept': 'application/json',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Ultron/0.1 (+local CLI agent)',
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new TavilyAuthError())
            return
          }
          if (res.statusCode === 429) {
            reject(new TavilyRateLimitError())
            return
          }
          if (res.statusCode === undefined || res.statusCode >= 400) {
            reject(new TavilyBackendError(`Tavily HTTP ${res.statusCode ?? '?'}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch (err) {
            reject(new TavilyBackendError(`Tavily returned non-JSON: ${(err as Error).message}`))
          }
        })
      },
    )

    const onAbort = () => {
      req.destroy(new TavilyBackendError('aborted'))
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    req.on('timeout', () => {
      req.destroy(new TavilyBackendError('Tavily timed out'))
    })
    req.on('error', (err) => {
      opts.signal.removeEventListener('abort', onAbort)
      if (err instanceof TavilyBackendError) reject(err)
      else reject(new TavilyBackendError(err.message))
    })
    req.on('close', () => {
      opts.signal.removeEventListener('abort', onAbort)
    })

    req.write(payload)
    req.end()
  })
}
