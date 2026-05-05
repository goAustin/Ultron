import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { spawnMock } = vi.hoisted(() => {
  return { spawnMock: vi.fn() }
})
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import { OpenInBrowserTool } from './OpenInBrowserTool.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { createStore, getDefaultAppState } from '../core/state.js'

function makeContext() {
  return createToolUseContext({
    appState: createStore(getDefaultAppState()),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createToolRegistry(),
  })
}

type FakeChild = {
  unref: ReturnType<typeof vi.fn>
  once: (event: string, handler: (err?: Error) => void) => FakeChild
  emitError?: Error
}

function makeFakeChild(opts: { emitError?: Error } = {}): FakeChild {
  const child: FakeChild = {
    unref: vi.fn(),
    once(event, handler) {
      if (event === 'error' && opts.emitError) {
        // Synchronously schedule the error so the tool's setImmediate
        // resolution loses the race (consistent with real spawn behavior on
        // ENOENT).
        queueMicrotask(() => handler(opts.emitError))
      }
      return child
    },
  }
  return child
}

const signal = new AbortController().signal
const originalPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  spawnMock.mockReset()
  spawnMock.mockReturnValue(makeFakeChild())
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('OpenInBrowserTool', () => {
  it('has the expected metadata', () => {
    expect(OpenInBrowserTool.name).toBe('OpenInBrowser')
    expect(OpenInBrowserTool.isMutating).toBe(false)
    expect(OpenInBrowserTool.isReadOnly).toBe(true)
    expect(OpenInBrowserTool.isConcurrencySafe?.({})).toBe(true)
    expect(OpenInBrowserTool.getDomain?.({ url: 'https://example.com/path' })).toBe(
      'example.com',
    )
  })

  describe('validateInput', () => {
    it('accepts https URLs', async () => {
      const ctx = makeContext()
      const v = await OpenInBrowserTool.validateInput(
        { url: 'https://example.com' },
        ctx,
      )
      expect(v.valid).toBe(true)
    })

    it('accepts http URLs', async () => {
      const ctx = makeContext()
      const v = await OpenInBrowserTool.validateInput(
        { url: 'http://example.com' },
        ctx,
      )
      expect(v.valid).toBe(true)
    })

    it('rejects file:// URLs', async () => {
      const ctx = makeContext()
      const v = await OpenInBrowserTool.validateInput(
        { url: 'file:///etc/passwd' },
        ctx,
      )
      expect(v.valid).toBe(false)
      if (!v.valid) expect(v.message).toContain('http(s)')
    })

    it('rejects javascript: URLs', async () => {
      const ctx = makeContext()
      const v = await OpenInBrowserTool.validateInput(
        { url: 'javascript:alert(1)' },
        ctx,
      )
      expect(v.valid).toBe(false)
    })

    it('rejects data: URLs', async () => {
      const ctx = makeContext()
      const v = await OpenInBrowserTool.validateInput(
        { url: 'data:text/html,<script>alert(1)</script>' },
        ctx,
      )
      expect(v.valid).toBe(false)
    })

    it('rejects malformed URLs', async () => {
      const ctx = makeContext()
      const v = await OpenInBrowserTool.validateInput(
        { url: 'not a url' },
        ctx,
      )
      expect(v.valid).toBe(false)
    })

    it('rejects URLs with userinfo', async () => {
      const ctx = makeContext()
      const v = await OpenInBrowserTool.validateInput(
        { url: 'https://user:pass@example.com' },
        ctx,
      )
      expect(v.valid).toBe(false)
    })

    it('rejects empty url', async () => {
      const ctx = makeContext()
      const v = await OpenInBrowserTool.validateInput({ url: '' }, ctx)
      expect(v.valid).toBe(false)
    })
  })

  describe('checkPermissions', () => {
    it('returns allow (defers to cascade)', async () => {
      const ctx = makeContext()
      const p = await OpenInBrowserTool.checkPermissions(
        { url: 'https://example.com' },
        ctx,
      )
      expect(p.behavior).toBe('allow')
    })
  })

  describe('call', () => {
    it('on darwin, spawns "open" with the url as a separate argv element', async () => {
      setPlatform('darwin')
      const ctx = makeContext()
      const result = await OpenInBrowserTool.call(
        { url: 'https://youtube.com/watch?v=abc' },
        ctx,
        signal,
      )
      expect(result.isError).toBe(false)
      expect(result.content).toContain('Opened')
      expect(spawnMock).toHaveBeenCalledTimes(1)
      const [command, args] = spawnMock.mock.calls[0]
      expect(command).toBe('open')
      expect(args).toEqual(['https://youtube.com/watch?v=abc'])
    })

    it('on linux, spawns "xdg-open" with the url as a separate argv element', async () => {
      setPlatform('linux')
      const ctx = makeContext()
      const result = await OpenInBrowserTool.call(
        { url: 'https://example.com' },
        ctx,
        signal,
      )
      expect(result.isError).toBe(false)
      const [command, args] = spawnMock.mock.calls[0]
      expect(command).toBe('xdg-open')
      expect(args).toEqual(['https://example.com'])
    })

    it('on win32, spawns "cmd /c start" with the url after a blank title', async () => {
      setPlatform('win32')
      const ctx = makeContext()
      const result = await OpenInBrowserTool.call(
        { url: 'https://example.com' },
        ctx,
        signal,
      )
      expect(result.isError).toBe(false)
      const [command, args] = spawnMock.mock.calls[0]
      expect(command).toBe('cmd')
      // Empty title arg prevents `start` from interpreting the url as a window title.
      expect(args).toEqual(['/c', 'start', '', 'https://example.com'])
    })

    it('detaches and unrefs the child so it outlives this process', async () => {
      setPlatform('darwin')
      const child = makeFakeChild()
      spawnMock.mockReturnValueOnce(child)
      const ctx = makeContext()
      await OpenInBrowserTool.call({ url: 'https://example.com' }, ctx, signal)
      const opts = spawnMock.mock.calls[0][2]
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
      expect(child.unref).toHaveBeenCalled()
    })

    it('returns an aborted result when signal is already aborted', async () => {
      setPlatform('darwin')
      const ctx = makeContext()
      const ac = new AbortController()
      ac.abort()
      const result = await OpenInBrowserTool.call(
        { url: 'https://example.com' },
        ctx,
        ac.signal,
      )
      expect(result.isError).toBe(true)
      expect(result.errorKind).toBe('aborted')
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('reports execution_error when spawn emits an error', async () => {
      setPlatform('linux')
      spawnMock.mockReturnValueOnce(
        makeFakeChild({ emitError: new Error('ENOENT: xdg-open not found') }),
      )
      const ctx = makeContext()
      const result = await OpenInBrowserTool.call(
        { url: 'https://example.com' },
        ctx,
        signal,
      )
      expect(result.isError).toBe(true)
      expect(result.errorKind).toBe('execution_error')
      expect(result.content).toContain('xdg-open not found')
    })
  })
})
