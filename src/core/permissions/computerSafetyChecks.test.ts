/**
 * v3 Phase 4·1 — unit tests for `makeComputerUseSafetyCheck`.
 *
 * Strategy: a minimal `FakeComputerSessionManager` returns a stub session
 * whose `lastAriaSnapshot()` is whatever the test wires up. Real cascade
 * integration is exercised in `permissions.test.ts` (existing) and via the
 * action-tool integration tests.
 */

import { describe, expect, it } from 'vitest'

import {
  buildSnapshot,
  type AriaNode,
  type AriaTreeSnapshot,
  type BoundingBox,
} from '../computer/ariaSnapshot.js'
import type { AtomEntry } from '../computer/atomResolver.js'
import type { SessionAtomCache } from '../computer/selectorCache.js'
import type {
  BrowserSession,
  ComputerSessionId,
  ComputerSessionManager,
  ComputerViewport,
  StartSessionOptions,
  StepDecision,
} from '../computer/types.js'
import type { Tool } from '../tools/types.js'
import type { ToolUseContext } from '../tools/context.js'
import { createStore, getDefaultAppState } from '../state.js'
import { createToolRegistry } from '../tools/registry.js'

import { makeComputerUseSafetyCheck } from './computerSafetyChecks.js'

const VIEWPORT: ComputerViewport = { width: 1024, height: 768, deviceScaleFactor: 1 }

function node(role: string, partial: Partial<AriaNode> = {}): AriaNode {
  return {
    role,
    name: partial.name ?? null,
    bbox: partial.bbox ?? null,
    focused: partial.focused ?? false,
    disabled: partial.disabled ?? false,
    children: partial.children ?? [],
    ...(partial.fieldType !== undefined && { fieldType: partial.fieldType }),
  }
}

function snap(tree: AriaNode): AriaTreeSnapshot {
  return buildSnapshot(tree, { tokenBudget: Infinity })
}

class StubSession implements BrowserSession {
  readonly id: ComputerSessionId
  readonly viewport = VIEWPORT
  readonly displaySize = { width: 1024, height: 768 }
  readonly headless = true
  private _ariaSnapshot: AriaTreeSnapshot | null
  private _url: string | null

  constructor(id: ComputerSessionId, ariaSnapshot: AriaTreeSnapshot | null, url: string | null) {
    this.id = id
    this._ariaSnapshot = ariaSnapshot
    this._url = url
  }

  currentUrl(): string | null {
    return this._url
  }
  async currentTitle(): Promise<string | null> {
    return null
  }
  isClosed(): boolean {
    return false
  }
  async close(): Promise<void> {}
  async navigate(): Promise<void> {}
  async screenshot(): Promise<never> {
    throw new Error('not exercised')
  }
  async stabilize(): Promise<void> {}
  async click(): Promise<void> {}
  async doubleClick(): Promise<void> {}
  async typeText(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scroll(): Promise<void> {}
  async drag(): Promise<void> {}
  async ariaSnapshot(): Promise<AriaTreeSnapshot> {
    if (this._ariaSnapshot === null) throw new Error('no snapshot')
    return this._ariaSnapshot
  }
  lastAriaSnapshot(): AriaTreeSnapshot | null {
    return this._ariaSnapshot
  }
  async getSensitiveRegions(): Promise<readonly BoundingBox[]> {
    return []
  }
  async exportStorageState(): Promise<unknown> {
    return {}
  }
  // Phase 4b — atom catalog. Tests that exercise ActAtom seed `_atomCache`
  // directly via `setAtomCache`; the rest get the default empty behavior.
  private _atomCache: SessionAtomCache | null = null
  async actOnAtom(): Promise<void> {}
  setAtomCache(cache: SessionAtomCache): void {
    this._atomCache = cache
  }
  lookupAtom(atomId: string): AtomEntry | null {
    return this._atomCache?.entries.get(atomId) ?? null
  }
  currentAtomCache(): SessionAtomCache | null {
    return this._atomCache
  }
}

class FakeManager implements ComputerSessionManager {
  readonly sessions = new Map<ComputerSessionId, StubSession>()

  add(id: string, ariaSnapshot: AriaTreeSnapshot | null, url: string | null = null): void {
    const sid = id as ComputerSessionId
    this.sessions.set(sid, new StubSession(sid, ariaSnapshot, url))
  }
  async start(_opts: StartSessionOptions): Promise<BrowserSession> {
    throw new Error('not exercised')
  }
  get(id: ComputerSessionId): BrowserSession | undefined {
    return this.sessions.get(id)
  }
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async requestClose(): Promise<void> {}
  recordStep(): StepDecision { return { abort: false } }
}

function fakeTool(name: string): Tool {
  return { name } as Tool
}

function fakeContext(): ToolUseContext {
  return {
    appState: createStore(getDefaultAppState()),
    abort: new AbortController().signal,
    toolUseId: 'test-tool-use-id' as never,
    toolRegistry: createToolRegistry(),
    cwd: '/tmp',
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

describe('makeComputerUseSafetyCheck', () => {
  describe('non-Computer tools', () => {
    it.each(['Bash', 'FileRead', 'WebFetch', 'MemoryWrite'])('%s → null (defer)', (toolName) => {
      const mgr = new FakeManager()
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      expect(check(fakeTool(toolName), {}, fakeContext())).toBeNull()
    })
  })

  describe('sessionManager === null (Computer-Use disabled)', () => {
    it('every Computer tool → null (no-op)', () => {
      const check = makeComputerUseSafetyCheck({ sessionManager: null })
      expect(
        check(fakeTool('ComputerClick'), { sessionId: 'x', x: 0.5, y: 0.5 }, fakeContext()),
      ).toBeNull()
    })
  })

  describe('level 0/1 (defer)', () => {
    it('ComputerObserve → null', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null)
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      expect(check(fakeTool('ComputerObserve'), { sessionId: 's1' }, fakeContext())).toBeNull()
    })

    it('ComputerScroll → null', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null)
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      expect(
        check(fakeTool('ComputerScroll'), { sessionId: 's1', deltaX: 0, deltaY: 100 }, fakeContext()),
      ).toBeNull()
    })

    it('ComputerType plain text → null', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null)
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      expect(
        check(fakeTool('ComputerType'), { sessionId: 's1', text: 'hello' }, fakeContext()),
      ).toBeNull()
    })
  })

  describe('level 2 (sensitive_input → ask)', () => {
    it('ComputerType with sensitive=true → ask + metadata', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null)
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      const decision = check(
        fakeTool('ComputerType'),
        { sessionId: 's1', text: 'hunter2', sensitive: true },
        fakeContext(),
      )
      expect(decision).not.toBeNull()
      expect(decision!.behavior).toBe('ask')
      expect(decision!.reason.type).toBe('safetyCheck')
      const sc = decision!.reason as { type: 'safetyCheck'; metadata?: { riskLevel: number } }
      expect(sc.metadata?.riskLevel).toBe(2)
    })

    it('ComputerClick on a password field → ask + metadata.evidence.fieldType', () => {
      const tree = node('form', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('textbox', {
            name: 'Password',
            fieldType: 'password',
            bbox: { x: 100, y: 100, width: 200, height: 30 },
          }),
        ],
      })
      const mgr = new FakeManager()
      mgr.add('s1', snap(tree))
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      const decision = check(
        fakeTool('ComputerClick'),
        { sessionId: 's1', x: 0.15, y: 0.15 },
        fakeContext(),
      )
      expect(decision!.behavior).toBe('ask')
      const sc = decision!.reason as {
        type: 'safetyCheck'
        metadata?: { riskLevel: number; evidence?: { fieldType?: string } }
      }
      expect(sc.metadata?.riskLevel).toBe(2)
      expect(sc.metadata?.evidence?.fieldType).toBe('password')
    })
  })

  describe('level 3 (irreversible → ask)', () => {
    it('ComputerClick on Delete button → ask with riskLevel 3 + nearby text', () => {
      const tree = node('main', {
        bbox: { x: 0, y: 0, width: 1024, height: 768 },
        children: [
          node('button', {
            name: 'Delete account',
            bbox: { x: 100, y: 100, width: 200, height: 30 },
          }),
        ],
      })
      const mgr = new FakeManager()
      mgr.add('s1', snap(tree))
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      const decision = check(
        fakeTool('ComputerClick'),
        { sessionId: 's1', x: 0.15, y: 0.15 },
        fakeContext(),
      )
      expect(decision!.behavior).toBe('ask')
      const sc = decision!.reason as {
        type: 'safetyCheck'
        message: string
        metadata?: { riskLevel: number; riskCategory: string; evidence?: { nearbyText?: string } }
      }
      expect(sc.metadata?.riskLevel).toBe(3)
      expect(sc.metadata?.riskCategory).toBe('irreversible')
      expect(sc.metadata?.evidence?.nearbyText).toBe('Delete account')
      expect(sc.message).toContain('ComputerClick')
    })

    it('ComputerKey Enter on focused Delete button → ask with riskLevel 3 (fix #6)', () => {
      // Without fix #6, this would have returned null (level 1) and the
      // dangerous-action prompt would never fire. The cascade picks up the
      // synchronous SafetyCheck which reads `lastAriaSnapshot` and finds the
      // focused button via `findFocused`.
      const tree = node('main', {
        children: [
          node('button', {
            name: 'Delete account',
            focused: true,
            bbox: { x: 100, y: 100, width: 200, height: 30 },
          }),
        ],
      })
      const mgr = new FakeManager()
      mgr.add('s1', snap(tree))
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      const decision = check(
        fakeTool('ComputerKey'),
        { sessionId: 's1', key: 'Enter' },
        fakeContext(),
      )
      expect(decision).not.toBeNull()
      expect(decision!.behavior).toBe('ask')
      const sc = decision!.reason as {
        type: 'safetyCheck'
        metadata?: { riskLevel: number; evidence?: { nearbyText?: string } }
      }
      expect(sc.metadata?.riskLevel).toBe(3)
      expect(sc.metadata?.evidence?.nearbyText).toBe('Delete account')
    })

    it('ComputerKey Enter on focused input inside form-with-Pay → ask riskLevel 3 (fix #6 form-submit case)', () => {
      const tree = node('main', {
        children: [
          node('form', {
            children: [
              node('textbox', { name: 'Card number', focused: true }),
              node('button', { name: 'Pay $99' }),
            ],
          }),
        ],
      })
      const mgr = new FakeManager()
      mgr.add('s1', snap(tree))
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      const decision = check(
        fakeTool('ComputerKey'),
        { sessionId: 's1', key: 'Enter' },
        fakeContext(),
      )
      expect(decision!.behavior).toBe('ask')
      const sc = decision!.reason as {
        type: 'safetyCheck'
        message: string
        metadata?: { riskLevel: number; evidence?: { nearbyText?: string } }
      }
      expect(sc.metadata?.riskLevel).toBe(3)
      expect(sc.metadata?.evidence?.nearbyText).toBe('Pay $99')
      expect(sc.message).toContain('level 3')
    })
  })

  describe('checkName + structured metadata shape', () => {
    it('emits checkName === computerUseSafetyCheck', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null)
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      const decision = check(
        fakeTool('ComputerType'),
        { sessionId: 's1', text: 'x', sensitive: true },
        fakeContext(),
      )
      const sc = decision!.reason as { type: 'safetyCheck'; metadata?: { checkName: string } }
      expect(sc.metadata?.checkName).toBe('computerUseSafetyCheck')
    })
  })

  describe('missing session', () => {
    it('still classifies (deferring missing-ARIA inputs to level 1 → null)', () => {
      const mgr = new FakeManager() // no sessions added
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      // ComputerClick with no session → no ARIA → classifyAction returns level 1
      // → safety check returns null.
      expect(
        check(fakeTool('ComputerClick'), { sessionId: 'unknown', x: 0.5, y: 0.5 }, fakeContext()),
      ).toBeNull()
    })

    it('ComputerStart (no sessionId in input) → still works', () => {
      const mgr = new FakeManager()
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      // ComputerStart is in ALWAYS_REVERSIBLE_TOOLS → level 1 → null.
      expect(check(fakeTool('ComputerStart'), {}, fakeContext())).toBeNull()
    })
  })

  describe('Phase 4b — ComputerActAtom atom resolution', () => {
    it('ComputerObserveActions → null (level 0 observation)', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null)
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      expect(
        check(fakeTool('ComputerObserveActions'), { sessionId: 's1' }, fakeContext()),
      ).toBeNull()
    })

    it('ComputerActAtom on cached <button>Delete</button> → ask riskLevel 3', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null)
      // Seed the cache directly with an entry whose node carries a dangerous label.
      const session = mgr.get('s1' as ComputerSessionId)!
      session.setAtomCache({
        url: 'https://example.com/',
        ariaHash: 'h',
        entries: new Map([
          [
            'a-0',
            {
              atomId: 'a-0',
              role: 'button',
              displayName: 'Delete account',
              locatorName: 'Delete account',
              node: node('button', { name: 'Delete account' }),
              ancestorPath: [],
              nth: 0,
            },
          ],
        ]),
      })
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      const decision = check(
        fakeTool('ComputerActAtom'),
        { sessionId: 's1', atomId: 'a-0', action: { type: 'click' } },
        fakeContext(),
      )
      expect(decision).not.toBeNull()
      expect(decision!.behavior).toBe('ask')
      const sc = decision!.reason as {
        type: 'safetyCheck'
        metadata?: { riskLevel: number; evidence?: { nearbyText?: string } }
      }
      expect(sc.metadata?.riskLevel).toBe(3)
      expect(sc.metadata?.evidence?.nearbyText).toBe('Delete account')
    })

    it('ComputerActAtom fill on cached password input → ask riskLevel 2', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null)
      const session = mgr.get('s1' as ComputerSessionId)!
      session.setAtomCache({
        url: 'https://example.com/',
        ariaHash: 'h',
        entries: new Map([
          [
            'a-3',
            {
              atomId: 'a-3',
              role: 'textbox',
              displayName: '[REDACTED]',
              locatorName: 'Password',
              node: node('textbox', { name: 'Password', fieldType: 'password' }),
              ancestorPath: [],
              nth: 0,
            },
          ],
        ]),
      })
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      const decision = check(
        fakeTool('ComputerActAtom'),
        { sessionId: 's1', atomId: 'a-3', action: { type: 'fill', text: 'x' } },
        fakeContext(),
      )
      expect(decision!.behavior).toBe('ask')
      const sc = decision!.reason as {
        type: 'safetyCheck'
        metadata?: { riskLevel: number; evidence?: { fieldType?: string } }
      }
      expect(sc.metadata?.riskLevel).toBe(2)
      expect(sc.metadata?.evidence?.fieldType).toBe('password')
    })

    it('ComputerActAtom with cache miss → null (cascade defers; tool errors at execute time)', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null) // session exists but has no atom cache
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      expect(
        check(
          fakeTool('ComputerActAtom'),
          { sessionId: 's1', atomId: 'a-99', action: { type: 'click' } },
          fakeContext(),
        ),
      ).toBeNull()
    })

    it('ComputerActAtom with non-string atomId → null (cascade defers)', () => {
      const mgr = new FakeManager()
      mgr.add('s1', null)
      const check = makeComputerUseSafetyCheck({ sessionManager: mgr })
      expect(
        check(
          fakeTool('ComputerActAtom'),
          { sessionId: 's1', atomId: 42, action: { type: 'click' } },
          fakeContext(),
        ),
      ).toBeNull()
    })
  })
})
