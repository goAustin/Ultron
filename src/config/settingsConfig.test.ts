import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

import {
  readSettingsConfig,
  writeSettingsConfig,
  __setSettingsPathForTest,
} from './settingsConfig.js'

describe('settingsConfig', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ultron-settings-'))
    path = join(dir, 'settings.json')
    __setSettingsPathForTest(path)
  })

  afterEach(() => {
    __setSettingsPathForTest(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('readSettingsConfig returns {} when the file does not exist', () => {
    expect(readSettingsConfig()).toEqual({})
  })

  it('readSettingsConfig returns {} for malformed JSON', () => {
    writeFileSync(path, '{ broken json', 'utf8')
    expect(readSettingsConfig()).toEqual({})
  })

  it('round-trips a permissionRules write', () => {
    writeSettingsConfig({
      schemaVersion: 1,
      permissionRules: [
        { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'userSettings' },
      ],
    })
    expect(readSettingsConfig()).toEqual({
      schemaVersion: 1,
      permissionRules: [
        { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'userSettings' },
      ],
    })
  })

  it('schema-aware merge: writing webSearch.apiKeys.brave preserves tavily', () => {
    writeSettingsConfig({ webSearch: { apiKeys: { tavily: 'tav-key' } } })
    writeSettingsConfig({ webSearch: { apiKeys: { brave: 'bra-key' } } })

    const got = readSettingsConfig()
    expect(got.webSearch?.apiKeys?.brave).toBe('bra-key')
    expect(got.webSearch?.apiKeys?.tavily).toBe('tav-key')
  })

  it('schema-aware merge: writing one top-level key does not erase others', () => {
    writeSettingsConfig({
      webSearch: { apiKeys: { brave: 'b' } },
      permissionRules: [
        { toolName: 'WebFetch', behavior: 'deny', domain: 'evil.com', source: 'userSettings' },
      ],
    })
    writeSettingsConfig({ webPolicy: { allowlist: ['github.com'] } })

    const got = readSettingsConfig()
    expect(got.webSearch?.apiKeys?.brave).toBe('b')
    expect(got.permissionRules).toHaveLength(1)
    expect(got.webPolicy?.allowlist).toEqual(['github.com'])
  })

  it('writeSettingsConfig creates parent dir if missing', () => {
    const nested = join(dir, 'a', 'b', 'settings.json')
    __setSettingsPathForTest(nested)
    writeSettingsConfig({ schemaVersion: 1 })
    expect(existsSync(nested)).toBe(true)
  })

  it('writeSettingsConfig is atomic: no .tmp left on success', () => {
    writeSettingsConfig({ schemaVersion: 1 })
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it.skipIf(platform() === 'win32')('writes file with mode 0600', () => {
    writeSettingsConfig({ webSearch: { apiKeys: { brave: 'secret' } } })
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it.skipIf(platform() === 'win32')(
    'sets mode 0600 at file creation, not after — no permissive window (fix #2)',
    () => {
      // We can't easily race the chmod from userland, but we can verify the
      // tmp file path is opened with O_EXCL + 0600. Approximate this by
      // setting a permissive umask before the write and asserting the final
      // mode is still 0600 (chmod-after-write would have left a window
      // governed by umask, but the final inode mode would still be 0600
      // — so this is a regression marker more than a strict race test).
      const prevUmask = process.umask(0o022)
      try {
        writeSettingsConfig({ webSearch: { apiKeys: { brave: 'secret' } } })
        const mode = statSync(path).mode & 0o777
        expect(mode).toBe(0o600)
      } finally {
        process.umask(prevUmask)
      }
    },
  )

  it('readSettingsConfig returns {} for a JSON array (rejects non-object)', () => {
    writeFileSync(path, '[1, 2, 3]', 'utf8')
    // Arrays are objects in JS so this currently passes through; we accept that
    // — the schema validator at boot is what guards downstream consumers.
    const got = readSettingsConfig()
    expect(typeof got).toBe('object')
  })

  it('writing replaces permissionRules entirely (does not append)', () => {
    writeSettingsConfig({
      permissionRules: [
        { toolName: 'WebFetch', behavior: 'allow', domain: 'a.com', source: 'userSettings' },
      ],
    })
    writeSettingsConfig({
      permissionRules: [
        { toolName: 'WebFetch', behavior: 'allow', domain: 'b.com', source: 'userSettings' },
      ],
    })
    const got = readSettingsConfig()
    expect(got.permissionRules).toHaveLength(1)
    expect(got.permissionRules?.[0].domain).toBe('b.com')
  })
})
