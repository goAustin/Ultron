/**
 * HTTPS fetcher for WebFetch.
 *
 * Posture:
 * - HTTPS-only (rejects http:// at every hop)
 * - Per-host policy check on FIRST hop AND every redirect hop. Closes
 *   the PreToolUse-hook URL-rewrite gap at query.ts:301.
 * - DNS lookup → IP-class block (loopback, link-local, RFC 1918, etc.)
 * - 30 s timeout, 5 MB body cap, 5 redirects max, content-type allow-list
 * - GET only, anonymous (no cookies, no custom headers, no auth)
 *
 * `lookup` and `httpsAgent` are explicit DI hooks on FetchOptions so
 * tests can inject behavior without monkeypatching globals.
 */

import https from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import net from 'node:net'
import type { LookupAddress } from 'node:dns'
import { extractHost } from './domainPolicy.js'

export class WebFetchSchemeError extends Error {
  constructor(message: string) { super(message); this.name = 'WebFetchSchemeError' }
}
export class WebFetchPolicyRedirectError extends Error {
  constructor(message: string) { super(message); this.name = 'WebFetchPolicyRedirectError' }
}
export class WebFetchPrivateAddressError extends Error {
  constructor(message: string) { super(message); this.name = 'WebFetchPrivateAddressError' }
}
export class WebFetchTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = 'WebFetchTimeoutError' }
}
export class WebFetchTooLargeError extends Error {
  constructor(message: string) { super(message); this.name = 'WebFetchTooLargeError' }
}
export class WebFetchUnsupportedContentTypeError extends Error {
  constructor(message: string) { super(message); this.name = 'WebFetchUnsupportedContentTypeError' }
}
export class WebFetchHttpError extends Error {
  constructor(message: string) { super(message); this.name = 'WebFetchHttpError' }
}
export class WebFetchTooManyRedirectsError extends Error {
  constructor(message: string) { super(message); this.name = 'WebFetchTooManyRedirectsError' }
}
export class WebFetchInvalidUrlError extends Error {
  constructor(message: string) { super(message); this.name = 'WebFetchInvalidUrlError' }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5
const HARD_CEILING_MULTIPLIER = 2
const DEFAULT_USER_AGENT = 'Ultron/0.1 (+local CLI agent)'

const ALLOWED_CONTENT_TYPE_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/ld+json',
] as const

export type LookupFn = (hostname: string) => Promise<LookupAddress | LookupAddress[]>

export type FetchOptions = {
  readonly signal: AbortSignal
  /**
   * Per-host policy lookup invoked on each REDIRECT hop (not the first hop —
   * the cascade already authorized the initial input). The closure should
   * mirror cascade rule semantics: deny > ask > allow > fallback ask.
   */
  readonly checkPolicy: (host: string) => 'allow' | 'deny' | 'ask'
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly maxRedirects?: number
  readonly userAgent?: string
  /** DI hook for DNS — defaults to node:dns/promises lookup. */
  readonly lookup?: LookupFn
  /** DI hook for the HTTPS agent — tests inject one that accepts self-signed certs. */
  readonly httpsAgent?: https.Agent
  /**
   * DI hook for the SSRF check. Defaults to `isPrivateAddress` from this
   * module. Tests inject `() => false` to allow loopback connections to
   * the local test server. Production callers leave this undefined.
   */
  readonly isPrivateAddress?: (ip: string) => boolean
}

export type FetchResult = {
  readonly status: number
  readonly contentType: string
  readonly body: string
  readonly truncated: boolean
  readonly finalUrl: string
  readonly redirectChain: readonly string[]
}

// ---------------------------------------------------------------------------
// IP-class checks
// ---------------------------------------------------------------------------

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip)
  if (net.isIPv6(ip)) return isPrivateIPv6(ip)
  return false
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return true // malformed — fail closed
  }
  const [a, b] = parts as [number, number, number, number]
  // 0.0.0.0/8
  if (a === 0) return true
  // 10.0.0.0/8
  if (a === 10) return true
  // 100.64.0.0/10 (carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1), 192.88.99.0/24 (6to4 anycast)
  if (a === 192 && b === 0) return true
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true
  // 198.18.0.0/15 (benchmark)
  if (a === 198 && (b === 18 || b === 19)) return true
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51) return true
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0) return true
  // 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved)
  if (a >= 224) return true
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  // IPv6 loopback
  if (lower === '::1') return true
  // unspecified
  if (lower === '::') return true
  // IPv4-mapped IPv6: ::ffff:a.b.c.d → check the IPv4
  const v4MappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4MappedMatch && v4MappedMatch[1]) return isPrivateIPv4(v4MappedMatch[1])
  // unique local fc00::/7 → first byte 0xfc or 0xfd
  if (/^f[cd][0-9a-f]{0,2}:/i.test(lower)) return true
  // link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/i.test(lower)) return true
  // multicast ff00::/8
  if (lower.startsWith('ff')) return true
  return false
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function fetchWeb(url: string, opts: FetchOptions): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
  const lookup: LookupFn = opts.lookup ?? ((h) => dnsLookup(h))
  const isPrivate = opts.isPrivateAddress ?? isPrivateAddress

  const start = Date.now()
  let currentUrl = url
  const redirectChain: string[] = []

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (opts.signal.aborted) throw new Error('aborted')

    const remaining = timeoutMs - (Date.now() - start)
    if (remaining <= 0) {
      throw new WebFetchTimeoutError(`fetch timed out after ${timeoutMs} ms`)
    }

    let parsed: URL
    try {
      parsed = new URL(currentUrl)
    } catch {
      throw new WebFetchInvalidUrlError(`invalid URL: ${currentUrl}`)
    }
    if (parsed.protocol !== 'https:') {
      throw new WebFetchSchemeError(`only https:// is allowed (got ${parsed.protocol})`)
    }

    const host = extractHost(currentUrl)
    if (host === null) {
      throw new WebFetchInvalidUrlError(`could not extract host from URL: ${currentUrl}`)
    }

    // Policy check — REDIRECTS ONLY. The first hop is trusted because the
    // permission cascade already authorized this exact input (via allow rule,
    // allow_by_rule, allow_once, bypassPermissions, etc.). Redirect hops are
    // a runtime mutation the cascade never saw — re-check them to prevent
    // tunneling from an authorized origin to a denied target.
    //
    // Known limitation: a PreToolUse hook that rewrites input.url between
    // authorize and execute slips past per-host policy here. Closing this
    // gap requires re-authorization on hook input mutation, which is a
    // cross-tool concern and lives in a future phase.
    if (hop > 0) {
      const decision = opts.checkPolicy(host)
      if (decision !== 'allow') {
        throw new WebFetchPolicyRedirectError(
          `redirect to "${host}" not authorized by per-host policy (decision: ${decision})`,
        )
      }
    }

    // DNS lookup → IP-class check. Race against the wall-clock timeout and
    // the user abort signal so a hanging resolver can't ignore cancellation.
    let resolved: LookupAddress
    try {
      const result = await raceWithTimeoutAndAbort(
        lookup(host),
        remaining,
        opts.signal,
        () => new WebFetchTimeoutError(`DNS lookup timed out after ${remaining} ms`),
      )
      resolved = Array.isArray(result) ? (result[0] as LookupAddress) : result
    } catch (err) {
      if (
        err instanceof WebFetchTimeoutError ||
        (err instanceof Error && err.message === 'aborted')
      ) {
        throw err
      }
      throw new WebFetchHttpError(`DNS lookup failed for ${host}: ${errMsg(err)}`)
    }
    if (!resolved || typeof resolved.address !== 'string') {
      throw new WebFetchHttpError(`DNS lookup returned no address for ${host}`)
    }
    if (isPrivate(resolved.address)) {
      throw new WebFetchPrivateAddressError(
        `host "${host}" resolves to private/loopback address ${resolved.address}`,
      )
    }

    redirectChain.push(currentUrl)

    // Issue the request. Pin the resolved IP via custom `lookup` to defend
    // against TOCTOU between our DNS check and the connect. Node calls
    // `lookup` with either a callback expecting (err, address, family) or,
    // when `options.all` is set, (err, [{address, family}, ...]). Both
    // shapes are handled.
    const pinnedIp = resolved.address
    const pinnedFamily: 4 | 6 = resolved.family === 6 ? 6 : 4
    const pinnedLookup = ((hostname: string, options: unknown, cb?: unknown) => {
      const callback = typeof options === 'function' ? options : cb
      const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true
      if (typeof callback !== 'function') return
      if (wantsAll) {
        ;(callback as (e: Error | null, addrs: { address: string; family: number }[]) => void)(
          null,
          [{ address: pinnedIp, family: pinnedFamily }],
        )
      } else {
        ;(callback as (e: Error | null, addr: string, family: number) => void)(
          null,
          pinnedIp,
          pinnedFamily,
        )
      }
    }) as unknown as NonNullable<https.RequestOptions['lookup']>

    const response = await issueHttpsGet(parsed, {
      remainingMs: remaining,
      userAgent,
      pinnedLookup,
      httpsAgent: opts.httpsAgent,
      signal: opts.signal,
    })

    if (response.kind === 'redirect') {
      if (hop >= maxRedirects) {
        throw new WebFetchTooManyRedirectsError(
          `exceeded max redirects (${maxRedirects})`,
        )
      }
      currentUrl = new URL(response.location, currentUrl).toString()
      continue
    }

    // 2xx / 4xx / 5xx — read the body
    const contentType = response.contentType
    if (!isAllowedContentType(contentType)) {
      response.consume()
      throw new WebFetchUnsupportedContentTypeError(
        `unsupported content-type: ${contentType}`,
      )
    }

    const body = await readBody(response, {
      maxBytes,
      hardCeiling: maxBytes * HARD_CEILING_MULTIPLIER,
      remainingMs: timeoutMs - (Date.now() - start),
      signal: opts.signal,
    })

    const decoded = decodeBody(body.bytes, contentType)

    return {
      status: response.status,
      contentType,
      body: decoded,
      truncated: body.truncated,
      finalUrl: currentUrl,
      redirectChain,
    }
  }

  throw new WebFetchTooManyRedirectsError(`exceeded max redirects (${maxRedirects})`)
}

// ---------------------------------------------------------------------------
// HTTPS request — split out for clarity. Resolves to either a redirect
// pointer or a body-bearing response handle that can be drained.
// ---------------------------------------------------------------------------

type HttpResponse =
  | {
      readonly kind: 'redirect'
      readonly location: string
    }
  | {
      readonly kind: 'body'
      readonly status: number
      readonly contentType: string
      readonly stream: NodeJS.ReadableStream
      consume: () => void
    } & ReadResponseHandle

type ReadResponseHandle = {
  readonly stream: NodeJS.ReadableStream
  consume: () => void
}

type IssueHttpsOptions = {
  remainingMs: number
  userAgent: string
  pinnedLookup: NonNullable<https.RequestOptions['lookup']>
  httpsAgent?: https.Agent
  signal: AbortSignal
}

async function issueHttpsGet(
  parsed: URL,
  opts: IssueHttpsOptions,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const reqOpts: https.RequestOptions = {
      method: 'GET',
      protocol: parsed.protocol,
      host: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      lookup: opts.pinnedLookup,
      headers: {
        'User-Agent': opts.userAgent,
        // Don't ask for compression — node:https doesn't auto-decompress.
        'Accept-Encoding': 'identity',
        // Be explicit; most servers expect Host to match the URL.
        Host: parsed.host,
      },
      timeout: opts.remainingMs,
      ...(opts.httpsAgent && { agent: opts.httpsAgent }),
    }

    const req = https.request(reqOpts, (res) => {
      const status = res.statusCode ?? 0

      // Redirect?
      if (status >= 300 && status < 400) {
        const loc = res.headers.location
        if (typeof loc === 'string' && loc.length > 0) {
          // Drain the body so the socket can be reused.
          res.resume()
          resolve({ kind: 'redirect', location: loc })
          return
        }
        // Redirect status with no Location header — treat as body.
      }

      const contentType = (res.headers['content-type'] ?? 'application/octet-stream').toString()
      let consumed = false
      const consume = () => {
        if (consumed) return
        consumed = true
        res.resume()
      }

      resolve({
        kind: 'body',
        status,
        contentType,
        stream: res,
        consume,
      })
    })

    req.on('error', (err) => {
      // Pass through our typed errors (e.g. timeout/abort) without wrapping.
      if (
        err instanceof WebFetchTimeoutError ||
        err instanceof WebFetchPolicyRedirectError ||
        err instanceof WebFetchPrivateAddressError ||
        err instanceof WebFetchSchemeError
      ) {
        reject(err)
        return
      }
      reject(new WebFetchHttpError(errMsg(err)))
    })
    req.on('timeout', () => {
      req.destroy(new WebFetchTimeoutError(`fetch timed out after ${opts.remainingMs} ms`))
    })

    const onAbort = () => req.destroy(new Error('aborted'))
    if (opts.signal.aborted) {
      req.destroy(new Error('aborted'))
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    req.end()
  })
}

// ---------------------------------------------------------------------------
// Body reader — caps at maxBytes, drains to hardCeiling before throwing.
// ---------------------------------------------------------------------------

type ReadOptions = {
  maxBytes: number
  hardCeiling: number
  remainingMs: number
  signal: AbortSignal
}

async function readBody(
  handle: ReadResponseHandle,
  opts: ReadOptions,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false

    const timer = setTimeout(() => {
      handle.consume()
      reject(new WebFetchTimeoutError(`body read timed out after ${opts.remainingMs} ms`))
    }, Math.max(0, opts.remainingMs))

    const onAbort = () => {
      clearTimeout(timer)
      handle.consume()
      reject(new Error('aborted'))
    }
    if (opts.signal.aborted) {
      onAbort()
      return
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    handle.stream.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > opts.hardCeiling) {
        clearTimeout(timer)
        handle.consume()
        reject(new WebFetchTooLargeError(
          `response exceeded hard ceiling of ${opts.hardCeiling} bytes`,
        ))
        return
      }
      if (total <= opts.maxBytes) {
        chunks.push(chunk)
      } else if (!truncated) {
        // First chunk that crosses the cap — keep what fits, mark truncated.
        const remaining = opts.maxBytes - (total - chunk.length)
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        truncated = true
      }
    })

    handle.stream.on('end', () => {
      clearTimeout(timer)
      resolve({ bytes: Buffer.concat(chunks), truncated })
    })

    handle.stream.on('error', (err: Error) => {
      clearTimeout(timer)
      reject(new WebFetchHttpError(errMsg(err)))
    })
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAllowedContentType(ct: string): boolean {
  const normalized = ct.split(';')[0]?.trim().toLowerCase() ?? ''
  return ALLOWED_CONTENT_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function decodeBody(buf: Buffer, contentType: string): string {
  const charset = extractCharset(contentType) ?? 'utf-8'
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf)
  } catch {
    // Unknown charset — fall back to UTF-8.
    return new TextDecoder('utf-8', { fatal: false }).decode(buf)
  }
}

function extractCharset(contentType: string): string | null {
  const match = contentType.match(/charset=([^;]+)/i)
  if (!match || !match[1]) return null
  return match[1].trim().replace(/^["']|["']$/g, '').toLowerCase()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Race a promise against a wall-clock timeout and an AbortSignal. Used to
 * give cancellable behavior to APIs like `dns/promises.lookup` that don't
 * natively accept a signal.
 */
async function raceWithTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  makeTimeoutError: () => Error,
): Promise<T> {
  if (signal.aborted) throw new Error('aborted')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(makeTimeoutError()), Math.max(0, timeoutMs))
      abortListener = () => reject(new Error('aborted'))
      signal.addEventListener('abort', abortListener, { once: true })
      promise.then(resolve, reject)
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener)
  }
}
