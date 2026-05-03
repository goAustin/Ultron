import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { createComputerWatchMode } from './computerWatchMode.js'
import type {
  PermissionDecisionEvent,
  ToolCallFinishedEvent,
  ToolCallStartedEvent,
} from '../core/queryEvents.js'
import type { ToolUseId } from '../core/messages.js'
import type { SessionLookup } from './permissionPrompt.js'

class CapturingStream extends Writable {
  chunks: string[] = []
  isTTY = true
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    cb()
  }
  text(): string {
    return this.chunks.join('')
  }
}

function makeStartEvent(overrides?: Partial<ToolCallStartedEvent>): ToolCallStartedEvent {
  return {
    type: 'tool_call_started',
    toolUseId: 'tu-1' as ToolUseId,
    toolName: 'ComputerClick',
    input: { sessionId: 'sess-abc12345', x: 0.5, y: 0.5 },
    timestamp: 0,
    ...overrides,
  }
}

function makeFinishEvent(overrides?: Partial<ToolCallFinishedEvent>): ToolCallFinishedEvent {
  return {
    type: 'tool_call_finished',
    toolUseId: 'tu-1' as ToolUseId,
    toolName: 'ComputerClick',
    outcome: 'ok',
    durationMs: 1247,
    resultPreview: '',
    timestamp: 0,
    ...overrides,
  }
}

function makeDecisionEvent(
  overrides?: Partial<PermissionDecisionEvent>,
): PermissionDecisionEvent {
  return {
    type: 'permission_decision',
    toolUseId: 'tu-1' as ToolUseId,
    toolName: 'ComputerClick',
    input: { sessionId: 'sess-abc12345', x: 0.5, y: 0.5 },
    decision: 'allow',
    reason: 'fallback ask: approved',
    timestamp: 0,
    ...overrides,
  }
}

describe('createComputerWatchMode', () => {
  describe('TTY gating', () => {
    it('is a no-op when isTTY=false (piped stderr)', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: false })
      wm.handle(makeStartEvent())
      wm.handle(makeFinishEvent())
      expect(out.text()).toBe('')
    })

    it('renders when isTTY=true', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(makeStartEvent())
      expect(out.text()).not.toBe('')
    })

    it('auto-detects isTTY from the output stream when not specified', () => {
      const out = new CapturingStream()
      out.isTTY = true
      const wm = createComputerWatchMode({ output: out })
      wm.handle(makeStartEvent())
      expect(out.text()).not.toBe('')
    })

    it('is a no-op after detach()', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(makeStartEvent())
      const before = out.text().length
      wm.detach()
      wm.handle(makeFinishEvent())
      expect(out.text().length).toBe(before)
    })
  })

  describe('event filtering', () => {
    it('ignores non-Computer tool events', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(makeStartEvent({ toolName: 'Read' }))
      wm.handle(makeFinishEvent({ toolName: 'Read' }))
      wm.handle(makeDecisionEvent({ toolName: 'Read' }))
      expect(out.text()).toBe('')
    })

    it('ignores unrelated event types (text_delta, turn, etc.)', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      // QueryEvent is a discriminated union; cast through unknown to assert
      // the renderer doesn't accidentally echo non-Computer event types.
      wm.handle({ type: 'text_delta', text: 'hello' } as unknown as Parameters<typeof wm.handle>[0])
      wm.handle({ type: 'request_start' } as unknown as Parameters<typeof wm.handle>[0])
      expect(out.text()).toBe('')
    })

    it('renders all three Computer event types in order', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(makeDecisionEvent())
      wm.handle(makeStartEvent())
      wm.handle(makeFinishEvent())
      const lines = out.text().split('\n').filter((l) => l !== '')
      expect(lines.length).toBe(3)
      expect(lines[0]).toContain('allow')
      expect(lines[1]).toContain('start')
      expect(lines[2]).toContain('finish')
    })
  })

  describe('rendering', () => {
    it('shows the action summary on start', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(makeStartEvent({ input: { sessionId: 'sess-abc12345', x: 0.86, y: 0.41 } }))
      expect(out.text()).toContain('click(0.86, 0.41)')
    })

    it('shows outcome + duration on finish', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(makeFinishEvent({ outcome: 'ok', durationMs: 1247 }))
      expect(out.text()).toContain('ok (1247ms)')
    })

    it('appends risk-level tag when safetyMetadata is present', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(
        makeDecisionEvent({
          decision: 'allow',
          userResponse: 'allow_once',
          reason: 'irreversible click on «Delete»',
          safetyMetadata: {
            checkName: 'computerUseSafetyCheck',
            riskLevel: 3,
            riskCategory: 'irreversible',
          },
        }),
      )
      const text = out.text()
      expect(text).toContain('allow L3')
      expect(text).toContain('(allow_once)')
      expect(text).toContain('irreversible click on «Delete»')
    })

    it('renders deny decision with risk level', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(
        makeDecisionEvent({
          decision: 'deny',
          reason: 'denied (level 4): captcha bypass',
          safetyMetadata: {
            checkName: 'computerUseSafetyCheck',
            riskLevel: 4,
            riskCategory: 'prohibited',
          },
        }),
      )
      expect(out.text()).toContain('deny L4')
    })

    it('omits L<n> tag for plain allow with no metadata', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(makeDecisionEvent({ decision: 'allow' }))
      const text = out.text()
      expect(text).toContain('allow')
      expect(text).not.toContain(' L')
    })
  })

  describe('sessionLookup integration', () => {
    it('shows the host when sessionLookup resolves a URL', () => {
      const out = new CapturingStream()
      const sessionLookup: SessionLookup = (id) =>
        id === 'sess-abc12345' ? { url: 'https://github.com/octo/repo/settings', title: null } : null
      const wm = createComputerWatchMode({ output: out, isTTY: true, sessionLookup })
      wm.handle(makeStartEvent())
      expect(out.text()).toContain('github.com')
    })

    it('omits the host when sessionLookup is absent (best-effort)', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(makeStartEvent())
      expect(out.text()).not.toContain('→')
    })

    it('omits the host when sessionLookup returns null (closed session)', () => {
      const out = new CapturingStream()
      const sessionLookup: SessionLookup = () => null
      const wm = createComputerWatchMode({ output: out, isTTY: true, sessionLookup })
      wm.handle(makeStartEvent())
      expect(out.text()).not.toContain('→')
    })

    it('truncates long sessionIds to 8 chars + ellipsis', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(makeStartEvent({ input: { sessionId: 'sess-abcdef0123456789', x: 0, y: 0 } }))
      expect(out.text()).toContain('sess-abc…')
    })
  })

  describe('Phase 4b — atom path rendering', () => {
    it('ComputerObserveActions start renders generic summary', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(
        makeStartEvent({
          toolName: 'ComputerObserveActions',
          input: { sessionId: 'sess-abc12345' },
        }),
      )
      const text = out.text()
      expect(text).toContain('ComputerObserveActions')
      expect(text).toContain('start')
      expect(text).toContain('observe-actions')
    })

    it('ComputerActAtom start shows atomId + action.type, no locatorName', () => {
      const out = new CapturingStream()
      const wm = createComputerWatchMode({ output: out, isTTY: true })
      wm.handle(
        makeStartEvent({
          toolName: 'ComputerActAtom',
          input: {
            sessionId: 'sess-abc12345',
            atomId: 'a-7',
            action: { type: 'click' },
          },
        }),
      )
      const text = out.text()
      expect(text).toContain('ComputerActAtom')
      expect(text).toContain('actAtom(a-7 → click)')
      // No raw locatorName ever appears (it isn't in the event input).
      expect(text).not.toContain('Sign in')
      expect(text).not.toContain('Password')
    })
  })
})
