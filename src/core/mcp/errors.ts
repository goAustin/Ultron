/**
 * MCP-specific error types. Kept separate from src/core/errors.ts so an
 * MCP-free build has zero dead code from this module.
 */

export class McpConfigError extends Error {
  readonly code = 'MCP_CONFIG_ERROR' as const
  constructor(message: string) {
    super(message)
    this.name = 'McpConfigError'
  }
}

export class McpInitializeError extends Error {
  readonly code = 'MCP_INITIALIZE_ERROR' as const
  readonly serverName: string
  constructor(serverName: string, message: string) {
    super(message)
    this.name = 'McpInitializeError'
    this.serverName = serverName
  }
}

export class McpTransportError extends Error {
  readonly code = 'MCP_TRANSPORT_ERROR' as const
  readonly serverName: string
  constructor(serverName: string, message: string) {
    super(message)
    this.name = 'McpTransportError'
    this.serverName = serverName
  }
}

export class McpProtocolError extends Error {
  readonly code = 'MCP_PROTOCOL_ERROR' as const
  readonly serverName: string
  readonly rpcCode?: number
  constructor(serverName: string, message: string, rpcCode?: number) {
    super(message)
    this.name = 'McpProtocolError'
    this.serverName = serverName
    if (rpcCode !== undefined) this.rpcCode = rpcCode
  }
}
