import type { Tool, ToolInputJSONSchema } from '../tools/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolProgressInput } from '../tools/context.js'
import type { McpConfig, McpServerConfig } from './config.js'
import { sameMcpServerConfig } from './config.js'
import {
  createMcpClient,
  type McpClient,
  type McpClientState,
  type McpToolCallResult,
  type McpToolDescriptor,
} from './client.js'
import { spawnStdioTransport, type StdioTransport } from './transportStdio.js'
import { createMcpTool, type McpCallToolGateway } from './toolAdapter.js'

export type McpBootstrapFailure = {
  readonly server: string
  readonly error: Error
}

export type McpBootstrapResult = {
  readonly connected: readonly string[]
  readonly failed: readonly McpBootstrapFailure[]
}

export type McpReloadResult = {
  readonly connected: readonly string[]
  readonly failed: readonly McpBootstrapFailure[]
  readonly removed: readonly string[]
  readonly disabled: readonly string[]
  readonly unchanged: readonly string[]
  readonly backoff: readonly McpServerStatus[]
  readonly toolDefinitionsChanged: boolean
}

export type McpServerStatus = {
  readonly server: string
  readonly state: McpClientState
  readonly toolCount: number
  readonly lastError: string | null
  readonly reconnectAttempts: number
  readonly nextRetryAt: number | null
  readonly lastConnectedAt: number | null
  readonly lastDisconnectedAt: number | null
}

export type McpRegisteredToolInfo = {
  readonly server: string
  readonly name: string
  readonly description: string
  readonly state: McpClientState
}

export interface McpManager {
  bootstrap(args: {
    config: McpConfig
    registry: ToolRegistry
    signal: AbortSignal
  }): Promise<McpBootstrapResult>
  reload(args: {
    config: McpConfig
    registry: ToolRegistry
    signal: AbortSignal
  }): Promise<McpReloadResult>
  callTool(args: {
    serverName: string
    toolName: string
    input: unknown
    signal: AbortSignal
    onProgress?: (progress: ToolProgressInput) => void
  }): Promise<McpToolCallResult>
  listTools(serverName?: string): readonly McpRegisteredToolInfo[]
  shutdown(): Promise<void>
  status(): readonly McpServerStatus[]
}

export type SpawnTransportFn = (args: {
  command: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
  cwd?: string
}) => StdioTransport

type ReconnectPolicy = {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly maxAttempts: number
}

type McpServerHandle = {
  serverName: string
  config: McpServerConfig
  state: McpClientState
  client: McpClient | null
  descriptors: McpToolDescriptor[]
  descriptorSignature: string
  registeredToolNames: string[]
  generation: number
  lastError: string | null
  reconnectAttempts: number
  nextRetryAt: number | null
  lastConnectedAt: number | null
  lastDisconnectedAt: number | null
  reconnectPromise: Promise<void> | null
  reconnectAbortController: AbortController | null
}

const DEFAULT_RECONNECT: ReconnectPolicy = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 5,
}

class McpToolSetChangedError extends Error {
  constructor() {
    super('MCP tool set changed; run /mcp reload')
  }
}

export function createMcpManager(deps?: {
  spawnTransport?: SpawnTransportFn
  reconnectPolicy?: Partial<ReconnectPolicy>
  now?: () => number
}): McpManager {
  const spawn: SpawnTransportFn = deps?.spawnTransport ?? spawnStdioTransport
  const reconnectPolicy: ReconnectPolicy = {
    ...DEFAULT_RECONNECT,
    ...deps?.reconnectPolicy,
  }
  const now = deps?.now ?? Date.now
  const handles = new Map<string, McpServerHandle>()
  let registryRef: ToolRegistry | null = null
  let shutdownStarted = false
  let manager: McpManager

  const gateway: McpCallToolGateway = (args) => manager.callTool(args)

  function makeHandle(
    serverName: string,
    config: McpServerConfig,
    state: McpClientState,
  ): McpServerHandle {
    return {
      serverName,
      config,
      state,
      client: null,
      descriptors: [],
      descriptorSignature: '[]',
      registeredToolNames: [],
      generation: 0,
      lastError: null,
      reconnectAttempts: 0,
      nextRetryAt: null,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      reconnectPromise: null,
      reconnectAbortController: null,
    }
  }

  function spawnClient(handle: McpServerHandle): McpClient {
    const cfg = handle.config
    const transport = spawn({
      command: cfg.command,
      args: cfg.args ?? [],
      ...(cfg.env !== undefined && { env: cfg.env }),
      ...(cfg.cwd !== undefined && { cwd: cfg.cwd }),
    })
    return createMcpClient(handle.serverName, cfg, transport)
  }

  async function connectClient(
    handle: McpServerHandle,
    signal: AbortSignal,
  ): Promise<{ client: McpClient; descriptors: readonly McpToolDescriptor[] }> {
    const client = spawnClient(handle)
    try {
      await client.connect(signal)
      return { client, descriptors: client.listedTools() }
    } catch (err) {
      await client.close()
      throw err
    }
  }

  async function bootstrapHandle(
    handle: McpServerHandle,
    registry: ToolRegistry,
    signal: AbortSignal,
  ): Promise<void> {
    handle.state = 'connecting'
    const { client, descriptors } = await connectClient(handle, signal)
    handle.client = client
    registerDescriptors(handle, registry, descriptors)
    handle.state = 'ready'
    handle.lastError = null
    handle.lastConnectedAt = now()
    handle.lastDisconnectedAt = null
    handle.reconnectAttempts = 0
    handle.nextRetryAt = null
  }

  function registerDescriptors(
    handle: McpServerHandle,
    registry: ToolRegistry,
    descriptors: readonly McpToolDescriptor[],
  ): void {
    const registered: string[] = []
    const tools: Tool[] = []
    for (const [i, descriptor] of descriptors.entries()) {
      const tool = createMcpTool({
        serverName: handle.serverName,
        descriptor,
        fallbackIndex: i,
        callToolGateway: gateway,
      })
      if (tool === null) {
        process.stderr.write(
          `[mcp] server "${handle.serverName}" tool "${descriptor.name}" dropped: unsupported top-level schema\n`,
        )
        continue
      }
      try {
        registry.register(tool)
        registered.push(tool.name)
        tools.push(tool)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `[mcp] server "${handle.serverName}" tool "${tool.name}" failed to register: ${msg}\n`,
        )
      }
    }
    handle.descriptors = [...descriptors]
    handle.registeredToolNames = registered
    handle.descriptorSignature = signatureForTools(tools)
    handle.generation++
  }

  function unregisterTools(handle: McpServerHandle, registry: ToolRegistry | null): boolean {
    const hadTools = handle.registeredToolNames.length > 0
    if (registry) {
      for (const toolName of handle.registeredToolNames) {
        registry.unregister(toolName)
      }
    }
    handle.registeredToolNames = []
    handle.descriptors = []
    handle.descriptorSignature = '[]'
    return hadTools
  }

  async function closeHandle(handle: McpServerHandle): Promise<void> {
    handle.reconnectAbortController?.abort()
    handle.reconnectAbortController = null
    const client = handle.client
    handle.client = null
    if (client) {
      await client.close()
    }
  }

  function syncClientState(handle: McpServerHandle): void {
    if (handle.state !== 'ready') return
    const clientState = handle.client?.state
    if (clientState === 'failed' || clientState === 'closed') {
      markUnexpectedDisconnect(handle, handle.client?.lastError?.message ?? 'Transport exited')
    }
  }

  function markUnexpectedDisconnect(handle: McpServerHandle, message: string): void {
    handle.state = 'failed'
    handle.lastError = message
    handle.lastDisconnectedAt = now()
    handle.client = handle.client
    if (handle.nextRetryAt === null && handle.reconnectAttempts < reconnectPolicy.maxAttempts) {
      handle.nextRetryAt = now() + reconnectPolicy.initialDelayMs
    }
  }

  function markReconnectFailure(handle: McpServerHandle, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    handle.state = 'failed'
    handle.lastError = msg
    handle.lastDisconnectedAt = now()
    if (err instanceof McpToolSetChangedError) {
      handle.reconnectAttempts = reconnectPolicy.maxAttempts
      handle.nextRetryAt = null
      return
    }
    const delay = reconnectDelay(handle.reconnectAttempts)
    handle.nextRetryAt =
      handle.reconnectAttempts >= reconnectPolicy.maxAttempts ? null : now() + delay
  }

  function reconnectDelay(attempts: number): number {
    const exp = Math.max(0, attempts - 1)
    return Math.min(
      reconnectPolicy.maxDelayMs,
      reconnectPolicy.initialDelayMs * 2 ** exp,
    )
  }

  async function ensureConnected(
    handle: McpServerHandle,
    signal: AbortSignal,
  ): Promise<McpToolCallResult | null> {
    syncClientState(handle)
    if (handle.state === 'ready' && handle.client?.state === 'ready') return null

    if (shutdownStarted) {
      return { kind: 'transport_error', message: 'MCP manager has been shut down' }
    }
    if (handle.state === 'idle' || handle.config.disabled === true) {
      return { kind: 'transport_error', message: `MCP server "${handle.serverName}" is disabled` }
    }
    const ts = now()
    if (handle.nextRetryAt !== null && handle.nextRetryAt > ts) {
      return {
        kind: 'transport_error',
        message: `MCP server "${handle.serverName}" reconnect in ${handle.nextRetryAt - ts}ms`,
      }
    }
    if (handle.reconnectAttempts >= reconnectPolicy.maxAttempts) {
      return {
        kind: 'transport_error',
        message: handle.lastError ?? `MCP server "${handle.serverName}" reconnect attempts exhausted`,
      }
    }

    if (!handle.reconnectPromise) {
      handle.reconnectAbortController = new AbortController()
      handle.reconnectPromise = reconnectHandle(handle, handle.reconnectAbortController.signal)
        .finally(() => {
          handle.reconnectPromise = null
          handle.reconnectAbortController = null
        })
    }

    try {
      await waitForReconnect(handle.reconnectPromise, signal)
      return null
    } catch (err) {
      if (signal.aborted) return { kind: 'aborted' }
      return {
        kind: 'transport_error',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async function waitForReconnect(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    if (!signal.aborted) {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          )
        }),
      ])
      return
    }
    throw new Error('aborted')
  }

  async function reconnectHandle(
    handle: McpServerHandle,
    signal: AbortSignal,
  ): Promise<void> {
    handle.reconnectAttempts++
    handle.state = 'connecting'
    handle.nextRetryAt = null

    try {
      const { client, descriptors } = await connectClient(handle, signal)
      const nextSignature = descriptorSignatureForRegistered(
        handle.serverName,
        descriptors,
        handle.registeredToolNames,
      )
      if (nextSignature !== handle.descriptorSignature) {
        await client.close()
        throw new McpToolSetChangedError()
      }

      const oldClient = handle.client
      handle.client = client
      if (oldClient && oldClient !== client) {
        await oldClient.close()
      }
      handle.descriptors = [...descriptors]
      handle.state = 'ready'
      handle.lastError = null
      handle.lastConnectedAt = now()
      handle.lastDisconnectedAt = null
      handle.nextRetryAt = null
    } catch (err) {
      markReconnectFailure(handle, err)
      throw err
    }
  }

  async function replaceServer(
    handle: McpServerHandle,
    cfg: McpServerConfig,
    registry: ToolRegistry,
    signal: AbortSignal,
  ): Promise<void> {
    unregisterTools(handle, registry)
    await closeHandle(handle)
    handle.config = cfg
    handle.client = null
    handle.state = 'connecting'
    handle.lastError = null
    handle.reconnectAttempts = 0
    handle.nextRetryAt = null
    handle.lastConnectedAt = null
    handle.lastDisconnectedAt = null
    await bootstrapHandle(handle, registry, signal)
  }

  function statusFor(handle: McpServerHandle): McpServerStatus {
    syncClientState(handle)
    return {
      server: handle.serverName,
      state: handle.state,
      toolCount: handle.registeredToolNames.length,
      lastError: handle.state === 'idle' ? '(disabled)' : handle.lastError,
      reconnectAttempts: handle.reconnectAttempts,
      nextRetryAt: handle.nextRetryAt,
      lastConnectedAt: handle.lastConnectedAt,
      lastDisconnectedAt: handle.lastDisconnectedAt,
    }
  }

  manager = {
    async bootstrap({ config, registry, signal }): Promise<McpBootstrapResult> {
      registryRef = registry
      const connected: string[] = []
      const failed: McpBootstrapFailure[] = []

      for (const [name, cfg] of Object.entries(config.servers)) {
        const handle = makeHandle(name, cfg, cfg.disabled === true ? 'idle' : 'connecting')
        handles.set(name, handle)
      }

      const activeHandles = [...handles.values()].filter(h => h.config.disabled !== true)
      const results = await Promise.allSettled(
        activeHandles.map(async (handle) => {
          await bootstrapHandle(handle, registry, signal)
          return handle.serverName
        }),
      )

      for (const [i, result] of results.entries()) {
        const handle = activeHandles[i]
        if (result.status === 'fulfilled') {
          connected.push(handle.serverName)
        } else {
          const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason))
          handle.state = 'failed'
          handle.lastError = err.message
          handle.lastDisconnectedAt = now()
          failed.push({ server: handle.serverName, error: err })
          process.stderr.write(`[mcp] server "${handle.serverName}" failed: ${err.message}\n`)
        }
      }

      return { connected, failed }
    },

    async reload({ config, registry, signal }): Promise<McpReloadResult> {
      registryRef = registry
      const connected: string[] = []
      const failed: McpBootstrapFailure[] = []
      const removed: string[] = []
      const disabled: string[] = []
      const unchanged: string[] = []
      let toolDefinitionsChanged = false

      for (const [name, handle] of [...handles.entries()]) {
        if (config.servers[name] === undefined) {
          toolDefinitionsChanged = unregisterTools(handle, registry) || toolDefinitionsChanged
          await closeHandle(handle)
          handles.delete(name)
          removed.push(name)
        }
      }

      for (const [name, cfg] of Object.entries(config.servers)) {
        const existing = handles.get(name)

        if (cfg.disabled === true) {
          if (existing) {
            toolDefinitionsChanged = unregisterTools(existing, registry) || toolDefinitionsChanged
            await closeHandle(existing)
            existing.config = cfg
            existing.state = 'idle'
            existing.lastError = null
            existing.reconnectAttempts = 0
            existing.nextRetryAt = null
          } else {
            handles.set(name, makeHandle(name, cfg, 'idle'))
          }
          disabled.push(name)
          continue
        }

        if (!existing) {
          const handle = makeHandle(name, cfg, 'connecting')
          handles.set(name, handle)
          try {
            await bootstrapHandle(handle, registry, signal)
            toolDefinitionsChanged =
              handle.registeredToolNames.length > 0 || toolDefinitionsChanged
            connected.push(name)
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err))
            handle.state = 'failed'
            handle.lastError = e.message
            handle.lastDisconnectedAt = now()
            failed.push({ server: name, error: e })
            process.stderr.write(`[mcp] server "${name}" failed: ${e.message}\n`)
          }
          continue
        }

        if (!sameMcpServerConfig(existing.config, cfg) || existing.state === 'idle') {
          const oldSignature = existing.descriptorSignature
          try {
            await replaceServer(existing, cfg, registry, signal)
            toolDefinitionsChanged =
              existing.descriptorSignature !== oldSignature || toolDefinitionsChanged
            connected.push(name)
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err))
            existing.state = 'failed'
            existing.lastError = e.message
            existing.lastDisconnectedAt = now()
            failed.push({ server: name, error: e })
            toolDefinitionsChanged = oldSignature !== '[]' || toolDefinitionsChanged
            process.stderr.write(`[mcp] server "${name}" failed: ${e.message}\n`)
          }
          continue
        }

        unchanged.push(name)
        syncClientState(existing)
      }

      const backoff = [...handles.values()]
        .map(statusFor)
        .filter(s => s.state === 'failed' && s.nextRetryAt !== null)

      return {
        connected,
        failed,
        removed,
        disabled,
        unchanged,
        backoff,
        toolDefinitionsChanged,
      }
    },

    async callTool({ serverName, toolName, input, signal, onProgress }): Promise<McpToolCallResult> {
      const handle = handles.get(serverName)
      if (!handle) {
        return { kind: 'transport_error', message: `MCP server "${serverName}" not found` }
      }

      const reconnectError = await ensureConnected(handle, signal)
      if (reconnectError) return reconnectError

      const client = handle.client
      if (!client || client.state !== 'ready') {
        return { kind: 'transport_error', message: `MCP server "${serverName}" is not ready` }
      }

      const result = await client.callTool(toolName, input, signal, onProgress)
      if (result.kind === 'transport_error' && handle.client?.state === 'failed') {
        markUnexpectedDisconnect(handle, result.message)
      }
      return result
    },

    listTools(serverName?: string): readonly McpRegisteredToolInfo[] {
      const out: McpRegisteredToolInfo[] = []
      for (const handle of handles.values()) {
        syncClientState(handle)
        if (serverName !== undefined && handle.serverName !== serverName) continue
        for (const toolName of handle.registeredToolNames) {
          const tool = registryRef?.get(toolName)
          out.push({
            server: handle.serverName,
            name: toolName,
            description: tool?.description ?? '',
            state: handle.state,
          })
        }
      }
      return Object.freeze(out)
    },

    async shutdown(): Promise<void> {
      if (shutdownStarted) return
      shutdownStarted = true
      const snapshot = [...handles.values()]
      handles.clear()
      const registry = registryRef
      for (const handle of snapshot) {
        unregisterTools(handle, registry)
      }
      await Promise.allSettled(snapshot.map(closeHandle))
    },

    status(): readonly McpServerStatus[] {
      return [...handles.values()].map(statusFor)
    },
  }

  return manager
}

function descriptorSignature(
  serverName: string,
  descriptors: readonly McpToolDescriptor[],
): string {
  return signatureForTools(toolsFromDescriptors(serverName, descriptors))
}

function descriptorSignatureForRegistered(
  serverName: string,
  descriptors: readonly McpToolDescriptor[],
  registeredToolNames: readonly string[],
): string {
  const registered = new Set(registeredToolNames)
  const tools = toolsFromDescriptors(serverName, descriptors).filter(tool => registered.has(tool.name))
  return signatureForTools(tools)
}

function signatureForTools(tools: readonly Tool[]): string {
  return stableStringify(
    tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as ToolInputJSONSchema,
    })),
  )
}

function toolsFromDescriptors(
  serverName: string,
  descriptors: readonly McpToolDescriptor[],
): Tool[] {
  const tools: Tool[] = []
  const noopGateway: McpCallToolGateway = async () => ({
    kind: 'transport_error',
    message: 'descriptor comparison only',
  })
  for (const [i, descriptor] of descriptors.entries()) {
    const tool = createMcpTool({
      serverName,
      descriptor,
      fallbackIndex: i,
      callToolGateway: noopGateway,
    })
    if (tool) tools.push(tool)
  }
  return tools
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    const entries = Object.keys(obj)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
