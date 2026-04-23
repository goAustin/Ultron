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
import { createPermissionLogger } from './core/permissions/logging.js'
import type { AskUserFn } from './core/permissions/types.js'
import { resolveModel } from './core/providers/registry.js'
import { UnknownModelError } from './core/providers/types.js'
import { readUserConfig, writeUserConfig } from './config/userConfig.js'

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

const engine = new QueryEngine({
  model,
  cwd,
  baseUrl,
  permissionMode: 'default',
  askUser,
  logDecision: createPermissionLogger(),
  thinkingBudget: DEFAULT_THINKING_BUDGET,
})

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
      process.exit(0)
    }

    if (trimmed === '/session') {
      console.log(`Session: ${engine.sessionId}`)
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
          case 'compact':
            process.stdout.write(`\n\x1b[35m[compacted: ${event.messagesBefore} → ${event.messagesAfter} messages]\x1b[0m\n`)
            break
          case 'error':
            process.stderr.write(`\n\x1b[31m[error: ${event.error.message}]\x1b[0m\n`)
            break
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
console.log('Type /quit to exit, /session to see session ID, /model to switch models.\n')
prompt()
