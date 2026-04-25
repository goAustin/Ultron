import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveSearchBackend } from './searchBackend.js'
import { __setSettingsPathForTest, writeSettingsConfig } from '../config/settingsConfig.js'

describe('resolveSearchBackend', () => {
  let dir: string
  let prevBrave: string | undefined
  let prevTavily: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ultron-resolve-'))
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
  })

  it('falls back to DuckDuckGo when no env vars and no settings keys', () => {
    const r = resolveSearchBackend()
    expect(r.backend.id).toBe('duckduckgo')
    expect(r.source).toBe('default')
  })

  it('selects Brave when BRAVE_SEARCH_API_KEY is set', () => {
    process.env.BRAVE_SEARCH_API_KEY = 'env-brave'
    const r = resolveSearchBackend()
    expect(r.backend.id).toBe('brave')
    expect(r.source).toBe('env')
  })

  it('selects Tavily when only TAVILY_API_KEY is set', () => {
    process.env.TAVILY_API_KEY = 'env-tavily'
    const r = resolveSearchBackend()
    expect(r.backend.id).toBe('tavily')
    expect(r.source).toBe('env')
  })

  it('Brave env wins over Tavily env', () => {
    process.env.BRAVE_SEARCH_API_KEY = 'b'
    process.env.TAVILY_API_KEY = 't'
    expect(resolveSearchBackend().backend.id).toBe('brave')
  })

  it('settings.json Brave key is used when no env var present', () => {
    writeSettingsConfig({ webSearch: { apiKeys: { brave: 'settings-brave' } } })
    const r = resolveSearchBackend()
    expect(r.backend.id).toBe('brave')
    expect(r.source).toBe('settings')
  })

  it('env var wins over settings.json key', () => {
    process.env.BRAVE_SEARCH_API_KEY = 'env'
    writeSettingsConfig({ webSearch: { apiKeys: { brave: 'settings' } } })
    const r = resolveSearchBackend()
    expect(r.source).toBe('env')
  })

  it('settings Tavily picked when only Tavily setting present', () => {
    writeSettingsConfig({ webSearch: { apiKeys: { tavily: 't' } } })
    const r = resolveSearchBackend()
    expect(r.backend.id).toBe('tavily')
    expect(r.source).toBe('settings')
  })

  it('empty env var (whitespace) falls through', () => {
    process.env.BRAVE_SEARCH_API_KEY = '   '
    const r = resolveSearchBackend()
    expect(r.backend.id).toBe('duckduckgo')
  })
})
