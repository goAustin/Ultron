import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'

import { promptForModel, formatModelMenuHeader } from './modelMenu.js'
import type { TerminalIO } from './modelMenu.js'
import { allModels, listProviders } from '../core/providers/registry.js'

// ---------------------------------------------------------------------------
// Helpers — mock TerminalIO (identical shape to permissionPrompt.test.ts)
// ---------------------------------------------------------------------------

function createMockIO(): TerminalIO & {
  input: PassThrough & { setRawMode: (m: boolean) => void }
  output: PassThrough
  getOutput: () => string
} {
  const input = new PassThrough() as PassThrough & { setRawMode: (m: boolean) => void }
  input.setRawMode = () => {}
  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on('data', (chunk: Buffer) => chunks.push(chunk))
  return {
    input,
    output,
    getOutput: () => Buffer.concat(chunks).toString(),
  }
}

function sendKeys(input: PassThrough, ...keys: string[]): void {
  let delay = 10
  for (const key of keys) {
    setTimeout(() => input.write(key), delay)
    delay += 10
  }
}

const ARROW_DOWN = '\x1B[B'
const ARROW_UP = '\x1B[A'
const ENTER = '\r'
const ESC = '\x1B'
const CTRL_C = '\x03'

function modelsOf(providerId: string) {
  return allModels().filter(m => m.provider === providerId)
}

// ---------------------------------------------------------------------------

describe('formatModelMenuHeader', () => {
  it('announces the select-model action', () => {
    expect(formatModelMenuHeader()).toContain('Select model')
  })
})

describe('promptForModel', () => {
  it('Enter on open confirms the current model', async () => {
    const io = createMockIO()
    const models = modelsOf('openai')
    const current = models[1]!.id

    const p = promptForModel(current, io)
    sendKeys(io.input, ENTER)
    expect(await p).toBe(current)
  })

  it('Down + Enter selects the next model within the same provider', async () => {
    const io = createMockIO()
    const models = modelsOf('openai')
    const current = models[0]!.id

    const p = promptForModel(current, io)
    sendKeys(io.input, ARROW_DOWN, ENTER)
    expect(await p).toBe(models[1]!.id)
  })

  it('navigation skips non-selectable provider headers', async () => {
    // With Anthropic registered before OpenAI, arrow-down from the last
    // Anthropic model should land on the first OpenAI model, skipping the
    // OpenAI group header.
    const io = createMockIO()
    const anthropicModels = modelsOf('anthropic')
    const openaiModels = modelsOf('openai')
    const current = anthropicModels[anthropicModels.length - 1]!.id

    const p = promptForModel(current, io)
    sendKeys(io.input, ARROW_DOWN, ENTER)
    expect(await p).toBe(openaiModels[0]!.id)
  })

  it('Up past the top is clamped', async () => {
    const io = createMockIO()
    const firstModel = allModels()[0]!.id

    const p = promptForModel(firstModel, io)
    sendKeys(io.input, ARROW_UP, ARROW_UP, ENTER)
    expect(await p).toBe(firstModel)
  })

  it('Down past the end is clamped', async () => {
    const io = createMockIO()
    const all = allModels()
    const lastModel = all[all.length - 1]!.id

    const p = promptForModel(lastModel, io)
    sendKeys(io.input, ARROW_DOWN, ARROW_DOWN, ENTER)
    expect(await p).toBe(lastModel)
  })

  it('Esc cancels and resolves null', async () => {
    const io = createMockIO()
    const current = allModels()[0]!.id

    const p = promptForModel(current, io)
    sendKeys(io.input, ESC)
    expect(await p).toBe(null)
  })

  it('Ctrl+C cancels and resolves null', async () => {
    const io = createMockIO()
    const current = allModels()[0]!.id

    const p = promptForModel(current, io)
    sendKeys(io.input, CTRL_C)
    expect(await p).toBe(null)
  })

  it('unknown current model places cursor at the first selectable row', async () => {
    const io = createMockIO()
    const firstModel = allModels()[0]!.id

    const p = promptForModel('not-a-real-model', io)
    sendKeys(io.input, ENTER)
    expect(await p).toBe(firstModel)
  })

  it('output shows grouped provider headers + the cursor + (current) marker', async () => {
    const io = createMockIO()
    const anthropicModels = modelsOf('anthropic')
    const current = anthropicModels[1]!.id

    const p = promptForModel(current, io)
    sendKeys(io.input, ENTER)
    await p

    const out = io.getOutput()
    for (const adapter of listProviders()) {
      if (adapter.models.length > 0) expect(out).toContain(adapter.displayName)
    }
    expect(out).toContain('(current)')
    expect(out).toContain('>')
    expect(out).toContain(anthropicModels[1]!.label)
  })
})
