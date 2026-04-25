import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'

import {
  fetchWeb,
  isPrivateAddress,
  WebFetchInvalidUrlError,
  WebFetchPolicyRedirectError,
  WebFetchPrivateAddressError,
  WebFetchSchemeError,
  WebFetchTimeoutError,
  WebFetchTooLargeError,
  WebFetchTooManyRedirectsError,
  WebFetchUnsupportedContentTypeError,
} from './fetcher.js'

// ---------------------------------------------------------------------------
// IP-class tests (no network)
// ---------------------------------------------------------------------------

describe('isPrivateAddress', () => {
  const PRIVATE = [
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.1.1',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ]
  for (const ip of PRIVATE) {
    it(`flags ${ip} as private`, () => {
      expect(isPrivateAddress(ip)).toBe(true)
    })
  }

  const PUBLIC = ['1.1.1.1', '8.8.8.8', '142.250.190.46', '2001:4860:4860::8888']
  for (const ip of PUBLIC) {
    it(`allows ${ip} as public`, () => {
      expect(isPrivateAddress(ip)).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// fetchWeb — error paths (no network connection)
// ---------------------------------------------------------------------------

const alwaysAllow = (): 'allow' => 'allow'
const publicLookup = async () => ({ address: '1.1.1.1', family: 4 as const })

function netFamily(ip: string): 4 | 6 {
  return ip.includes(':') ? 6 : 4
}

describe('fetchWeb — pre-network gates', () => {
  it('rejects http://', async () => {
    await expect(
      fetchWeb('http://example.com/', {
        signal: new AbortController().signal,
        checkPolicy: alwaysAllow,
        lookup: publicLookup,
      }),
    ).rejects.toBeInstanceOf(WebFetchSchemeError)
  })

  it('rejects malformed URL', async () => {
    await expect(
      fetchWeb('not-a-url', {
        signal: new AbortController().signal,
        checkPolicy: alwaysAllow,
        lookup: publicLookup,
      }),
    ).rejects.toBeInstanceOf(WebFetchInvalidUrlError)
  })

  // First-hop policy check is intentionally NOT performed by the fetcher.
  // The cascade authorizes the initial input; the fetcher only re-checks
  // redirect hops (covered in the network-paths suite below). This keeps
  // allow_once and bypassPermissions working — both authorize without
  // persisting a rule, which the cascade relies on.

  for (const ip of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.0.1', '::1', 'fc00::1', 'fe80::1',
  ]) {
    it(`throws WebFetchPrivateAddressError when DNS resolves to ${ip}`, async () => {
      await expect(
        fetchWeb('https://example.com/', {
          signal: new AbortController().signal,
          checkPolicy: alwaysAllow,
          lookup: async () => ({ address: ip, family: netFamily(ip) }),
        }),
      ).rejects.toBeInstanceOf(WebFetchPrivateAddressError)
    })
  }

  it('throws WebFetchTimeoutError when DNS lookup hangs past timeout', async () => {
    await expect(
      fetchWeb('https://example.com/', {
        signal: new AbortController().signal,
        checkPolicy: alwaysAllow,
        // Resolver never resolves.
        lookup: () => new Promise(() => undefined),
        timeoutMs: 100,
      }),
    ).rejects.toBeInstanceOf(WebFetchTimeoutError)
  })

  it('aborts a hanging DNS lookup when AbortSignal fires', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    await expect(
      fetchWeb('https://example.com/', {
        signal: ac.signal,
        checkPolicy: alwaysAllow,
        lookup: () => new Promise(() => undefined),
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow('aborted')
  })
})

// ---------------------------------------------------------------------------
// Local HTTPS test server
//
// The fetcher's SSRF block deny-lists 127.0.0.1 by design. To test
// successful network paths against a local server, we spy on
// `isPrivateAddress` to return false for the duration of these tests
// only. The production path is exercised separately by the IP-class
// suite above.
// ---------------------------------------------------------------------------

let server: https.Server | undefined
let port = 0
let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void = () => undefined
let certDir: string | undefined
let canRunNetworkTests = true

function generateCert(): { cert: Buffer; key: Buffer } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'ultron-test-cert-'))
    certDir = dir
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', join(dir, 'key.pem'),
      '-out', join(dir, 'cert.pem'),
      '-days', '1',
      '-nodes',
      '-subj', '/CN=localhost',
    ], { stdio: 'pipe' })
    return {
      cert: readFileSync(join(dir, 'cert.pem')),
      key: readFileSync(join(dir, 'key.pem')),
    }
  } catch {
    return null
  }
}

beforeAll(async () => {
  const certs = generateCert()
  if (!certs) {
    canRunNetworkTests = false
    // eslint-disable-next-line no-console
    console.warn('openssl not available; skipping fetcher network tests')
    return
  }
  server = https.createServer({ cert: certs.cert, key: certs.key }, (req, res) => handler(req, res))
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server!.address() as AddressInfo).port
})

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  if (certDir) {
    rmSync(certDir, { recursive: true, force: true })
  }
})

function testAgent(): https.Agent {
  return new https.Agent({ rejectUnauthorized: false })
}

const localLookup = async () => ({ address: '127.0.0.1', family: 4 as const })
const allowLocalhost = () => false  // override SSRF block for local test server

describe('fetchWeb — network paths (local HTTPS server)', () => {
  const skipIf = () => !canRunNetworkTests

  it.skipIf(skipIf())('fetches a simple 200 text/plain response', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('hello')
    }
    const result = await fetchWeb(`https://localhost:${port}/`, {
      signal: new AbortController().signal,
      checkPolicy: alwaysAllow,
      lookup: localLookup,
      httpsAgent: testAgent(),
      isPrivateAddress: allowLocalhost,
    })
    expect(result.status).toBe(200)
    expect(result.body).toBe('hello')
    expect(result.truncated).toBe(false)
    expect(result.contentType).toMatch(/text\/plain/)
    expect(result.redirectChain.length).toBe(1)
  })

  it.skipIf(skipIf())('returns FetchResult for 404 without throwing', async () => {
    handler = (_req, res) => {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain')
      res.end('not found')
    }
    const result = await fetchWeb(`https://localhost:${port}/missing`, {
      signal: new AbortController().signal,
      checkPolicy: alwaysAllow,
      lookup: localLookup,
      httpsAgent: testAgent(),
      isPrivateAddress: allowLocalhost,
    })
    expect(result.status).toBe(404)
    expect(result.body).toBe('not found')
  })

  it.skipIf(skipIf())('throws WebFetchUnsupportedContentTypeError on binary content', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/octet-stream')
      res.end(Buffer.from([0, 1, 2, 3]))
    }
    await expect(
      fetchWeb(`https://localhost:${port}/binary`, {
        signal: new AbortController().signal,
        checkPolicy: alwaysAllow,
        lookup: localLookup,
        httpsAgent: testAgent(),
        isPrivateAddress: allowLocalhost,
      }),
    ).rejects.toBeInstanceOf(WebFetchUnsupportedContentTypeError)
  })

  it.skipIf(skipIf())('truncates body at maxBytes and marks truncated', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      // 6 KB body — between 4 KB cap and 8 KB hard ceiling.
      res.end('a'.repeat(6 * 1024))
    }
    const result = await fetchWeb(`https://localhost:${port}/big`, {
      signal: new AbortController().signal,
      checkPolicy: alwaysAllow,
      lookup: localLookup,
      httpsAgent: testAgent(),
      isPrivateAddress: allowLocalhost,
      maxBytes: 4 * 1024,
    })
    expect(result.body.length).toBe(4 * 1024)
    expect(result.truncated).toBe(true)
  })

  it.skipIf(skipIf())('throws WebFetchTooLargeError when body exceeds hard ceiling (cap × 2)', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('a'.repeat(20 * 1024))
    }
    await expect(
      fetchWeb(`https://localhost:${port}/huge`, {
        signal: new AbortController().signal,
        checkPolicy: alwaysAllow,
        lookup: localLookup,
        httpsAgent: testAgent(),
        isPrivateAddress: allowLocalhost,
        maxBytes: 4 * 1024,
      }),
    ).rejects.toBeInstanceOf(WebFetchTooLargeError)
  })

  it.skipIf(skipIf())('follows same-host redirect and records the chain', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302
        res.setHeader('Location', `/end`)
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('done')
    }
    const result = await fetchWeb(`https://localhost:${port}/start`, {
      signal: new AbortController().signal,
      checkPolicy: alwaysAllow,
      lookup: localLookup,
      httpsAgent: testAgent(),
      isPrivateAddress: allowLocalhost,
    })
    expect(result.body).toBe('done')
    expect(result.redirectChain.length).toBe(2)
    expect(result.finalUrl).toContain('/end')
  })

  it.skipIf(skipIf())('throws WebFetchPolicyRedirectError on cross-host redirect with deny', async () => {
    handler = (_req, res) => {
      res.statusCode = 302
      res.setHeader('Location', `https://other.example.com/`)
      res.end()
    }
    // checkPolicy is only invoked on redirect hops — the first hop is
    // trusted (cascade already authorized it). Returning 'deny' here
    // applies to the redirect target.
    await expect(
      fetchWeb(`https://localhost:${port}/redir`, {
        signal: new AbortController().signal,
        checkPolicy: () => 'deny',
        lookup: localLookup,
        httpsAgent: testAgent(),
        isPrivateAddress: allowLocalhost,
      }),
    ).rejects.toBeInstanceOf(WebFetchPolicyRedirectError)
  })

  it.skipIf(skipIf())('throws WebFetchTooManyRedirectsError after maxRedirects', async () => {
    let i = 0
    handler = (_req, res) => {
      i++
      res.statusCode = 302
      res.setHeader('Location', `/r${i}`)
      res.end()
    }
    await expect(
      fetchWeb(`https://localhost:${port}/r0`, {
        signal: new AbortController().signal,
        checkPolicy: alwaysAllow,
        lookup: localLookup,
        httpsAgent: testAgent(),
        isPrivateAddress: allowLocalhost,
        maxRedirects: 2,
      }),
    ).rejects.toBeInstanceOf(WebFetchTooManyRedirectsError)
  })

  it.skipIf(skipIf())('aborts when AbortSignal fires', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.write('partial')
      // never end
    }
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    await expect(
      fetchWeb(`https://localhost:${port}/hang`, {
        signal: ac.signal,
        checkPolicy: alwaysAllow,
        lookup: localLookup,
        httpsAgent: testAgent(),
        isPrivateAddress: allowLocalhost,
      }),
    ).rejects.toThrow()
  })

  it.skipIf(skipIf())('throws WebFetchTimeoutError when total timeout elapses', async () => {
    handler = () => {
      // never respond
    }
    await expect(
      fetchWeb(`https://localhost:${port}/never`, {
        signal: new AbortController().signal,
        checkPolicy: alwaysAllow,
        lookup: localLookup,
        httpsAgent: testAgent(),
        isPrivateAddress: allowLocalhost,
        timeoutMs: 200,
      }),
    ).rejects.toBeInstanceOf(WebFetchTimeoutError)
  }, 5_000)
})
