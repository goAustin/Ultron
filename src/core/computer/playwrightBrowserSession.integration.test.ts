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

import { createComputerUseTools } from '../../tools/ComputerTools.js'
import { createToolRegistry } from '../tools/registry.js'
import { createStore } from '../state.js'
import { getDefaultAppState } from '../state.js'

import { createPlaywrightSessionFactory } from './playwrightBrowserSession.js'
import { SessionManager } from './sessionManager.js'
import {
  __setStoragePathForTest,
  loadStorageState,
  writeStorageState,
} from './storageStateStore.js'
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

/**
 * Phase 3 fixture page. Inline JS records the latest UI event into a
 * `<pre id="state">` and into `window.__lastEvent` so a test can read state
 * via `page.evaluate` (here exercised through `currentTitle()` since the
 * fixture sets `document.title` for cheap assertions). Action endpoints:
 *   - `<button id="b1">` records 'click:b1' on click.
 *   - `<input id="i1">` records its value on every input event.
 *   - 4000px-tall body for scroll testing.
 *   - `<div id="src">` is draggable; mouseup elsewhere records 'drag:end'.
 */
const PHASE3_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>fixture</title></head>
<body style="margin:0">
  <h1>OK</h1>
  <button id="b1" style="position:absolute;left:480px;top:368px;width:80px;height:32px;">B1</button>
  <input id="i1" style="position:absolute;left:480px;top:300px;" />
  <div id="src" draggable="false" style="position:absolute;left:80px;top:600px;width:60px;height:60px;background:red;"></div>
  <pre id="state"></pre>
  <div style="height:4000px;">tall</div>
  <img src="http://denied.local/track.gif" alt="">
  <script>
    const setState = (s) => {
      document.title = s;
      const el = document.getElementById('state');
      if (el) el.textContent = s;
      window.__lastEvent = s;
    };
    document.getElementById('b1').addEventListener('click', () => setState('click:b1'));
    const input = document.getElementById('i1');
    input.addEventListener('input', () => setState('input:' + input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') setState('keydown:Enter');
    });
    window.addEventListener('scroll', () => setState('scroll:' + Math.round(window.scrollY)));
    let dragging = false;
    document.getElementById('src').addEventListener('mousedown', () => {
      dragging = true;
      setState('drag:start');
    });
    window.addEventListener('mouseup', (e) => {
      if (dragging) {
        dragging = false;
        setState('drag:end:' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
      }
    });
  </script>
</body>
</html>`

async function startFixtureServers(): Promise<FixtureServers> {
  const deniedRequests: string[] = []

  const fixture = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(PHASE3_FIXTURE)
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

  // -------------------------------------------------------------------------
  // Phase 3: action methods (click, typeText, pressKey, scroll, drag).
  // The fixture page records every UI event into `document.title` so we can
  // assert via `currentTitle()` without leaking page.evaluate into the test.
  // -------------------------------------------------------------------------

  async function startActionSession(): Promise<{
    mgr: SessionManager
    session: import('./types.js').BrowserSession
    ac: AbortController
  }> {
    const factory = createPlaywrightSessionFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    const session = await mgr.start(makeStartOptions(servers), ac.signal)
    await session.navigate('http://fixture.local/', ac.signal)
    await session.stabilize(ac.signal)
    return { mgr, session, ac }
  }

  it('phase 3: click lands on button #b1 (positioned at viewport center)', async () => {
    const { mgr, session, ac } = await startActionSession()
    try {
      // #b1 is positioned at left:480 top:368 (80x32) → center (520, 384).
      // Normalize against the 1024x768 viewport: x = 520/1023 ≈ 0.508,
      // y = 384/767 ≈ 0.5007. Round-trip lands on (520, 384) per
      // normalizedToCssPx, which is inside the button.
      await session.click({ x: 520 / 1023, y: 384 / 767 }, 'left', ac.signal)
      expect(await session.currentTitle()).toBe('click:b1')
    } finally {
      await mgr.stop(session.id)
    }
  })

  it('phase 3: typeText fills input after click-to-focus', async () => {
    const { mgr, session, ac } = await startActionSession()
    try {
      // #i1 is at left:480 top:300 (default-sized input). Click in its area to focus.
      await session.click({ x: 500 / 1023, y: 308 / 767 }, 'left', ac.signal)
      await session.typeText('hi', ac.signal)
      // The fixture's input handler fires 'input:hi' on each keystroke; the
      // last update is 'input:hi'.
      expect(await session.currentTitle()).toBe('input:hi')
    } finally {
      await mgr.stop(session.id)
    }
  })

  it('phase 3: pressKey(Enter) fires keydown handler on focused input', async () => {
    const { mgr, session, ac } = await startActionSession()
    try {
      await session.click({ x: 500 / 1023, y: 308 / 767 }, 'left', ac.signal)
      await session.pressKey('Enter', ac.signal)
      expect(await session.currentTitle()).toBe('keydown:Enter')
    } finally {
      await mgr.stop(session.id)
    }
  })

  it('phase 3: scroll(null, 0, 500) advances window.scrollY past 0', async () => {
    const { mgr, session, ac } = await startActionSession()
    try {
      await session.scroll(null, 0, 500, ac.signal)
      // Page-level scroll fires 'scroll:N'. Allow a moment for the handler.
      await new Promise((r) => setTimeout(r, 100))
      const title = await session.currentTitle()
      expect(title).toMatch(/^scroll:\d+/)
      const y = Number(title!.split(':')[1])
      expect(y).toBeGreaterThan(0)
    } finally {
      await mgr.stop(session.id)
    }
  })

  it('phase 3: drag from src div to far right runs the full move-down-move-up sequence', async () => {
    const { mgr, session, ac } = await startActionSession()
    try {
      // src is at left:80 top:600 (60x60) → center (110, 630).
      // Drag to (900, 630) on the right side.
      await session.drag(
        { x: 110 / 1023, y: 630 / 767 },
        { x: 900 / 1023, y: 630 / 767 },
        ac.signal,
      )
      const title = await session.currentTitle()
      // mouseup handler reports 'drag:end:X,Y'. X should be near 900.
      expect(title).toMatch(/^drag:end:/)
      const [, coords] = title!.split('drag:end:')
      const [xStr] = coords!.split(',')
      expect(Number(xStr)).toBeGreaterThan(800)
    } finally {
      await mgr.stop(session.id)
    }
  })

  it('phase 3: aborting mid-call surfaces BrowserSessionError(kind: aborted)', async () => {
    const { mgr, session, ac } = await startActionSession()
    try {
      // Pre-aborted signal must reject immediately with kind:'aborted'.
      const ac2 = new AbortController()
      ac2.abort()
      await expect(
        session.click({ x: 0.5, y: 0.5 }, 'left', ac2.signal),
      ).rejects.toMatchObject({ kind: 'aborted' })
    } finally {
      await mgr.stop(session.id)
      ac.abort()
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

  // -------------------------------------------------------------------------
  // Phase 4·3: storageState snapshot + rehydration round-trip.
  //
  // Fixture has two routes:
  //   GET /login → Set-Cookie: session=abc; Path=/
  //   GET /     → reads `session` cookie and reflects it as document.title
  //
  // The end-to-end check: session A navigates to /login (cookie is set) →
  // exportStorageState → pass that object to a new session B →
  // navigate('/') → currentTitle() shows the rehydrated cookie value.
  // -------------------------------------------------------------------------
  describe('Phase 4·3: storageState rehydration', () => {
    type CookieFixtureServers = FixtureServers & { authPort: number; authClose: () => Promise<void> }

    async function startCookieFixture(): Promise<CookieFixtureServers> {
      const auth = createServer((req: IncomingMessage, res) => {
        const url = req.url ?? '/'
        if (url === '/login') {
          res.setHeader('Set-Cookie', 'session=abc; Path=/')
          res.setHeader('content-type', 'text/html')
          res.end('<!DOCTYPE html><html><head><title>logged-in</title></head><body>ok</body></html>')
          return
        }
        // Default route reflects the cookie back as the title — proves the
        // browser is sending it on subsequent requests.
        const cookieHeader = req.headers.cookie ?? ''
        const m = /session=([^;]+)/.exec(cookieHeader)
        const value = m !== null ? m[1] : '<none>'
        res.setHeader('content-type', 'text/html')
        res.end(
          `<!DOCTYPE html><html><head><title>session=${value}</title></head><body>ok</body></html>`,
        )
      })
      await new Promise<void>((resolve) => auth.listen(0, '127.0.0.1', resolve))
      const authPort = (auth.address() as AddressInfo).port
      return {
        ...servers,
        authPort,
        authClose: async () => {
          await new Promise<void>((resolve, reject) =>
            auth.close((err) => (err ? reject(err) : resolve())),
          )
        },
      }
    }

    function makeAuthStartOptions(
      cookies: CookieFixtureServers,
      extra: Partial<StartSessionOptions> = {},
    ): StartSessionOptions {
      return {
        headless: true,
        requireAllowlist: true,
        allowHttpForTest: true,
        hostResolverRules: `MAP fixture.local:80 127.0.0.1:${cookies.fixturePort}, MAP denied.local:80 127.0.0.1:${cookies.deniedPort}, MAP auth.local:80 127.0.0.1:${cookies.authPort}`,
        ...extra,
      }
    }

    function makeAuthSettings(): ComputerUseSettings {
      return makeSettings({ allowedDomains: ['fixture.local', 'auth.local'] })
    }

    it('round-trip: cookie set in session A is rehydrated into session B via exportStorageState', async () => {
      const cookies = await startCookieFixture()
      try {
        // Session A — navigate to /login so the server sets `session=abc`.
        const factoryA = createPlaywrightSessionFactory()
        const mgrA = new SessionManager({ settings: makeAuthSettings(), factory: factoryA })
        const acA = new AbortController()
        const sessionA = await mgrA.start(makeAuthStartOptions(cookies), acA.signal)
        let exported: unknown
        try {
          await sessionA.navigate('http://auth.local/login', acA.signal)
          exported = await sessionA.exportStorageState(acA.signal)
        } finally {
          await mgrA.stop(sessionA.id)
        }
        // Sanity: the exported state has at least one cookie.
        expect(exported).toMatchObject({ cookies: expect.any(Array) })
        const cookieList = (exported as { cookies: Array<{ name: string; value: string }> }).cookies
        expect(cookieList.some((c) => c.name === 'session' && c.value === 'abc')).toBe(true)

        // Session B — start with the exported storageState; navigate to `/`
        // and observe that the server sees the rehydrated cookie (reflected
        // as the page title).
        const factoryB = createPlaywrightSessionFactory()
        const mgrB = new SessionManager({ settings: makeAuthSettings(), factory: factoryB })
        const acB = new AbortController()
        const sessionB = await mgrB.start(
          makeAuthStartOptions(cookies, { storageState: exported }),
          acB.signal,
        )
        try {
          await sessionB.navigate('http://auth.local/', acB.signal)
          expect(await sessionB.currentTitle()).toBe('session=abc')
        } finally {
          await mgrB.stop(sessionB.id)
        }
      } finally {
        await cookies.authClose()
      }
    })

    it('without storageState, session B sees no cookies (negative control)', async () => {
      const cookies = await startCookieFixture()
      try {
        const factory = createPlaywrightSessionFactory()
        const mgr = new SessionManager({ settings: makeAuthSettings(), factory })
        const ac = new AbortController()
        const session = await mgr.start(makeAuthStartOptions(cookies), ac.signal)
        try {
          await session.navigate('http://auth.local/', ac.signal)
          // No /login was visited, no cookie rehydrated → server reflects '<none>'.
          expect(await session.currentTitle()).toBe('session=<none>')
        } finally {
          await mgr.stop(session.id)
        }
      } finally {
        await cookies.authClose()
      }
    })

    // -----------------------------------------------------------------------
    // Phase 4·3 review fix #3 — full cross-tool acceptance criterion 5.
    //
    // Earlier tests in this describe exercised the BrowserSession plumbing
    // (exportStorageState ↔ newContext({storageState})) directly. This test
    // covers the actual user-visible path: ComputerHandoffToUser writes
    // storageState via the store; a *separate* ComputerStart({initialUrl})
    // reads it back via the store and rehydrates cookies into a new session.
    // -----------------------------------------------------------------------
    it('cross-tool acceptance: handoff writes storageState; second ComputerStart({initialUrl}) rehydrates it (review fix #3)', async () => {
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const storeDir = mkdtempSync(join(tmpdir(), 'ultron-handoff-int-'))
      __setStoragePathForTest(storeDir)
      const cookies = await startCookieFixture()
      try {
        // Build a tool surface backed by a real Playwright SessionManager.
        const settings = {
          ...makeAuthSettings(),
          // Two consents required by the design — both must be true for the
          // handoff write path to trigger.
          allowAuthHandoff: true,
          persistProfiles: true,
          // Headed for handoff's `checkPermissions` gate (it refuses headless).
          // We pretend by passing headless:false to ComputerStart below; the
          // session class records that and the gate accepts it.
        }
        const factory = createPlaywrightSessionFactory()
        // Pre-bake the default Start options into a launcher closure so the
        // tool can call sessionManager.start with just the user-supplied
        // {headless, initialUrl}. We need hostResolverRules to map the
        // fixture hosts; intercept via a wrapped factory.
        const wrappedFactory: typeof factory = async (params) => {
          const enrichedOpts: StartSessionOptions = {
            ...params.options,
            requireAllowlist: true,
            allowHttpForTest: true,
            hostResolverRules: `MAP fixture.local:80 127.0.0.1:${cookies.fixturePort}, MAP denied.local:80 127.0.0.1:${cookies.deniedPort}, MAP auth.local:80 127.0.0.1:${cookies.authPort}`,
          }
          return factory({ ...params, options: enrichedOpts })
        }
        const mgr = new SessionManager({ settings, factory: wrappedFactory })
        const tools = createComputerUseTools({ sessionManager: mgr, settings })

        const appState = createStore(getDefaultAppState())
        const ctx = {
          appState,
          abortController: new AbortController(),
          messages: [],
          readFileState: new Map(),
          toolRegistry: createToolRegistry(),
        }

        // Step 1 — start headed session, /login (cookie set), then handoff.
        // The handoff call body assumes the cascade prompt was approved, so
        // we invoke .call() directly — that's the post-approval entry point.
        const startA = await tools.start.call(
          { headless: false },
          ctx,
          ctx.abortController.signal,
        )
        expect(startA.isError).toBe(false)
        const sessionIdA = startA.content.replace('sessionId: ', '') as ComputerSessionId
        const sessionA = mgr.get(sessionIdA)!

        await sessionA.navigate('http://auth.local/login', ctx.abortController.signal)
        const handoffResult = await tools.handoffToUser.call(
          { sessionId: sessionIdA, message: 'finish login' },
          ctx,
          ctx.abortController.signal,
        )
        expect(handoffResult.isError).toBe(false)

        // Stop session A — its in-memory cookies die with the context. The
        // only persistence is what handoff wrote to disk via the store.
        await mgr.stop(sessionIdA)

        // Verify storageStateStore wrote a file for auth.local.
        const persisted = await loadStorageState('auth.local') as { cookies: Array<{ name: string }> } | null
        expect(persisted).not.toBeNull()
        expect(persisted!.cookies.some((c) => c.name === 'session')).toBe(true)

        // Step 2 — separate ComputerStart with initialUrl pointing at the
        // same host. The tool calls loadStorageState(host) → passes through
        // StartSessionOptions.storageState → newContext rehydrates cookies.
        const startB = await tools.start.call(
          { headless: true, initialUrl: 'https://auth.local/' },
          ctx,
          ctx.abortController.signal,
        )
        expect(startB.isError).toBe(false)
        const sessionIdB = startB.content.replace('sessionId: ', '') as ComputerSessionId
        const sessionB = mgr.get(sessionIdB)!

        try {
          // Navigate to / — server reflects the rehydrated cookie as title.
          await sessionB.navigate('http://auth.local/', ctx.abortController.signal)
          expect(await sessionB.currentTitle()).toBe('session=abc')
        } finally {
          await mgr.stop(sessionIdB)
        }
      } finally {
        __setStoragePathForTest(null)
        await cookies.authClose()
      }
    })
  })
})
