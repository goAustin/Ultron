import { describe, expect, it, vi } from 'vitest'

import { WebFetchTool } from './WebFetchTool.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import type { AppState } from '../core/state.js'
import type { PermissionRule } from '../core/permissions/types.js'
import * as fetcherMod from '../web/fetcher.js'
import {
  WebFetchPolicyRedirectError,
  WebFetchPrivateAddressError,
} from '../web/fetcher.js'

function makeContext(stateOverrides: Partial<AppState> = {}) {
  const registry = createToolRegistry()
  registry.register(WebFetchTool)
  return createToolUseContext({
    appState: createStore({ ...getDefaultAppState(), ...stateOverrides }),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: registry,
  })
}

describe('WebFetchTool.validateInput', () => {
  const ctx = makeContext()

  it('rejects missing url', async () => {
    const r = await WebFetchTool.validateInput({}, ctx)
    expect(r.valid).toBe(false)
  })

  it('rejects non-string url', async () => {
    const r = await WebFetchTool.validateInput({ url: 42 }, ctx)
    expect(r.valid).toBe(false)
  })

  it('rejects empty string url', async () => {
    const r = await WebFetchTool.validateInput({ url: '   ' }, ctx)
    expect(r.valid).toBe(false)
  })

  it('rejects malformed url', async () => {
    const r = await WebFetchTool.validateInput({ url: 'not-a-url' }, ctx)
    expect(r.valid).toBe(false)
  })

  it('rejects http://', async () => {
    const r = await WebFetchTool.validateInput({ url: 'http://github.com/' }, ctx)
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.message).toContain('https')
  })

  it('rejects URLs with userinfo', async () => {
    const r = await WebFetchTool.validateInput({ url: 'https://u:p@github.com/' }, ctx)
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.message).toContain('userinfo')
  })

  it('rejects localhost / .local / .internal hosts', async () => {
    expect((await WebFetchTool.validateInput({ url: 'https://localhost/' }, ctx)).valid).toBe(false)
    expect((await WebFetchTool.validateInput({ url: 'https://foo.local/' }, ctx)).valid).toBe(false)
    expect((await WebFetchTool.validateInput({ url: 'https://foo.internal/' }, ctx)).valid).toBe(false)
  })

  it('accepts a well-formed https URL', async () => {
    const r = await WebFetchTool.validateInput({ url: 'https://github.com/foo' }, ctx)
    expect(r.valid).toBe(true)
  })
})

describe('WebFetchTool.getDomain', () => {
  it('returns the lowercased host', () => {
    expect(WebFetchTool.getDomain?.({ url: 'https://A.GITHUB.com/x' })).toBe('a.github.com')
  })

  it('returns undefined for missing url', () => {
    expect(WebFetchTool.getDomain?.({})).toBeUndefined()
  })

  it('returns undefined for non-string url', () => {
    expect(WebFetchTool.getDomain?.({ url: 42 })).toBeUndefined()
  })

  it('returns undefined for malformed URL', () => {
    expect(WebFetchTool.getDomain?.({ url: 'not-a-url' })).toBeUndefined()
  })
})

describe('WebFetchTool.checkPermissions', () => {
  it('returns allow for any well-formed URL (cascade decides)', async () => {
    const ctx = makeContext()
    const r = await WebFetchTool.checkPermissions({ url: 'https://github.com/x' }, ctx)
    expect(r.behavior).toBe('allow')
  })

  it('returns deny for a URL whose host cannot be extracted', async () => {
    const ctx = makeContext()
    const r = await WebFetchTool.checkPermissions({ url: 'https://u:p@github.com/x' }, ctx)
    // userinfo URL → extractHost returns null → deny.
    expect(r.behavior).toBe('deny')
  })
})

describe('WebFetchTool.call (fetchWeb mocked)', () => {
  it('returns a wrapped 200 text/plain response', async () => {
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockResolvedValue({
      status: 200,
      contentType: 'text/plain',
      body: 'hello world',
      truncated: false,
      finalUrl: 'https://github.com/foo',
      redirectChain: ['https://github.com/foo'],
    })
    const ctx = makeContext()
    const result = await WebFetchTool.call(
      { url: 'https://github.com/foo' },
      ctx,
      new AbortController().signal,
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('URL: https://github.com/foo')
    expect(result.content).toContain('Status: 200')
    expect(result.content).toContain('hello world')
    spy.mockRestore()
  })

  it('strips HTML to text for text/html responses', async () => {
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockResolvedValue({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<p>hello <b>world</b></p>',
      truncated: false,
      finalUrl: 'https://github.com/foo',
      redirectChain: ['https://github.com/foo'],
    })
    const ctx = makeContext()
    const result = await WebFetchTool.call(
      { url: 'https://github.com/foo' },
      ctx,
      new AbortController().signal,
    )
    expect(result.content).toContain('hello world')
    expect(result.content).not.toContain('<p>')
    expect(result.content).not.toContain('<b>')
    spy.mockRestore()
  })

  it('appends the redirect chain when length > 1', async () => {
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockResolvedValue({
      status: 200,
      contentType: 'text/plain',
      body: 'ok',
      truncated: false,
      finalUrl: 'https://b.test/x',
      redirectChain: ['https://a.test/x', 'https://b.test/x'],
    })
    const ctx = makeContext()
    const result = await WebFetchTool.call(
      { url: 'https://a.test/x' },
      ctx,
      new AbortController().signal,
    )
    expect(result.content).toContain('Followed redirects:')
    expect(result.content).toContain('a.test')
    expect(result.content).toContain('b.test')
    spy.mockRestore()
  })

  it('marks truncated bodies', async () => {
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockResolvedValue({
      status: 200,
      contentType: 'text/plain',
      body: 'partial',
      truncated: true,
      finalUrl: 'https://github.com/big',
      redirectChain: ['https://github.com/big'],
    })
    const ctx = makeContext()
    const result = await WebFetchTool.call(
      { url: 'https://github.com/big' },
      ctx,
      new AbortController().signal,
    )
    expect(result.content).toContain('[truncated at 5 MB]')
    spy.mockRestore()
  })

  it('returns 404 body without isError', async () => {
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockResolvedValue({
      status: 404,
      contentType: 'text/plain',
      body: 'not found',
      truncated: false,
      finalUrl: 'https://github.com/missing',
      redirectChain: ['https://github.com/missing'],
    })
    const ctx = makeContext()
    const result = await WebFetchTool.call(
      { url: 'https://github.com/missing' },
      ctx,
      new AbortController().signal,
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Status: 404')
    expect(result.content).toContain('not found')
    spy.mockRestore()
  })

  it('returns execution_error on WebFetchPolicyRedirectError', async () => {
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockRejectedValue(
      new WebFetchPolicyRedirectError('redirect to "evil.com" not authorized'),
    )
    const ctx = makeContext()
    const result = await WebFetchTool.call(
      { url: 'https://github.com/' },
      ctx,
      new AbortController().signal,
    )
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('execution_error')
    spy.mockRestore()
  })

  it('returns execution_error on WebFetchPrivateAddressError', async () => {
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockRejectedValue(
      new WebFetchPrivateAddressError('host resolves to private/loopback'),
    )
    const ctx = makeContext()
    const result = await WebFetchTool.call(
      { url: 'https://github.com/' },
      ctx,
      new AbortController().signal,
    )
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('execution_error')
    spy.mockRestore()
  })

  it('returns aborted when signal is aborted', async () => {
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockRejectedValue(new Error('aborted'))
    const ctx = makeContext()
    const ac = new AbortController()
    ac.abort()
    const result = await WebFetchTool.call(
      { url: 'https://github.com/' },
      ctx,
      ac.signal,
    )
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('aborted')
    expect(result.content).toBe('[aborted]')
    spy.mockRestore()
  })
})

describe('WebFetchTool.call — checkPolicy closure reuses cascade rules', () => {
  // The closure inside WebFetchTool.call constructs its own checkPolicy by
  // calling findMatchingRules. We can't easily intercept the closure
  // directly, but we can verify behavior end-to-end by mocking fetchWeb to
  // capture the checkPolicy callback and call it ourselves.

  it('returns allow when a session rule for the host exists', async () => {
    let captured: ((host: string) => 'allow' | 'deny' | 'ask') | undefined
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockImplementation(async (_url, opts) => {
      captured = opts.checkPolicy
      return {
        status: 200,
        contentType: 'text/plain',
        body: 'ok',
        truncated: false,
        finalUrl: 'https://github.com/',
        redirectChain: ['https://github.com/'],
      }
    })

    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'session' },
    ]
    const ctx = makeContext({ permissionRules: rules })
    await WebFetchTool.call({ url: 'https://github.com/' }, ctx, new AbortController().signal)

    expect(captured).toBeDefined()
    expect(captured!('github.com')).toBe('allow')
    expect(captured!('evil.com')).toBe('ask')
    spy.mockRestore()
  })

  it('honours *.suffix wildcard rules', async () => {
    let captured: ((host: string) => 'allow' | 'deny' | 'ask') | undefined
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockImplementation(async (_url, opts) => {
      captured = opts.checkPolicy
      return {
        status: 200,
        contentType: 'text/plain',
        body: 'ok',
        truncated: false,
        finalUrl: 'https://gist.github.com/',
        redirectChain: ['https://gist.github.com/'],
      }
    })

    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: '*.github.com', source: 'session' },
    ]
    const ctx = makeContext({ permissionRules: rules })
    await WebFetchTool.call({ url: 'https://gist.github.com/' }, ctx, new AbortController().signal)

    expect(captured!('gist.github.com')).toBe('allow')
    expect(captured!('github.com')).toBe('ask') // apex excluded
    expect(captured!('a.b.github.com')).toBe('allow')
    spy.mockRestore()
  })

  it('deny rule wins over allow rule for the same host', async () => {
    let captured: ((host: string) => 'allow' | 'deny' | 'ask') | undefined
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockImplementation(async (_url, opts) => {
      captured = opts.checkPolicy
      return {
        status: 200,
        contentType: 'text/plain',
        body: 'ok',
        truncated: false,
        finalUrl: 'https://github.com/',
        redirectChain: ['https://github.com/'],
      }
    })

    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'session' },
      { toolName: 'WebFetch', behavior: 'deny', domain: 'github.com', source: 'userSettings' },
    ]
    const ctx = makeContext({ permissionRules: rules })
    await WebFetchTool.call({ url: 'https://github.com/' }, ctx, new AbortController().signal)

    expect(captured!('github.com')).toBe('deny')
    spy.mockRestore()
  })

  it('ask rule wins over allow rule (mirrors cascade order)', async () => {
    let captured: ((host: string) => 'allow' | 'deny' | 'ask') | undefined
    const spy = vi.spyOn(fetcherMod, 'fetchWeb').mockImplementation(async (_url, opts) => {
      captured = opts.checkPolicy
      return {
        status: 200,
        contentType: 'text/plain',
        body: 'ok',
        truncated: false,
        finalUrl: 'https://github.com/',
        redirectChain: ['https://github.com/'],
      }
    })

    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'ask', domain: 'github.com', source: 'userSettings' },
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'session' },
    ]
    const ctx = makeContext({ permissionRules: rules })
    await WebFetchTool.call({ url: 'https://github.com/' }, ctx, new AbortController().signal)

    // Cascade returns 'ask' for this rule set (deny > ask > allow). The
    // closure must mirror that order so a redirect re-check produces the
    // same decision as a fresh authorization.
    expect(captured!('github.com')).toBe('ask')
    spy.mockRestore()
  })
})
