import { describe, it, expect } from 'vitest'
import { createToolRegistry, createDefaultRegistry } from './registry.js'
import { buildTool } from './types.js'
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

  it('has exactly 7 tools', () => {
    expect(reg.size).toBe(7)
  })

  it.each(['FileRead', 'FileWrite', 'FileEdit', 'Glob', 'Grep', 'Bash'])(
    'contains %s',
    (name) => {
      const tool = reg.get(name)
      expect(tool).toBeDefined()
      expect(tool!.name).toBe(name)
    },
  )

  it('read-only tools report isConcurrencySafe', () => {
    for (const name of ['FileRead', 'Glob', 'Grep']) {
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
})
