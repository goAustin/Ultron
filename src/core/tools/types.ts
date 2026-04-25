/**
 * Tool interface and related types.
 * All tools implement this interface. No Zod, no generics.
 */

import type { ToolUseContext } from './context.js'

// ---------------------------------------------------------------------------
// JSON Schema for tool inputs (always type: 'object')
// ---------------------------------------------------------------------------

export type ToolInputJSONSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { valid: true }
  | { valid: false; message: string }

export type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; message: string }

export type ToolResult = {
  readonly content: string
  readonly isError: boolean
  readonly errorKind?: ToolErrorKind
}

export type ToolErrorKind =
  | 'tool_not_found'
  | 'validation_failed'
  | 'permission_denied'
  | 'permission_ask'
  | 'execution_error'
  | 'aborted'
  | 'hook_blocked'

export type ToolSource = 'builtin' | 'mcp' | 'custom'

// ---------------------------------------------------------------------------
// Tool interface
// ---------------------------------------------------------------------------

export interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: ToolInputJSONSchema

  validateInput(
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  checkPermissions(
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    signal: AbortSignal,
  ): Promise<ToolResult>

  /** True if this tool can safely run concurrently with others. */
  isConcurrencySafe?(input: Record<string, unknown>): boolean

  /**
   * Whether this tool mutates state (files, processes, etc.).
   * Filesystem safety checks only fire for mutating tools.
   * Default undefined = true (conservative).
   */
  readonly isMutating?: boolean

  /**
   * Best-effort filesystem path this tool operates on, for permission routing.
   * Not all tools have a meaningful path (e.g., Bash).
   */
  getPath?(input: Record<string, unknown>): string

  /**
   * Best-effort host this tool operates against, for domain-scoped permission
   * rules. Parallel to getPath. Returns undefined when the input doesn't
   * carry a URL (or the URL is malformed). Pure / declarative — no I/O.
   */
  getDomain?(input: Record<string, unknown>): string | undefined

  /**
   * Where this tool came from. Undefined is treated as 'builtin' on read so
   * literal-object tools (e.g., AgentTool) don't need to declare it.
   */
  readonly source?: ToolSource

  /** For MCP tools, the server name this tool came from. */
  readonly namespace?: string
}

// ---------------------------------------------------------------------------
// buildTool — fills defaults so tool definitions stay lean
// ---------------------------------------------------------------------------

export type ToolSpec = {
  name: string
  description?: string
  inputSchema: ToolInputJSONSchema
  call: Tool['call']
  validateInput?: Tool['validateInput']
  checkPermissions?: Tool['checkPermissions']
  isMutating?: boolean
  isConcurrencySafe?: Tool['isConcurrencySafe']
  getPath?: Tool['getPath']
  getDomain?: Tool['getDomain']
  source?: ToolSource
  namespace?: string
}

export function buildTool(spec: ToolSpec): Tool {
  const tool: Tool = {
    name: spec.name,
    description: spec.description ?? '',
    inputSchema: spec.inputSchema,

    validateInput: spec.validateInput ?? (async () => ({ valid: true as const })),
    checkPermissions: spec.checkPermissions ?? (async () => ({ behavior: 'allow' as const })),
    call: spec.call,

    source: spec.source ?? 'builtin',

    ...(spec.isMutating !== undefined && { isMutating: spec.isMutating }),
    ...(spec.isConcurrencySafe && { isConcurrencySafe: spec.isConcurrencySafe }),
    ...(spec.getPath && { getPath: spec.getPath }),
    ...(spec.getDomain && { getDomain: spec.getDomain }),
    ...(spec.namespace !== undefined && { namespace: spec.namespace }),
  }
  return tool
}
