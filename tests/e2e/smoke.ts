#!/usr/bin/env npx tsx
/**
 * Ultron v1 E2E Smoke Tests
 *
 * Runs against a real API (e.g. OpenRouter) to validate the full system.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx tests/e2e/smoke.ts
 *   ANTHROPIC_API_KEY=... npx tsx tests/e2e/smoke.ts --base-url https://openrouter.ai/api/v1 --model anthropic/claude-sonnet-4-20250514
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { QueryEngine } from '../../src/sdk/QueryEngine.js'
import type { QueryEvent } from '../../src/core/queryEvents.js'
import type { Terminal } from '../../src/core/queryTypes.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const apiKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('Error: OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable is required.')
  process.exit(1)
}

const args = process.argv.slice(2)
const baseUrl = args.includes('--base-url')
  ? args[args.indexOf('--base-url') + 1]!
  : (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1')
const model = args.includes('--model')
  ? args[args.indexOf('--model') + 1]!
  : 'gpt-5.4-mini'
const provider = (args.includes('--provider')
  ? args[args.indexOf('--provider') + 1]!
  : 'openai') as 'anthropic' | 'openai'

const cwd = join(import.meta.dirname, '..', '..')

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

type TestResult = { name: string; passed: boolean; error?: string; durationMs: number }
const results: TestResult[] = []

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now()
  process.stdout.write(`  ${name} ... `)
  try {
    await fn()
    const ms = Date.now() - start
    results.push({ name, passed: true, durationMs: ms })
    console.log(`\x1b[32mPASS\x1b[0m (${ms}ms)`)
  } catch (err) {
    const ms = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    results.push({ name, passed: false, error: msg, durationMs: ms })
    console.log(`\x1b[31mFAIL\x1b[0m (${ms}ms)`)
    console.log(`    ${msg}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEngine(overrides?: { model?: string; provider?: 'anthropic' | 'openai' }): QueryEngine {
  return new QueryEngine({
    apiKey: apiKey!,
    model: overrides?.model ?? model,
    cwd,
    baseUrl,
    provider: overrides?.provider ?? provider,
    permissionMode: 'bypassPermissions',
    headless: true,
    maxTurns: 10,
  })
}

async function submitAndCollect(engine: QueryEngine, prompt: string): Promise<{
  events: QueryEvent[]
  terminal: Terminal
  fullText: string
  errors: string[]
}> {
  const events: QueryEvent[] = []
  const errors: string[] = []
  let fullText = ''

  const gen = engine.submitPrompt(prompt)
  let result = await gen.next()
  while (!result.done) {
    events.push(result.value)
    if (result.value.type === 'text_delta') {
      fullText += result.value.text
    }
    if (result.value.type === 'error') {
      errors.push(result.value.error.message.slice(0, 150))
    }
    result = await gen.next()
  }

  return { events, terminal: result.value, fullText, errors }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), 'ultron-e2e-'))

console.log(`\n\x1b[1mUltron E2E Smoke Tests\x1b[0m`)
console.log(`  Model: ${model}`)
console.log(`  Provider: ${provider}`)
console.log(`  Base URL: ${baseUrl}`)
console.log(`  CWD: ${cwd}`)
console.log(`  Temp dir: ${tmpDir}\n`)

// 3.1 Basic connectivity
await runTest('3.1 Basic connectivity', async () => {
  const engine = createEngine()
  const { events, terminal, fullText, errors } = await submitAndCollect(
    engine,
    'Reply with exactly this text and nothing else: ULTRON_OK',
  )

  if (errors.length > 0) {
    throw new Error(`API errors: ${errors.join('; ')}`)
  }
  assert(events.length > 0, 'should receive events')
  assert(events.some(e => e.type === 'text_delta'), 'should have text_delta events')
  assert(fullText.includes('ULTRON_OK'), `response should contain ULTRON_OK, got: "${fullText.slice(0, 100)}"`)
  assert(terminal.reason === 'end_turn', `terminal reason should be end_turn, got: ${terminal.reason}`)
})

// 3.2 Streaming events arrive incrementally
await runTest('3.2 Streaming events', async () => {
  const engine = createEngine()
  const { events } = await submitAndCollect(engine, 'Count from 1 to 5, one number per line.')

  const textDeltas = events.filter(e => e.type === 'text_delta')
  assert(textDeltas.length > 1, `should have multiple text_delta events, got: ${textDeltas.length}`)
})

// 3.3 FileRead tool use
await runTest('3.3 FileRead tool use', async () => {
  const engine = createEngine()
  const { events, fullText } = await submitAndCollect(
    engine,
    `Read the file at ${cwd}/package.json and tell me the project name. Use the FileRead tool.`,
  )

  const toolStarts = events.filter(e => e.type === 'tool_use_start')
  assert(toolStarts.length > 0, 'should have tool_use_start events')
  assert(
    toolStarts.some(e => e.type === 'tool_use_start' && e.name === 'FileRead'),
    `should use FileRead tool, got: ${toolStarts.map(e => e.type === 'tool_use_start' ? e.name : '').join(', ')}`,
  )

  const toolResults = events.filter(e => e.type === 'tool_result')
  assert(toolResults.length > 0, 'should have tool_result events')

  assert(
    fullText.toLowerCase().includes('ultron'),
    `response should mention 'ultron', got: "${fullText.slice(0, 200)}"`,
  )
})

// 3.4 Glob tool use
await runTest('3.4 Glob tool use', async () => {
  const engine = createEngine()
  const { events, fullText } = await submitAndCollect(
    engine,
    `Use the Glob tool to find all .ts files in ${cwd}/src/core/ (not recursively, just the top level). List them.`,
  )

  const toolStarts = events.filter(e => e.type === 'tool_use_start')
  assert(toolStarts.length > 0, 'should have tool_use_start events')
  assert(
    fullText.toLowerCase().includes('query') || fullText.includes('.ts'),
    `response should mention TypeScript files, got: "${fullText.slice(0, 200)}"`,
  )
})

// 3.5 Grep tool use
await runTest('3.5 Grep tool use', async () => {
  const engine = createEngine()
  const { events, fullText } = await submitAndCollect(
    engine,
    `Use the Grep tool to search for the string "QueryEngine" in ${cwd}/src/sdk/. List the files that match.`,
  )

  const toolStarts = events.filter(e => e.type === 'tool_use_start')
  assert(toolStarts.length > 0, 'should have tool_use_start events')
  assert(
    fullText.includes('QueryEngine') || fullText.toLowerCase().includes('match'),
    `response should mention QueryEngine matches, got: "${fullText.slice(0, 200)}"`,
  )
})

// 3.6 FileWrite tool use (write inside cwd to pass working directory check)
await runTest('3.6 FileWrite tool use', async () => {
  const engine = createEngine()
  const testFile = join(cwd, 'ultron-write-test.tmp')
  try {
    const { events } = await submitAndCollect(
      engine,
      `Use the FileWrite tool to create a file at ${testFile} with the exact content: hello from ultron`,
    )

    const toolStarts = events.filter(e => e.type === 'tool_use_start')
    assert(toolStarts.length > 0, 'should have tool_use_start events')

    assert(existsSync(testFile), `file should exist at ${testFile}`)
    const content = readFileSync(testFile, 'utf-8')
    assert(
      content.includes('hello from ultron'),
      `file content should contain 'hello from ultron', got: "${content.slice(0, 100)}"`,
    )
  } finally {
    // Clean up test file
    rmSync(testFile, { force: true })
  }
})

// 3.7 Bash tool use (uses allowlisted `ls` command)
await runTest('3.7 Bash tool use', async () => {
  const engine = createEngine()
  const { events, fullText } = await submitAndCollect(
    engine,
    `Use the Bash tool to run: ls ${cwd}/src/core/`,
  )

  const toolStarts = events.filter(e => e.type === 'tool_use_start')
  assert(toolStarts.length > 0, 'should have tool_use_start events')
  assert(
    toolStarts.some(e => e.type === 'tool_use_start' && e.name === 'Bash'),
    `should use Bash tool, got: ${toolStarts.map(e => e.type === 'tool_use_start' ? e.name : '').join(', ')}`,
  )
  assert(
    fullText.includes('query') || fullText.includes('.ts'),
    `response should mention files, got: "${fullText.slice(0, 200)}"`,
  )
})

// 3.8 Multi-turn context retention
await runTest('3.8 Multi-turn context', async () => {
  const engine = createEngine()

  // Turn 1: give it a code word
  await submitAndCollect(engine, 'Remember this code word: PINEAPPLE42. Just say OK.')

  // Turn 2: ask for it back
  const { fullText } = await submitAndCollect(engine, 'What was the code word I told you?')
  assert(
    fullText.includes('PINEAPPLE42'),
    `response should contain PINEAPPLE42, got: "${fullText.slice(0, 200)}"`,
  )
})

// 3.9 Session transcript written to disk
await runTest('3.9 Session transcript', async () => {
  const engine = createEngine()
  await submitAndCollect(engine, 'Say hello.')

  const sessionId = engine.sessionId
  const sessionDir = join(homedir(), '.ultron', 'sessions', sessionId)
  const transcriptPath = join(sessionDir, 'transcript.jsonl')

  assert(existsSync(transcriptPath), `transcript should exist at ${transcriptPath}`)
  const content = readFileSync(transcriptPath, 'utf-8').trim()
  const lines = content.split('\n')
  assert(lines.length >= 2, `transcript should have at least 2 lines (user + assistant), got: ${lines.length}`)

  // Verify each line is valid JSON
  for (const line of lines) {
    try {
      JSON.parse(line)
    } catch {
      throw new Error(`transcript line is not valid JSON: ${line.slice(0, 100)}`)
    }
  }
})

// 3.10 Secret scanning blocks credential writes
await runTest('3.10 Secret scanning blocks writes', async () => {
  const engine = createEngine()
  const secretFile = join(cwd, 'secret-test.env')
  try {
    const { events } = await submitAndCollect(
      engine,
      `You MUST use the FileWrite tool right now. Create a file at ${secretFile} with this exact content: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`,
    )

    // The tool result should be an error due to secret scanning
    const toolResults = events.filter(e => e.type === 'tool_result')
    assert(toolResults.length > 0, 'should have tool_result events')

    // Check that the tool result was an error
    const hasError = toolResults.some(e => {
      if (e.type !== 'tool_result') return false
      const block = e.message.content[0]
      return block?.type === 'tool_result' && block.isError
    })
    assert(hasError, 'tool result should be an error (secret detected)')

    // File should NOT exist (write was blocked)
    assert(!existsSync(secretFile), `secret file should NOT exist at ${secretFile}`)
  } finally {
    rmSync(secretFile, { force: true })
  }
})

// 3.11 Terminal state check (already covered by 3.1, but explicit)
await runTest('3.11 Terminal state', async () => {
  const engine = createEngine()
  const { terminal } = await submitAndCollect(engine, 'Say "test complete".')
  assert(terminal.reason === 'end_turn', `terminal reason should be end_turn, got: ${terminal.reason}`)
  assert(!terminal.error, `terminal should have no error, got: ${terminal.error?.message}`)
})

// 4.1 Abort mid-stream
await runTest('4.1 Abort mid-stream', async () => {
  const engine = createEngine()

  const events: QueryEvent[] = []
  const gen = engine.submitPrompt('Write a very long essay about the history of computing. Be extremely detailed.')
  let aborted = false

  let result = await gen.next()
  while (!result.done) {
    events.push(result.value)
    // Abort after receiving first text_delta
    if (!aborted && result.value.type === 'text_delta') {
      engine.abort()
      aborted = true
    }
    result = await gen.next()
  }

  assert(aborted, 'should have triggered abort')
  // Should complete without crashing — terminal state may vary
  const terminal: Terminal = result.value
  assert(terminal != null, 'should have a terminal value')
})

// 4.2 Invalid model name
await runTest('4.2 Invalid model name', async () => {
  const engine = createEngine({ model: 'nonexistent-model-xyz-999' })
  let caughtError = false

  try {
    const gen = engine.submitPrompt('Hello')
    let result = await gen.next()
    while (!result.done) {
      if (result.value.type === 'error') {
        caughtError = true
      }
      result = await gen.next()
    }
    // If we get terminal with error reason, that's also fine
    if (result.value.reason === 'error') {
      caughtError = true
    }
  } catch {
    // Exception is also acceptable — as long as it doesn't crash the process
    caughtError = true
  }

  assert(caughtError, 'should surface an error for invalid model')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(50))
const passed = results.filter(r => r.passed).length
const failed = results.filter(r => !r.passed).length
const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0)

if (failed === 0) {
  console.log(`\x1b[32m  All ${passed} tests passed\x1b[0m (${(totalMs / 1000).toFixed(1)}s)`)
} else {
  console.log(`\x1b[31m  ${failed} failed\x1b[0m, ${passed} passed (${(totalMs / 1000).toFixed(1)}s)`)
  console.log('\nFailed tests:')
  for (const r of results.filter(r => !r.passed)) {
    console.log(`  - ${r.name}: ${r.error}`)
  }
}
console.log('='.repeat(50))

// Cleanup
rmSync(tmpDir, { recursive: true, force: true })

process.exit(failed > 0 ? 1 : 0)
