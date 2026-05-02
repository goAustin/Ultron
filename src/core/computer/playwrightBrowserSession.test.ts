import { describe, expect, it, vi } from 'vitest'

import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from '../../config/computerUseSettings.js'

import {
  createPlaywrightSessionFactory,
  type LaunchChromiumFn,
  type LaunchedBrowser,
} from './playwrightBrowserSession.js'
import type { ComputerSessionId } from './types.js'

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
  const browser = { close: noop } as unknown as LaunchedBrowser['browser']
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
      }),
    ).rejects.toThrow(/Timeout 30000ms exceeded/)
    // And NOT translated into chromium_not_installed.
    await expect(
      factory({
        id: 'sess-7c' as ComputerSessionId,
        settings: makeSettings(),
        options: {},
        requestClose: async () => {},
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
    })
    expect(routeRegistered).toBe(true)
  })
})
