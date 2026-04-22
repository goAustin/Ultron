import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readUserConfig,
  writeUserConfig,
  __setConfigPathForTest,
} from './userConfig.js'

describe('userConfig', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ultron-cfg-'))
    path = join(dir, 'config.json')
    __setConfigPathForTest(path)
  })

  afterEach(() => {
    __setConfigPathForTest(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('readUserConfig returns {} when the file does not exist', () => {
    expect(readUserConfig()).toEqual({})
  })

  it('readUserConfig returns {} for corrupt JSON, without throwing', () => {
    writeFileSync(path, '{ this is not json }', 'utf8')
    expect(readUserConfig()).toEqual({})
  })

  it('writeUserConfig persists lastModel and readUserConfig round-trips it', () => {
    writeUserConfig({ lastModel: 'claude-sonnet-4-6' })
    expect(readUserConfig()).toEqual({ lastModel: 'claude-sonnet-4-6' })
  })

  it('writeUserConfig creates the parent directory if missing', () => {
    const nestedPath = join(dir, 'nested', 'subdir', 'config.json')
    __setConfigPathForTest(nestedPath)

    writeUserConfig({ lastModel: 'gpt-5.4-mini' })
    expect(existsSync(nestedPath)).toBe(true)
    expect(readUserConfig()).toEqual({ lastModel: 'gpt-5.4-mini' })
  })

  it('writeUserConfig merges with existing contents (preserves unrelated keys)', () => {
    writeFileSync(path, JSON.stringify({ lastModel: 'original', futureField: 42 }), 'utf8')
    writeUserConfig({ lastModel: 'updated' })

    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.lastModel).toBe('updated')
    expect(parsed.futureField).toBe(42)
  })

  it('writeUserConfig uses atomic rename (no .tmp left behind on success)', () => {
    writeUserConfig({ lastModel: 'claude-opus-4-7' })
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })
})
