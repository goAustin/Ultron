/**
 * AgentTool — delegate a task to a read-only subagent.
 *
 * The model invokes this tool with a prompt string. The tool calls
 * context.forkSubagent(prompt) and returns the subagent's result text.
 */

import type { Tool, ToolResult, ToolInputJSONSchema, ValidationResult, PermissionResult } from '../core/tools/types.js'
import type { ToolUseContext } from '../core/tools/context.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AGENT_TOOL_NAME = 'Agent'

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const inputSchema: ToolInputJSONSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'The task to delegate to a subagent',
    },
  },
  required: ['prompt'],
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export function createAgentTool(): Tool {
  return {
    name: AGENT_TOOL_NAME,
    description: 'Delegate a task to a read-only subagent for research or exploration.',
    inputSchema,

    async validateInput(
      input: Record<string, unknown>,
    ): Promise<ValidationResult> {
      if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
        return { valid: false, message: 'prompt must be a non-empty string' }
      }
      return { valid: true }
    },

    async checkPermissions(
    ): Promise<PermissionResult> {
      // Auto-approve: v1 subagents are read-only, so delegation is safe.
      // Individual tool calls within the subagent go through their own
      // permission cascade.
      return { behavior: 'allow' }
    },

    async call(
      input: Record<string, unknown>,
      context: ToolUseContext,
    ): Promise<ToolResult> {
      if (!context.forkSubagent) {
        return {
          content: 'Agent delegation is not available in this context',
          isError: true,
        }
      }

      const prompt = input.prompt as string
      const result = await context.forkSubagent(prompt)

      return {
        content: result.text,
        isError: false,
      }
    },
  }
}

/** Pre-built AgentTool instance for registry registration. */
export const AgentTool = createAgentTool()
