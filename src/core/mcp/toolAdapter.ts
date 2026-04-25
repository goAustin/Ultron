import type { Tool, ToolInputJSONSchema } from '../tools/types.js'
import type { ToolProgressInput } from '../tools/context.js'
import { makeErrorResult, makeAbortResult } from '../tools/toolExecution.js'
import type { McpToolCallResult, McpToolDescriptor } from './client.js'
import { qualifyToolName, sanitizeToolName } from './namespacing.js'

export type McpCallToolGateway = (args: {
  readonly serverName: string
  readonly toolName: string
  readonly input: unknown
  readonly signal: AbortSignal
  readonly onProgress?: (progress: ToolProgressInput) => void
}) => Promise<McpToolCallResult>

export type CreateMcpToolArgs = {
  readonly serverName: string
  readonly descriptor: McpToolDescriptor
  readonly fallbackIndex: number
  readonly callToolGateway: McpCallToolGateway
}

/**
 * Adapt an MCP tool descriptor to the Tool interface.
 *
 * Object schemas pass through unchanged. Non-object valid-primitive schemas
 * (string/number/integer/boolean/array/null at the top level) are wrapped
 * into `{ type: 'object', properties: { value: <original> }, required:
 * ['value'], additionalProperties: false }`, and the adapter unwraps
 * `input.value` before calling the server. Unsupported shapes (no valid
 * top-level `type` — e.g. `anyOf`, `oneOf`, `$ref`) return null; the manager
 * logs and skips.
 */
export function createMcpTool(args: CreateMcpToolArgs): Tool | null {
  const { serverName, descriptor, fallbackIndex, callToolGateway } = args

  let effectiveSchema: ToolInputJSONSchema
  let wrapped = false
  if (isObjectSchema(descriptor.inputSchema)) {
    effectiveSchema = descriptor.inputSchema as ToolInputJSONSchema
  } else if (isNonObjectValidSchema(descriptor.inputSchema)) {
    effectiveSchema = wrapSchema(descriptor.inputSchema)
    wrapped = true
  } else {
    return null
  }

  const sanitized = sanitizeToolName(descriptor.name, fallbackIndex)
  const qualifiedName = qualifyToolName(serverName, sanitized)
  const baseDescription = descriptor.description ?? `(MCP tool from ${serverName})`
  const description = wrapped
    ? `${baseDescription}\n\n(This tool accepts a single \`value\` argument.)`
    : baseDescription

  const tool: Tool = {
    name: qualifiedName,
    description,
    inputSchema: effectiveSchema,
    source: 'mcp',
    namespace: serverName,
    isMutating: true,

    async validateInput() {
      return { valid: true }
    },

    // The full rationale lives in docs/phase3a-v2-design.md §Critical invariants.
    // Returning `allow` lets the permission cascade fall through to fallback-ask
    // on first use and match session allow rules on subsequent calls.
    async checkPermissions() {
      return { behavior: 'allow' }
    },

    async call(input, ctx, signal) {
      const serverInput = wrapped ? (input as Record<string, unknown>)['value'] : input
      const result = await callToolGateway({
        serverName,
        toolName: descriptor.name,
        input: serverInput,
        signal,
        ...(ctx.onProgress && { onProgress: ctx.onProgress }),
      })
      switch (result.kind) {
        case 'ok':
          return { content: result.content, isError: result.isError }
        case 'aborted':
          return makeAbortResult()
        case 'transport_error':
        case 'protocol_error':
        case 'timeout':
          return makeErrorResult('execution_error', result.message)
      }
    },
  }

  return tool
}

function isObjectSchema(schema: unknown): schema is ToolInputJSONSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    !Array.isArray(schema) &&
    (schema as Record<string, unknown>).type === 'object'
  )
}

function isNonObjectValidSchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false
  const t = (schema as Record<string, unknown>).type
  return (
    t === 'string' ||
    t === 'number' ||
    t === 'integer' ||
    t === 'boolean' ||
    t === 'array' ||
    t === 'null'
  )
}

function wrapSchema(original: unknown): ToolInputJSONSchema {
  return {
    type: 'object',
    properties: { value: (original ?? {}) as Record<string, unknown> },
    required: ['value'],
    additionalProperties: false,
  } as ToolInputJSONSchema
}
