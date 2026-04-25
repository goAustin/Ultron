/**
 * Tool registry — register and look up tools by name.
 * Includes stub tool definitions for the Phase 0 tool set.
 */

import type { Tool, ToolInputJSONSchema } from './types.js'
import { FileReadTool } from '../../tools/FileReadTool.js'
import { FileWriteTool } from '../../tools/FileWriteTool.js'
import { FileEditTool } from '../../tools/FileEditTool.js'
import { GlobTool } from '../../tools/GlobTool.js'
import { GrepTool } from '../../tools/GrepTool.js'
import { BashTool } from '../../tools/BashTool.js'
import { WebFetchTool } from '../../tools/WebFetchTool.js'
import { WebSearchTool } from '../../tools/WebSearchTool.js'
import { CodeSandboxTool } from '../../tools/CodeSandboxTool.js'
import { AgentTool } from '../../agents/agentTool.js'

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  register(tool: Tool): void
  unregister(name: string): boolean
  get(name: string): Tool | undefined
  has(name: string): boolean
  getAll(): readonly Tool[]
  getByNamespace(namespace: string | undefined): readonly Tool[]
  readonly size: number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const MCP_TOOL_PREFIX = 'mcp__'

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>()

  return {
    register(tool: Tool): void {
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered`)
      }
      const source = tool.source ?? 'builtin'
      if (tool.name.startsWith(MCP_TOOL_PREFIX) && source !== 'mcp') {
        throw new Error(
          `Tool "${tool.name}" uses reserved prefix "${MCP_TOOL_PREFIX}" but source is "${source}"`,
        )
      }
      tools.set(tool.name, tool)
    },

    unregister(name: string): boolean {
      return tools.delete(name)
    },

    get(name: string): Tool | undefined {
      return tools.get(name)
    },

    has(name: string): boolean {
      return tools.has(name)
    },

    getAll(): readonly Tool[] {
      return Object.freeze([...tools.values()])
    },

    getByNamespace(namespace: string | undefined): readonly Tool[] {
      const out: Tool[] = []
      for (const tool of tools.values()) {
        if (tool.namespace === namespace) out.push(tool)
      }
      return Object.freeze(out)
    },

    get size(): number {
      return tools.size
    },
  }
}

// ---------------------------------------------------------------------------
// API tool definitions — for passing to model APIs
// ---------------------------------------------------------------------------

export type ApiToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input_schema: ToolInputJSONSchema
}

export function getToolDefinitions(registry: ToolRegistry): ApiToolDefinition[] {
  return registry.getAll().map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

// ---------------------------------------------------------------------------
// Default registry — pre-populated with all Phase 6 tool implementations
// ---------------------------------------------------------------------------

export function createDefaultRegistry(): ToolRegistry {
  const registry = createToolRegistry()
  registry.register(FileReadTool)
  registry.register(FileWriteTool)
  registry.register(FileEditTool)
  registry.register(GlobTool)
  registry.register(GrepTool)
  registry.register(BashTool)
  registry.register(WebFetchTool)
  registry.register(WebSearchTool)
  registry.register(CodeSandboxTool)
  registry.register(AgentTool)
  return registry
}
