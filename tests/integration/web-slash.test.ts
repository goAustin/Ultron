/**
 * Integration test: `/web` slash command + persistence end-to-end.
 *
 * Drives `handleWebCommand` against a real `QueryEngine`, then tears the
 * engine down and re-inits to verify settings.json seeding survives
 * restart.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { createAuditWriter } from '../../src/audit/auditLog.js'
import { QueryEngine } from '../../src/sdk/QueryEngine.js'
import type { QueryEngineConfig } from '../../src/sdk/QueryEngine.js'
import { handleWebCommand } from '../../src/cli/webCommand.js'
import { __setSettingsPathForTest } from '../../src/config/settingsConfig.js'

function streams(): {
  stdout: PassThrough
  stderr: PassThrough
  outText: () => string
  errText: () => string
} {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const outChunks: Buffer[] = []
  const errChunks: Buffer[] = []
  stdout.on('data', (c) => outChunks.push(Buffer.from(c)))
  stderr.on('data', (c) => errChunks.push(Buffer.from(c)))
  return {
    stdout,
    stderr,
    outText: () => Buffer.concat(outChunks).toString('utf8'),
    errText: () => Buffer.concat(errChunks).toString('utf8'),
  }
}

function makeEngine(opts: { cwd: string; auditDir: string }): QueryEngine {
  const auditWriter = createAuditWriter({ dir: opts.auditDir })
  const config: QueryEngineConfig = {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    cwd: opts.cwd,
    auditWriter,
    disableMemory: true,
  }
  return new QueryEngine(config)
}

describe('/web integration', () => {
  let tmp: string
  let cwd: string
  let auditDir: string
  let prevBrave: string | undefined
  let prevTavily: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ultron-webint-'))
    cwd = join(tmp, 'cwd')
    auditDir = join(tmp, 'audit')
    rmSync(cwd, { recursive: true, force: true })
    rmSync(auditDir, { recursive: true, force: true })
    require('node:fs').mkdirSync(cwd, { recursive: true })
    require('node:fs').mkdirSync(auditDir, { recursive: true })
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
  })

  it('persisted /web allow rule survives engine restart', async () => {
    const engine1 = makeEngine({ cwd, auditDir })
    const f = streams()

    await handleWebCommand(
      '/web allow github.com --persist',
      { appState: engine1.appStateStore, auditWriter: engine1.auditWriter },
      { stdout: f.stdout, stderr: f.stderr },
    )
    expect(f.outText()).toContain('(persisted)')
    expect(engine1.appStateStore.getState().permissionRules).toEqual([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'userSettings' },
    ])
    await engine1.auditWriter.close()
    await engine1.dispose()

    // New engine, same settings.json — rule should be seeded at boot.
    const engine2 = makeEngine({ cwd, auditDir })
    expect(engine2.appStateStore.getState().permissionRules).toEqual([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'userSettings' },
    ])
    await engine2.auditWriter.close()
    await engine2.dispose()
  })

  it('non-persistent /web allow does NOT survive restart', async () => {
    const engine1 = makeEngine({ cwd, auditDir })
    const f = streams()

    await handleWebCommand(
      '/web allow github.com',
      { appState: engine1.appStateStore, auditWriter: engine1.auditWriter },
      { stdout: f.stdout, stderr: f.stderr },
    )
    expect(engine1.appStateStore.getState().permissionRules).toHaveLength(1)
    await engine1.auditWriter.close()
    await engine1.dispose()

    const engine2 = makeEngine({ cwd, auditDir })
    expect(engine2.appStateStore.getState().permissionRules).toEqual([])
    await engine2.auditWriter.close()
    await engine2.dispose()
  })

  it('webPolicy.denylist in settings.json seeds deny rules at boot', async () => {
    // Manually write a settings.json with a denylist
    const { writeSettingsConfig } = await import('../../src/config/settingsConfig.js')
    writeSettingsConfig({ webPolicy: { denylist: ['evil.com', '*.tracker.com'] } })

    const engine = makeEngine({ cwd, auditDir })
    const rules = engine.appStateStore.getState().permissionRules
    expect(rules).toHaveLength(2)
    expect(rules[0]).toMatchObject({
      toolName: 'WebFetch',
      behavior: 'deny',
      domain: 'evil.com',
    })
    expect(rules[1]).toMatchObject({
      toolName: 'WebFetch',
      behavior: 'deny',
      domain: '*.tracker.com',
    })
    await engine.auditWriter.close()
    await engine.dispose()
  })

  it('/web remove drops both session and persisted rules', async () => {
    const engine1 = makeEngine({ cwd, auditDir })
    const f1 = streams()
    await handleWebCommand(
      '/web allow github.com --persist',
      { appState: engine1.appStateStore, auditWriter: engine1.auditWriter },
      { stdout: f1.stdout, stderr: f1.stderr },
    )
    await handleWebCommand(
      '/web remove github.com',
      { appState: engine1.appStateStore, auditWriter: engine1.auditWriter },
      { stdout: f1.stdout, stderr: f1.stderr },
    )
    expect(engine1.appStateStore.getState().permissionRules).toEqual([])
    await engine1.auditWriter.close()
    await engine1.dispose()

    // Confirm restart sees no rules.
    const engine2 = makeEngine({ cwd, auditDir })
    expect(engine2.appStateStore.getState().permissionRules).toEqual([])
    await engine2.auditWriter.close()
    await engine2.dispose()
  })

  it('invalid permissionRules in settings.json are skipped, not thrown', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(tmp, 'settings.json'),
      JSON.stringify({
        permissionRules: [
          { toolName: 'WebFetch', behavior: 'BOGUS', domain: 'x.com' },
          { toolName: 'WebFetch', behavior: 'allow', domain: 'good.com' },
        ],
      }),
      'utf8',
    )

    // Boot must not throw.
    const engine = makeEngine({ cwd, auditDir })
    const rules = engine.appStateStore.getState().permissionRules
    expect(rules).toHaveLength(1)
    expect(rules[0].domain).toBe('good.com')
    await engine.auditWriter.close()
    await engine.dispose()
  })
})
