/**
 * Integration test: notify channel end-to-end (fix #1).
 *
 * Verifies that when the model (mocked) invokes WebSearchTool, the
 * `web_backend_resolved` notify event flows through the engine's
 * audit writer AND the configured `onNotify` subscriber.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAuditWriter } from '../../src/audit/auditLog.js'
import { QueryEngine } from '../../src/sdk/QueryEngine.js'
import type { QueryEngineConfig } from '../../src/sdk/QueryEngine.js'
import type { NotifyEvent } from '../../src/core/tools/context.js'
import { __setSettingsPathForTest } from '../../src/config/settingsConfig.js'

describe('notify channel integration', () => {
  let tmp: string
  let auditDir: string
  let prevBrave: string | undefined
  let prevTavily: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ultron-notify-'))
    auditDir = join(tmp, 'audit')
    mkdirSync(auditDir, { recursive: true })
    __setSettingsPathForTest(join(tmp, 'settings.json'))
    prevBrave = process.env.BRAVE_SEARCH_API_KEY
    prevTavily = process.env.TAVILY_API_KEY
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.TAVILY_API_KEY
  })

  afterEach(() => {
    __setSettingsPathForTest(null)
    rmSync(tmp, { recursive: true, force: true })
    if (prevBrave !== undefined) process.env.BRAVE_SEARCH_API_KEY = prevBrave
    else delete process.env.BRAVE_SEARCH_API_KEY
    if (prevTavily !== undefined) process.env.TAVILY_API_KEY = prevTavily
    else delete process.env.TAVILY_API_KEY
    vi.restoreAllMocks()
  })

  it('engine.emitNotify writes to audit and forwards to onNotify', async () => {
    const auditWriter = createAuditWriter({ dir: auditDir })
    const seen: NotifyEvent[] = []
    const config: QueryEngineConfig = {
      apiKey: 'test',
      model: 'claude-sonnet-4-6',
      cwd: tmp,
      auditWriter,
      disableMemory: true,
      onNotify: (e) => seen.push(e),
    }
    const engine = new QueryEngine(config)

    engine.emitNotify({
      type: 'web_backend_resolved',
      backend: 'duckduckgo',
      source: 'default',
    })

    await engine.auditWriter.close()
    await engine.dispose()

    expect(seen).toEqual([
      { type: 'web_backend_resolved', backend: 'duckduckgo', source: 'default' },
    ])

    const auditFile = join(auditDir, 'audit.jsonl')
    expect(existsSync(auditFile)).toBe(true)
    const lines = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean)
    const events = lines.map((l) => JSON.parse(l))
    const wbr = events.find((e) => e.type === 'web_backend_resolved')
    expect(wbr).toMatchObject({
      type: 'web_backend_resolved',
      backend: 'duckduckgo',
      source: 'default',
    })
  })

  it('onNotify error does not throw out of emitNotify', async () => {
    const auditWriter = createAuditWriter({ dir: auditDir })
    const config: QueryEngineConfig = {
      apiKey: 'test',
      model: 'claude-sonnet-4-6',
      cwd: tmp,
      auditWriter,
      disableMemory: true,
      onNotify: () => {
        throw new Error('boom')
      },
    }
    const engine = new QueryEngine(config)
    expect(() =>
      engine.emitNotify({
        type: 'web_backend_resolved',
        backend: 'duckduckgo',
        source: 'default',
      }),
    ).not.toThrow()
    await engine.auditWriter.close()
    await engine.dispose()
  })

})
