/**
 * CDP backend integration test.
 *
 * Gated by `ULTRON_PLAYWRIGHT_CDP_INTEGRATION=1`. Like the Phase-2 integration
 * suite, this assumes `npx playwright install chromium` has populated
 * `chromium.executablePath()`.
 *
 * Run:
 *   ULTRON_PLAYWRIGHT_CDP_INTEGRATION=1 npx vitest run \
 *     src/core/computer/playwrightBrowserSession.cdp.integration.test.ts
 *
 * Strategy: spawn Chromium ourselves with `--remote-debugging-port=0` so the
 * OS picks a free port; parse the port from Chromium's stderr line
 * `DevTools listening on ws://127.0.0.1:PORT/devtools/browser/<uuid>`; point
 * `connectOverCDP` at `http://127.0.0.1:PORT` exactly the way `ComputerStart`
 * would. After the session closes, assert the spawned process is still alive
 * AND a fresh `connectOverCDP` to the same port succeeds — that's the
 * load-bearing property: a Computer-Use session must not terminate the user's
 * Chrome.
 *
 * (`chromium.launchServer()` is the wrong harness here — it returns a
 * Playwright-protocol endpoint paired with `chromium.connect()`, not CDP.
 * See `playwright-core/types/types.d.ts:15681-15688`.)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'

import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from '../../config/computerUseSettings.js'
import { createPlaywrightSessionFactory } from './playwrightBrowserSession.js'
import { SessionManager } from './sessionManager.js'
import type { StartSessionOptions } from './types.js'

const integrationEnabled = process.env.ULTRON_PLAYWRIGHT_CDP_INTEGRATION === '1'

const FIXTURE = `<!DOCTYPE html>
<html><head><title>cdp-fixture</title></head>
<body><h1>CDP OK</h1></body></html>`

type ChromeProcess = {
  child: ChildProcess
  port: number
  userDataDir: string
}

/**
 * Spawn Chromium directly with `--remote-debugging-port=0` and resolve once
 * the port has been parsed from stderr. Throws if Chromium exits without ever
 * announcing the port. `extraArgs` lets the caller bake `--host-resolver-rules`
 * etc. into the spawned Chrome — the launch path won't add them since the
 * session attaches via CDP, not via `chromium.launch()`.
 */
async function spawnChromiumWithCdp(extraArgs: readonly string[] = []): Promise<ChromeProcess> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'ultron-cdp-it-'))
  const child = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      ...extraArgs,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const port = await new Promise<number>((resolve, reject) => {
    const onExit = (code: number | null): void => {
      reject(new Error(`Chromium exited (code=${code}) before announcing CDP port`))
    }
    const onStderr = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      const match = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
      if (match !== null && match[1] !== undefined) {
        const parsed = Number.parseInt(match[1], 10)
        if (Number.isInteger(parsed)) {
          child.stderr?.off('data', onStderr)
          child.off('exit', onExit)
          resolve(parsed)
        }
      }
    }
    child.stderr?.on('data', onStderr)
    child.once('exit', onExit)
    setTimeout(() => {
      child.stderr?.off('data', onStderr)
      child.off('exit', onExit)
      reject(new Error('Timed out waiting for Chromium DevTools port'))
    }, 15_000).unref()
  })

  return { child, port, userDataDir }
}

async function killChromium(proc: ChromeProcess): Promise<void> {
  if (proc.child.exitCode === null && proc.child.signalCode === null) {
    proc.child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.child.kill('SIGKILL')
        resolve()
      }, 3000).unref()
      proc.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  try {
    rmSync(proc.userDataDir, { recursive: true, force: true })
  } catch {
    /* swallow */
  }
}

function makeSettings(partial: Partial<ComputerUseSettings> = {}): ComputerUseSettings {
  return {
    ...defaultComputerUseSettings,
    viewport: { ...defaultComputerUseSettings.viewport },
    displaySize: { ...defaultComputerUseSettings.displaySize },
    maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
    allowedDomains: ['cdp-fixture.local'],
    deniedDomains: [],
    enabled: true,
    maxDurationMs: 60_000,
    ...partial,
  }
}

describe.skipIf(!integrationEnabled)('PlaywrightBrowserSession CDP backend integration', () => {
  let chrome: ChromeProcess
  let fixture: Server
  let fixturePort: number
  let cdpEndpoint: string

  beforeAll(async () => {
    fixture = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(FIXTURE)
    })
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
    fixturePort = (fixture.address() as AddressInfo).port

    // Bake the resolver rule into the user-owned Chrome since `connectOverCDP`
    // doesn't forward Playwright's launch args. Without this, navigation to
    // cdp-fixture.local fails with ERR_NAME_NOT_RESOLVED.
    chrome = await spawnChromiumWithCdp([
      `--host-resolver-rules=MAP cdp-fixture.local:80 127.0.0.1:${fixturePort}`,
    ])
    cdpEndpoint = `http://127.0.0.1:${chrome.port}`
  }, 30_000)

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      fixture.close((err) => (err ? reject(err) : resolve())),
    )
    await killChromium(chrome)
  })

  it('connectOverCDP attaches and the session can navigate + screenshot', async () => {
    const factory = createPlaywrightSessionFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    // No `hostResolverRules` here — that's a launch-time flag for the
    // bundled-Chromium path, ignored under CDP. The resolver rule is baked
    // into the spawned Chrome itself in beforeAll.
    const opts: StartSessionOptions = {
      backend: 'cdp',
      cdpEndpoint,
      requireAllowlist: true,
      allowHttpForTest: true,
    }
    const session = await mgr.start(opts, ac.signal)
    try {
      // Default `cdpAssumeVisible: false` — session reports headless: true
      // (= invisible) so `ComputerHandoffToUser` refuses handoff. This matches
      // reality: the test's Chrome was spawned with `--headless=new`.
      expect(session.headless).toBe(true)
      await session.navigate('http://cdp-fixture.local/', ac.signal)
      const shot = await session.screenshot(ac.signal)
      expect(shot.attachment.mediaType).toBe('image/png')
      expect(shot.observation.url).toBe('http://cdp-fixture.local/')
      expect(shot.observation.title).toBe('cdp-fixture')
    } finally {
      await mgr.stop(session.id)
    }

    // Load-bearing assertion: closing a Computer-Use session must NOT kill the
    // user's Chrome. The spawned process is still alive AND a fresh
    // connectOverCDP to the same port succeeds.
    expect(chrome.child.exitCode).toBeNull()
    expect(chrome.child.signalCode).toBeNull()
    const reconnected = await chromium.connectOverCDP(cdpEndpoint)
    try {
      expect(reconnected.isConnected()).toBe(true)
    } finally {
      await reconnected.close()
    }
  }, 60_000)

  it('cdpAssumeVisible: true flips session.headless to false', async () => {
    const factory = createPlaywrightSessionFactory()
    const mgr = new SessionManager({
      settings: makeSettings({ cdpAssumeVisible: true }),
      factory,
    })
    const ac = new AbortController()
    const session = await mgr.start(
      {
        backend: 'cdp',
        cdpEndpoint,
        requireAllowlist: true,
        allowHttpForTest: true,
      },
      ac.signal,
    )
    try {
      expect(session.headless).toBe(false)
    } finally {
      await mgr.stop(session.id)
    }
  }, 30_000)

  it('throws cdp_connect_failed when the endpoint is unreachable', async () => {
    const factory = createPlaywrightSessionFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    await expect(
      mgr.start(
        {
          backend: 'cdp',
          cdpEndpoint: 'http://127.0.0.1:1', // port 1 is not bound
          requireAllowlist: true,
          allowHttpForTest: true,
        },
        ac.signal,
      ),
    ).rejects.toMatchObject({
      kind: 'cdp_connect_failed',
      message: expect.stringContaining('connectOverCDP'),
    })
  }, 30_000)
})
