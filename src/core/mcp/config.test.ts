import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadMcpConfig, emptyMcpConfig } from './config.js'
import { McpConfigError } from './errors.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultron-mcp-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('emptyMcpConfig', () => {
  it('returns a schemaVersion 1 config with no servers', () => {
    expect(emptyMcpConfig()).toEqual({ schemaVersion: 1, servers: {} })
  })
})

describe('loadMcpConfig', () => {
  it('returns empty config on ENOENT', async () => {
    const cfg = await loadMcpConfig(join(dir, 'missing.json'))
    expect(cfg).toEqual({ schemaVersion: 1, servers: {} })
  })

  it('parses a well-formed config', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        servers: {
          github: { command: 'node', args: ['gh.js'], env: { TOKEN: 'x' } },
          fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], disabled: true, timeoutMs: 5000 },
        },
      }),
    )
    const cfg = await loadMcpConfig(file)
    expect(cfg.schemaVersion).toBe(1)
    expect(Object.keys(cfg.servers).sort()).toEqual(['fs', 'github'])
    expect(cfg.servers.github).toEqual({
      command: 'node',
      args: ['gh.js'],
      env: { TOKEN: 'x' },
    })
    expect(cfg.servers.fs.disabled).toBe(true)
    expect(cfg.servers.fs.timeoutMs).toBe(5000)
  })

  it('throws McpConfigError on malformed JSON', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(file, '{ not json')
    await expect(loadMcpConfig(file)).rejects.toBeInstanceOf(McpConfigError)
    await expect(loadMcpConfig(file)).rejects.toThrow(/JSON parse failed/)
  })

  it('throws on wrong schemaVersion', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(file, JSON.stringify({ schemaVersion: 2, servers: {} }))
    await expect(loadMcpConfig(file)).rejects.toBeInstanceOf(McpConfigError)
    await expect(loadMcpConfig(file)).rejects.toThrow(/schemaVersion must be 1/)
  })

  it('throws on missing servers object', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(file, JSON.stringify({ schemaVersion: 1 }))
    await expect(loadMcpConfig(file)).rejects.toThrow(/"servers" must be an object/)
  })

  it('throws on invalid server name (underscores)', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, servers: { my_server: { command: 'x' } } }),
    )
    await expect(loadMcpConfig(file)).rejects.toThrow(/must match/)
  })

  it('throws on empty command', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, servers: { foo: { command: '' } } }),
    )
    await expect(loadMcpConfig(file)).rejects.toThrow(/command must be a non-empty string/)
  })

  it('throws on args that are not strings', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, servers: { foo: { command: 'node', args: [1, 2] } } }),
    )
    await expect(loadMcpConfig(file)).rejects.toThrow(/args must be an array of strings/)
  })

  it('throws on env with non-string values', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        servers: { foo: { command: 'node', env: { X: 1 } } },
      }),
    )
    await expect(loadMcpConfig(file)).rejects.toThrow(/env must be an object of string values/)
  })

  it('throws on non-boolean disabled', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        servers: { foo: { command: 'node', disabled: 'yes' } },
      }),
    )
    await expect(loadMcpConfig(file)).rejects.toThrow(/disabled must be a boolean/)
  })

  it('throws on non-positive timeoutMs', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        servers: { foo: { command: 'node', timeoutMs: 0 } },
      }),
    )
    await expect(loadMcpConfig(file)).rejects.toThrow(/timeoutMs must be a positive integer/)
  })

  it('includes the file path in error messages', async () => {
    const file = join(dir, 'mcp.json')
    await writeFile(file, 'garbage')
    await expect(loadMcpConfig(file)).rejects.toThrow(file)
  })
})
