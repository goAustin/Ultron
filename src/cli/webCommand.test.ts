import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { handleWebCommand, type WebEngine } from './webCommand.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import {
  __setSettingsPathForTest,
  readSettingsConfig,
} from '../config/settingsConfig.js'
import * as resolverMod from '../web/searchBackend.js'

class StringWritable extends Writable {
  buf = ''
  override _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.buf += chunk.toString('utf8')
    cb()
  }
}

function makeEngine(): WebEngine {
  return {
    appState: createStore(getDefaultAppState()),
    auditWriter: { write: () => {}, close: async () => {}, withOrigin: () => ({} as never) },
  }
}

describe('handleWebCommand', () => {
  let dir: string
  let prevBrave: string | undefined
  let prevTavily: string | undefined
  let stdout: StringWritable
  let stderr: StringWritable

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ultron-webcmd-'))
    __setSettingsPathForTest(join(dir, 'settings.json'))
    prevBrave = process.env.BRAVE_SEARCH_API_KEY
    prevTavily = process.env.TAVILY_API_KEY
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.TAVILY_API_KEY
    stdout = new StringWritable()
    stderr = new StringWritable()
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

  it('bare /web shows backend + no rules', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web', engine, { stdout, stderr })
    expect(stdout.buf).toContain('Backend: duckduckgo (default)')
    expect(stdout.buf).toContain('No domain rules.')
  })

  it('/web help prints usage', async () => {
    await handleWebCommand('/web help', makeEngine(), { stdout, stderr })
    expect(stdout.buf).toContain('Usage:')
    expect(stdout.buf).toContain('/web search')
  })

  it('/web allow github.com adds session WebFetch domain rule', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web allow github.com', engine, { stdout, stderr })
    const rules = engine.appState.getState().permissionRules
    expect(rules).toEqual([
      {
        toolName: 'WebFetch',
        behavior: 'allow',
        domain: 'github.com',
        source: 'session',
      },
    ])
    expect(stdout.buf).toContain('(session)')
    // Did not write to disk:
    expect(readSettingsConfig().permissionRules).toBeUndefined()
  })

  it('/web allow github.com --persist writes to settings.json', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web allow github.com --persist', engine, { stdout, stderr })
    expect(stdout.buf).toContain('(persisted)')
    const persisted = readSettingsConfig().permissionRules
    expect(persisted).toEqual([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'userSettings' },
    ])
  })

  it.skipIf(platform() === 'win32')('--persist writes settings.json with mode 0600', async () => {
    await handleWebCommand('/web allow github.com --persist', makeEngine(), { stdout, stderr })
    const path = join(dir, 'settings.json')
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('/web deny mirrors allow but with deny behavior', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web deny evil.com', engine, { stdout, stderr })
    const rules = engine.appState.getState().permissionRules
    expect(rules[0].behavior).toBe('deny')
    expect(rules[0].domain).toBe('evil.com')
  })

  it('rejects invalid host pattern', async () => {
    await handleWebCommand('/web allow not a host!', makeEngine(), { stdout, stderr })
    expect(stderr.buf).toContain('invalid host pattern')
  })

  it('lowercases the host', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web allow GITHUB.COM', engine, { stdout, stderr })
    expect(engine.appState.getState().permissionRules[0].domain).toBe('github.com')
  })

  it('dedups: running /web allow X twice produces one rule', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web allow github.com', engine, { stdout, stderr })
    await handleWebCommand('/web allow github.com', engine, { stdout, stderr })
    expect(engine.appState.getState().permissionRules).toHaveLength(1)
  })

  it('/web remove drops session + persisted rules for the host', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web allow github.com --persist', engine, { stdout, stderr })
    await handleWebCommand('/web remove github.com', engine, { stdout, stderr })
    expect(engine.appState.getState().permissionRules).toHaveLength(0)
    expect(readSettingsConfig().permissionRules).toEqual([])
  })

  it('/web rules prints a table when rules exist', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web allow github.com', engine, { stdout, stderr })
    stdout.buf = ''
    await handleWebCommand('/web rules', engine, { stdout, stderr })
    expect(stdout.buf).toContain('WebFetch')
    expect(stdout.buf).toContain('github.com')
  })

  it('/web search runs the resolved backend and prints results', async () => {
    vi.spyOn(resolverMod, 'resolveSearchBackend').mockReturnValue({
      backend: {
        id: 'duckduckgo',
        async search() {
          return [{ title: 'Hit', url: 'https://x.com', snippet: 's', unwrapped: true }]
        },
      },
      source: 'default',
    })
    await handleWebCommand('/web search react', makeEngine(), { stdout, stderr })
    expect(stdout.buf).toContain('WebSearch: "react" (via duckduckgo)')
    expect(stdout.buf).toContain('Hit')
  })

  it('/web search with no query errors out', async () => {
    await handleWebCommand('/web search', makeEngine(), { stdout, stderr })
    expect(stderr.buf).toContain('usage: /web search')
  })

  it('unknown subcommand prints error + help', async () => {
    await handleWebCommand('/web frobnicate', makeEngine(), { stdout, stderr })
    expect(stderr.buf).toContain('unknown subcommand "frobnicate"')
    expect(stdout.buf).toContain('Usage:')
  })

  it('/web setup choosing 1 keeps DuckDuckGo without prompts', async () => {
    await handleWebCommand('/web setup', makeEngine(), {
      stdout,
      stderr,
      promptText: async () => '1',
      confirmYesNo: async () => false,
    })
    expect(stdout.buf).toContain('Keeping DuckDuckGo')
  })

  it('/web setup choosing 2 + declining persistence prints env-var instructions', async () => {
    await handleWebCommand('/web setup', makeEngine(), {
      stdout,
      stderr,
      promptText: async () => '2',
      confirmYesNo: async () => false,
    })
    expect(stdout.buf).toContain('export BRAVE_SEARCH_API_KEY')
    expect(stdout.buf).toContain('Skipped persistence')
    expect(readSettingsConfig().webSearch).toBeUndefined()
  })

  it('/web setup choosing 2 + accepting persistence writes the key', async () => {
    let calls = 0
    await handleWebCommand('/web setup', makeEngine(), {
      stdout,
      stderr,
      promptText: async () => {
        calls++
        return calls === 1 ? '2' : 'sk-test-brave'
      },
      confirmYesNo: async () => true,
    })
    expect(readSettingsConfig().webSearch?.apiKeys?.brave).toBe('sk-test-brave')
    expect(stdout.buf).toContain('Saved with mode 0600')
  })

  it('/web setup persisting Tavily writes tavily key', async () => {
    let calls = 0
    await handleWebCommand('/web setup', makeEngine(), {
      stdout,
      stderr,
      promptText: async () => {
        calls++
        return calls === 1 ? '3' : 'tav-key'
      },
      confirmYesNo: async () => true,
    })
    expect(readSettingsConfig().webSearch?.apiKeys?.tavily).toBe('tav-key')
  })

  it('/web list is alias for bare /web', async () => {
    await handleWebCommand('/web list', makeEngine(), { stdout, stderr })
    expect(stdout.buf).toContain('Backend:')
  })

  it('/web allow X after /web deny X overrides the deny (fix #3)', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web deny github.com', engine, { stdout, stderr })
    await handleWebCommand('/web allow github.com', engine, { stdout, stderr })
    const rules = engine.appState.getState().permissionRules
    expect(rules).toEqual([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'session' },
    ])
  })

  it('/web allow --persist after deny --persist replaces in settings.json (fix #3)', async () => {
    const engine = makeEngine()
    await handleWebCommand('/web deny github.com --persist', engine, { stdout, stderr })
    await handleWebCommand('/web allow github.com --persist', engine, { stdout, stderr })
    const persisted = readSettingsConfig().permissionRules
    expect(persisted).toEqual([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'userSettings' },
    ])
  })

  it('/web allow X --persist strips X from webPolicy.denylist (fix #4 prereq)', async () => {
    const { writeSettingsConfig } = await import('../config/settingsConfig.js')
    writeSettingsConfig({ webPolicy: { denylist: ['github.com', 'evil.com'] } })

    const engine = makeEngine()
    await handleWebCommand('/web allow github.com --persist', engine, { stdout, stderr })
    const settings = readSettingsConfig()
    expect(settings.webPolicy?.denylist).toEqual(['evil.com'])
  })

  it('/web remove also strips webPolicy entries (fix #4)', async () => {
    const { writeSettingsConfig } = await import('../config/settingsConfig.js')
    writeSettingsConfig({ webPolicy: { allowlist: ['github.com'], denylist: ['evil.com'] } })

    const engine = makeEngine()
    await handleWebCommand('/web remove github.com', engine, { stdout, stderr })
    const settings = readSettingsConfig()
    expect(settings.webPolicy?.allowlist).toEqual([])
    expect(settings.webPolicy?.denylist).toEqual(['evil.com'])
  })

  it('/web search routes through WebSearchTool.validateInput (fix #5)', async () => {
    // Empty query after the prefix triggers validateInput rejection inside
    // the tool, surfacing as a stderr error rather than silently returning
    // garbage from the backend.
    const longQuery = 'a'.repeat(3000)
    vi.spyOn(resolverMod, 'resolveSearchBackend').mockReturnValue({
      backend: { id: 'duckduckgo', async search() { return [] } },
      source: 'default',
    })
    await handleWebCommand(`/web search ${longQuery}`, makeEngine(), { stdout, stderr })
    expect(stderr.buf).toMatch(/exceeds.*bytes/)
  })

  it('/web search triggers notify hook (fix #1, fix #5 via shared path)', async () => {
    vi.spyOn(resolverMod, 'resolveSearchBackend').mockReturnValue({
      backend: {
        id: 'duckduckgo',
        async search() {
          return [{ title: 'X', url: 'https://x.com', snippet: '', unwrapped: true }]
        },
      },
      source: 'default',
    })
    const events: Array<{ type: string }> = []
    const engine = {
      appState: createStore(getDefaultAppState()),
      auditWriter: { write: () => {}, close: async () => {}, withOrigin: () => ({} as never) },
      emitNotify: (e: { type: string }) => events.push(e),
    }
    await handleWebCommand('/web search react', engine, { stdout, stderr })
    expect(events.some((e) => e.type === 'web_backend_resolved')).toBe(true)
  })
})
