import { describe, it, expect } from 'vitest'
import { createToolRegistry, createDefaultRegistry, MCP_TOOL_PREFIX } from './registry.js'
import { buildTool } from './types.js'
import type { Tool } from './types.js'
import type { ToolUseContext } from './context.js'
import { createToolUseContext } from './context.js'
import { createStore, getDefaultAppState } from '../state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDummyTool(name: string) {
  return buildTool({
    name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    call: async () => ({ content: 'ok', isError: false }),
  })
}

function makeDummyContext(): ToolUseContext {
  return createToolUseContext({
    appState: createStore(getDefaultAppState()),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createToolRegistry(),
  })
}

// ---------------------------------------------------------------------------
// createToolRegistry
// ---------------------------------------------------------------------------

describe('createToolRegistry', () => {
  it('starts empty', () => {
    const reg = createToolRegistry()
    expect(reg.size).toBe(0)
    expect(reg.getAll()).toEqual([])
  })

  it('registers and retrieves a tool by name', () => {
    const reg = createToolRegistry()
    const tool = makeDummyTool('Foo')
    reg.register(tool)
    expect(reg.get('Foo')).toBe(tool)
    expect(reg.has('Foo')).toBe(true)
    expect(reg.size).toBe(1)
  })

  it('returns undefined for unknown tool names', () => {
    const reg = createToolRegistry()
    expect(reg.get('NonExistent')).toBeUndefined()
    expect(reg.has('NonExistent')).toBe(false)
  })

  it('throws on duplicate registration', () => {
    const reg = createToolRegistry()
    reg.register(makeDummyTool('Dup'))
    expect(() => reg.register(makeDummyTool('Dup'))).toThrowError(
      'Tool "Dup" is already registered',
    )
  })

  it('getAll returns all registered tools', () => {
    const reg = createToolRegistry()
    reg.register(makeDummyTool('A'))
    reg.register(makeDummyTool('B'))
    const all = reg.getAll()
    expect(all).toHaveLength(2)
    expect(all.map((t) => t.name)).toEqual(['A', 'B'])
  })
})

// ---------------------------------------------------------------------------
// createDefaultRegistry
// ---------------------------------------------------------------------------

describe('createDefaultRegistry', () => {
  const reg = createDefaultRegistry()

  it('has exactly 11 tools', () => {
    expect(reg.size).toBe(11)
  })

  it.each(['FileRead', 'FileWrite', 'FileEdit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'OpenInBrowser', 'CodeSandbox'])(
    'contains %s',
    (name) => {
      const tool = reg.get(name)
      expect(tool).toBeDefined()
      expect(tool!.name).toBe(name)
    },
  )

  it('read-only tools report isConcurrencySafe', () => {
    for (const name of ['FileRead', 'Glob', 'Grep', 'WebFetch']) {
      const tool = reg.get(name)!
      expect(tool.isConcurrencySafe?.({})).toBe(true)
    }
  })

  it('write tools do not have isConcurrencySafe', () => {
    for (const name of ['FileWrite', 'FileEdit', 'Bash']) {
      const tool = reg.get(name)!
      expect(tool.isConcurrencySafe).toBeUndefined()
    }
  })

  it('file tools have getPath', () => {
    for (const name of ['FileRead', 'FileWrite', 'FileEdit']) {
      const tool = reg.get(name)!
      expect(tool.getPath?.({ file_path: '/tmp/test.txt' })).toBe('/tmp/test.txt')
    }
  })

  it('FileRead is marked non-mutating', () => {
    expect(reg.get('FileRead')!.isMutating).toBe(false)
  })

  it('Glob is marked non-mutating', () => {
    expect(reg.get('Glob')!.isMutating).toBe(false)
  })

  it('Grep is marked non-mutating', () => {
    expect(reg.get('Grep')!.isMutating).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildTool defaults
// ---------------------------------------------------------------------------

describe('buildTool defaults', () => {
  const tool = makeDummyTool('Test')
  const ctx = makeDummyContext()

  it('validateInput defaults to valid', async () => {
    const result = await tool.validateInput({}, ctx)
    expect(result).toEqual({ valid: true })
  })

  it('checkPermissions defaults to allow', async () => {
    const result = await tool.checkPermissions({}, ctx)
    expect(result).toEqual({ behavior: 'allow' })
  })

  it('source defaults to "builtin"', () => {
    expect(tool.source).toBe('builtin')
  })

  it('namespace defaults to undefined', () => {
    expect(tool.namespace).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

describe('unregister', () => {
  it('removes a registered tool and returns true', () => {
    const reg = createToolRegistry()
    reg.register(makeDummyTool('X'))
    expect(reg.has('X')).toBe(true)
    expect(reg.unregister('X')).toBe(true)
    expect(reg.has('X')).toBe(false)
    expect(reg.size).toBe(0)
  })

  it('returns false when the tool is not registered', () => {
    const reg = createToolRegistry()
    expect(reg.unregister('Nope')).toBe(false)
  })

  it('allows re-registering after unregister', () => {
    const reg = createToolRegistry()
    reg.register(makeDummyTool('Y'))
    reg.unregister('Y')
    expect(() => reg.register(makeDummyTool('Y'))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// getByNamespace
// ---------------------------------------------------------------------------

describe('getByNamespace', () => {
  function makeMcpTool(serverName: string, toolName: string): Tool {
    return buildTool({
      name: `${MCP_TOOL_PREFIX}${serverName}__${toolName}`,
      inputSchema: { type: 'object', properties: {} },
      call: async () => ({ content: 'ok', isError: false }),
      source: 'mcp',
      namespace: serverName,
    })
  }

  it('returns built-ins when queried with undefined', () => {
    const reg = createToolRegistry()
    reg.register(makeDummyTool('A'))
    reg.register(makeDummyTool('B'))
    const got = reg.getByNamespace(undefined)
    expect(got.map(t => t.name).sort()).toEqual(['A', 'B'])
  })

  it('filters by MCP server name', () => {
    const reg = createToolRegistry()
    reg.register(makeDummyTool('A'))
    reg.register(makeMcpTool('github', 'create_issue'))
    reg.register(makeMcpTool('github', 'list_issues'))
    reg.register(makeMcpTool('fs', 'read'))

    const github = reg.getByNamespace('github')
    expect(github.map(t => t.name).sort()).toEqual([
      'mcp__github__create_issue',
      'mcp__github__list_issues',
    ])

    const fs = reg.getByNamespace('fs')
    expect(fs.map(t => t.name)).toEqual(['mcp__fs__read'])
  })

  it('returns empty when no tools match the namespace', () => {
    const reg = createToolRegistry()
    reg.register(makeDummyTool('A'))
    expect(reg.getByNamespace('nope')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// mcp__ prefix guard
// ---------------------------------------------------------------------------

describe('mcp__ prefix guard', () => {
  it('rejects a non-MCP tool that claims the mcp__ prefix', () => {
    const reg = createToolRegistry()
    const shadow = buildTool({
      name: 'mcp__fake__shadow',
      inputSchema: { type: 'object', properties: {} },
      call: async () => ({ content: 'x', isError: false }),
      // source defaults to 'builtin'
    })
    expect(() => reg.register(shadow)).toThrowError(/reserved prefix/)
  })

  it('allows an MCP-sourced tool with the mcp__ prefix', () => {
    const reg = createToolRegistry()
    const ok = buildTool({
      name: 'mcp__fake__ok',
      inputSchema: { type: 'object', properties: {} },
      call: async () => ({ content: 'x', isError: false }),
      source: 'mcp',
      namespace: 'fake',
    })
    expect(() => reg.register(ok)).not.toThrow()
  })

  it('allows a tool without the mcp__ prefix regardless of source', () => {
    const reg = createToolRegistry()
    expect(() => reg.register(makeDummyTool('Regular'))).not.toThrow()
  })
})
