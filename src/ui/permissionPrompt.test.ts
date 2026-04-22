import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'

import { formatApprovalPrompt, promptForApproval } from './permissionPrompt.js'
import type { TerminalIO } from './permissionPrompt.js'

// ---------------------------------------------------------------------------
// Helpers — mock TerminalIO
// ---------------------------------------------------------------------------

function createMockIO(): TerminalIO & { input: PassThrough & { setRawMode: (m: boolean) => void }; output: PassThrough; getOutput: () => string } {
  const input = new PassThrough() as PassThrough & { setRawMode: (m: boolean) => void }
  input.setRawMode = () => {} // no-op for tests
  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on('data', (chunk: Buffer) => chunks.push(chunk))

  return {
    input,
    output,
    getOutput: () => Buffer.concat(chunks).toString(),
  }
}

/** Send keypress data after a short delay (to let the prompt set up listeners). */
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
const CTRL_C = '\x03'

// ---------------------------------------------------------------------------
// formatApprovalPrompt (pure)
// ---------------------------------------------------------------------------

describe('formatApprovalPrompt', () => {
  it('includes tool name and reason', () => {
    const result = formatApprovalPrompt('FileWrite', { file_path: '/tmp/foo.ts' }, 'no matching rule')
    expect(result).toContain('FileWrite')
    expect(result).toContain('no matching rule')
    expect(result).toContain('Permission Required')
  })

  it('shows file_path for file tools', () => {
    const result = formatApprovalPrompt('FileWrite', { file_path: '/tmp/foo.ts' }, 'reason')
    expect(result).toContain('Path:')
    expect(result).toContain('/tmp/foo.ts')
  })

  it('shows file_path for FileEdit', () => {
    const result = formatApprovalPrompt('FileEdit', { file_path: '/tmp/bar.ts' }, 'reason')
    expect(result).toContain('/tmp/bar.ts')
  })

  it('shows command for Bash', () => {
    const result = formatApprovalPrompt('Bash', { command: 'npm install' }, 'reason')
    expect(result).toContain('Cmd:')
    expect(result).toContain('npm install')
  })

  it('truncates long Bash commands', () => {
    const longCmd = 'x'.repeat(200)
    const result = formatApprovalPrompt('Bash', { command: longCmd }, 'reason')
    expect(result).toContain('...')
    // The full 200-char command should not appear
    expect(result).not.toContain(longCmd)
  })

  it('shows pattern for Grep', () => {
    const result = formatApprovalPrompt('Grep', { pattern: 'foo.*bar', path: '/src' }, 'reason')
    expect(result).toContain('Pattern:')
    expect(result).toContain('foo.*bar')
    expect(result).toContain('/src')
  })

  it('shows pattern for Glob', () => {
    const result = formatApprovalPrompt('Glob', { pattern: '**/*.ts' }, 'reason')
    expect(result).toContain('**/*.ts')
  })

  it('shows generic JSON for unknown tools', () => {
    const result = formatApprovalPrompt('CustomTool', { key: 'value' }, 'reason')
    expect(result).toContain('Input:')
    expect(result).toContain('key')
  })

  it('omits input line for empty input', () => {
    const result = formatApprovalPrompt('CustomTool', {}, 'reason')
    expect(result).not.toContain('Input:')
  })
})

// ---------------------------------------------------------------------------
// promptForApproval (I/O)
// ---------------------------------------------------------------------------

describe('promptForApproval', () => {
  it('Enter on default selection returns deny_once', async () => {
    const io = createMockIO()
    const signal = new AbortController().signal

    sendKeys(io.input, ENTER)

    const result = await promptForApproval('FileWrite', { file_path: '/tmp/x' }, 'reason', signal, io)
    expect(result).toBe('deny_once')
  })

  it('Down + Enter returns allow_once', async () => {
    const io = createMockIO()
    const signal = new AbortController().signal

    sendKeys(io.input, ARROW_DOWN, ENTER)

    const result = await promptForApproval('FileWrite', { file_path: '/tmp/x' }, 'reason', signal, io)
    expect(result).toBe('allow_once')
  })

  it('Down + Down + Enter returns allow_by_rule', async () => {
    const io = createMockIO()
    const signal = new AbortController().signal

    sendKeys(io.input, ARROW_DOWN, ARROW_DOWN, ENTER)

    const result = await promptForApproval('FileWrite', { file_path: '/tmp/x' }, 'reason', signal, io)
    expect(result).toBe('allow_by_rule')
  })

  it('Ctrl+C returns abort', async () => {
    const io = createMockIO()
    const signal = new AbortController().signal

    sendKeys(io.input, CTRL_C)

    const result = await promptForApproval('FileWrite', { file_path: '/tmp/x' }, 'reason', signal, io)
    expect(result).toBe('abort')
  })

  it('aborted signal returns abort', async () => {
    const io = createMockIO()
    const ac = new AbortController()
    ac.abort()

    const result = await promptForApproval('FileWrite', { file_path: '/tmp/x' }, 'reason', ac.signal, io)
    expect(result).toBe('abort')
  })

  it('Up from top stays at top', async () => {
    const io = createMockIO()
    const signal = new AbortController().signal

    // Up (no-op, already at 0), then Enter → still deny_once
    sendKeys(io.input, ARROW_UP, ENTER)

    const result = await promptForApproval('FileWrite', { file_path: '/tmp/x' }, 'reason', signal, io)
    expect(result).toBe('deny_once')
  })

  it('Down past bottom stays at bottom', async () => {
    const io = createMockIO()
    const signal = new AbortController().signal

    // 3 downs (only 2 are effective), then Enter → allow_by_rule (index 2)
    sendKeys(io.input, ARROW_DOWN, ARROW_DOWN, ARROW_DOWN, ENTER)

    const result = await promptForApproval('FileWrite', { file_path: '/tmp/x' }, 'reason', signal, io)
    expect(result).toBe('allow_by_rule')
  })

  it('renders prompt header to output', async () => {
    const io = createMockIO()
    const signal = new AbortController().signal

    sendKeys(io.input, ENTER)

    await promptForApproval('Bash', { command: 'echo hi' }, 'test reason', signal, io)

    const output = io.getOutput()
    expect(output).toContain('Permission Required')
    expect(output).toContain('Bash')
    expect(output).toContain('Deny once')
    expect(output).toContain('Allow once')
    expect(output).toContain('Allow by rule')
  })
})
