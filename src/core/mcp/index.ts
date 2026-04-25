export { createMcpManager } from './manager.js'
export type {
  McpManager,
  McpBootstrapResult,
  McpBootstrapFailure,
  McpReloadResult,
  McpServerStatus,
  McpRegisteredToolInfo,
  SpawnTransportFn,
} from './manager.js'

export { loadMcpConfig, emptyMcpConfig } from './config.js'
export type { McpConfig, McpServerConfig } from './config.js'

export { spawnStdioTransport, DEFAULT_CLOSE_GRACE_MS } from './transportStdio.js'
export type { StdioTransport, SpawnStdioTransportArgs } from './transportStdio.js'

export {
  McpConfigError,
  McpInitializeError,
  McpTransportError,
  McpProtocolError,
} from './errors.js'

export { MCP_TOOL_PREFIX, isValidServerName, qualifyToolName, parseQualifiedName } from './namespacing.js'
