import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSearchTool, formatResults } from './WebSearchTool.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import { __setSettingsPathForTest } from '../config/settingsConfig.js'
import * as resolverMod from '../web/searchBackend.js'
import type { NotifyEvent } from '../core/tools/context.js'

function makeContext(opts: { notify?: (e: NotifyEvent) => void } = {}) {
  const registry = createToolRegistry()
  registry.register(WebSearchTool)
  return createToolUseContext({
    appState: createStore(getDefaultAppState()),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: registry,
    ...(opts.notify && { notify: opts.notify }),
  })
}

describe('WebSearchTool.validateInput', () => {
  const ctx = makeContext()

  it('rejects missing query', async () => {
    expect((await WebSearchTool.validateInput({}, ctx)).valid).toBe(false)
  })

  it('rejects empty query', async () => {
    expect((await WebSearchTool.validateInput({ query: '   ' }, ctx)).valid).toBe(false)
  })

  it('rejects non-string query', async () => {
    expect((await WebSearchTool.validateInput({ query: 42 }, ctx)).valid).toBe(false)
  })

  it('rejects oversized query', async () => {
    const long = 'a'.repeat(3000)
    expect((await WebSearchTool.validateInput({ query: long }, ctx)).valid).toBe(false)
  })

  it('rejects limit < 1', async () => {
    expect((await WebSearchTool.validateInput({ query: 'x', limit: 0 }, ctx)).valid).toBe(false)
  })

  it('rejects limit > 20', async () => {
    expect((await WebSearchTool.validateInput({ query: 'x', limit: 21 }, ctx)).valid).toBe(false)
  })

  it('rejects non-finite limit', async () => {
    expect((await WebSearchTool.validateInput({ query: 'x', limit: NaN }, ctx)).valid).toBe(false)
  })

  it('accepts a normal query', async () => {
    const r = await WebSearchTool.validateInput({ query: 'react hooks' }, ctx)
    expect(r.valid).toBe(true)
  })

  it('accepts limit at boundaries', async () => {
    expect((await WebSearchTool.validateInput({ query: 'x', limit: 1 }, ctx)).valid).toBe(true)
    expect((await WebSearchTool.validateInput({ query: 'x', limit: 20 }, ctx)).valid).toBe(true)
  })

  it.each(['day', 'week', 'month', 'year'])('accepts recency=%s', async (recency) => {
    const r = await WebSearchTool.validateInput({ query: 'x', recency }, ctx)
    expect(r.valid).toBe(true)
  })

  it('rejects unknown recency value', async () => {
    const r = await WebSearchTool.validateInput({ query: 'x', recency: 'forever' }, ctx)
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.message).toContain('day')
  })

  it('rejects non-string recency', async () => {
    const r = await WebSearchTool.validateInput({ query: 'x', recency: 7 }, ctx)
    expect(r.valid).toBe(false)
  })
})

describe('WebSearchTool.checkPermissions', () => {
  it('always returns allow (cascade decides)', async () => {
    const ctx = makeContext()
    const r = await WebSearchTool.checkPermissions({ query: 'x' }, ctx)
    expect(r.behavior).toBe('allow')
  })
})

describe('WebSearchTool.getDomain (intentionally absent)', () => {
  it('does not expose getDomain — search is not host-scoped', () => {
    expect(WebSearchTool.getDomain).toBeUndefined()
  })
})

describe('WebSearchTool.call', () => {
  let dir: string
  let prevBrave: string | undefined
  let prevTavily: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ultron-ws-'))
    __setSettingsPathForTest(join(dir, 'settings.json'))
    prevBrave = process.env.BRAVE_SEARCH_API_KEY
    prevTavily = process.env.TAVILY_API_KEY
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.TAVILY_API_KEY
  })

  afterEach(() => {
    __setSettingsPathForTest(null)
    rmSync(dir, { recursive: true, force: true })
    if (prevBrave !== undefined) process.env.BRAVE_SEARCH_API_KEY = prevBrave
    else delete process.env.BRAVE_SEARCH_API_KEY
    if (prevTavily !== undefined) process.env.TAVILY_API_KEY = prevTavily
    else delete process.env.TAVILY_API_KEY
    vi.restoreAllMocks()
  })

  it('returns formatted results from the resolved backend', async () => {
    vi.spyOn(resolverMod, 'resolveSearchBackend').mockReturnValue({
      backend: {
        id: 'duckduckgo',
        async search() {
          return [
            { title: 'Hooks docs', url: 'https://react.dev/hooks', snippet: 'Use state...', unwrapped: true },
            { title: 'Hooks tutorial', url: 'https://example.com/h', snippet: 'A guide.', unwrapped: true },
          ]
        },
      },
      source: 'default',
    })

    const ctx = makeContext()
    const ac = new AbortController()
    const r = await WebSearchTool.call({ query: 'react hooks' }, ctx, ac.signal)
    expect(r.isError).toBe(false)
    expect(r.content).toContain('WebSearch: "react hooks" (via duckduckgo)')
    expect(r.content).toContain('react.dev/hooks')
    expect(r.content).toContain('Hooks tutorial')
  })

  it('emits web_backend_resolved on every call (runtime dedups)', async () => {
    vi.spyOn(resolverMod, 'resolveSearchBackend').mockReturnValue({
      backend: { id: 'duckduckgo', async search() { return [] } },
      source: 'default',
    })

    const events: NotifyEvent[] = []
    const ctx = makeContext({ notify: (e) => events.push(e) })
    const ac = new AbortController()
    await WebSearchTool.call({ query: 'a' }, ctx, ac.signal)
    await WebSearchTool.call({ query: 'b' }, ctx, ac.signal)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'web_backend_resolved',
      backend: 'duckduckgo',
      source: 'default',
    })
  })

  it('surfaces backend errors as execution_error', async () => {
    vi.spyOn(resolverMod, 'resolveSearchBackend').mockReturnValue({
      backend: {
        id: 'duckduckgo',
        async search() {
          throw new Error('network unreachable')
        },
      },
      source: 'default',
    })

    const ctx = makeContext()
    const ac = new AbortController()
    const r = await WebSearchTool.call({ query: 'x' }, ctx, ac.signal)
    expect(r.isError).toBe(true)
    expect(r.errorKind).toBe('execution_error')
    expect(r.content).toContain('network unreachable')
  })

  it('threads recency through to backend.search when set', async () => {
    let received: { recency?: string } = {}
    vi.spyOn(resolverMod, 'resolveSearchBackend').mockReturnValue({
      backend: {
        id: 'tavily',
        async search(_q, opts) {
          received = { recency: opts.recency }
          return []
        },
      },
      source: 'env',
    })

    const ctx = makeContext()
    const ac = new AbortController()
    await WebSearchTool.call(
      { query: 'jensen huang interview', recency: 'month' },
      ctx,
      ac.signal,
    )
    expect(received.recency).toBe('month')
  })

  it('omits recency on backend.search when unset (default search behavior preserved)', async () => {
    let received: { recency?: string } = { recency: 'sentinel' }
    vi.spyOn(resolverMod, 'resolveSearchBackend').mockReturnValue({
      backend: {
        id: 'tavily',
        async search(_q, opts) {
          received = { recency: opts.recency }
          return []
        },
      },
      source: 'env',
    })

    const ctx = makeContext()
    const ac = new AbortController()
    await WebSearchTool.call({ query: 'static docs' }, ctx, ac.signal)
    expect(received.recency).toBeUndefined()
  })

  it('returns aborted when the signal aborts during the backend call', async () => {
    vi.spyOn(resolverMod, 'resolveSearchBackend').mockReturnValue({
      backend: {
        id: 'duckduckgo',
        async search(_q, opts) {
          await new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
          return []
        },
      },
      source: 'default',
    })

    const ctx = makeContext()
    const ac = new AbortController()
    const promise = WebSearchTool.call({ query: 'x' }, ctx, ac.signal)
    ac.abort()
    const r = await promise
    expect(r.isError).toBe(true)
    expect(r.errorKind).toBe('aborted')
  })
})

describe('formatResults', () => {
  it('renders an empty result list with a clear message', () => {
    const out = formatResults('x', 'duckduckgo', [])
    expect(out).toContain('No results.')
  })

  it('numbers results starting at 1', () => {
    const out = formatResults('x', 'brave', [
      { title: 'A', url: 'https://a.com', snippet: '', unwrapped: true },
      { title: 'B', url: 'https://b.com', snippet: '', unwrapped: true },
    ])
    expect(out).toMatch(/^WebSearch: "x" \(via brave\)/)
    expect(out).toContain('1. A')
    expect(out).toContain('2. B')
  })

  it('omits empty snippet line', () => {
    const out = formatResults('x', 'd', [
      { title: 'A', url: 'https://a.com', snippet: '', unwrapped: true },
    ])
    const lines = out.split('\n')
    // Line for title, line for url, blank line. No snippet line.
    expect(lines.filter((l) => l.trim() === '').length).toBeGreaterThanOrEqual(1)
  })
})
