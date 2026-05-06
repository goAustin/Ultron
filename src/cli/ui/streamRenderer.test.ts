import { describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'

import { StreamRenderer } from './streamRenderer.js'
import { buildTheme } from './themes.js'
import {
  messageId,
  toolUseId,
  type AssistantMessage,
  type UserMessage,
} from '../../core/messages.js'
import type { QueryEvent } from '../../core/queryEvents.js'

class StringWritable extends Writable {
  buf = ''
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.buf += chunk.toString()
    cb()
  }
}

function makeRenderer(): { renderer: StreamRenderer; out: StringWritable } {
  const out = new StringWritable()
  const renderer = new StreamRenderer({
    theme: buildTheme('light', { color: false }),
    output: out,
    width: 80,
  })
  return { renderer, out }
}

function emptyAssistant(): AssistantMessage {
  return {
    id: messageId('m1'),
    role: 'assistant',
    timestamp: 0,
    content: [],
  }
}

function toolResultMsg(id: string, content: string, isError = false): UserMessage {
  return {
    id: messageId('m2'),
    role: 'user',
    timestamp: 0,
    content: [
      {
        type: 'tool_result',
        toolUseId: toolUseId(id),
        content,
        isError,
      },
    ],
  }
}

describe('StreamRenderer', () => {
  it('emits ULTRON header exactly once before the first text_delta', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    renderer.handle({ type: 'text_delta', text: 'A' })
    renderer.handle({ type: 'text_delta', text: 'B' })
    renderer.handle({ type: 'text_delta', text: 'C' })
    expect(out.buf.match(/ULTRON/g)?.length).toBe(1)
    expect(out.buf).toContain('ULTRON\nABC')
  })

  it('does not emit a second ULTRON header after a tool runs in the same turn', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    renderer.handle({ type: 'text_delta', text: 'before. ' })
    renderer.handle({ type: 'tool_use_start', id: toolUseId('t1'), name: 'bash' })
    renderer.handle({
      type: 'tool_call_finished',
      toolUseId: toolUseId('t1'),
      toolName: 'bash',
      outcome: 'ok',
      durationMs: 180,
      resultPreview: 'ok',
      timestamp: 0,
    })
    renderer.handle({ type: 'tool_result', message: toolResultMsg('t1', 'output here') })
    renderer.handle({ type: 'text_delta', text: 'after.' })
    expect(out.buf.match(/ULTRON/g)?.length).toBe(1)
  })

  it('re-emits ULTRON header on a fresh turn', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    renderer.handle({ type: 'text_delta', text: 'one' })
    renderer.beginTurn()
    renderer.handle({ type: 'text_delta', text: 'two' })
    expect(out.buf.match(/ULTRON/g)?.length).toBe(2)
  })

  it('classifies common tool names into design kinds', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    renderer.handle({ type: 'tool_use_start', id: toolUseId('t1'), name: 'bash' })
    renderer.handle({ type: 'tool_use_start', id: toolUseId('t2'), name: 'Read' })
    renderer.handle({ type: 'tool_use_start', id: toolUseId('t3'), name: 'WebSearch' })
    expect(out.buf).toContain('SHELL')
    expect(out.buf).toContain('FILE')
    expect(out.buf).toContain('WEB')
  })

  it('renders a tool body indented under the dot and adds a done · time trailer', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    renderer.handle({ type: 'tool_use_start', id: toolUseId('t1'), name: 'bash' })
    renderer.handle({
      type: 'tool_call_finished',
      toolUseId: toolUseId('t1'),
      toolName: 'bash',
      outcome: 'ok',
      durationMs: 180,
      resultPreview: 'src/auth/session.ts',
      timestamp: 0,
    })
    renderer.handle({ type: 'tool_result', message: toolResultMsg('t1', 'src/auth/session.ts') })
    expect(out.buf).toMatch(/\n {4}src\/auth\/session\.ts\n/)
    expect(out.buf).toMatch(/done · 180ms/)
  })

  it('renders durations ≥ 950ms as seconds', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    renderer.handle({ type: 'tool_use_start', id: toolUseId('t1'), name: 'bash' })
    renderer.handle({
      type: 'tool_call_finished',
      toolUseId: toolUseId('t1'),
      toolName: 'bash',
      outcome: 'ok',
      durationMs: 1234,
      resultPreview: 'ok',
      timestamp: 0,
    })
    renderer.handle({ type: 'tool_result', message: toolResultMsg('t1', 'ok') })
    expect(out.buf).toMatch(/done · 1\.23s/)
  })

  it('marks an errored tool result with error · time', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    renderer.handle({ type: 'tool_use_start', id: toolUseId('t1'), name: 'bash' })
    renderer.handle({
      type: 'tool_call_finished',
      toolUseId: toolUseId('t1'),
      toolName: 'bash',
      outcome: 'error',
      durationMs: 50,
      resultPreview: 'no such file',
      timestamp: 0,
    })
    renderer.handle({ type: 'tool_result', message: toolResultMsg('t1', 'no such file', true) })
    expect(out.buf).toMatch(/error · 50ms/)
  })

  it('skips audit-only events silently', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    const events: QueryEvent[] = [
      { type: 'request_start' },
      { type: 'thinking_delta', thinking: 'hmm' },
      { type: 'turn', message: emptyAssistant() },
      {
        type: 'permission_decision',
        toolUseId: toolUseId('t1'),
        toolName: 'bash',
        input: {},
        decision: 'allow',
        reason: 'auto',
        timestamp: 0,
      },
    ]
    for (const e of events) renderer.handle(e)
    expect(out.buf).toBe('')
  })

  it('shows a one-line error for ErrorEvent', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    renderer.handle({ type: 'error', error: new Error('rate limited'), recoverable: true })
    expect(out.buf).toContain('rate limited')
  })

  it('emits no ANSI bg-paint escapes (no \\x1b[48 or \\x1b[K)', () => {
    const { renderer, out } = makeRenderer()
    renderer.beginTurn()
    renderer.handle({ type: 'text_delta', text: 'hi\n' })
    renderer.handle({ type: 'tool_use_start', id: toolUseId('t1'), name: 'bash' })
    expect(out.buf).not.toContain('\x1b[48;')
    expect(out.buf).not.toContain('\x1b[K')
  })
})
