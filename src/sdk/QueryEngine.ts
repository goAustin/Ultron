/**
 * QueryEngine — stateful session wrapper for the Ultron agent loop.
 *
 * Wires deps from config, manages message history, persists transcripts,
 * and exposes a streaming async generator interface.
 * Works identically in interactive (CLI) and headless (SDK) modes.
 */

import { randomUUID } from 'node:crypto'

import { query } from '../core/query.js'
import type { QueryEvent } from '../core/queryEvents.js'
import type { Terminal } from '../core/queryTypes.js'
import type { QueryDeps } from '../core/queryDeps.js'
import type { Message } from '../core/messages.js'
import { createUserMessage, messageId } from '../core/messages.js'
import type { PermissionMode, AppState } from '../core/state.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import type { AskUserFn, PermissionOptions } from '../core/permissions/types.js'
import { filesystemSafetyChecks } from '../core/permissions/filesystem.js'
import { createDefaultRegistry } from '../core/tools/registry.js'
import { createToolUseContext } from '../core/tools/context.js'
import type { ReadFileState } from '../core/tools/context.js'
import {
  createAuthorizeToolUseFn,
  createExecuteToolUseFn,
} from '../core/tools/toolExecution.js'
import { createAuditWriter } from '../audit/auditLog.js'
import type { AuditWriter } from '../audit/types.js'
import { resolveModel } from '../core/providers/registry.js'
import type { ProviderId, CapabilitySheet } from '../core/providers/types.js'
import { MissingApiKeyError } from '../core/providers/types.js'
import { normalizeThinkingBudget } from '../core/providers/thinkingNormalize.js'
import type { CallModelFn } from '../core/queryDeps.js'
import type { ApiToolDefinition } from '../core/tools/registry.js'
import { getToolDefinitions } from '../core/tools/registry.js'
import { createCompactFn } from '../context/compact.js'
import { buildFullSystemPromptParts } from '../context/queryContext.js'
import { getInitialAttachments, buildGetAttachments } from '../context/attachments.js'
import { createSession, resumeSession } from '../session/resume.js'
import { createForkSubagent } from '../agents/runAgent.js'
import type { SessionInfo } from '../session/resume.js'
import { appendMessage, getEventMessage } from '../session/transcript.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type QueryEngineConfig = {
  /**
   * Explicit API key. If omitted, the engine reads the env var that the model's
   * provider declares (e.g. `ANTHROPIC_API_KEY`). A single key is paired with
   * one provider at construction time — when `setModel()` switches to a
   * different provider, the engine re-resolves the key from env.
   */
  readonly apiKey?: string
  readonly model: string
  readonly cwd: string
  readonly baseUrl?: string                     // custom API base URL (e.g. OpenRouter)
  readonly permissionMode?: PermissionMode
  readonly headless?: boolean
  readonly askUser?: AskUserFn
  readonly maxTurns?: number
  readonly sessionId?: string
  readonly compactModel?: string
  /**
   * Engine-wide default thinking budget (tokens). Per-submission `submitPrompt`
   * `opts` win when set. The value is normalized once per submission against
   * the active model's capabilities.
   */
  readonly thinkingBudget?: number
  /** Engine-wide default for Anthropic interleaved-thinking. */
  readonly interleavedThinking?: boolean
  /**
   * Audit writer for the Phase 2a audit spine. When omitted, the engine creates
   * a default writer at `~/.ultron/audit.jsonl`. Tests should inject a writer
   * pointed at a temp dir to avoid touching the user's real home.
   */
  readonly auditWriter?: AuditWriter
  /** Test-only: override assembled deps. Not part of the public SDK surface. */
  readonly deps?: Partial<QueryDeps>
}

export type SubmitPromptOptions = {
  readonly thinkingBudget?: number
  readonly interleavedThinking?: boolean
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export class QueryEngine {
  // --- Engine-level (long-lived) ---
  private readonly config: QueryEngineConfig
  private callModel: CallModelFn
  private compactCallModel: CallModelFn
  private _model: string
  private readonly toolRegistry: ReturnType<typeof createDefaultRegistry>
  private readonly appState: ReturnType<typeof createStore<ReturnType<typeof getDefaultAppState>>>
  private readonly readFileState: ReadFileState
  private readonly permissionOpts: PermissionOptions
  private readonly auditWriter: AuditWriter
  private session: SessionInfo

  // --- Per-submission ---
  private currentAbort: AbortController | null = null
  private _running = false
  private _messages: Message[] = []
  private _turnCount = 0
  private _needsResume: boolean
  private _resumed = false

  constructor(config: QueryEngineConfig) {
    this.config = config

    // Long-lived deps
    this.toolRegistry = createDefaultRegistry()
    const toolDefs = getToolDefinitions(this.toolRegistry)

    this._model = config.model
    this.callModel = this.resolveCallModel(config.model, toolDefs)
    this.compactCallModel = config.compactModel
      ? this.resolveCallModel(config.compactModel, toolDefs)
      : this.callModel
    const initialState: AppState = {
      ...getDefaultAppState(),
      permissionMode: config.permissionMode ?? 'default',
      workingDirectories: [config.cwd],
    }
    this.appState = createStore(initialState)
    this.readFileState = new Map()

    const headless = config.headless ?? false
    this.permissionOpts = {
      headless,
      safetyChecks: [...filesystemSafetyChecks],
      askUser: headless ? undefined : config.askUser,
    }

    this.auditWriter = config.auditWriter ?? createAuditWriter()

    // Session
    if (config.sessionId) {
      // Lazy resume — actual load happens in first submitPrompt
      this._needsResume = true
      this.session = {
        id: config.sessionId,
        dir: '', // will be populated on resume
        createdAt: 0,
        messageCount: 0,
      }
    } else {
      this._needsResume = false
      this.session = createSession()
    }
  }

  /** The session ID (created or pending resume). */
  get sessionId(): string {
    return this.config.sessionId ?? this.session.id
  }

  /** Current message history (read-only). */
  get messages(): readonly Message[] {
    return this._messages
  }

  /** The model currently driving the main agent loop. */
  get currentModel(): string {
    return this._model
  }

  /** The provider id backing the current model (e.g. 'anthropic', 'openai'). */
  get currentProvider(): ProviderId {
    return resolveModel(this._model).adapter.id
  }

  /**
   * Resolve `modelId` to its provider adapter, pull the matching API key from
   * `config.apiKey` (if set) or env, and build a `CallModelFn`. Throws
   * `MissingApiKeyError` if neither is available.
   *
   * When switching across providers (e.g. Anthropic → OpenAI), `config.apiKey`
   * is a poor fit because it was paired with the original provider. The engine
   * falls back to env for the *new* provider's declared env var, which is the
   * mechanism that makes cross-provider hot-swap work.
   */
  private resolveCallModel(modelId: string, toolDefs: readonly ApiToolDefinition[]): CallModelFn {
    const { adapter, entry } = resolveModel(modelId)
    const envKey = process.env[adapter.envKeyName]
    // Use the config key only when it matches the target provider (inferred by
    // "the first resolve picked this provider"). For subsequent switches to a
    // different provider, env is the source of truth.
    const apiKey = envKey ?? this.config.apiKey
    if (!apiKey) {
      throw new MissingApiKeyError(adapter.envKeyName)
    }
    const capabilities: CapabilitySheet = {
      maxContextTokens: entry.maxContextTokens,
      maxOutputTokens: entry.maxOutputTokens,
      supportsThinking: entry.supportsThinking,
      supportsInterleavedThinking: entry.supportsInterleavedThinking,
      promptCacheModel: entry.promptCacheModel,
    }
    return adapter.createCallModel({
      apiKey,
      model: modelId,
      baseUrl: this.config.baseUrl,
      tools: toolDefs,
      capabilities,
    })
  }

  /** Capability sheet for the currently-active model. */
  private currentCapabilities(): CapabilitySheet {
    const { entry } = resolveModel(this._model)
    return {
      maxContextTokens: entry.maxContextTokens,
      maxOutputTokens: entry.maxOutputTokens,
      supportsThinking: entry.supportsThinking,
      supportsInterleavedThinking: entry.supportsInterleavedThinking,
      promptCacheModel: entry.promptCacheModel,
    }
  }

  /**
   * Hot-swap the main-loop model. Message history, session, permissions, and
   * tool registry are preserved. Throws if a submission is in progress.
   *
   * Works across providers: switching from `claude-sonnet-4-6` to `gpt-5.4-mini`
   * re-resolves the adapter via the registry and pulls the matching API key
   * from env.
   *
   * If the engine was constructed without an explicit `compactModel`, the
   * compaction call model is swapped in lockstep — otherwise it's left alone
   * (the user deliberately pinned a cheaper compactor).
   */
  setModel(model: string): void {
    if (this._running) {
      throw new Error('Cannot switch model while a submission is in progress')
    }
    if (model === this._model) return

    const toolDefs = getToolDefinitions(this.toolRegistry)
    const next = this.resolveCallModel(model, toolDefs)

    this.callModel = next
    if (!this.config.compactModel) {
      this.compactCallModel = next
    }
    this._model = model
  }

  /**
   * Submit a user prompt. Yields QueryEvents, returns Terminal.
   * Throws if another submission is already in progress.
   *
   * `opts.thinkingBudget` and `opts.interleavedThinking` override the engine
   * config defaults for this submission only. Subagents forked during the
   * submission inherit the resolved values.
   */
  async *submitPrompt(
    prompt: string,
    opts?: SubmitPromptOptions,
  ): AsyncGenerator<QueryEvent, Terminal> {
    if (this._running) {
      throw new Error('submitPrompt() already in progress')
    }

    this._running = true
    this.currentAbort = new AbortController()

    try {
      // Resume if needed (lazy, first call only)
      if (this._needsResume && !this._resumed) {
        const resumed = await resumeSession(this.config.sessionId!)
        this.session = resumed.info
        this._messages = [...resumed.messages]
        this._resumed = true
        this._needsResume = false
      }

      // System prompt
      const systemPromptParts = await buildFullSystemPromptParts(this.config.cwd)

      // User message
      const uuid = () => messageId(randomUUID())
      const userMsg = createUserMessage(prompt, { id: uuid() })

      // Initial attachments (first non-resumed turn only)
      let initialAttachments: Message[] = []
      if (this._messages.length === 0 && !this._resumed) {
        initialAttachments = await getInitialAttachments(this.config.cwd)
      }

      // Persist pre-query messages to transcript
      for (const att of initialAttachments) {
        await appendMessage(this.session.dir, att)
      }
      await appendMessage(this.session.dir, userMsg)

      // Build message array for query
      const allMessages = [...this._messages, ...initialAttachments, userMsg]

      // Resolve thinking knobs once per submission (per-call opts → config
      // defaults → undefined), normalize against the active model's
      // capabilities, then thread the result into both the main loop and any
      // subagent forks so the whole submission shares the same setting.
      const rawBudget = opts?.thinkingBudget ?? this.config.thinkingBudget
      const capSheet = this.currentCapabilities()
      const thinkingBudget = normalizeThinkingBudget(rawBudget, this._model, capSheet)
      const interleavedThinking = opts?.interleavedThinking ?? this.config.interleavedThinking

      // Per-submission subagent fork function
      const forkSubagent = createForkSubagent({
        callModel: this.callModel,
        compactCallModel: this.compactCallModel,
        parentToolRegistry: this.toolRegistry,
        parentAppState: this.appState,
        parentSystemPromptParts: systemPromptParts,
        parentSignal: this.currentAbort.signal,
        cwd: this.config.cwd,
        sessionDir: this.session.dir,
        permissionOpts: this.permissionOpts,
        auditWriter: this.auditWriter,
        parentThinkingBudget: thinkingBudget,
        parentInterleavedThinking: interleavedThinking,
      })

      // Per-submission tool context
      const toolUseContext = createToolUseContext({
        appState: this.appState,
        abortController: this.currentAbort,
        messages: allMessages,
        readFileState: this.readFileState,
        toolRegistry: this.toolRegistry,
        forkSubagent,
      })
      const authorizeToolUse = createAuthorizeToolUseFn(toolUseContext, this.permissionOpts)
      const executeToolUse = createExecuteToolUseFn(toolUseContext)

      // Assemble deps
      const deps: Partial<QueryDeps> = {
        callModel: this.callModel,
        authorizeToolUse,
        executeToolUse,
        compact: createCompactFn(this.compactCallModel, uuid),
        uuid,
        getAttachments: buildGetAttachments(this.config.cwd),
        ...this.config.deps, // test-only overrides
      }

      // Run query
      const gen = query({
        messages: allMessages,
        systemPromptParts,
        deps,
        signal: this.currentAbort.signal,
        maxTurns: this.config.maxTurns,
        thinkingBudget,
        interleavedThinking,
      })

      // Stream events through, persisting as we go
      let result = await gen.next()
      while (!result.done) {
        const event = result.value

        // Tee every event to the audit log (structured, redacted, rotated).
        this.auditWriter.write(event)

        // Persist persistable messages
        const msg = getEventMessage(event)
        if (msg) {
          await appendMessage(this.session.dir, msg)
        }

        yield event
        result = await gen.next()
      }

      // Update internal state
      const terminal: Terminal = result.value
      this._messages = [...terminal.messages]
      this._turnCount++

      return terminal
    } finally {
      this._running = false
      this.currentAbort = null
    }
  }

  /** Abort the currently running submission. No-op if nothing is running. */
  abort(): void {
    this.currentAbort?.abort()
  }
}
