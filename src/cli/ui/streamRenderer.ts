/**
 * Translates the QueryEvent stream coming out of QueryEngine into themed
 * terminal output. Stateful — tracks the current turn (so the "ULTRON" reply
 * header is emitted exactly once before the first text_delta) and a small
 * map of in-flight tool calls (so durations from `tool_call_finished` can
 * decorate the body printed at `tool_result` time).
 *
 * Per-event behavior matches the cards in the React design:
 *
 * - `text_delta`              → "ULTRON" header (once) + raw text passthrough
 * - `tool_use_start`          → ● colored dot + "KIND · name" header line
 * - `tool_call_finished`      → record durationMs / outcome, no output yet
 * - `tool_result`             → indented preview body + "done|error · Xs" footer
 * - `error`                   → red one-line
 * - `compaction_finished`     → faint one-line status
 *
 * Everything else flows through the audit log; the renderer stays silent so
 * the surface stays calm during long sessions.
 */

import type { QueryEvent } from '../../core/queryEvents.js'
import type { ToolUseId } from '../../core/messages.js'
import { renderToolBody, renderToolHeader, type ToolStatus } from './render.js'
import type { Theme } from './themes.js'

export type StreamRendererOpts = {
  readonly theme: Theme
  readonly output: NodeJS.WritableStream
  /** Width of the terminal window. Defaults to output.columns when present. */
  readonly width?: number
}

type ToolState = {
  readonly kind: string
  readonly name: string
  durationMs?: number
  outcome?: 'ok' | 'error' | 'aborted'
}

/**
 * Map an internal tool name to the short uppercase "kind" used in the header.
 * Vocabulary: SHELL, FILE, WEB, GIT, COMPUTER, MEMORY, SKILL.
 */
function classifyTool(toolName: string): string {
  const n = toolName.toLowerCase()
  if (n === 'bash' || n === 'shell' || n.includes('shell')) return 'shell'
  if (n.startsWith('git') || n === 'gitstatus' || n === 'gitlog') return 'git'
  if (n.includes('read') || n.includes('write') || n === 'edit' || n.includes('file')) return 'file'
  if (n.includes('web') || n.includes('search') || n.includes('fetch')) return 'web'
  if (n.startsWith('computer') || n === 'browser') return 'computer'
  if (n.includes('memory')) return 'memory'
  if (n.includes('skill')) return 'skill'
  return toolName
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 950) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function statusFromOutcome(outcome: ToolState['outcome']): ToolStatus {
  if (outcome === 'error' || outcome === 'aborted') return 'error'
  return 'done'
}

function previewFromMessage(event: Extract<QueryEvent, { type: 'tool_result' }>): {
  readonly body: string
  readonly isError: boolean
} {
  const block = event.message.content[0]
  if (!block || block.type !== 'tool_result') return { body: '', isError: false }
  return { body: String(block.content).slice(0, 600), isError: Boolean(block.isError) }
}

export class StreamRenderer {
  private readonly theme: Theme
  private readonly out: NodeJS.WritableStream
  private readonly width: number
  private readonly tools = new Map<ToolUseId, ToolState>()
  private headerEmitted = false
  private lastWasNewline = true

  constructor(opts: StreamRendererOpts) {
    this.theme = opts.theme
    this.out = opts.output
    const cols = opts.width ?? (this.out as { columns?: number }).columns
    this.width = typeof cols === 'number' && cols > 0 ? Math.min(100, Math.max(40, cols)) : 80
  }

  beginTurn(): void {
    this.headerEmitted = false
    this.tools.clear()
  }

  handle(event: QueryEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.onTextDelta(event.text)
        break
      case 'tool_use_start':
        this.onToolUseStart(event.id, event.name)
        break
      case 'tool_call_finished':
        this.onToolCallFinished(event.toolUseId, event.durationMs, event.outcome)
        break
      case 'tool_result':
        this.onToolResult(event)
        break
      case 'error':
        this.write(this.theme.style('error', `! ${event.error.message}`) + '\n')
        break
      case 'compaction_finished':
        if (event.outcome === 'ok') {
          this.write(
            this.theme.style(
              'faint',
              `· compacted ${event.messagesBefore} → ${event.messagesAfter} messages`,
            ) + '\n',
          )
        }
        break
      // Silent — flows to the audit log, not the rendered transcript.
      case 'request_start':
      case 'thinking_delta':
      case 'turn':
      case 'attachment':
      case 'permission_decision':
      case 'tool_call_started':
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
        break
      default: {
        const _exhaustive: never = event
        void _exhaustive
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private write(s: string): void {
    if (!s) return
    this.out.write(s)
    this.lastWasNewline = s.endsWith('\n')
  }

  private ensureLineStart(): void {
    if (!this.lastWasNewline) this.write('\n')
  }

  private emitReplyHeader(): void {
    this.ensureLineStart()
    this.write(this.theme.style('dim', 'ULTRON') + '\n')
  }

  private onTextDelta(text: string): void {
    if (!this.headerEmitted) {
      this.emitReplyHeader()
      this.headerEmitted = true
    }
    this.write(text)
  }

  private onToolUseStart(id: ToolUseId, toolName: string): void {
    const kind = classifyTool(toolName)
    this.tools.set(id, { kind, name: toolName })
    this.ensureLineStart()
    this.write('\n')
    this.write(
      renderToolHeader(this.theme, {
        kind,
        name: toolName,
        status: 'running',
        width: this.width,
      }),
    )
  }

  private onToolCallFinished(
    id: ToolUseId,
    durationMs: number,
    outcome: 'ok' | 'error' | 'aborted',
  ): void {
    const state = this.tools.get(id)
    if (!state) return
    state.durationMs = durationMs
    state.outcome = outcome
  }

  private onToolResult(event: Extract<QueryEvent, { type: 'tool_result' }>): void {
    const block = event.message.content[0]
    if (!block || block.type !== 'tool_result') return
    const id = block.toolUseId
    const state = this.tools.get(id)
    const { body, isError } = previewFromMessage(event)
    const role: 'dim' | 'error' = isError ? 'error' : 'dim'
    if (body) {
      this.ensureLineStart()
      this.write(renderToolBody(this.theme, body, role))
    }
    if (state) {
      const status: ToolStatus = isError ? 'error' : statusFromOutcome(state.outcome)
      const time = state.durationMs !== undefined ? formatDuration(state.durationMs) : undefined
      const tag = status === 'error' ? 'error' : 'done'
      const colorRole: 'dim' | 'error' = status === 'error' ? 'error' : 'dim'
      const trailer = time ? `${tag} · ${time}` : tag
      this.write(`    ${this.theme.style(colorRole, trailer)}\n`)
      this.tools.delete(id)
    }
  }
}
