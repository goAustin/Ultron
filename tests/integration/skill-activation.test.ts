/**
 * Integration test: skill activation end-to-end (Phase 5b).
 *
 * Drives `activateSkill` → `submitPrompt` → `deactivateSkill` against a
 * real `QueryEngine` with a stub `callModel` that records the system
 * prompt parts it sees. Audit events flow through a real
 * `createAuditWriter` pointed at a tmp dir.
 *
 * Coverage matrix:
 *   1. Happy path: activate → submit → turns_exhausted (1-turn).
 *   2. Multi-turn cache stability: skill 'org' part is byte-identical
 *      across submissions within a window.
 *   3. High-confidence secret refusal: no skill_activated, audit shows
 *      skill_deactivated { reason: 'secret_refused' }.
 *   4. User deactivation mid-window: clears state, audit reason matches.
 *   5. Instruction-only (`allowed-tools: []`): system prompt block shows
 *      instruction-only language; cascade denies any tool.
 *   6. Tool denial under skill scope: cascade returns skillScope deny.
 */

import { describe, it, expect } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { QueryEngine } from '../../src/sdk/QueryEngine.js'
import type { QueryEngineConfig } from '../../src/sdk/QueryEngine.js'
import { createAuditWriter } from '../../src/audit/auditLog.js'
import type { QueryEvent } from '../../src/core/queryEvents.js'
import type { Terminal } from '../../src/core/queryTypes.js'
import type {
  ApiResponseMeta,
  AuthorizeToolUseFn,
  CallModelFn,
  ExecuteToolUseFn,
  RawStreamEvent,
} from '../../src/core/queryDeps.js'
import type { SystemPromptPart } from '../../src/context/systemPromptParts.js'
import { hasPermissionsToUseTool } from '../../src/core/permissions/permissions.js'
import { buildTool } from '../../src/core/tools/types.js'
import { createToolUseContext } from '../../src/core/tools/context.js'
import { createToolRegistry } from '../../src/core/tools/registry.js'
import { createStore, getDefaultAppState } from '../../src/core/state.js'
import { toolUseId } from '../../src/core/messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-skill-activate-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function writeSkillMd(
  baseDir: string,
  id: string,
  frontmatter: Record<string, string>,
  body: string,
): void {
  const dir = join(baseDir, 'skills', id)
  mkdirSync(dir, { recursive: true })
  const lines = ['---']
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`)
  lines.push('---', '', body)
  writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'))
}

function readAuditEvents(baseDir: string): Array<Record<string, unknown>> {
  const path = join(baseDir, 'audit.jsonl')
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return []
  const raw = readFileSync(path, 'utf8').trim()
  if (raw.length === 0) return []
  return raw.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
}

// Records every system-prompt-parts array it sees + the messages stream.
function recordingCallModel(): {
  systemPartsHistory: ReadonlyArray<readonly SystemPromptPart[]>[]
  callModel: CallModelFn
} {
  const history: ReadonlyArray<readonly SystemPromptPart[]>[] = []
  const callModel: CallModelFn = async function* (_msgs, sys, _opts, _signal) {
    history.push([sys])
    yield { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } } as RawStreamEvent
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason: 'end_turn', inputTokens: 5, outputTokens: 1 } as ApiResponseMeta
  }
  return {
    get systemPartsHistory() { return history },
    callModel,
  }
}

const stubAuthorize: AuthorizeToolUseFn = async () => ({
  outcome: 'authorized',
  decision: { decision: 'allow', reason: 'integ-stub' },
})
const stubExecute: ExecuteToolUseFn = async () => ({
  content: 'ok',
  isError: false,
})

function makeConfig(
  cwd: string,
  baseDir: string,
  callModel: CallModelFn,
  auditWriter: ReturnType<typeof createAuditWriter>,
): QueryEngineConfig {
  return {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    cwd,
    memoryBaseDir: baseDir,
    disableMcp: true,
    auditWriter,
    deps: {
      callModel,
      authorizeToolUse: stubAuthorize,
      executeToolUse: stubExecute,
    },
  }
}

async function drain(
  gen: AsyncGenerator<QueryEvent, Terminal>,
): Promise<{ events: QueryEvent[]; terminal: Terminal }> {
  const events: QueryEvent[] = []
  let r = await gen.next()
  while (!r.done) {
    events.push(r.value)
    r = await gen.next()
  }
  return { events, terminal: r.value }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skill activation integration', () => {
  it('happy path: activate → submit → turns_exhausted (1 turn)', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (baseDir) => {
        writeSkillMd(
          baseDir,
          'review-pr',
          {
            name: 'review-pr',
            description: 'Review pull requests for correctness.',
          },
          'BODY-MARKER',
        )

        const captured = recordingCallModel()
        const auditWriter = createAuditWriter({ dir: baseDir })
        const engine = new QueryEngine(
          makeConfig(cwd, baseDir, captured.callModel, auditWriter),
        )

        try {
          await engine.activateSkill('review-pr', { turns: 1 })
          await drain(engine.submitPrompt('go'))

          // System prompt parts contained an 'org' part with the body.
          const parts = captured.systemPartsHistory[0]?.[0]
          const skillPart = parts?.find(
            (p) => p.cacheHint === 'org' && p.content.includes('BODY-MARKER'),
          )
          expect(skillPart).toBeDefined()
          expect(skillPart!.content).toContain('Active skill: review-pr')

          // Activation window auto-closed after the single turn.
          expect(engine.isSkillActive).toBe(false)
        } finally {
          await engine.dispose()
          await auditWriter.close()
        }

        // Audit log contains the activation envelope.
        const events = readAuditEvents(baseDir)
        const activated = events.find((e) => e['type'] === 'skill_activated')
        const deactivated = events.find((e) => e['type'] === 'skill_deactivated')
        expect(activated).toBeTruthy()
        expect(activated!['id']).toBe('review-pr')
        expect(activated!['turns']).toBe(1)
        expect(deactivated).toBeTruthy()
        expect(deactivated!['reason']).toBe('turns_exhausted')

        // Metadata-only contract: no body / args / allowedTools list.
        expect(activated!['body']).toBeUndefined()
        expect(activated!['args']).toBeUndefined()
        expect(activated!['allowedTools']).toBeUndefined()
      })
    })
  })

  it('multi-turn cache stability: skill org part is byte-identical', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (baseDir) => {
        writeSkillMd(
          baseDir,
          'sk',
          { name: 'sk', description: 'd' },
          'BODY-MARKER',
        )
        const captured = recordingCallModel()
        const auditWriter = createAuditWriter({ dir: baseDir })
        const engine = new QueryEngine(
          makeConfig(cwd, baseDir, captured.callModel, auditWriter),
        )

        try {
          await engine.activateSkill('sk', { turns: 3 })
          await drain(engine.submitPrompt('t1'))
          await drain(engine.submitPrompt('t2'))
          await drain(engine.submitPrompt('t3'))

          // Three submissions → three system-prompt builds. Every 'org'
          // part with BODY-MARKER must be byte-identical.
          const skillBodies = captured.systemPartsHistory.map((entry) => {
            const parts = entry[0]
            const p = parts.find(
              (x) =>
                x.cacheHint === 'org' && x.content.includes('BODY-MARKER'),
            )
            return p?.content
          })
          expect(skillBodies).toHaveLength(3)
          expect(skillBodies[0]).toBeDefined()
          expect(skillBodies[1]).toBe(skillBodies[0])
          expect(skillBodies[2]).toBe(skillBodies[0])

          // After 3rd turn → exhausted.
          expect(engine.isSkillActive).toBe(false)
        } finally {
          await engine.dispose()
          await auditWriter.close()
        }
      })
    })
  })

  it('high-confidence secret refusal: no skill_activated, only secret_refused', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (baseDir) => {
        writeSkillMd(
          baseDir,
          'leaky',
          { name: 'leaky', description: 'd' },
          'use AKIAABCDEFGHIJKLMNOP for s3 access',
        )
        const captured = recordingCallModel()
        const auditWriter = createAuditWriter({ dir: baseDir })
        const engine = new QueryEngine(
          makeConfig(cwd, baseDir, captured.callModel, auditWriter),
        )

        try {
          await expect(engine.activateSkill('leaky')).rejects.toThrow()
          expect(engine.isSkillActive).toBe(false)
        } finally {
          await engine.dispose()
          await auditWriter.close()
        }

        const events = readAuditEvents(baseDir)
        expect(
          events.find((e) => e['type'] === 'skill_activated'),
        ).toBeUndefined()
        const deact = events.find((e) => e['type'] === 'skill_deactivated')
        expect(deact).toBeTruthy()
        expect(deact!['reason']).toBe('secret_refused')
        expect(deact!['id']).toBe('leaky')
      })
    })
  })

  it('user deactivation mid-window emits user_deactivated', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (baseDir) => {
        writeSkillMd(
          baseDir,
          'sk',
          { name: 'sk', description: 'd' },
          'body',
        )
        const captured = recordingCallModel()
        const auditWriter = createAuditWriter({ dir: baseDir })
        const engine = new QueryEngine(
          makeConfig(cwd, baseDir, captured.callModel, auditWriter),
        )

        try {
          await engine.activateSkill('sk', { turns: 5 })
          await drain(engine.submitPrompt('t1'))
          expect(engine.isSkillActive).toBe(true)

          engine.deactivateSkill('user_deactivated')
          expect(engine.isSkillActive).toBe(false)

          // Next submit has NO 'org' skill part.
          await drain(engine.submitPrompt('t2'))
          const lastParts =
            captured.systemPartsHistory[
              captured.systemPartsHistory.length - 1
            ]?.[0]
          const hasSkillPart = lastParts?.some(
            (p) => p.cacheHint === 'org' && p.content.includes('Active skill'),
          )
          expect(hasSkillPart).toBe(false)
        } finally {
          await engine.dispose()
          await auditWriter.close()
        }

        const events = readAuditEvents(baseDir)
        const deact = events.find(
          (e) =>
            e['type'] === 'skill_deactivated' &&
            e['reason'] === 'user_deactivated',
        )
        expect(deact).toBeTruthy()
      })
    })
  })

  it('instruction-only (allowed-tools: []): renders instruction-only block', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (baseDir) => {
        writeSkillMd(
          baseDir,
          'silent',
          {
            name: 'silent',
            description: 'd',
            'allowed-tools': '[]',
          },
          'meditate',
        )
        const captured = recordingCallModel()
        const auditWriter = createAuditWriter({ dir: baseDir })
        const engine = new QueryEngine(
          makeConfig(cwd, baseDir, captured.callModel, auditWriter),
        )
        try {
          await engine.activateSkill('silent')
          expect(engine.activeSkill?.allowedTools).toEqual([])
          await drain(engine.submitPrompt('go'))

          const part = captured.systemPartsHistory[0]?.[0].find(
            (p) => p.cacheHint === 'org' && p.content.includes('meditate'),
          )
          expect(part).toBeDefined()
          expect(part!.content).toContain('instruction-only')
          expect(part!.content).toContain('You may not invoke any tools')
        } finally {
          await engine.dispose()
          await auditWriter.close()
        }
      })
    })
  })

  it('cascade denies tool not in allowedTools (skillScope reason)', async () => {
    // Run the cascade directly with the same scopedToolAllowlist the
    // engine would thread through during an active turn. This isolates
    // the integration assertion from the model-driven tool-call path.
    const tool = buildTool({
      name: 'Bash',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
    })
    const registry = createToolRegistry()
    registry.register(tool)
    const ctx = createToolUseContext({
      appState: createStore({
        ...getDefaultAppState(),
        permissionMode: 'bypassPermissions', // skill scope must still win
      }),
      abortController: new AbortController(),
      messages: [],
      toolRegistry: registry,
    })
    const decision = await hasPermissionsToUseTool(
      tool,
      { type: 'tool_use', id: toolUseId('tu-1'), name: 'Bash', input: {} },
      ctx,
      {
        headless: false,
        safetyChecks: [],
        scopedToolAllowlist: ['FileRead', 'Grep'],
      },
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({
      type: 'skillScope',
      toolName: 'Bash',
      allowed: ['FileRead', 'Grep'],
    })
  })
})
