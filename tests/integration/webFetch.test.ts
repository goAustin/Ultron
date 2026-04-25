/**
 * Integration test: Phase 6a WebFetch end-to-end through runToolUse.
 *
 * Spins up a local HTTPS server with a self-signed cert (generated via
 * openssl in beforeAll). Drives `tool_use` through authorizeToolUse +
 * executeToolUse to exercise:
 *   - First-call ask + allow_by_rule → domain-scoped session rule lands
 *   - Second call to same host → no prompt
 *   - Different host → prompt again
 *   - Skill scope: allowedTools: ['FileRead'] denies WebFetch
 *   - PreToolUse-hook URL rewrite is caught at fetcher first-hop
 *
 * The local server runs on 127.0.0.1, which `isPrivateAddress` would
 * reject. We bypass that for the integration via a `__skipPrivateAddressCheck`
 * shim — except we don't have one in production code. Workaround: this
 * test uses the WebFetchTool directly and replaces fetchWeb's behavior
 * via the same DI hook the unit tests use, but via a thin subclass
 * registered in the registry.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'

import { authorizeToolUse, executeToolUse } from '../../src/core/tools/runToolUse.js'
import { createToolUseContext } from '../../src/core/tools/context.js'
import { createToolRegistry } from '../../src/core/tools/registry.js'
import { createStore, getDefaultAppState } from '../../src/core/state.js'
import type { AppState } from '../../src/core/state.js'
import type { PermissionRule, PermissionOptions } from '../../src/core/permissions/types.js'
import type { ToolUseBlock } from '../../src/core/messages.js'
import { toolUseId } from '../../src/core/messages.js'
import { buildTool } from '../../src/core/tools/types.js'
import type { Tool } from '../../src/core/tools/types.js'
import { findMatchingRules } from '../../src/core/permissions/permissions.js'
import { extractHost } from '../../src/web/domainPolicy.js'
import { fetchWeb } from '../../src/web/fetcher.js'
import { htmlToText } from '../../src/web/htmlToText.js'

// ---------------------------------------------------------------------------
// Local HTTPS test server
// ---------------------------------------------------------------------------

let server: https.Server | undefined
let port = 0
let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void = () => undefined
let certDir: string | undefined
let canRunNetworkTests = true
let testAgent: https.Agent

function generateCert(): { cert: Buffer; key: Buffer } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'ultron-integ-cert-'))
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
    return
  }
  server = https.createServer({ cert: certs.cert, key: certs.key }, (req, res) => handler(req, res))
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server!.address() as AddressInfo).port
  testAgent = new https.Agent({ rejectUnauthorized: false })
})

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  if (certDir) rmSync(certDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test-only WebFetchTool variant — same shape as production WebFetchTool
// but injects DI hooks (httpsAgent, isPrivateAddress, lookup) into the
// fetcher so we can hit the local HTTPS server. The production tool stays
// unchanged; this variant lives only in this test file.
// ---------------------------------------------------------------------------

const noopFamily = (ip: string): 4 | 6 => (ip.includes(':') ? 6 : 4)

function makeTestWebFetchTool(testHosts: Set<string>): Tool {
  return buildTool({
    name: 'WebFetch',
    description: 'test variant',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    isMutating: false,
    isConcurrencySafe: () => true,
    getDomain: (input) => {
      const url = typeof input.url === 'string' ? input.url : ''
      return extractHost(url) ?? undefined
    },
    async validateInput(input) {
      if (typeof input.url !== 'string') {
        return { valid: false, message: 'url required' }
      }
      try {
        const u = new URL(input.url)
        if (u.protocol !== 'https:') return { valid: false, message: 'https only' }
        return { valid: true }
      } catch {
        return { valid: false, message: 'invalid URL' }
      }
    },
    async checkPermissions(input) {
      const host = extractHost(typeof input.url === 'string' ? input.url : '')
      if (host === null) return { behavior: 'deny', message: 'invalid URL' }
      return { behavior: 'allow' }
    },
    async call(input, context, signal) {
      const url = input.url as string
      const appState = context.appState
      const checkPolicy = (host: string): 'allow' | 'deny' | 'ask' => {
        const rules = appState.getState().permissionRules
        const matching = findMatchingRules(rules, 'WebFetch', undefined, host)
        if (matching.find((r) => r.behavior === 'deny')) return 'deny'
        if (matching.find((r) => r.behavior === 'allow')) return 'allow'
        return 'ask'
      }

      try {
        const result = await fetchWeb(url, {
          signal,
          checkPolicy,
          httpsAgent: testAgent,
          // Map our test "hosts" to 127.0.0.1 so the request hits our server.
          lookup: async (host) => {
            if (testHosts.has(host)) {
              return { address: '127.0.0.1', family: 4 }
            }
            // Anything else fails as if DNS doesn't resolve.
            throw new Error(`unknown host: ${host}`)
          },
          // The local server is on 127.0.0.1, which would normally trip
          // the SSRF block. Allow it for the integration test.
          isPrivateAddress: () => false,
        })

        const isHtml = /^(text\/html|application\/xhtml\+xml)\b/i.test(result.contentType)
        const body = isHtml ? htmlToText(result.body) : result.body
        const lines = [`URL: ${url}`, `Status: ${result.status}`, '', body]
        if (result.truncated) lines.push('[truncated at 5 MB]')
        return { content: lines.join('\n'), isError: false }
      } catch (err) {
        if (signal.aborted) return { content: '[aborted]', isError: true, errorKind: 'aborted' }
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
          errorKind: 'execution_error',
        }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tuCounter = 0
function makeToolUse(input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId(`tu-${++tuCounter}`), name: 'WebFetch', input }
}

function makeContext(testHosts: Set<string>, stateOverrides: Partial<AppState> = {}) {
  const registry = createToolRegistry()
  registry.register(makeTestWebFetchTool(testHosts))
  const cleanedHttpsAgent = testAgent
  void cleanedHttpsAgent
  return createToolUseContext({
    appState: createStore({ ...getDefaultAppState(), ...stateOverrides }),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: registry,
  })
}

const skipIf = () => !canRunNetworkTests

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebFetch integration — runToolUse end-to-end', () => {
  it.skipIf(skipIf())('first call asks; allow_by_rule persists a domain-scoped session rule', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('ok')
    }
    const testHosts = new Set(['a.test'])
    const ctx = makeContext(testHosts)
    let askCount = 0
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => {
        askCount++
        return 'allow_by_rule'
      },
    }

    const tu = makeToolUse({ url: `https://a.test:${port}/` })
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('authorized')
    if (auth.outcome === 'authorized') {
      expect(auth.decision.userResponse).toBe('allow_by_rule')
      expect(auth.decision.ruleCreated).toEqual({
        toolName: 'WebFetch',
        behavior: 'allow',
        domain: 'a.test',
        source: 'session',
      })
    }
    expect(askCount).toBe(1)
    expect(ctx.appState.getState().permissionRules).toHaveLength(1)

    const result = await executeToolUse(tu, ctx, new AbortController().signal)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('ok')
  })

  it.skipIf(skipIf())('second call to same host does not prompt', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('ok')
    }
    const testHosts = new Set(['a.test'])
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: 'a.test', source: 'session' },
    ]
    const ctx = makeContext(testHosts, { permissionRules: rules })
    let askCount = 0
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => {
        askCount++
        return 'allow_once'
      },
    }
    const tu = makeToolUse({ url: `https://a.test:${port}/` })
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('authorized')
    expect(askCount).toBe(0)
  })

  it.skipIf(skipIf())('different host prompts again', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('ok')
    }
    const testHosts = new Set(['a.test', 'b.test'])
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: 'a.test', source: 'session' },
    ]
    const ctx = makeContext(testHosts, { permissionRules: rules })
    let askCount = 0
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => {
        askCount++
        return 'deny_once'
      },
    }
    const tu = makeToolUse({ url: `https://b.test:${port}/` })
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(askCount).toBe(1)
    expect(auth.outcome).toBe('denied')
  })

  it.skipIf(skipIf())('domain deny rule blocks even with bypassPermissions mode', async () => {
    const testHosts = new Set(['evil.test'])
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'deny', domain: 'evil.test', source: 'userSettings' },
    ]
    const ctx = makeContext(testHosts, {
      permissionRules: rules,
      permissionMode: 'bypassPermissions',
    })
    const tu = makeToolUse({ url: `https://evil.test:${port}/` })
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal)
    expect(auth.outcome).toBe('denied')
  })

  it.skipIf(skipIf())('skill scope denies WebFetch when not in allowedTools', async () => {
    const testHosts = new Set(['a.test'])
    const ctx = makeContext(testHosts)
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      scopedToolAllowlist: ['FileRead'], // WebFetch not allowed
    }
    const tu = makeToolUse({ url: `https://a.test:${port}/` })
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('denied')
    if (auth.outcome === 'denied') {
      expect(auth.decision.reason).toContain("active skill's allowed-tools")
    }
  })

  it.skipIf(skipIf())('skill scope allows WebFetch when in allowedTools', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('ok')
    }
    const testHosts = new Set(['a.test'])
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: 'a.test', source: 'session' },
    ]
    const ctx = makeContext(testHosts, { permissionRules: rules })
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      scopedToolAllowlist: ['WebFetch'],
    }
    const tu = makeToolUse({ url: `https://a.test:${port}/` })
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('authorized')
  })

  it.skipIf(skipIf())('allow_once authorizes the call without persisting a rule', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('ok')
    }
    const testHosts = new Set(['a.test'])
    const ctx = makeContext(testHosts)
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => 'allow_once',
    }
    const tu = makeToolUse({ url: `https://a.test:${port}/` })
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('authorized')
    if (auth.outcome === 'authorized') {
      expect(auth.decision.userResponse).toBe('allow_once')
      expect(auth.decision.ruleCreated).toBeUndefined()
    }
    // No rule persisted.
    expect(ctx.appState.getState().permissionRules).toEqual([])

    // Tool MUST execute successfully — no rule was persisted, but the
    // cascade authorized this turn. The fetcher does not re-check the
    // first hop, so the call proceeds.
    const result = await executeToolUse(tu, ctx, new AbortController().signal)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('ok')
  })

  it.skipIf(skipIf())('bypassPermissions mode authorizes without persisting a rule', async () => {
    handler = (_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('ok')
    }
    const testHosts = new Set(['a.test'])
    const ctx = makeContext(testHosts, { permissionMode: 'bypassPermissions' })
    const tu = makeToolUse({ url: `https://a.test:${port}/` })
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal)
    expect(auth.outcome).toBe('authorized')
    expect(ctx.appState.getState().permissionRules).toEqual([])

    const result = await executeToolUse(tu, ctx, new AbortController().signal)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('ok')
  })

  // KNOWN LIMITATION: a PreToolUse hook that rewrites input.url between
  // authorize and execute slips past per-host policy. The fetcher's
  // first-hop policy check was removed in the review fixes because it
  // also broke allow_once and bypassPermissions (neither persists a rule
  // for the closure to find). The proper fix — re-authorize on hook
  // input mutation — is a cross-tool concern and lives in a future phase.
  // No test asserts this defense in 6a.

  it.skipIf(skipIf())('cross-host redirect to a denied host is still blocked', async () => {
    // The redirect-hop check IS preserved. This test confirms a redirect
    // from an authorized host to a denied target is rejected at the
    // network-layer policy re-check.
    let count = 0
    handler = (_req, res) => {
      count++
      if (count === 1) {
        res.statusCode = 302
        // Redirect to a host with a deny rule.
        res.setHeader('Location', `https://denied.test:${port}/x`)
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('should not reach here')
    }
    const testHosts = new Set(['a.test', 'denied.test'])
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: 'a.test', source: 'session' },
      { toolName: 'WebFetch', behavior: 'deny', domain: 'denied.test', source: 'userSettings' },
    ]
    const ctx = makeContext(testHosts, { permissionRules: rules })
    const tu = makeToolUse({ url: `https://a.test:${port}/` })
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal)
    expect(auth.outcome).toBe('authorized')

    const result = await executeToolUse(tu, ctx, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('execution_error')
    expect(result.content).toContain('denied.test')
  })
})
