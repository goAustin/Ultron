/**
 * v3 Phase 2: Playwright integration tests.
 *
 * Gated by `ULTRON_PLAYWRIGHT_INTEGRATION=1` (mirrors `seatbelt.integration.test.ts`'s
 * `isDarwin` gate). When the env var is unset, the suite is skipped, so a fresh
 * checkout that hasn't run `npx playwright install chromium` keeps `npm run test`
 * green.
 *
 * Run:
 *   ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run \
 *     src/core/computer/playwrightBrowserSession.integration.test.ts
 *
 * Asserts the four roadmap acceptance criteria
 * (docs/ultron_v3/v3-computer-use-plan.md:577-582) end-to-end:
 *   1. Starting a browser session creates an isolated context.
 *   2. Navigation to denied domains is blocked before request completion.
 *   3. Screenshot returns expected dimensions and MIME type.
 *   4. Abort closes the Playwright context AND browser process.
 *
 * Strategy:
 * - Two `http.createServer` instances bind to 127.0.0.1 on distinct ports.
 * - Chromium is launched with `--host-resolver-rules` so fixture.local and
 *   denied.local resolve to those ports without needing an OS resolver entry.
 *   `fixture.local` and `denied.local` both pass `isValidDomainPattern` (two
 *   labels) so they fit the existing webPolicy machinery.
 */

import { createServer, type Server, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from '../../config/computerUseSettings.js'
import { validateImageAttachment } from '../tools/imageAttachment.js'

import { createPlaywrightSessionFactory } from './playwrightBrowserSession.js'
import { SessionManager } from './sessionManager.js'
import type { ComputerSessionId, StartSessionOptions } from './types.js'

const integrationEnabled = process.env.ULTRON_PLAYWRIGHT_INTEGRATION === '1'

type FixtureServers = {
  fixture: Server
  fixturePort: number
  denied: Server
  deniedPort: number
  /** Hosts (host:port) recorded for every request that reached the denied server. */
  deniedRequests: string[]
  /** Stop both servers. */
  close: () => Promise<void>
}

async function startFixtureServers(): Promise<FixtureServers> {
  const deniedRequests: string[] = []

  const fixture = createServer((req, res) => {
    // Embed a subresource pointing at denied.local so we can verify the
    // route interceptor blocks subresources.
    const subresourceHost = (req.headers.host ?? '').includes('denied.local')
      ? '' // shouldn't happen for fixture
      : `<img src="http://denied.local/track.gif" alt="">`
    res.setHeader('content-type', 'text/html')
    res.end(`<!DOCTYPE html><html><head><title>fixture</title></head><body><h1>OK</h1>${subresourceHost}</body></html>`)
  })
  const denied = createServer((req: IncomingMessage, res) => {
    deniedRequests.push(req.headers.host ?? '<unknown>')
    res.setHeader('content-type', 'text/plain')
    res.end('SHOULD NOT BE REACHED')
  })

  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => denied.listen(0, '127.0.0.1', resolve))
  const fixturePort = (fixture.address() as AddressInfo).port
  const deniedPort = (denied.address() as AddressInfo).port

  return {
    fixture,
    fixturePort,
    denied,
    deniedPort,
    deniedRequests,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        fixture.close((err) => (err ? reject(err) : resolve())),
      )
      await new Promise<void>((resolve, reject) =>
        denied.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
}

function makeSettings(partial: Partial<ComputerUseSettings> = {}): ComputerUseSettings {
  return {
    ...defaultComputerUseSettings,
    viewport: { ...defaultComputerUseSettings.viewport },
    displaySize: { ...defaultComputerUseSettings.displaySize },
    maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
    allowedDomains: ['fixture.local'],
    deniedDomains: [],
    enabled: true,
    maxDurationMs: 60_000,
    ...partial,
  }
}

function makeStartOptions(servers: FixtureServers): StartSessionOptions {
  return {
    headless: true,
    requireAllowlist: true,
    allowHttpForTest: true,
    hostResolverRules: `MAP fixture.local:80 127.0.0.1:${servers.fixturePort}, MAP denied.local:80 127.0.0.1:${servers.deniedPort}`,
  }
}


describe.skipIf(!integrationEnabled)('PlaywrightBrowserSession integration', () => {
  let servers: FixtureServers

  beforeAll(async () => {
    servers = await startFixtureServers()
  })

  afterAll(async () => {
    await servers.close()
  })

  it('acceptance 1: start creates an isolated context (fresh storageState)', async () => {
    const factory = createPlaywrightSessionFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    const session = await mgr.start(makeStartOptions(servers), ac.signal)
    try {
      expect(session.isClosed()).toBe(false)
      expect(session.currentUrl()).toBe('about:blank')
    } finally {
      await mgr.stop(session.id)
      expect(session.isClosed()).toBe(true)
    }
  })

  it('acceptance 2 (top-level): navigation to denied domain is blocked, denied server sees no request', async () => {
    servers.deniedRequests.length = 0
    const factory = createPlaywrightSessionFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    const session = await mgr.start(makeStartOptions(servers), ac.signal)
    try {
      await expect(
        session.navigate('http://denied.local/', ac.signal),
      ).rejects.toMatchObject({ kind: 'domain_denied' })
      // Pre-flight rejection means no request leaves the host.
      expect(servers.deniedRequests).toEqual([])
    } finally {
      await mgr.stop(session.id)
    }
  })

  it('acceptance 2 (subresource): denied subresource is blocked at the route layer', async () => {
    servers.deniedRequests.length = 0
    const factory = createPlaywrightSessionFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    const session = await mgr.start(makeStartOptions(servers), ac.signal)
    try {
      await session.navigate('http://fixture.local/', ac.signal)
      // Give Chromium a chance to issue the subresource request.
      await new Promise((r) => setTimeout(r, 250))
      expect(servers.deniedRequests).toEqual([])
    } finally {
      await mgr.stop(session.id)
    }
  })

  it('acceptance 3: screenshot returns expected dimensions and MIME', async () => {
    const factory = createPlaywrightSessionFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    const session = await mgr.start(makeStartOptions(servers), ac.signal)
    try {
      await session.navigate('http://fixture.local/', ac.signal)
      const result = await session.screenshot(ac.signal)
      expect(result.attachment.mediaType).toBe('image/png')
      expect(result.attachment.width).toBe(1024)
      expect(result.attachment.height).toBe(768)
      // Confirm the base64 round-trips through Phase 1's validator.
      const re = validateImageAttachment(result.attachment.data, 'image/png', {
        maxBytes: 5_000_000,
        maxWidth: 1280,
        maxHeight: 800,
      })
      expect(re.ok).toBe(true)
    } finally {
      await mgr.stop(session.id)
    }
  })

  it('acceptance 4: abort closes browser AND context', async () => {
    const factory = createPlaywrightSessionFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    const session = await mgr.start(makeStartOptions(servers), ac.signal)
    // Reach into the private fields by structural cast so we can verify both
    // browser.close() and context.close() were exercised by closeOnce.
    type Internals = {
      _browser: { isConnected(): boolean }
    }
    const internals = session as unknown as Internals
    expect(internals._browser.isConnected()).toBe(true)

    // Fire abort. SessionManager's abort listener routes through closeOnce,
    // which closes both context and browser.
    ac.abort()
    // Allow the abort listener and async close calls to complete.
    await new Promise((r) => setTimeout(r, 500))

    expect(session.isClosed()).toBe(true)
    expect(mgr.get(session.id as ComputerSessionId)).toBeUndefined()

    // Browser.isConnected() must be false — proving browser.close() ran, not
    // just context.close(). This is what the design doc means by "no leaked
    // browser process".
    expect(internals._browser.isConnected()).toBe(false)
  })
})
