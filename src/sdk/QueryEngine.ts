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
import type { ReadFileState, NotifyEvent } from '../core/tools/context.js'
import { makeWebBackendResolvedEvent } from '../core/queryEventFactories.js'
import {
  createAuthorizeToolUseFn,
  createExecuteToolUseFn,
} from '../core/tools/toolExecution.js'
import { createAuditWriter } from '../audit/auditLog.js'
import { readSettingsConfig } from '../config/settingsConfig.js'
import {
  validateAndNormalizeRules,
  compileWebPolicy,
  dedupeRules,
} from '../web/rulesSeed.js'
import type { AuditWriter } from '../audit/types.js'
import { createMemoryTools } from '../tools/MemoryTools.js'
import { readSkill } from '../skills/store.js'
import {
  filterToolDefs,
  makeActiveSkill,
  scanForActivation,
  summarizeMatches,
  type ActiveSkill,
} from '../skills/router.js'
import {
  makeSkillActivatedEvent,
  makeSkillDeactivatedEvent,
} from '../core/queryEventFactories.js'
import type { SecretMatch } from '../memory/secretScanner.js'
import { resolveModel } from '../core/providers/registry.js'
import type { ProviderId, CapabilitySheet } from '../core/providers/types.js'
import { MissingApiKeyError } from '../core/providers/types.js'
import { createMcpManager } from '../core/mcp/index.js'
import type {
  McpManager,
  SpawnTransportFn,
  McpConfig,
  McpReloadResult,
  McpRegisteredToolInfo,
} from '../core/mcp/index.js'
import { loadMcpConfig } from '../core/mcp/config.js'
import { normalizeThinkingBudget } from '../core/providers/thinkingNormalize.js'
import type {
  CallModelFn,
  RunPreToolUseHooksFn,
  RunPostToolUseHooksFn,
} from '../core/queryDeps.js'
import type { HookConfig } from '../hooks/types.js'
import { loadHooks } from '../hooks/loadHooks.js'
import { runPreToolUseHooks } from '../hooks/runPreToolUseHooks.js'
import { runPostToolUseHooks } from '../hooks/runPostToolUseHooks.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  /**
   * Phase 2b hook config. Tests pass this directly to avoid disk I/O; production
   * leaves it unset and the engine lazy-loads from `~/.ultron/hooks.json` (or
   * `hookConfigPath`) on first `submitPrompt`.
   */
  readonly hookConfig?: HookConfig
  /**
   * Override the default hook config path (`~/.ultron/hooks.json`). Mostly for
   * tests that want to point at a tmp file.
   */
  readonly hookConfigPath?: string
  /**
   * Phase 3a MCP config. Tests pass this directly; production leaves it unset
   * and the engine lazy-loads from `~/.ultron/mcp.json` (or `mcpConfigPath`)
   * on first `submitPrompt`.
   */
  readonly mcpConfig?: McpConfig
  /** Override the default MCP config path (`~/.ultron/mcp.json`). */
  readonly mcpConfigPath?: string
  /** Short-circuit: skip MCP bootstrap entirely. */
  readonly disableMcp?: boolean
  /** Test seam: inject a pre-built MCP manager. */
  readonly mcpManager?: McpManager
  /** Test seam: inject a custom stdio-transport factory. */
  readonly mcpSpawnTransport?: SpawnTransportFn
  /** Test-only: override assembled deps. Not part of the public SDK surface. */
  readonly deps?: Partial<QueryDeps>
  /**
   * Phase 4b: override the default `~/.ultron` base dir that memory tools
   * read and write to. Tests pass a tmp dir; production leaves unset.
   */
  readonly memoryBaseDir?: string
  /**
   * Phase 4b: skip registering MemoryRead / MemoryWrite / MemoryEdit into
   * the engine's tool registry. When true the model cannot see the memory
   * surface at all. Default false (memory tools are on by default).
   */
  readonly disableMemory?: boolean
  /**
   * Phase 6b: subscriber for cross-cutting tool notifications (today only
   * `web_backend_resolved`). The engine wraps this with audit-write +
   * dedup. The CLI provides a handler that renders one-time notices to
   * stderr. Tests usually omit this (silent).
   */
  readonly onNotify?: (event: NotifyEvent) => void
}

export type SubmitPromptOptions = {
  readonly thinkingBudget?: number
  readonly interleavedThinking?: boolean
}

/**
 * Phase 5b: options for `activateSkill`. `turns` defaults to 1; `args` is
 * an optional freeform string surfaced to the model inside `<skill-args>`.
 */
export type ActivateSkillOpts = {
  readonly turns?: number
  readonly args?: string
}

/**
 * Phase 5b: hook invoked when activation hits a low-confidence secret match.
 * Return `true` to proceed, `false` to refuse. High-confidence matches refuse
 * unconditionally and never invoke the handler.
 */
export type SkillScanHandler = (
  matches: readonly SecretMatch[],
) => Promise<boolean>

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
  private readonly _auditWriter: AuditWriter
  private readonly _memoryBaseDir: string | null
  private hookConfig: HookConfig | null
  private session: SessionInfo
  private readonly mcpManager: McpManager
  private _mcpInitPromise: Promise<void> | null = null
  private _callModelRebuilt = false
  private _disposed = false

  // --- Skill activation (Phase 5b) ---
  private _activeSkill: ActiveSkill | null = null
  private _remainingTurns = 0
  private _activeCallModel: CallModelFn | null = null

  // --- Per-submission ---
  private currentAbort: AbortController | null = null
  private _running = false
  private _messages: Message[] = []
  private _turnCount = 0
  private _needsResume: boolean
  private _resumed = false

  constructor(config: QueryEngineConfig) {
    this.config = config

    // Phase 4b: audit writer is built first so memory tools can capture it
    // in their closures before the registry is frozen into `toolDefs`.
    this._auditWriter = config.auditWriter ?? createAuditWriter()

    // Long-lived deps
    this.toolRegistry = createDefaultRegistry()
    if (!config.disableMemory) {
      this._memoryBaseDir =
        config.memoryBaseDir ?? join(homedir(), '.ultron')
      const memoryTools = createMemoryTools({
        baseDir: this._memoryBaseDir,
        auditWriter: this._auditWriter,
      })
      this.toolRegistry.register(memoryTools.read)
      this.toolRegistry.register(memoryTools.write)
      this.toolRegistry.register(memoryTools.edit)
    } else {
      this._memoryBaseDir = null
    }
    const toolDefs = getToolDefinitions(this.toolRegistry)

    this._model = config.model
    this.callModel = this.resolveCallModel(config.model, toolDefs)
    this.compactCallModel = config.compactModel
      ? this.resolveCallModel(config.compactModel, toolDefs)
      : this.callModel
    // Phase 6b: seed permissionRules from ~/.ultron/settings.json. Validation
    // is permissive — invalid entries warn to stderr and are skipped, never
    // throw. Tests can shadow the settings path via __setSettingsPathForTest.
    const settings = readSettingsConfig()
    const seededRules = validateAndNormalizeRules(settings.permissionRules ?? [])
    const seededFromPolicy = compileWebPolicy(settings.webPolicy)
    const seeded = dedupeRules([...seededRules, ...seededFromPolicy])

    const initialState: AppState = {
      ...getDefaultAppState(),
      permissionMode: config.permissionMode ?? 'default',
      workingDirectories: [config.cwd],
      ...(seeded.length > 0 && { permissionRules: seeded }),
    }
    this.appState = createStore(initialState)
    this.readFileState = new Map()

    const headless = config.headless ?? false
    this.permissionOpts = {
      headless,
      safetyChecks: [...filesystemSafetyChecks],
      askUser: headless ? undefined : config.askUser,
    }
    // Hook config is lazily loaded on first submitPrompt. An explicitly-provided
    // hookConfig short-circuits the lazy-load path (tests, SDK embedders).
    this.hookConfig = config.hookConfig ?? null

    this.mcpManager =
      config.mcpManager ??
      createMcpManager(
        config.mcpSpawnTransport ? { spawnTransport: config.mcpSpawnTransport } : undefined,
      )

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
   * Phase 4c: resolved memory base dir (same instance the memory tools use),
   * or `null` when `config.disableMemory` is true. The `/memory` slash command
   * reads this so it shares one source of truth for the on-disk location.
   */
  get memoryBaseDir(): string | null {
    return this._memoryBaseDir
  }

  /**
   * Phase 4c: the audit writer the engine tees events to. Exposed so the
   * `/memory` slash command can call `writeEntry` / `deleteEntry` with the
   * same writer the memory tools capture, keeping all audit rows in one file.
   */
  get auditWriter(): AuditWriter {
    return this._auditWriter
  }

  /**
   * Phase 6b: the AppState store. Exposed so the `/web` slash command can
   * read/mutate `permissionRules` directly without re-implementing the
   * `allow_by_rule` plumbing.
   */
  get appStateStore(): ReturnType<typeof createStore<ReturnType<typeof getDefaultAppState>>> {
    return this.appState
  }

  /** Phase 5b: the currently-active skill snapshot, or `null`. */
  get activeSkill(): ActiveSkill | null {
    return this._activeSkill
  }

  /** Phase 5b: convenience — true while an activation window is open. */
  get isSkillActive(): boolean {
    return this._activeSkill !== null
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
  /**
   * Phase 6b: notify-event sink. Tool implementations call
   * `context.notify(event)`; the engine writes the corresponding QueryEvent
   * to the audit spine on every emission, then forwards to the optional
   * config.onNotify subscriber. Dedup (e.g. once-per-session UI) lives in
   * the subscriber. Any subscriber error is swallowed — notify never throws
   * out of a tool.
   *
   * Public so `/web search` (slash command path) routes through the same
   * audit + dedup pipeline as model-invoked WebSearch.
   */
  emitNotify(event: NotifyEvent): void {
    if (event.type === 'web_backend_resolved') {
      this._auditWriter.write(
        makeWebBackendResolvedEvent({ backend: event.backend, source: event.source }),
      )
    }
    try {
      this.config.onNotify?.(event)
    } catch {
      // never throw out of tool execution
    }
  }

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

    // Phase 5b: keep the activation-filtered call model in sync with the
    // newly-selected model.
    this.refreshActiveCallModel()
  }

  private rebuildCallModels(): void {
    const toolDefs = getToolDefinitions(this.toolRegistry)
    this.callModel = this.resolveCallModel(this._model, toolDefs)
    if (!this.config.compactModel) {
      this.compactCallModel = this.callModel
    }
    // Phase 5b: same refresh for the activation-filtered call model.
    this.refreshActiveCallModel()
  }

  /**
   * Phase 5b: rebuild `_activeCallModel` against the current model + tool
   * registry when a skill is active with a `allowedTools` list. Called from
   * `setModel`, `rebuildCallModels`, and the MCP first-bootstrap rebuild
   * path so all three sites stay in sync.
   */
  private refreshActiveCallModel(): void {
    if (this._activeSkill?.allowedTools !== undefined) {
      const fullDefs = getToolDefinitions(this.toolRegistry)
      const filtered = filterToolDefs(fullDefs, this._activeSkill.allowedTools)
      this._activeCallModel = this.resolveCallModel(this._model, filtered)
    }
  }

  /**
   * Phase 5b: activate a skill for `opts.turns` (default 1) turns. Reads the
   * skill from disk, runs the activation-time secret re-scan, captures an
   * immutable `ActiveSkill` snapshot, and (if `allowedTools` is set on the
   * skill) builds a filtered `_activeCallModel` so the model genuinely sees
   * a narrowed tool set. Throws if a submission is in progress, if a skill
   * is already active, or if the skill is missing.
   *
   * @param scanHandler optional callback invoked on a low-confidence secret
   *   match. Return `true` to proceed; `false` to refuse. Without a handler,
   *   any match (high or low) refuses. High-confidence matches refuse
   *   unconditionally and never invoke the handler.
   */
  async activateSkill(
    id: string,
    opts: ActivateSkillOpts = {},
    scanHandler?: SkillScanHandler,
  ): Promise<void> {
    if (this._disposed) {
      throw new Error('QueryEngine has been disposed')
    }
    if (this._running) {
      throw new Error('Cannot activate skill while a submission is in progress')
    }
    if (this._activeSkill !== null) {
      throw new Error(
        `Skill "${this._activeSkill.id}" is already active; deactivate first`,
      )
    }
    if (this._memoryBaseDir === null) {
      throw new Error('Skills are disabled (disableMemory: true)')
    }

    const skill = await readSkill(this._memoryBaseDir, id)
    if (skill === null) {
      throw new Error(`Skill "${id}" not found`)
    }

    const scan = scanForActivation(skill)
    if (!scan.ok) {
      if (scan.kind === 'high') {
        this.recordRefusedActivation(skill.id, skill.name)
        throw new Error(
          `activation refused: high-confidence credentials in body (${summarizeMatches(scan.matches)})`,
        )
      }
      // low-confidence
      if (!scanHandler) {
        this.recordRefusedActivation(skill.id, skill.name)
        throw new Error(
          `activation refused: credential-like patterns in body (${summarizeMatches(scan.matches)})`,
        )
      }
      let proceed: boolean
      try {
        proceed = await scanHandler(scan.matches)
      } catch (err) {
        this.recordRefusedActivation(skill.id, skill.name)
        throw err
      }
      if (!proceed) {
        this.recordRefusedActivation(skill.id, skill.name)
        throw new Error('activation refused by user')
      }
    }

    const args = opts.args ?? ''
    const turns = opts.turns ?? 1
    if (!Number.isInteger(turns) || turns < 1) {
      throw new Error('turns must be a positive integer')
    }

    const active = makeActiveSkill(skill, args)
    this._activeSkill = active
    this._remainingTurns = turns

    if (active.allowedTools !== undefined) {
      const fullDefs = getToolDefinitions(this.toolRegistry)
      const filtered = filterToolDefs(fullDefs, active.allowedTools)
      this._activeCallModel = this.resolveCallModel(this._model, filtered)
    } else {
      this._activeCallModel = null
    }

    this._auditWriter.write(
      makeSkillActivatedEvent({
        id: active.id,
        name: active.name,
        turns,
        hasAllowedTools: active.allowedTools !== undefined,
        hasArgs: args.length > 0,
      }),
    )
  }

  /**
   * Phase 5b: deactivate the active skill. The `'secret_refused'` reason is
   * NOT accepted here — it is reserved for the pre-activation refusal path
   * and is emitted by `recordRefusedActivation`, which never touches active
   * state. No-op when no skill is active.
   *
   * Throws if a submission is in progress. Mid-submission state has already
   * captured `systemPromptParts` and `turnPermissionOpts`; clearing
   * `_activeSkill` underneath the running turn would desync the in-flight
   * cascade from engine state. The `submitPrompt` epilogue is the only path
   * that may deactivate during a submission, and it does so as the very last
   * step after the terminal is computed (so this guard does not block it,
   * since `_running` is already cleared by the `finally` by the time the
   * epilogue's `deactivateSkill` call lands — but that call goes through the
   * same path; see the epilogue's structure).
   *
   * IMPORTANT: the epilogue calls `deactivateSkill` BEFORE `finally` clears
   * `_running`. To avoid a self-block, the epilogue calls go through a
   * private bypass; see `_epilogueDeactivate`.
   */
  deactivateSkill(
    reason: 'turns_exhausted' | 'user_deactivated' | 'error',
  ): void {
    if (this._disposed) {
      throw new Error('QueryEngine has been disposed')
    }
    if (this._running) {
      throw new Error(
        'Cannot deactivate skill while a submission is in progress',
      )
    }
    this._epilogueDeactivate(reason)
  }

  /**
   * Internal deactivation path — used by `deactivateSkill` (after guards) and
   * by `submitPrompt`'s epilogue (which runs while `_running` is still true
   * but the in-flight turn's state has already been finalized).
   */
  private _epilogueDeactivate(
    reason: 'turns_exhausted' | 'user_deactivated' | 'error',
  ): void {
    if (this._activeSkill === null) return
    const { id, name } = this._activeSkill
    this._activeSkill = null
    this._remainingTurns = 0
    this._activeCallModel = null
    this._auditWriter.write(
      makeSkillDeactivatedEvent({ id, name, reason }),
    )
  }

  /**
   * Phase 5b: emit `skill_deactivated { reason: 'secret_refused' }` without
   * flipping any active state. Used during activation refusals (high-confidence
   * detection or user-declined low-confidence) where no active state was
   * ever set.
   */
  private recordRefusedActivation(id: string, name: string): void {
    this._auditWriter.write(
      makeSkillDeactivatedEvent({ id, name, reason: 'secret_refused' }),
    )
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
    if (this._disposed) {
      throw new Error('QueryEngine has been disposed')
    }
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

      // Lazy-load hooks config on first submit. Missing file → empty config.
      // Malformed JSON / schema error throws here so the user sees it.
      if (this.hookConfig === null) {
        const path = this.config.hookConfigPath ?? join(homedir(), '.ultron', 'hooks.json')
        this.hookConfig = await loadHooks(path)
      }

      // Lazy-bootstrap MCP on first submit. Mirrors the hookConfig cache shape.
      // Individual server failures are absorbed; malformed mcp.json rejects
      // with McpConfigError.
      if (!this._mcpInitPromise && !this.config.disableMcp) {
        this._mcpInitPromise = this.bootstrapMcp()
      }
      if (this._mcpInitPromise) {
        await this._mcpInitPromise
      }

      // If MCP registered any tools, rebuild callModel once so the model
      // actually sees them in its tools parameter. See design doc §Critical
      // invariant 2 — tool defs are baked into callModel at construction.
      if (!this._callModelRebuilt && this.hasMcpTools()) {
        this.rebuildCallModels()
        this._callModelRebuilt = true
      }

      // System prompt — pass _memoryBaseDir so 4d's memory injection runs
      // when memory is enabled. Pass _activeSkill so 5b's skill injection
      // appends a single 'org' part during an activation window. Both
      // injection steps no-op when their input is null/disabled.
      const systemPromptParts = await buildFullSystemPromptParts(this.config.cwd, {
        memoryBaseDir: this._memoryBaseDir,
        activeSkill: this._activeSkill,
      })

      // Phase 5b: when a skill with allowedTools is active, the cascade
      // narrows the tool set for THIS turn (defense-in-depth alongside the
      // send-side `_activeCallModel`). User explicit deny rules still win.
      const turnPermissionOpts: PermissionOptions = this._activeSkill?.allowedTools
        ? {
            ...this.permissionOpts,
            scopedToolAllowlist: this._activeSkill.allowedTools,
          }
        : this.permissionOpts

      // Phase 5b: when a skill with allowedTools is active, route the main
      // loop and subagent forks through the filtered call model so the
      // model genuinely sees a narrowed tool list. compactCallModel stays
      // unfiltered (compaction emits text only).
      const turnCallModel = this._activeCallModel ?? this.callModel

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

      // Phase 2b — hook runners bound to the current session/cwd and the
      // loaded HookConfig. Same runners used for the main loop AND any
      // subagent forks — one config, applied uniformly.
      const hookConfig = this.hookConfig
      const hookContext = {
        sessionId: this.sessionId,
        cwd: this.config.cwd,
        hookConfig,
      }
      const runPreHooks: RunPreToolUseHooksFn = (toolUse, signal) =>
        runPreToolUseHooks(toolUse, hookContext, signal)
      const runPostHooks: RunPostToolUseHooksFn = (toolUse, result, signal) =>
        runPostToolUseHooks(toolUse, result, hookContext, signal)

      // Per-submission subagent fork function
      const forkSubagent = createForkSubagent({
        callModel: turnCallModel,
        compactCallModel: this.compactCallModel,
        parentToolRegistry: this.toolRegistry,
        parentAppState: this.appState,
        parentSystemPromptParts: systemPromptParts,
        parentSignal: this.currentAbort.signal,
        cwd: this.config.cwd,
        sessionDir: this.session.dir,
        permissionOpts: turnPermissionOpts,
        auditWriter: this._auditWriter,
        runPreToolUseHooks: runPreHooks,
        runPostToolUseHooks: runPostHooks,
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
        notify: (event) => this.emitNotify(event),
      })
      const authorizeToolUse = createAuthorizeToolUseFn(toolUseContext, turnPermissionOpts)
      const executeToolUse = createExecuteToolUseFn(toolUseContext)

      // Assemble deps
      const deps: Partial<QueryDeps> = {
        callModel: turnCallModel,
        authorizeToolUse,
        executeToolUse,
        runPreToolUseHooks: runPreHooks,
        runPostToolUseHooks: runPostHooks,
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
        this._auditWriter.write(event)

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

      // Phase 5b: maintain the activation window. `error` deactivates
      // immediately; successful turns decrement the counter and deactivate
      // when it reaches zero. `aborted` and `max_turns` do NOT auto-deactivate
      // — the user may want to retry within the same window.
      if (this._activeSkill !== null) {
        if (terminal.reason === 'error') {
          this._epilogueDeactivate('error')
        } else if (terminal.reason === 'end_turn') {
          this._remainingTurns--
          if (this._remainingTurns <= 0) {
            this._epilogueDeactivate('turns_exhausted')
          }
        }
      }

      return terminal
    } catch (err) {
      // Phase 5b: pre-query / mid-stream throws (resumeSession, loadHooks,
      // bootstrapMcp, buildFullSystemPromptParts, getInitialAttachments,
      // appendMessage, normalizeMessages, etc.) bypass the terminal-based
      // epilogue above. Per design ("error during the active turn → deactivate"),
      // these still close the activation window — UNLESS the error is the
      // user pressing abort, which the design explicitly preserves.
      if (
        this._activeSkill !== null &&
        !(this.currentAbort?.signal.aborted ?? false)
      ) {
        this._epilogueDeactivate('error')
      }
      throw err
    } finally {
      this._running = false
      this.currentAbort = null
    }
  }

  /** Abort the currently running submission. No-op if nothing is running. */
  abort(): void {
    this.currentAbort?.abort()
  }

  /**
   * Optional pre-warm: eagerly bootstrap MCP so failures surface before the
   * first `submitPrompt`. Idempotent. Safe to skip — `submitPrompt` auto-inits.
   */
  async init(): Promise<void> {
    if (this._disposed) {
      throw new Error('QueryEngine has been disposed')
    }
    if (!this._mcpInitPromise && !this.config.disableMcp) {
      this._mcpInitPromise = this.bootstrapMcp()
    }
    if (this._mcpInitPromise) {
      await this._mcpInitPromise
    }
  }

  /**
   * Terminal dispose — shuts down MCP subprocesses. After dispose, subsequent
   * `submitPrompt` calls reject. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this._disposed) return
    this._disposed = true
    await this.mcpManager.shutdown()
  }

  /**
   * Expose the tool registry for integration tests that need to assert on
   * registered tools after MCP bootstrap. Not part of the public SDK.
   */
  getRegistry(): ReturnType<typeof createDefaultRegistry> {
    return this.toolRegistry
  }

  /** Expose MCP manager status for diagnostics and tests. */
  getMcpStatus(): ReturnType<McpManager['status']> {
    return this.mcpManager.status()
  }

  /** Reload MCP config and rebuild provider tool definitions if tools changed. */
  async reloadMcp(): Promise<McpReloadResult> {
    if (this._disposed) {
      throw new Error('QueryEngine has been disposed')
    }
    if (this._running) {
      throw new Error('Cannot reload MCP while a submission is in progress')
    }
    if (this.config.disableMcp) {
      return {
        connected: [],
        failed: [],
        removed: [],
        disabled: [],
        unchanged: [],
        backoff: [],
        toolDefinitionsChanged: false,
      }
    }

    const config = await this.loadMcpConfig()
    const result = await this.mcpManager.reload({
      config,
      registry: this.toolRegistry,
      signal: new AbortController().signal,
    })
    this._mcpInitPromise = Promise.resolve()

    if (result.toolDefinitionsChanged) {
      this.rebuildCallModels()
      this._callModelRebuilt = this.hasMcpTools()
    }

    return result
  }

  /** Expose registered MCP tool metadata for CLI diagnostics. */
  listMcpTools(serverName?: string): readonly McpRegisteredToolInfo[] {
    return this.mcpManager.listTools(serverName)
  }

  private async bootstrapMcp(): Promise<void> {
    const config = await this.loadMcpConfig()
    // Failures are absorbed into result.failed; we don't re-throw here.
    await this.mcpManager.bootstrap({
      config,
      registry: this.toolRegistry,
      signal: new AbortController().signal,
    })
  }

  private async loadMcpConfig(): Promise<McpConfig> {
    return (
      this.config.mcpConfig ??
      (await loadMcpConfig(
        this.config.mcpConfigPath ?? join(homedir(), '.ultron', 'mcp.json'),
      ))
    )
  }

  private hasMcpTools(): boolean {
    for (const tool of this.toolRegistry.getAll()) {
      if (tool.source === 'mcp') return true
    }
    return false
  }
}
