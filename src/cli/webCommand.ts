/**
 * Phase 6b: `/web` slash command.
 *
 * Imperative surface for inspecting and editing web policy + running ad-hoc
 * searches from the prompt. Mirrors `memoryCommand.ts` dispatch.
 *
 * Subcommands:
 *   /web                      — print backend + active rules
 *   /web search <query>       — run a search; uses the same code path as
 *                                model-invoked WebSearchTool
 *   /web list                 — alias for bare /web
 *   /web allow <host> [--persist]  — add WebFetch domain allow rule
 *   /web deny  <host> [--persist]  — add WebFetch domain deny rule
 *   /web remove <host>        — remove rules matching <host> (session+disk)
 *   /web rules                — print all current domain-scoped rules
 *   /web setup                — interactive backend chooser
 *   /web help                 — usage
 *
 * Domain rules created via /web apply to **WebFetch**, not WebSearch:
 * WebSearch.getDomain returns undefined, so a domain-scoped rule on
 * WebSearch could never match. Per-result host gating happens when the
 * model later calls WebFetch on a result link.
 */

import type { Store, AppState } from '../core/state.js'
import type { AuditWriter } from '../audit/types.js'
import type { PermissionRule } from '../core/permissions/types.js'
import type { NotifyEvent } from '../core/tools/context.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { isValidDomainPattern } from '../web/domainPolicy.js'
import {
  readSettingsConfig,
  writeSettingsConfig,
} from '../config/settingsConfig.js'
import { resolveSearchBackend } from '../web/searchBackend.js'
import { confirmYesNo as defaultConfirmYesNo } from './confirmPrompt.js'
import { promptText as defaultPromptText } from './promptText.js'
import { WebSearchTool } from '../tools/WebSearchTool.js'
import {
  makeWebBackendResolvedEvent,
} from '../core/queryEventFactories.js'

// ---------------------------------------------------------------------------
// Engine-facing surface — structural type so tests can hand in a fake.
// ---------------------------------------------------------------------------

export type WebEngine = {
  readonly appState: Store<AppState>
  readonly auditWriter: AuditWriter
  /**
   * Shared notify pipeline so `/web search` flows through the same audit +
   * dedup path as model-invoked WebSearch. When omitted (older test fakes),
   * `searchCmd` falls back to writing its own audit row. Real engines from
   * `QueryEngine` always provide this.
   */
  readonly emitNotify?: (event: NotifyEvent) => void
}

export type WebCommandIo = {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly confirmYesNo?: typeof defaultConfirmYesNo
  readonly promptText?: typeof defaultPromptText
}

type SubCtx = {
  readonly engine: WebEngine
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly confirmYesNo: typeof defaultConfirmYesNo
  readonly promptText: typeof defaultPromptText
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleWebCommand(
  input: string,
  engine: WebEngine,
  io: WebCommandIo,
): Promise<void> {
  const trimmed = input.trim()
  const rest = trimmed === '/web' ? '' : trimmed.slice('/web '.length)
  const tokens = rest.trim().length === 0 ? [] : rest.trim().split(/\s+/)
  const subcommand = tokens[0] ?? ''
  const args = tokens.slice(1)

  const ctx: SubCtx = {
    engine,
    stdout: io.stdout,
    stderr: io.stderr,
    confirmYesNo: io.confirmYesNo ?? defaultConfirmYesNo,
    promptText: io.promptText ?? defaultPromptText,
  }

  try {
    switch (subcommand) {
      case '':
      case 'list':
        showStatus(ctx)
        return
      case 'search':
        await searchCmd(ctx, rest)
        return
      case 'allow':
        await ruleCmd(ctx, 'allow', args)
        return
      case 'deny':
        await ruleCmd(ctx, 'deny', args)
        return
      case 'remove':
        removeCmd(ctx, args)
        return
      case 'rules':
        rulesCmd(ctx)
        return
      case 'setup':
        await setupCmd(ctx)
        return
      case 'help':
        writeHelp(ctx)
        return
      default:
        ctx.stderr.write(`[web] unknown subcommand "${subcommand}"\n`)
        writeHelp(ctx)
        return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`[web] ${msg}\n`)
  }
}

// ---------------------------------------------------------------------------
// /web — status (backend + rule summary)
// ---------------------------------------------------------------------------

function showStatus(ctx: SubCtx): void {
  const { backend, source } = resolveSearchBackend()
  ctx.stdout.write(`Backend: ${backend.id} (${source})\n`)

  const rules = ctx.engine.appState.getState().permissionRules
  const webRules = rules.filter(
    (r) => (r.toolName === 'WebFetch' || r.toolName === 'WebSearch') && r.domain !== undefined,
  )
  if (webRules.length === 0) {
    ctx.stdout.write('No domain rules.\n')
    return
  }
  ctx.stdout.write(`Domain rules (${webRules.length}):\n`)
  for (const r of webRules) {
    ctx.stdout.write(`  ${r.behavior.padEnd(5)} ${r.toolName} ${r.domain} [${r.source}]\n`)
  }
}

// ---------------------------------------------------------------------------
// /web search <query>
// ---------------------------------------------------------------------------

async function searchCmd(ctx: SubCtx, restAfterSlashWeb: string): Promise<void> {
  // Strip the leading "search " token; preserve the rest as the raw query
  // so the user can include spaces, quotes, etc.
  const query = restAfterSlashWeb.slice('search'.length).trim()
  if (query === '') {
    ctx.stderr.write('[web] usage: /web search <query>\n')
    return
  }

  // Route through WebSearchTool so:
  //   - validateInput catches oversized / bogus queries (parity w/ model path)
  //   - the notify channel fires (first-time DuckDuckGo notice + audit)
  //   - the formatter is the same one the model sees
  // NOTE: We deliberately do NOT run the permission cascade — `/web search`
  // is a trusted user command (analogous to typing in the prompt), like
  // `/memory new` and `/skill activate`. A user-typed deny on `WebSearch`
  // does not gate slash-command use of the tool.
  const ac = new AbortController()
  const registry = createToolRegistry()
  registry.register(WebSearchTool)
  const notify = ctx.engine.emitNotify ?? ((event: NotifyEvent) => {
    // Fallback for engine fakes that don't provide a shared notify: still
    // record the audit row so the slash path leaves a trail.
    if (event.type === 'web_backend_resolved') {
      ctx.engine.auditWriter.write(
        makeWebBackendResolvedEvent({ backend: event.backend, source: event.source }),
      )
    }
  })
  const toolCtx = createToolUseContext({
    appState: ctx.engine.appState,
    abortController: ac,
    messages: [],
    toolRegistry: registry,
    notify,
  })

  const validation = await WebSearchTool.validateInput({ query }, toolCtx)
  if (!validation.valid) {
    ctx.stderr.write(`[web] ${validation.message}\n`)
    return
  }

  const result = await WebSearchTool.call({ query }, toolCtx, ac.signal)
  if (result.isError) {
    ctx.stderr.write(`[web] search failed: ${result.content}\n`)
    return
  }
  ctx.stdout.write(result.content + '\n')
}

// ---------------------------------------------------------------------------
// /web allow|deny <host> [--persist]
// ---------------------------------------------------------------------------

async function ruleCmd(
  ctx: SubCtx,
  behavior: 'allow' | 'deny',
  args: readonly string[],
): Promise<void> {
  const host = args[0]
  if (host === undefined || host === '') {
    ctx.stderr.write(`[web] usage: /web ${behavior} <host> [--persist]\n`)
    return
  }
  const lowered = host.toLowerCase()
  if (!isValidDomainPattern(lowered)) {
    ctx.stderr.write(
      `[web] invalid host pattern "${host}" — must be exact host or *.suffix\n`,
    )
    return
  }
  const persist = args.includes('--persist')

  const rule: PermissionRule = {
    toolName: 'WebFetch',
    behavior,
    domain: lowered,
    source: persist ? 'userSettings' : 'session',
  }

  // Replace any existing rule on the same (toolName, domain) regardless of
  // its behavior — otherwise `/web allow X` after `/web deny X` would leave
  // both rules and the cascade's deny-first ordering would make the new
  // allow inert. De-dup-on-same-triple is also covered by this filter.
  const samePair = (r: PermissionRule) =>
    r.toolName === rule.toolName && r.domain === rule.domain
  const current = ctx.engine.appState.getState().permissionRules
  const next = [...current.filter((r) => !samePair(r)), rule]
  ctx.engine.appState.setState({ permissionRules: next })

  if (persist) {
    const settings = readSettingsConfig()
    const existing = settings.permissionRules ?? []
    const persistedNext = [...existing.filter((r) => !samePair(r)), rule]
    // Also strip the host from any matching webPolicy entry so the
    // boot-time compileWebPolicy pass doesn't resurrect the overridden
    // behavior. e.g. `/web allow github.com --persist` after the user
    // had `webPolicy.denylist: ['github.com']` should win, not lose.
    const cleanedPolicy = stripHostFromPolicy(settings.webPolicy, lowered)
    writeSettingsConfig({
      permissionRules: persistedNext,
      ...(cleanedPolicy !== undefined && { webPolicy: cleanedPolicy }),
    })
  }

  ctx.stdout.write(
    `${behavior === 'allow' ? '✓' : '✗'} ${behavior} WebFetch on ${lowered}` +
      (persist ? ' (persisted)' : ' (session)') +
      '\n',
  )
}

// ---------------------------------------------------------------------------
// /web remove <host>
// ---------------------------------------------------------------------------

function removeCmd(ctx: SubCtx, args: readonly string[]): void {
  const host = args[0]
  if (host === undefined || host === '') {
    ctx.stderr.write('[web] usage: /web remove <host>\n')
    return
  }
  const lowered = host.toLowerCase()

  const current = ctx.engine.appState.getState().permissionRules
  const next = current.filter((r) => r.domain !== lowered)
  const removedSession = current.length - next.length
  ctx.engine.appState.setState({ permissionRules: next })

  // Strip from BOTH settings.permissionRules AND settings.webPolicy. If we
  // only updated permissionRules, a host originally added via
  // webPolicy.allowlist/denylist would be re-seeded from webPolicy on the
  // next engine boot — making `/web remove` ineffective for that case.
  const settings = readSettingsConfig()
  const persisted = settings.permissionRules ?? []
  const persistedNext = persisted.filter((r) => r.domain !== lowered)
  const removedRules = persisted.length - persistedNext.length

  const cleanedPolicy = stripHostFromPolicy(settings.webPolicy, lowered)
  const beforePolicyCount = countPolicyEntries(settings.webPolicy)
  const afterPolicyCount = countPolicyEntries(cleanedPolicy)
  const removedPolicy = beforePolicyCount - afterPolicyCount

  if (removedRules > 0 || removedPolicy > 0) {
    writeSettingsConfig({
      permissionRules: persistedNext,
      ...(cleanedPolicy !== undefined && { webPolicy: cleanedPolicy }),
    })
  }

  ctx.stdout.write(
    `Removed ${removedSession} session rule(s), ${removedRules} persisted rule(s), ${removedPolicy} policy entrie(s) for "${lowered}".\n`,
  )
}

// Helpers for webPolicy mutation
// ---------------------------------------------------------------------------

function stripHostFromPolicy(
  policy: { allowlist?: string[]; denylist?: string[] } | undefined,
  loweredHost: string,
): { allowlist?: string[]; denylist?: string[] } | undefined {
  if (!policy) return undefined
  const allow = policy.allowlist?.filter((h) => h.toLowerCase() !== loweredHost) ?? []
  const deny = policy.denylist?.filter((h) => h.toLowerCase() !== loweredHost) ?? []
  return {
    ...(policy.allowlist !== undefined && { allowlist: allow }),
    ...(policy.denylist !== undefined && { denylist: deny }),
  }
}

function countPolicyEntries(
  policy: { allowlist?: string[]; denylist?: string[] } | undefined,
): number {
  if (!policy) return 0
  return (policy.allowlist?.length ?? 0) + (policy.denylist?.length ?? 0)
}

// ---------------------------------------------------------------------------
// /web rules
// ---------------------------------------------------------------------------

function rulesCmd(ctx: SubCtx): void {
  const rules = ctx.engine.appState.getState().permissionRules
  const domainRules = rules.filter((r) => r.domain !== undefined)
  if (domainRules.length === 0) {
    ctx.stdout.write('No domain rules.\n')
    return
  }
  ctx.stdout.write(`tool         behavior  domain                          source\n`)
  ctx.stdout.write(`-----------  --------  ------------------------------  ------------\n`)
  for (const r of domainRules) {
    ctx.stdout.write(
      `${r.toolName.padEnd(11)}  ${r.behavior.padEnd(8)}  ${(r.domain ?? '').padEnd(30)}  ${r.source}\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// /web setup — interactive backend chooser
// ---------------------------------------------------------------------------

async function setupCmd(ctx: SubCtx): Promise<void> {
  const { backend } = resolveSearchBackend()
  ctx.stdout.write('Web search backend selection:\n')
  ctx.stdout.write(`  [1] DuckDuckGo (no key, default)${backend.id === 'duckduckgo' ? '        ← currently active' : ''}\n`)
  ctx.stdout.write(`  [2] Brave  (recommended: 'export BRAVE_SEARCH_API_KEY=...' in your shell)\n`)
  ctx.stdout.write(`  [3] Tavily (recommended: 'export TAVILY_API_KEY=...' in your shell)\n`)

  const choice = (await ctx.promptText('Choice [1-3, default 1]: ')).trim()
  if (choice === '' || choice === '1') {
    ctx.stdout.write('Keeping DuckDuckGo. Nothing to configure.\n')
    return
  }
  if (choice !== '2' && choice !== '3') {
    ctx.stderr.write(`[web] invalid choice "${choice}"\n`)
    return
  }

  const which: 'brave' | 'tavily' = choice === '2' ? 'brave' : 'tavily'
  const envName = which === 'brave' ? 'BRAVE_SEARCH_API_KEY' : 'TAVILY_API_KEY'

  ctx.stdout.write('\nRecommended: paste this into your shell rc file and restart:\n')
  ctx.stdout.write(`  export ${envName}="..."\n\n`)

  const persistAns = await ctx.confirmYesNo(
    'Or persist to ~/.ultron/settings.json (plaintext at rest, mode 0600)?\n' +
      'This is convenient but less safe than an env var.',
    { defaultNo: true },
  )
  if (!persistAns) {
    ctx.stdout.write('Skipped persistence. Set the env var to use this backend.\n')
    return
  }

  const key = (await ctx.promptText(`Paste ${envName} (input hidden): `, { mask: true })).trim()
  if (key === '') {
    ctx.stderr.write('[web] empty key, aborting.\n')
    return
  }

  const apiKeys = which === 'brave' ? { brave: key } : { tavily: key }
  writeSettingsConfig({ webSearch: { apiKeys } })
  ctx.stdout.write(`✓ Saved with mode 0600. Restart Ultron to use ${which}.\n`)
}

// ---------------------------------------------------------------------------
// /web help
// ---------------------------------------------------------------------------

function writeHelp(ctx: SubCtx): void {
  ctx.stdout.write(
    [
      'Usage:',
      '  /web                       — backend + active rules',
      '  /web search <query>        — run a web search',
      '  /web allow <host> [--persist]   — add WebFetch domain allow rule',
      '  /web deny  <host> [--persist]   — add WebFetch domain deny rule',
      '  /web remove <host>         — drop rules matching <host>',
      '  /web rules                 — print all domain-scoped rules',
      '  /web setup                 — choose backend (interactive)',
      '  /web help                  — this message',
      '',
      'Domain rules created here apply to WebFetch (per-result host gating).',
      'WebSearch is not host-scoped; disable it via standard permission UX.',
      '',
    ].join('\n'),
  )
}
