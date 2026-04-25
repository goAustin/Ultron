#!/usr/bin/env node
// Suppress punycode deprecation warning from dependencies
process.removeAllListeners('warning')
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning' || !w.message.includes('punycode')) console.warn(w) })
/**
 * Ultron CLI — minimal interactive chat interface.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node dist/cli.js
 *   ANTHROPIC_API_KEY=sk-... node dist/cli.js --model claude-sonnet-4-20250514
 *   ANTHROPIC_API_KEY=sk-... node dist/cli.js --base-url https://openrouter.ai/api/v1
 */

import { createInterface } from 'node:readline'
import { QueryEngine } from './sdk/QueryEngine.js'
import { promptForApproval } from './ui/permissionPrompt.js'
import { promptForModel } from './ui/modelMenu.js'
import type { AskUserFn } from './core/permissions/types.js'
import { resolveModel } from './core/providers/registry.js'
import { UnknownModelError } from './core/providers/types.js'
import { readUserConfig, writeUserConfig } from './config/userConfig.js'
import { handleMemoryCommand } from './cli/memoryCommand.js'
import { handleSkillCommand } from './cli/skillsCommand.js'
import { handleWebCommand } from './cli/webCommand.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-opus-4-7'
// Named constant for future phases (error recovery, rate-limit degradation) —
// not wired in Phase 1a.
export const FAST_FALLBACK_MODEL = 'claude-sonnet-4-6'

// Applies whenever the resolved model has supportsThinking: true. Models
// without it drop the knob with a one-time warn (see warnOnce.ts). No
// `/thinking` CLI toggle in Phase 1c — surface is engine config only.
const DEFAULT_THINKING_BUDGET = 4096

const baseUrl = process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]!
  : undefined

// Model resolution order: --model flag → persisted ~/.ultron/config.json → default.
// Provider is inferred from the registry; no --provider flag needed.
const cliModel = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]!
  : undefined
const model = cliModel ?? readUserConfig().lastModel ?? DEFAULT_MODEL

let adapter
try {
  adapter = resolveModel(model).adapter
} catch (err) {
  if (err instanceof UnknownModelError) {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(1)
  }
  throw err
}

if (!process.env[adapter.envKeyName]) {
  process.stderr.write(`Error: Missing ${adapter.envKeyName}. Set the env var and retry.\n`)
  process.exit(1)
}

const cwd = process.cwd()

// ---------------------------------------------------------------------------
// Permission approval callback
// ---------------------------------------------------------------------------

const askUser: AskUserFn = async (toolName, input, reason, signal) => {
  return promptForApproval(toolName, input, reason, signal)
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

// Phase 6b: dedup'd one-shot notice renderer. Audit gets every emission via
// the engine; the CLI only renders the first per session per event type.
const seenNotifyTypes = new Set<string>()
const engine = new QueryEngine({
  model,
  cwd,
  baseUrl,
  permissionMode: 'default',
  askUser,
  thinkingBudget: DEFAULT_THINKING_BUDGET,
  onNotify: (event) => {
    if (seenNotifyTypes.has(event.type)) return
    seenNotifyTypes.add(event.type)
    if (event.type === 'web_backend_resolved' && event.backend === 'duckduckgo') {
      process.stderr.write(
        '\n[WebSearch] Using DuckDuckGo (no API key set). For higher quality results,\n' +
          'set BRAVE_SEARCH_API_KEY (free tier: brave.com/search/api) or TAVILY_API_KEY\n' +
          '(free tier: tavily.com), then restart Ultron.\n\n',
      )
    }
  },
})

// One-shot deprecation notice for the retired Phase 1 permissions log.
// Does not touch the user's existing file; new decisions flow to ~/.ultron/audit.jsonl.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
if (existsSync(join(homedir(), '.ultron', 'permissions.jsonl'))) {
  process.stderr.write(
    '[ultron] Note: permissions.jsonl is deprecated; new decisions recorded in audit.jsonl\n',
  )
}

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

let rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

function prompt(): void {
  rl.question('\n\x1b[36myou>\x1b[0m ', async (input) => {
    const trimmed = input.trim()
    if (!trimmed) {
      prompt()
      return
    }

    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('Goodbye!')
      rl.close()
      await engine.dispose()
      process.exit(0)
    }

    if (trimmed === '/session') {
      console.log(`Session: ${engine.sessionId}`)
      prompt()
      return
    }

    if (trimmed === '/mcp status') {
      const statuses = engine.getMcpStatus()
      if (statuses.length === 0) {
        console.log('[mcp] no servers configured')
      } else {
        const pad = (s: string, n: number): string =>
          s.length >= n ? s : s + ' '.repeat(n - s.length)
        for (const s of statuses) {
          const stateColor =
            s.state === 'ready'      ? '\x1b[32m' :
            s.state === 'connecting' ? '\x1b[36m' :
            s.state === 'failed'     ? '\x1b[31m' :
                                       '\x1b[2m'
          const err = s.lastError ?? '(none)'
          const retry =
            s.nextRetryAt !== null
              ? ` retryIn=${Math.max(0, s.nextRetryAt - Date.now())}ms`
              : ''
          console.log(
            `[mcp] ${pad(s.server, 12)} ${stateColor}${pad(s.state, 10)}\x1b[0m tools=${s.toolCount} attempts=${s.reconnectAttempts}${retry}   lastError=${err}`,
          )
        }
      }
      prompt()
      return
    }

    if (trimmed === '/mcp reload') {
      try {
        const result = await engine.reloadMcp()
        console.log(
          `[mcp] reload complete: connected=${result.connected.length} failed=${result.failed.length} removed=${result.removed.length} disabled=${result.disabled.length} unchanged=${result.unchanged.length} backoff=${result.backoff.length} toolsChanged=${result.toolDefinitionsChanged}`,
        )
        for (const row of result.backoff) {
          const retryMs = row.nextRetryAt === null ? 0 : Math.max(0, row.nextRetryAt - Date.now())
          console.log(`[mcp] ${row.server} still in backoff; retry in ${Math.ceil(retryMs / 1000)}s`)
        }
        for (const failure of result.failed) {
          console.log(`[mcp] ${failure.server} failed: ${failure.error.message}`)
        }
      } catch (err) {
        process.stderr.write(`[mcp] reload failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
      prompt()
      return
    }

    if (trimmed === '/mcp list-tools' || trimmed.startsWith('/mcp list-tools ')) {
      const server = trimmed === '/mcp list-tools'
        ? undefined
        : trimmed.slice('/mcp list-tools '.length).trim()
      const tools = engine.listMcpTools(server || undefined)
      if (tools.length === 0) {
        console.log(server ? `[mcp] no tools for server "${server}"` : '[mcp] no MCP tools registered')
      } else {
        const byServer = new Map<string, typeof tools>()
        for (const tool of tools) {
          byServer.set(tool.server, [...(byServer.get(tool.server) ?? []), tool])
        }
        const pad = (s: string, n: number): string =>
          s.length >= n ? s : s + ' '.repeat(n - s.length)
        for (const [serverName, rows] of byServer) {
          console.log(`[mcp] ${serverName} ${rows[0]?.state ?? 'unknown'}`)
          for (const tool of rows) {
            const oneLineDescription = tool.description.replace(/\s+/g, ' ').slice(0, 100)
            console.log(`  ${pad(tool.name, 36)} ${oneLineDescription}`)
          }
        }
      }
      prompt()
      return
    }

    if (trimmed === '/model') {
      // Close readline so the submenu owns stdin in raw mode
      rl.close()
      try {
        const choice = await promptForModel(engine.currentModel)
        if (choice === null) {
          process.stdout.write('\x1b[2m[model unchanged]\x1b[0m\n')
        } else if (choice === engine.currentModel) {
          process.stdout.write(`\x1b[2m[model unchanged: ${choice}]\x1b[0m\n`)
        } else {
          engine.setModel(choice)
          writeUserConfig({ lastModel: choice })
          process.stdout.write(`\x1b[32m[model: ${choice}]\x1b[0m\n`)
        }
      } catch (err) {
        process.stderr.write(`\n\x1b[31m[model switch failed: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\n`)
      } finally {
        rl = createInterface({ input: process.stdin, output: process.stdout })
      }
      prompt()
      return
    }

    if (trimmed === '/memory' || trimmed.startsWith('/memory ')) {
      // Close readline so sub-helpers (editor, confirm) own stdin briefly.
      rl.close()
      try {
        await handleMemoryCommand(trimmed, engine, {
          stdout: process.stdout,
          stderr: process.stderr,
        })
      } catch (err) {
        process.stderr.write(
          `\n\x1b[31m[memory: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\n`,
        )
      } finally {
        rl = createInterface({ input: process.stdin, output: process.stdout })
      }
      prompt()
      return
    }

    if (trimmed === '/skill' || trimmed.startsWith('/skill ')) {
      // Close readline so sub-helpers (confirmYesNo) own stdin briefly.
      rl.close()
      try {
        await handleSkillCommand(trimmed, engine, {
          stdout: process.stdout,
          stderr: process.stderr,
        })
      } catch (err) {
        process.stderr.write(
          `\n\x1b[31m[skill: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\n`,
        )
      } finally {
        rl = createInterface({ input: process.stdin, output: process.stdout })
      }
      prompt()
      return
    }

    if (trimmed === '/web' || trimmed.startsWith('/web ')) {
      // Close readline so sub-helpers (confirmYesNo / promptText) own stdin.
      rl.close()
      try {
        await handleWebCommand(
          trimmed,
          {
            appState: engine.appStateStore,
            auditWriter: engine.auditWriter,
            emitNotify: (event) => engine.emitNotify(event),
          },
          { stdout: process.stdout, stderr: process.stderr },
        )
      } catch (err) {
        process.stderr.write(
          `\n\x1b[31m[web: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\n`,
        )
      } finally {
        rl = createInterface({ input: process.stdin, output: process.stdout })
      }
      prompt()
      return
    }

    // Fully close readline so raw-mode permission prompts own stdin exclusively
    rl.close()

    try {
      const gen = engine.submitPrompt(trimmed)
      let result = await gen.next()

      while (!result.done) {
        const event = result.value

        switch (event.type) {
          case 'text_delta':
            process.stdout.write(event.text)
            break
          case 'tool_use_start':
            process.stdout.write(`\n\x1b[33m[tool: ${event.name}]\x1b[0m `)
            break
          case 'tool_result': {
            const block = event.message.content[0]
            if (block && block.type === 'tool_result') {
              const prefix = block.isError ? '\x1b[31m[error]\x1b[0m ' : '\x1b[32m[done]\x1b[0m '
              const preview = block.content.slice(0, 200)
              process.stdout.write(`${prefix}${preview}\n`)
            }
            break
          }
          case 'compaction_finished':
            if (event.outcome === 'ok') {
              process.stdout.write(`\n\x1b[35m[compacted: ${event.messagesBefore} → ${event.messagesAfter} messages]\x1b[0m\n`)
            }
            break
          case 'error':
            process.stderr.write(`\n\x1b[31m[error: ${event.error.message}]\x1b[0m\n`)
            break
          case 'request_start':
          case 'thinking_delta':
          case 'turn':
          case 'attachment':
          case 'permission_decision':
          case 'tool_call_started':
          case 'tool_call_finished':
          case 'tool_progress':
          case 'hook_started':
          case 'hook_finished':
          case 'compaction_started':
          case 'memory_entry_written':
          case 'memory_entry_deleted':
          case 'skill_written':
          case 'skill_deleted':
          case 'skill_activated':
          case 'skill_deactivated':
          case 'web_backend_resolved':
            // Intentionally silent in the interactive CLI — these flow to the audit log.
            break
          default: {
            const _exhaustive: never = event
            void _exhaustive
          }
        }

        result = await gen.next()
      }

      const terminal = result.value
      if (terminal.reason === 'error') {
        process.stderr.write(`\n\x1b[31m[terminal error: ${terminal.error?.message}]\x1b[0m\n`)
      }

      process.stdout.write('\n')
    } catch (err) {
      process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`)
    } finally {
      // Recreate readline interface for next prompt
      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    }

    prompt()
  })
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

console.log(`\x1b[1mUltron v0.1.0\x1b[0m — model: ${model} (${adapter.displayName})${baseUrl ? `, via: ${baseUrl}` : ''}, cwd: ${cwd}`)
console.log('Type /quit to exit, /session, /model, /memory, /skill, /web, /mcp status, /mcp reload, /mcp list-tools.\n')

// Pre-warm MCP so any config errors surface before the first prompt and any
// server failures are reported up-front.
engine.init().catch((err) => {
  process.stderr.write(
    `[mcp] bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`,
  )
})

let shuttingDown = false
const gracefulExit = async (code: number): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await engine.dispose()
  } catch {
    // best-effort
  }
  process.exit(code)
}
process.on('SIGINT', () => void gracefulExit(130))
process.on('SIGTERM', () => void gracefulExit(143))

prompt()
