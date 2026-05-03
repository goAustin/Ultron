import { describe, expect, it, vi } from 'vitest'

import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from '../../config/computerUseSettings.js'

import { decodePng, encodePng } from './pngCodec.js'

import {
  createPlaywrightSessionFactory,
  PlaywrightBrowserSession,
  type LaunchChromiumFn,
  type LaunchedBrowser,
} from './playwrightBrowserSession.js'
import {
  BrowserSessionError,
  type ComputerSessionId,
  type NormalizedPoint,
} from './types.js'

function makeSettings(partial: Partial<ComputerUseSettings> = {}): ComputerUseSettings {
  return {
    ...defaultComputerUseSettings,
    viewport: { ...defaultComputerUseSettings.viewport },
    displaySize: { ...defaultComputerUseSettings.displaySize },
    maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
    allowedDomains: ['example.com'],
    deniedDomains: [],
    ...partial,
  }
}

function makeStubLaunched(): LaunchedBrowser {
  const noop = async () => {}
  const noopRoute = async (_pattern: string, _handler: unknown) => {}
  const noopOn = (_event: string, _handler: unknown) => {}
  // v3 Phase 6: `_installDisconnectHandler` calls `browser.on('disconnected', …)`
  // on every factory build, so the browser stub needs `on`.
  const browser = { close: noop, on: noopOn } as unknown as LaunchedBrowser['browser']
  const context = {
    close: noop,
    route: noopRoute,
    on: noopOn,
    storageState: async () => ({ cookies: [], origins: [] }),
  } as unknown as LaunchedBrowser['context']
  const page = {
    url: () => 'about:blank',
    title: async () => '',
    goto: async () => null,
    screenshot: async () => Buffer.from([]),
    waitForLoadState: async () => {},
    close: noop,
  } as unknown as LaunchedBrowser['page']
  return { browser, context, page }
}

/**
 * v3 Phase 6 — variant of `makeStubLaunched` that captures the listener
 * `_installDisconnectHandler` registers on `browser.on('disconnected', …)`.
 * The returned `fireDisconnected()` lets tests simulate an unexpected
 * Chromium crash to exercise the runtime hardening.
 */
function makeStubLaunchedCapturingDisconnect(): {
  launched: LaunchedBrowser
  fireDisconnected: () => void
} {
  const noop = async () => {}
  const noopRoute = async (_pattern: string, _handler: unknown) => {}
  const noopOn = (_event: string, _handler: unknown) => {}
  let captured: (() => void) | null = null
  const browser = {
    close: noop,
    on: (event: string, handler: () => void) => {
      if (event === 'disconnected') captured = handler
    },
  } as unknown as LaunchedBrowser['browser']
  const context = {
    close: noop,
    route: noopRoute,
    on: noopOn,
    storageState: async () => ({ cookies: [], origins: [] }),
  } as unknown as LaunchedBrowser['context']
  const page = {
    url: () => 'about:blank',
    title: async () => '',
    goto: async () => null,
    screenshot: async () => Buffer.from([]),
    waitForLoadState: async () => {},
    close: noop,
  } as unknown as LaunchedBrowser['page']
  return {
    launched: { browser, context, page },
    fireDisconnected: () => {
      if (captured === null) throw new Error('disconnect handler never registered')
      captured()
    },
  }
}

describe('createPlaywrightSessionFactory', () => {
  it('passes viewport, headless, and args to launchChromium', async () => {
    const launchSpy = vi.fn<LaunchChromiumFn>(async (params) => {
      void params
      return makeStubLaunched()
    })
    const factory = createPlaywrightSessionFactory({ launchChromium: launchSpy })
    const settings = makeSettings()
    await factory({
      id: 'sess-1' as ComputerSessionId,
      settings,
      options: { headless: true },
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    expect(launchSpy).toHaveBeenCalledTimes(1)
    const call = launchSpy.mock.calls[0]?.[0]
    expect(call).toBeDefined()
    expect(call?.headless).toBe(true)
    expect(call?.viewport).toEqual({
      width: settings.viewport.width,
      height: settings.viewport.height,
    })
    expect(call?.args).toEqual([])
  })

  it('forwards hostResolverRules into launch args', async () => {
    const launchSpy = vi.fn<LaunchChromiumFn>(async () => makeStubLaunched())
    const factory = createPlaywrightSessionFactory({ launchChromium: launchSpy })
    await factory({
      id: 'sess-2' as ComputerSessionId,
      settings: makeSettings(),
      options: {
        headless: true,
        hostResolverRules: 'MAP fixture.local:80 127.0.0.1:8080',
      },
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    const args = launchSpy.mock.calls[0]?.[0]?.args
    expect(args).toEqual(['--host-resolver-rules=MAP fixture.local:80 127.0.0.1:8080'])
  })

  it('headless defaults to true when option omitted', async () => {
    const launchSpy = vi.fn<LaunchChromiumFn>(async () => makeStubLaunched())
    const factory = createPlaywrightSessionFactory({ launchChromium: launchSpy })
    await factory({
      id: 'sess-3' as ComputerSessionId,
      settings: makeSettings(),
      options: {},
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    expect(launchSpy.mock.calls[0]?.[0]?.headless).toBe(true)
  })

  it('translates "Executable doesn\'t exist" into chromium_not_installed', async () => {
    const failingLaunch: LaunchChromiumFn = async () => {
      throw new Error(
        "browserType.launch: Executable doesn't exist at /Users/test/.cache/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      )
    }
    const factory = createPlaywrightSessionFactory({ launchChromium: failingLaunch })
    await expect(
      factory({
        id: 'sess-4' as ComputerSessionId,
        settings: makeSettings(),
        options: {},
        requestClose: async () => {},
        recordScreenshot: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'chromium_not_installed',
      message: expect.stringContaining('npx playwright install chromium'),
    })
  })

  it('translates ENOENT into chromium_not_installed', async () => {
    const failingLaunch: LaunchChromiumFn = async () => {
      const err = new Error('spawn ENOENT') as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    }
    const factory = createPlaywrightSessionFactory({ launchChromium: failingLaunch })
    await expect(
      factory({
        id: 'sess-5' as ComputerSessionId,
        settings: makeSettings(),
        options: {},
        requestClose: async () => {},
        recordScreenshot: () => {},
      }),
    ).rejects.toMatchObject({ kind: 'chromium_not_installed' })
  })

  it('propagates non-missing-chromium launch errors unchanged', async () => {
    const failingLaunch: LaunchChromiumFn = async () => {
      throw new Error('totally unrelated error')
    }
    const factory = createPlaywrightSessionFactory({ launchChromium: failingLaunch })
    await expect(
      factory({
        id: 'sess-6' as ComputerSessionId,
        settings: makeSettings(),
        options: {},
        requestClose: async () => {},
        recordScreenshot: () => {},
      }),
    ).rejects.toThrow(/totally unrelated/)
  })

  it('does NOT mislabel unrelated browserType.launch errors as missing-chromium', async () => {
    // Regression: previous matcher caught any `browserType.launch:`-prefixed
    // message, which would mistranslate timeouts / sandbox / permission errors.
    const failingLaunch: LaunchChromiumFn = async () => {
      throw new Error('browserType.launch: Timeout 30000ms exceeded.')
    }
    const factory = createPlaywrightSessionFactory({ launchChromium: failingLaunch })
    await expect(
      factory({
        id: 'sess-7b' as ComputerSessionId,
        settings: makeSettings(),
        options: {},
        requestClose: async () => {},
        recordScreenshot: () => {},
      }),
    ).rejects.toThrow(/Timeout 30000ms exceeded/)
    // And NOT translated into chromium_not_installed.
    await expect(
      factory({
        id: 'sess-7c' as ComputerSessionId,
        settings: makeSettings(),
        options: {},
        requestClose: async () => {},
        recordScreenshot: () => {},
      }),
    ).rejects.not.toMatchObject({ kind: 'chromium_not_installed' })
  })

  it('registers a route interceptor on the context', async () => {
    let routeRegistered = false
    const launch: LaunchChromiumFn = async () => {
      const stubbed = makeStubLaunched()
      const context = {
        ...stubbed.context,
        route: async (_pattern: string, _handler: unknown) => {
          routeRegistered = true
        },
      } as unknown as LaunchedBrowser['context']
      return { ...stubbed, context }
    }
    const factory = createPlaywrightSessionFactory({ launchChromium: launch })
    await factory({
      id: 'sess-7' as ComputerSessionId,
      settings: makeSettings(),
      options: {},
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    expect(routeRegistered).toBe(true)
  })

  it('exposes the headless option on the BrowserSession', async () => {
    const factory = createPlaywrightSessionFactory({
      launchChromium: async () => makeStubLaunched(),
    })
    const headedSession = await factory({
      id: 'sess-h-1' as ComputerSessionId,
      settings: makeSettings(),
      options: { headless: false },
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    const headlessSession = await factory({
      id: 'sess-h-2' as ComputerSessionId,
      settings: makeSettings(),
      options: { headless: true },
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    const defaultSession = await factory({
      id: 'sess-h-3' as ComputerSessionId,
      settings: makeSettings(),
      options: {},
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    expect(headedSession.headless).toBe(false)
    expect(headlessSession.headless).toBe(true)
    // Default is true (matches Phase 2's chromium.launch default).
    expect(defaultSession.headless).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // v3 Phase 6 — deviceScaleFactor launch option
  // ---------------------------------------------------------------------------

  it('forwards deviceScaleFactor to launchChromium when set', async () => {
    const launchSpy = vi.fn<LaunchChromiumFn>(async () => makeStubLaunched())
    const factory = createPlaywrightSessionFactory({ launchChromium: launchSpy })
    await factory({
      id: 'sess-dsf-1' as ComputerSessionId,
      settings: makeSettings(),
      options: { deviceScaleFactor: 2 },
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    expect(launchSpy.mock.calls[0]?.[0]?.deviceScaleFactor).toBe(2)
  })

  it('omits deviceScaleFactor from launch params when option is not set (default Playwright behavior preserved)', async () => {
    const launchSpy = vi.fn<LaunchChromiumFn>(async () => makeStubLaunched())
    const factory = createPlaywrightSessionFactory({ launchChromium: launchSpy })
    await factory({
      id: 'sess-dsf-2' as ComputerSessionId,
      settings: makeSettings(),
      options: {},
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    expect(launchSpy.mock.calls[0]?.[0]?.deviceScaleFactor).toBeUndefined()
  })

  it('mirrors deviceScaleFactor onto BrowserSession.viewport.deviceScaleFactor', async () => {
    const factory = createPlaywrightSessionFactory({
      launchChromium: async () => makeStubLaunched(),
    })
    const dsf2 = await factory({
      id: 'sess-dsf-3' as ComputerSessionId,
      settings: makeSettings(),
      options: { deviceScaleFactor: 2 },
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    const dsfDefault = await factory({
      id: 'sess-dsf-4' as ComputerSessionId,
      settings: makeSettings(),
      options: {},
      requestClose: async () => {},
      recordScreenshot: () => {},
    })
    expect(dsf2.viewport.deviceScaleFactor).toBe(2)
    expect(dsfDefault.viewport.deviceScaleFactor).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // v3 Phase 6 — disconnect handler
  // ---------------------------------------------------------------------------

  it('installs a browser.on("disconnected") handler that calls requestClose("error")', async () => {
    const captured = makeStubLaunchedCapturingDisconnect()
    const requestCloseCalls: Array<'aborted' | 'timeout' | 'error'> = []
    const factory = createPlaywrightSessionFactory({
      launchChromium: async () => captured.launched,
    })
    await factory({
      id: 'sess-dc-1' as ComputerSessionId,
      settings: makeSettings(),
      options: {},
      requestClose: async (reason) => {
        requestCloseCalls.push(reason)
      },
      recordScreenshot: () => {},
    })
    // Simulate Chromium crash.
    captured.fireDisconnected()
    // requestClose is fire-and-forget (`void this._requestClose(...)`); a
    // microtask flush is enough.
    await new Promise((r) => setImmediate(r))
    expect(requestCloseCalls).toEqual(['error'])
  })

  it('disconnect handler suppresses requestClose when session already initiated close', async () => {
    const captured = makeStubLaunchedCapturingDisconnect()
    const requestCloseCalls: Array<'aborted' | 'timeout' | 'error'> = []
    const factory = createPlaywrightSessionFactory({
      launchChromium: async () => captured.launched,
    })
    const session = await factory({
      id: 'sess-dc-2' as ComputerSessionId,
      settings: makeSettings(),
      options: {},
      requestClose: async (reason) => {
        requestCloseCalls.push(reason)
      },
      recordScreenshot: () => {},
    })
    // Intentional close path sets `_closed`, so the disconnect arriving after
    // close — Playwright fires it even on graceful shutdown — is suppressed.
    await session.close()
    captured.fireDisconnected()
    await new Promise((r) => setImmediate(r))
    expect(requestCloseCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Phase 3: action method wiring + post-op abort hardening
// ---------------------------------------------------------------------------

type MouseSpy = {
  click: ReturnType<typeof vi.fn>
  dblclick: ReturnType<typeof vi.fn>
  move: ReturnType<typeof vi.fn>
  down: ReturnType<typeof vi.fn>
  up: ReturnType<typeof vi.fn>
  wheel: ReturnType<typeof vi.fn>
}

type KeyboardSpy = {
  type: ReturnType<typeof vi.fn>
  press: ReturnType<typeof vi.fn>
}

function makeSpiedSession(opts?: {
  mouseImpl?: Partial<Record<keyof MouseSpy, () => Promise<void>>>
  keyboardImpl?: Partial<Record<keyof KeyboardSpy, () => Promise<void>>>
}): {
  session: PlaywrightBrowserSession
  mouse: MouseSpy
  keyboard: KeyboardSpy
} {
  const mouse: MouseSpy = {
    click: vi.fn(opts?.mouseImpl?.click ?? (async () => {})),
    dblclick: vi.fn(opts?.mouseImpl?.dblclick ?? (async () => {})),
    move: vi.fn(opts?.mouseImpl?.move ?? (async () => {})),
    down: vi.fn(opts?.mouseImpl?.down ?? (async () => {})),
    up: vi.fn(opts?.mouseImpl?.up ?? (async () => {})),
    wheel: vi.fn(opts?.mouseImpl?.wheel ?? (async () => {})),
  }
  const keyboard: KeyboardSpy = {
    type: vi.fn(opts?.keyboardImpl?.type ?? (async () => {})),
    press: vi.fn(opts?.keyboardImpl?.press ?? (async () => {})),
  }
  const noop = async () => {}
  const noopRoute = async (_pattern: string, _handler: unknown) => {}
  const noopOn = (_event: string, _handler: unknown) => {}
  const launched: LaunchedBrowser = {
    browser: { close: noop } as unknown as LaunchedBrowser['browser'],
    context: {
      close: noop,
      route: noopRoute,
      on: noopOn,
      storageState: async () => ({ cookies: [], origins: [] }),
    } as unknown as LaunchedBrowser['context'],
    page: {
      url: () => 'about:blank',
      title: async () => '',
      mouse,
      keyboard,
    } as unknown as LaunchedBrowser['page'],
  }
  const session = new PlaywrightBrowserSession({
    id: 'sess-action' as ComputerSessionId,
    settings: makeSettings(),
    options: { headless: true },
    requestClose: async () => {},
    launched,
  })
  return { session, mouse, keyboard }
}

const POINT_CENTER: NormalizedPoint = { x: 0.5, y: 0.5 }
// Settings default 1024x768 → CSS px (round(0.5 * 1023), round(0.5 * 767)) = (512, 384).
const CENTER_CSS_X = 512
const CENTER_CSS_Y = 384

describe('PlaywrightBrowserSession action methods', () => {
  describe('click', () => {
    it('converts NormalizedPoint to CSS px and forwards button to page.mouse.click', async () => {
      const { session, mouse } = makeSpiedSession()
      await session.click(POINT_CENTER, 'right', new AbortController().signal)
      expect(mouse.click).toHaveBeenCalledTimes(1)
      expect(mouse.click).toHaveBeenCalledWith(CENTER_CSS_X, CENTER_CSS_Y, { button: 'right' })
    })

    it('rejects with session_closed after close()', async () => {
      const { session } = makeSpiedSession()
      await session.close()
      await expect(
        session.click(POINT_CENTER, 'left', new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'session_closed' })
    })

    it('translates Playwright errors into interaction_failed', async () => {
      const { session } = makeSpiedSession({
        mouseImpl: {
          click: async () => {
            throw new Error('Target page, context or browser has been closed')
          },
        },
      })
      await expect(
        session.click(POINT_CENTER, 'left', new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'interaction_failed' })
    })
  })

  describe('doubleClick', () => {
    it('forwards to page.mouse.dblclick with the right CSS px and button', async () => {
      const { session, mouse } = makeSpiedSession()
      await session.doubleClick({ x: 0, y: 1 }, 'middle', new AbortController().signal)
      expect(mouse.dblclick).toHaveBeenCalledWith(0, 767, { button: 'middle' })
    })
  })

  describe('typeText', () => {
    it('forwards to page.keyboard.type', async () => {
      const { session, keyboard } = makeSpiedSession()
      await session.typeText('hello world', new AbortController().signal)
      expect(keyboard.type).toHaveBeenCalledWith('hello world')
    })

    it('translates Playwright errors into interaction_failed', async () => {
      const { session } = makeSpiedSession({
        keyboardImpl: {
          type: async () => {
            throw new Error('keyboard locked')
          },
        },
      })
      await expect(
        session.typeText('x', new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'interaction_failed' })
    })
  })

  describe('pressKey', () => {
    it('forwards to page.keyboard.press', async () => {
      const { session, keyboard } = makeSpiedSession()
      await session.pressKey('Enter', new AbortController().signal)
      expect(keyboard.press).toHaveBeenCalledWith('Enter')
    })
  })

  describe('scroll', () => {
    it('moves to the anchor point first, then wheels', async () => {
      const { session, mouse } = makeSpiedSession()
      await session.scroll({ x: 0.25, y: 0.75 }, 0, 250, new AbortController().signal)
      // 0.25 * 1023 = 255.75 → 256; 0.75 * 767 = 575.25 → 575
      expect(mouse.move).toHaveBeenCalledWith(256, 575)
      expect(mouse.wheel).toHaveBeenCalledWith(0, 250)
      // move was called BEFORE wheel
      const moveOrder = mouse.move.mock.invocationCallOrder[0]
      const wheelOrder = mouse.wheel.mock.invocationCallOrder[0]
      expect(moveOrder).toBeLessThan(wheelOrder)
    })

    it('skips move when point is null (page-level scroll)', async () => {
      const { session, mouse } = makeSpiedSession()
      await session.scroll(null, 0, 100, new AbortController().signal)
      expect(mouse.move).not.toHaveBeenCalled()
      expect(mouse.wheel).toHaveBeenCalledWith(0, 100)
    })
  })

  describe('drag', () => {
    it('runs move-down-move-up in order with the right CSS px', async () => {
      const { session, mouse } = makeSpiedSession()
      await session.drag(
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        new AbortController().signal,
      )
      expect(mouse.move).toHaveBeenNthCalledWith(1, 0, 0)
      expect(mouse.down).toHaveBeenCalledTimes(1)
      expect(mouse.move).toHaveBeenNthCalledWith(2, 1023, 767)
      expect(mouse.up).toHaveBeenCalledTimes(1)
      // Order: move(from) → down → move(to) → up
      const orders = [
        mouse.move.mock.invocationCallOrder[0],
        mouse.down.mock.invocationCallOrder[0],
        mouse.move.mock.invocationCallOrder[1],
        mouse.up.mock.invocationCallOrder[0],
      ]
      const sorted = [...orders].sort((a, b) => a - b)
      expect(orders).toEqual(sorted)
    })

    it('best-effort releases the mouse button when move(to) throws after down() succeeded', async () => {
      // Phase 3 review fix: without the finally-up() cleanup, a throw between
      // down() and up() leaves the Playwright mouse logically held down,
      // bleeding state into subsequent operations on the same session.
      let moveCount = 0
      const { session, mouse } = makeSpiedSession({
        mouseImpl: {
          move: async () => {
            moveCount++
            // The first move (from) succeeds; the second move (to) throws.
            if (moveCount === 2) throw new Error('move-to failed')
          },
        },
      })
      await expect(
        session.drag({ x: 0, y: 0 }, { x: 1, y: 1 }, new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'interaction_failed' })
      // down() ran exactly once; up() must have been called from the cleanup
      // path since the success-path up() never executes after the throw.
      expect(mouse.down).toHaveBeenCalledTimes(1)
      expect(mouse.up).toHaveBeenCalledTimes(1)
    })

    it('does not call up() if down() never ran (failure before mouse-down)', async () => {
      const { session, mouse } = makeSpiedSession({
        mouseImpl: {
          move: async () => {
            throw new Error('move-from failed')
          },
        },
      })
      await expect(
        session.drag({ x: 0, y: 0 }, { x: 1, y: 1 }, new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'interaction_failed' })
      expect(mouse.down).not.toHaveBeenCalled()
      expect(mouse.up).not.toHaveBeenCalled()
    })
  })

  describe('ariaSnapshot (Phase 4·1)', () => {
    function makeSessionWithEvaluate(
      evaluateImpl: () => Promise<unknown>,
    ): PlaywrightBrowserSession {
      const noop = async () => {}
      const noopRoute = async (_pattern: string, _handler: unknown) => {}
      const noopOn = (_event: string, _handler: unknown) => {}
      const launched: LaunchedBrowser = {
        browser: { close: noop } as unknown as LaunchedBrowser['browser'],
        context: {
          close: noop,
          route: noopRoute,
          on: noopOn,
        } as unknown as LaunchedBrowser['context'],
        page: {
          url: () => 'about:blank',
          title: async () => '',
          evaluate: vi.fn(evaluateImpl),
        } as unknown as LaunchedBrowser['page'],
      }
      return new PlaywrightBrowserSession({
        id: 'sess-aria' as ComputerSessionId,
        settings: makeSettings(),
        options: { headless: true },
        requestClose: async () => {},
        launched,
      })
    }

    const sampleTree = {
      role: 'main',
      name: null,
      bbox: null,
      focused: false,
      disabled: false,
      children: [
        {
          role: 'button',
          name: 'Submit',
          bbox: { x: 100, y: 100, width: 80, height: 30 },
          focused: false,
          disabled: false,
          children: [],
        },
      ],
    }

    it('captures the tree via page.evaluate and returns a snapshot with hash + yaml', async () => {
      const session = makeSessionWithEvaluate(async () => sampleTree)
      const snap = await session.ariaSnapshot(new AbortController().signal)
      expect(snap.tree).toEqual(sampleTree)
      expect(snap.yaml).toContain('button "Submit"')
      expect(snap.hash).toMatch(/^[0-9a-f]{16}$/)
    })

    it('caches the snapshot — lastAriaSnapshot returns it after capture', async () => {
      const session = makeSessionWithEvaluate(async () => sampleTree)
      expect(session.lastAriaSnapshot()).toBeNull()
      const snap = await session.ariaSnapshot(new AbortController().signal)
      expect(session.lastAriaSnapshot()).toBe(snap)
    })

    it('lastAriaSnapshot returns null after close', async () => {
      const session = makeSessionWithEvaluate(async () => sampleTree)
      await session.ariaSnapshot(new AbortController().signal)
      expect(session.lastAriaSnapshot()).not.toBeNull()
      await session.close()
      expect(session.lastAriaSnapshot()).toBeNull()
    })

    it('clears the cache on capture failure (fix #7 — no stale snapshot for the next safety check)', async () => {
      // Stateful evaluate: succeed on first call, fail on second.
      let calls = 0
      const session = makeSessionWithEvaluate(async () => {
        calls++
        if (calls === 1) return sampleTree
        throw new Error('page evaluate broke')
      })
      // First capture: cache populates with the sample.
      await session.ariaSnapshot(new AbortController().signal)
      expect(session.lastAriaSnapshot()).not.toBeNull()
      // Second capture fails — the cache MUST be cleared so a follow-up
      // safety check doesn't classify against the stale tree from call 1.
      await expect(
        session.ariaSnapshot(new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'interaction_failed' })
      expect(session.lastAriaSnapshot()).toBeNull()
    })

    it('maps page.evaluate failures to interaction_failed', async () => {
      const session = makeSessionWithEvaluate(async () => {
        throw new Error('ouch')
      })
      await expect(
        session.ariaSnapshot(new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'interaction_failed' })
    })

    it('returns aborted when signal is already aborted', async () => {
      const ctrl = new AbortController()
      ctrl.abort()
      const session = makeSessionWithEvaluate(async () => sampleTree)
      await expect(
        session.ariaSnapshot(ctrl.signal),
      ).rejects.toMatchObject({ kind: 'aborted' })
    })
  })

  describe('getSensitiveRegions + screenshot redaction (Phase 4·2)', () => {
    type FakeHandle = {
      boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>
      dispose: () => Promise<void>
    }

    function makeSessionWithLocator(
      locatorHandles: Map<string, FakeHandle[]>,
      screenshotPng: Buffer,
      opts?: {
        extraSelectors?: readonly string[]
        recordScreenshot?: (bytes: number) => void
      },
    ): PlaywrightBrowserSession {
      const noop = async () => {}
      const noopRoute = async (_pattern: string, _handler: unknown) => {}
      const noopOn = (_event: string, _handler: unknown) => {}
      const launched: LaunchedBrowser = {
        browser: { close: noop } as unknown as LaunchedBrowser['browser'],
        context: {
          close: noop,
          route: noopRoute,
          on: noopOn,
        } as unknown as LaunchedBrowser['context'],
        page: {
          url: () => 'about:blank',
          title: async () => 'test',
          screenshot: async () => screenshotPng,
          locator: (selector: string) => ({
            elementHandles: async () => locatorHandles.get(selector) ?? [],
          }),
        } as unknown as LaunchedBrowser['page'],
      }
      const settings = makeSettings({
        ...(opts?.extraSelectors !== undefined && { redactionSelectors: opts.extraSelectors }),
      })
      return new PlaywrightBrowserSession({
        id: 'sess-redact' as ComputerSessionId,
        settings,
        options: { headless: true },
        requestClose: async () => {},
        ...(opts?.recordScreenshot !== undefined && { recordScreenshot: opts.recordScreenshot }),
        launched,
      })
    }

    function makeWhitePng(w: number, h: number): Buffer {
      const rgba = new Uint8Array(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = 255
        rgba[i * 4 + 1] = 255
        rgba[i * 4 + 2] = 255
        rgba[i * 4 + 3] = 255
      }
      return Buffer.from(encodePng(w, h, rgba))
    }

    it('returns no regions when no selectors match', async () => {
      const session = makeSessionWithLocator(new Map(), makeWhitePng(32, 32))
      const regions = await session.getSensitiveRegions([], new AbortController().signal)
      expect(regions).toEqual([])
    })

    it('aggregates bboxes from matching selectors', async () => {
      const handles = new Map<string, FakeHandle[]>([
        [
          'input[type="password"]',
          [
            {
              boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 30 }),
              dispose: async () => {},
            },
          ],
        ],
      ])
      const session = makeSessionWithLocator(handles, makeWhitePng(32, 32))
      const regions = await session.getSensitiveRegions([], new AbortController().signal)
      expect(regions).toEqual([{ x: 10, y: 20, width: 100, height: 30 }])
    })

    it('skips elements with null boundingBox (off-screen / hidden)', async () => {
      const handles = new Map<string, FakeHandle[]>([
        [
          'input[type="password"]',
          [
            { boundingBox: async () => null, dispose: async () => {} },
            {
              boundingBox: async () => ({ x: 5, y: 5, width: 50, height: 20 }),
              dispose: async () => {},
            },
          ],
        ],
      ])
      const session = makeSessionWithLocator(handles, makeWhitePng(32, 32))
      const regions = await session.getSensitiveRegions([], new AbortController().signal)
      expect(regions).toEqual([{ x: 5, y: 5, width: 50, height: 20 }])
    })

    it('screenshot applies blackouts and stamps redacted=true when regions are present', async () => {
      const handles = new Map<string, FakeHandle[]>([
        [
          'input[type="password"]',
          [
            {
              boundingBox: async () => ({ x: 4, y: 4, width: 16, height: 16 }),
              dispose: async () => {},
            },
          ],
        ],
      ])
      const session = makeSessionWithLocator(handles, makeWhitePng(32, 32))
      const result = await session.screenshot(new AbortController().signal)
      expect(result.attachment.redacted).toBe(true)
      // Decode the result and check the blackout region is black, outside is white.
      const decoded = decodePng(Buffer.from(result.attachment.data, 'base64'))
      const inBoxOff = (10 * 32 + 10) * 4 // pixel inside the bbox
      const outBoxOff = (0 * 32 + 0) * 4 // top-left, outside
      expect(decoded.rgba[inBoxOff]).toBe(0)
      expect(decoded.rgba[inBoxOff + 1]).toBe(0)
      expect(decoded.rgba[inBoxOff + 2]).toBe(0)
      expect(decoded.rgba[outBoxOff]).toBe(255)
    })

    it('screenshot leaves attachment.redacted unset when no regions are found', async () => {
      const session = makeSessionWithLocator(new Map(), makeWhitePng(32, 32))
      const result = await session.screenshot(new AbortController().signal)
      expect(result.attachment.redacted).toBeFalsy()
    })

    // v3 Phase 6 — pin the metrics callback wiring at the runtime layer.
    // sessionMetrics.test.ts proves the manager hands a bound callback to the
    // factory; this test proves PlaywrightBrowserSession actually invokes it
    // with the on-the-wire byte count after each successful capture.
    it('screenshot invokes recordScreenshot exactly once with the encoded byte size', async () => {
      const recordedBytes: number[] = []
      const session = makeSessionWithLocator(new Map(), makeWhitePng(32, 32), {
        recordScreenshot: (bytes) => recordedBytes.push(bytes),
      })
      const result = await session.screenshot(new AbortController().signal)
      expect(recordedBytes).toHaveLength(1)
      expect(recordedBytes[0]).toBe(result.attachment.byteSize)
      expect(recordedBytes[0]).toBeGreaterThan(0)
    })

    it('screenshot does NOT invoke recordScreenshot when capture fails', async () => {
      // Use a non-PNG buffer that pngCodec rejects → screenshot rejects with
      // screenshot_failed; the metrics callback must not be called for a
      // failed capture (count would mislead the eval suite into thinking the
      // model received a usable image).
      const handles = new Map<string, FakeHandle[]>([
        [
          'input[type="password"]',
          [
            {
              boundingBox: async () => ({ x: 0, y: 0, width: 4, height: 4 }),
              dispose: async () => {},
            },
          ],
        ],
      ])
      const recordedBytes: number[] = []
      const garbageBuffer = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])
      const session = makeSessionWithLocator(handles, garbageBuffer, {
        recordScreenshot: (bytes) => recordedBytes.push(bytes),
      })
      await expect(
        session.screenshot(new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'screenshot_failed' })
      expect(recordedBytes).toHaveLength(0)
    })

    it('screenshot FAILS CLOSED when blackout fails AFTER regions are detected (fix #9)', async () => {
      // Simulate a working selector probe (regions found) but a corrupted
      // PNG that the blackout codec can't decode. The previous single
      // try/catch lumped these failures together and shipped the unredacted
      // PNG — exposing the exact fields we identified as sensitive.
      const handles = new Map<string, FakeHandle[]>([
        [
          'input[type="password"]',
          [
            {
              boundingBox: async () => ({ x: 0, y: 0, width: 4, height: 4 }),
              dispose: async () => {},
            },
          ],
        ],
      ])
      // Pass a NON-PNG buffer as the screenshot — pngCodec.decodePng will
      // throw on the signature check, simulating a blackout failure.
      const garbageBuffer = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])
      const session = makeSessionWithLocator(handles, garbageBuffer)
      await expect(
        session.screenshot(new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'screenshot_failed' })
    })

    it('screenshot still succeeds when selector probe throws (best-effort redaction)', async () => {
      const noop = async () => {}
      const noopRoute = async (_pattern: string, _handler: unknown) => {}
      const noopOn = (_event: string, _handler: unknown) => {}
      const launched: LaunchedBrowser = {
        browser: { close: noop } as unknown as LaunchedBrowser['browser'],
        context: {
          close: noop,
          route: noopRoute,
          on: noopOn,
        } as unknown as LaunchedBrowser['context'],
        page: {
          url: () => 'about:blank',
          title: async () => 'test',
          screenshot: async () => makeWhitePng(16, 16),
          // locator throws — the screenshot path must still ship the PNG.
          locator: () => {
            throw new Error('locator broke')
          },
        } as unknown as LaunchedBrowser['page'],
      }
      const session = new PlaywrightBrowserSession({
        id: 'sess-broken-locator' as ComputerSessionId,
        settings: makeSettings(),
        options: { headless: true },
        requestClose: async () => {},
        launched,
      })
      const result = await session.screenshot(new AbortController().signal)
      // Unredacted but still a valid attachment.
      expect(result.attachment.redacted).toBeFalsy()
      expect(result.attachment.type).toBe('image')
    })
  })

  describe('post-op abort hardening', () => {
    it('throws aborted when signal flips DURING a fast op that resolves successfully', async () => {
      // Models the race the hardening fixes: page.mouse.click resolves
      // synchronously while the signal aborts mid-flight. Without the post-op
      // check, the success value would propagate.
      const ctrl = new AbortController()
      const { session } = makeSpiedSession({
        mouseImpl: {
          click: async () => {
            ctrl.abort()
          },
        },
      })
      await expect(
        session.click(POINT_CENTER, 'left', ctrl.signal),
      ).rejects.toBeInstanceOf(BrowserSessionError)
      await expect(
        session.click(POINT_CENTER, 'left', ctrl.signal),
      ).rejects.toMatchObject({ kind: 'aborted' })
    })

    it('throws aborted when the signal is already aborted before the call', async () => {
      const ctrl = new AbortController()
      ctrl.abort()
      const { session } = makeSpiedSession()
      await expect(
        session.click(POINT_CENTER, 'left', ctrl.signal),
      ).rejects.toMatchObject({ kind: 'aborted' })
    })
  })
})

// ---------------------------------------------------------------------------
// Phase 4b — atom cache surface (setAtomCache / lookupAtom / currentAtomCache)
// ---------------------------------------------------------------------------

describe('PlaywrightBrowserSession atom cache (Phase 4b)', () => {
  // Build a session whose `page.evaluate` returns a controllable AriaNode tree
  // — we use the same trick as the ariaSnapshot tests so we can drive
  // `_lastAriaSnapshot` explicitly between cache operations.
  function makeSession(
    evaluateImpl: () => Promise<unknown>,
    navigateImpl?: (url: string) => Promise<unknown>,
  ): PlaywrightBrowserSession {
    const noop = async () => {}
    const noopRoute = async (_pattern: string, _handler: unknown) => {}
    const noopOn = (_event: string, _handler: unknown) => {}
    const launched: LaunchedBrowser = {
      browser: { close: noop } as unknown as LaunchedBrowser['browser'],
      context: {
        close: noop,
        route: noopRoute,
        on: noopOn,
      } as unknown as LaunchedBrowser['context'],
      page: {
        url: () => 'about:blank',
        title: async () => '',
        goto: navigateImpl !== undefined ? vi.fn(navigateImpl) : async () => null,
        evaluate: vi.fn(evaluateImpl),
      } as unknown as LaunchedBrowser['page'],
    }
    return new PlaywrightBrowserSession({
      id: 'sess-atom' as ComputerSessionId,
      settings: makeSettings({ allowedDomains: ['example.com'] }),
      options: { headless: true, allowHttpForTest: false },
      requestClose: async () => {},
      launched,
    })
  }

  function makeAtomCache(ariaHash: string, atomId = 'a-0'): {
    url: string
    ariaHash: string
    entries: Map<string, import('./atomResolver.js').AtomEntry>
  } {
    return {
      url: 'https://example.com/',
      ariaHash,
      entries: new Map([
        [
          atomId,
          {
            atomId,
            role: 'button',
            displayName: 'X',
            locatorName: 'X',
            node: {
              role: 'button', name: 'X', bbox: null, focused: false, disabled: false, children: [],
            },
            ancestorPath: [],
            nth: 0,
          },
        ],
      ]),
    }
  }

  const sampleTree = {
    role: 'main', name: null, bbox: null, focused: false, disabled: false,
    children: [{ role: 'button', name: 'X', bbox: null, focused: false, disabled: false, children: [] }],
  }

  it('setAtomCache + currentAtomCache round-trip', () => {
    const session = makeSession(async () => sampleTree)
    expect(session.currentAtomCache()).toBeNull()
    const cache = makeAtomCache('h1')
    session.setAtomCache(cache)
    expect(session.currentAtomCache()).toBe(cache)
  })

  it('lookupAtom returns null when no cache is set', () => {
    const session = makeSession(async () => sampleTree)
    expect(session.lookupAtom('a-0')).toBeNull()
  })

  it('lookupAtom returns the entry when cache.ariaHash matches the live ARIA hash (replay)', async () => {
    const session = makeSession(async () => sampleTree)
    // Take a snapshot so _lastAriaSnapshot is set; build the cache against that hash.
    const snap = await session.ariaSnapshot(new AbortController().signal)
    session.setAtomCache(makeAtomCache(snap.hash))
    const entry = session.lookupAtom('a-0')
    expect(entry).not.toBeNull()
    expect(entry?.atomId).toBe('a-0')
  })

  it('lookupAtom returns null when liveAriaHash diverges from cache.ariaHash (stale-cache guard)', async () => {
    // This is the high-severity bypass fix: after an action mutates the page
    // and a fresh ariaSnapshot updates _lastAriaSnapshot to a NEW hash, the
    // cached atomId must no longer resolve — the cached AriaNode could
    // misrepresent the live element (e.g., a previously-disabled Delete
    // button that's now enabled).
    let call = 0
    const trees = [
      sampleTree,
      // Second snapshot has a different child name → different YAML hash.
      {
        role: 'main', name: null, bbox: null, focused: false, disabled: false,
        children: [{ role: 'button', name: 'Y', bbox: null, focused: false, disabled: false, children: [] }],
      },
    ]
    const session = makeSession(async () => {
      const t = trees[call] ?? sampleTree
      call++
      return t
    })
    const snap1 = await session.ariaSnapshot(new AbortController().signal)
    session.setAtomCache(makeAtomCache(snap1.hash))
    expect(session.lookupAtom('a-0')).not.toBeNull()
    // Recapture — _lastAriaSnapshot now has a different hash.
    const snap2 = await session.ariaSnapshot(new AbortController().signal)
    expect(snap2.hash).not.toBe(snap1.hash)
    // Cache wasn't refreshed → lookupAtom must refuse.
    expect(session.lookupAtom('a-0')).toBeNull()
  })

  it('lookupAtom returns null when _lastAriaSnapshot is null (post-action capture failed)', async () => {
    let call = 0
    const session = makeSession(async () => {
      call++
      if (call === 1) return sampleTree
      throw new Error('evaluate failed')
    })
    const snap = await session.ariaSnapshot(new AbortController().signal)
    session.setAtomCache(makeAtomCache(snap.hash))
    expect(session.lookupAtom('a-0')).not.toBeNull()
    // Failed recapture clears _lastAriaSnapshot (Phase 4·1 fix #7).
    await expect(session.ariaSnapshot(new AbortController().signal)).rejects.toMatchObject({
      kind: 'interaction_failed',
    })
    expect(session.lastAriaSnapshot()).toBeNull()
    // Defensive posture: no live hash means we can't trust the cache either.
    expect(session.lookupAtom('a-0')).toBeNull()
  })

  it('navigate() clears the atom cache eagerly', async () => {
    const session = makeSession(
      async () => sampleTree,
      async () => null,
    )
    const snap = await session.ariaSnapshot(new AbortController().signal)
    session.setAtomCache(makeAtomCache(snap.hash))
    expect(session.currentAtomCache()).not.toBeNull()
    await session.navigate('https://example.com/x', new AbortController().signal)
    expect(session.currentAtomCache()).toBeNull()
  })

  it('close() clears the atom cache', async () => {
    const session = makeSession(async () => sampleTree)
    const snap = await session.ariaSnapshot(new AbortController().signal)
    session.setAtomCache(makeAtomCache(snap.hash))
    expect(session.currentAtomCache()).not.toBeNull()
    await session.close()
    expect(session.currentAtomCache()).toBeNull()
    expect(session.lookupAtom('a-0')).toBeNull()
  })
})
