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
import { AgentTool } from '../../agents/agentTool.js'

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  has(name: string): boolean
  getAll(): readonly Tool[]
  readonly size: number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>()

  return {
    register(tool: Tool): void {
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered`)
      }
      tools.set(tool.name, tool)
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
  registry.register(AgentTool)
  return registry
}
