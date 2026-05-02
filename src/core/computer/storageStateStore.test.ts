import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __setStoragePathForTest,
  loadStorageState,
  writeStorageState,
} from './storageStateStore.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ultron-storage-test-'))
  __setStoragePathForTest(dir)
})

afterEach(() => {
  __setStoragePathForTest(null)
})

describe('storageStateStore', () => {
  describe('loadStorageState', () => {
    it('returns null for missing file', async () => {
      expect(await loadStorageState('example.com')).toBeNull()
    })

    it('returns null + warns for malformed JSON', async () => {
      // Pre-write a corrupted file at the same key the store will look up.
      const validState = { cookies: [], origins: [] }
      await writeStorageState('example.com', validState)
      // Find the written file and corrupt it.
      const fs = await import('node:fs')
      const files = fs.readdirSync(dir)
      expect(files.length).toBe(1)
      writeFileSync(join(dir, files[0]!), '{not valid json', 'utf8')

      const result = await loadStorageState('example.com')
      expect(result).toBeNull()
    })

    it('returns null for value that is not an object', async () => {
      const fs = await import('node:fs')
      const { createHash } = await import('node:crypto')
      const key = createHash('sha256').update('example.com').digest('hex').slice(0, 16)
      writeFileSync(join(dir, `${key}.json`), '"just a string"', 'utf8')

      expect(await loadStorageState('example.com')).toBeNull()
      void fs
    })

    it('returns null when cookies is not an array', async () => {
      const { createHash } = await import('node:crypto')
      const key = createHash('sha256').update('example.com').digest('hex').slice(0, 16)
      writeFileSync(join(dir, `${key}.json`), JSON.stringify({ cookies: 'not-array' }), 'utf8')

      expect(await loadStorageState('example.com')).toBeNull()
    })

    it('returns null when origins is not an array', async () => {
      const { createHash } = await import('node:crypto')
      const key = createHash('sha256').update('example.com').digest('hex').slice(0, 16)
      writeFileSync(join(dir, `${key}.json`), JSON.stringify({ origins: 42 }), 'utf8')

      expect(await loadStorageState('example.com')).toBeNull()
    })

    it('returns the validated object for a well-formed file', async () => {
      const state = {
        cookies: [{ name: 'session', value: 'abc', domain: 'example.com', path: '/' }],
        origins: [
          { origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] },
        ],
      }
      await writeStorageState('example.com', state)

      const loaded = await loadStorageState('example.com')
      expect(loaded).toEqual(state)
    })

    it('accepts a value with no cookies/origins keys (Playwright accepts empty)', async () => {
      await writeStorageState('example.com', {})
      expect(await loadStorageState('example.com')).toEqual({})
    })

    it('drops cookie entries missing required name/value (review fix #1)', async () => {
      const fs = await import('node:fs')
      const { createHash } = await import('node:crypto')
      const key = createHash('sha256').update('example.com').digest('hex').slice(0, 16)
      const corrupt = {
        cookies: [
          {}, // missing name + value
          { name: 'ok' }, // missing value
          { value: 'ok' }, // missing name
          { name: 'good', value: 'still-here' },
          'not-an-object',
          null,
        ],
        origins: [],
      }
      fs.writeFileSync(join(dir, `${key}.json`), JSON.stringify(corrupt), 'utf8')

      const loaded = (await loadStorageState('example.com')) as { cookies: unknown[] }
      expect(loaded).not.toBeNull()
      expect(loaded.cookies).toEqual([{ name: 'good', value: 'still-here' }])
    })

    it('drops origin entries missing required origin/localStorage (review fix #1)', async () => {
      const fs = await import('node:fs')
      const { createHash } = await import('node:crypto')
      const key = createHash('sha256').update('example.com').digest('hex').slice(0, 16)
      const corrupt = {
        origins: [
          {}, // missing both
          { origin: 'https://x.test' }, // missing localStorage
          { localStorage: [] }, // missing origin
          { origin: 'https://good.test', localStorage: [{ name: 'k', value: 'v' }] },
        ],
      }
      fs.writeFileSync(join(dir, `${key}.json`), JSON.stringify(corrupt), 'utf8')

      const loaded = (await loadStorageState('example.com')) as { origins: unknown[] }
      expect(loaded).not.toBeNull()
      expect(loaded.origins).toEqual([
        { origin: 'https://good.test', localStorage: [{ name: 'k', value: 'v' }] },
      ])
    })
  })

  describe('writeStorageState', () => {
    it('round-trips through load', async () => {
      const state = { cookies: [{ name: 'a', value: '1' }], origins: [] }
      await writeStorageState('foo.test', state)
      expect(await loadStorageState('foo.test')).toEqual(state)
    })

    it('writes file with mode 0600 on POSIX', async () => {
      if (platform() === 'win32') return
      await writeStorageState('example.com', { cookies: [], origins: [] })
      const { createHash } = await import('node:crypto')
      const key = createHash('sha256').update('example.com').digest('hex').slice(0, 16)
      const path = join(dir, `${key}.json`)
      const stat = statSync(path)
      // Mask off type bits, keep permission bits.
      expect(stat.mode & 0o777).toBe(0o600)
    })

    it('uses sha256-derived deterministic file names', async () => {
      await writeStorageState('example.com', { cookies: [] })
      await writeStorageState('example.com', { cookies: [{ name: 'x', value: '1' }] })
      // Same host → same file → second write overwrites.
      const { createHash } = await import('node:crypto')
      const key = createHash('sha256').update('example.com').digest('hex').slice(0, 16)
      const path = join(dir, `${key}.json`)
      const content = JSON.parse(readFileSync(path, 'utf8'))
      expect(content.cookies).toEqual([{ name: 'x', value: '1' }])
    })

    it('different hosts use different keys', async () => {
      await writeStorageState('a.example.com', { cookies: [{ name: 'aa', value: '1' }] })
      await writeStorageState('b.example.com', { cookies: [{ name: 'bb', value: '2' }] })

      const a = await loadStorageState('a.example.com') as { cookies: unknown[] }
      const b = await loadStorageState('b.example.com') as { cookies: unknown[] }
      expect(a.cookies).toEqual([{ name: 'aa', value: '1' }])
      expect(b.cookies).toEqual([{ name: 'bb', value: '2' }])
    })

    it('creates the storage directory if missing', async () => {
      // Point at a non-existent subdir; write should mkdir -p.
      const nestedDir = join(dir, 'deep', 'nested')
      __setStoragePathForTest(nestedDir)
      await writeStorageState('example.com', { cookies: [] })
      expect(await loadStorageState('example.com')).toEqual({ cookies: [] })
    })
  })
})
