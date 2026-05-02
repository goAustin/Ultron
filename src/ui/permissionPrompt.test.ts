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

  // -------------------------------------------------------------------------
  // Phase 4·1 — Computer-tool rendering
  // -------------------------------------------------------------------------

  describe('Computer-Use branch', () => {
    it('renders sessionId + url + click action when sessionLookup is provided', () => {
      const result = formatApprovalPrompt(
        'ComputerClick',
        { sessionId: 'abc12345-def0-1111-2222-333344445555', x: 0.5, y: 0.3, button: 'left' },
        'requires approval',
        {
          sessionLookup: () => ({
            url: 'https://github.com/u/repo/settings',
            title: 'Settings',
          }),
        },
      )
      expect(result).toContain('Tool:    ComputerClick')
      expect(result).toContain('Session: abc12345…')
      expect(result).toContain('https://github.com/u/repo/settings')
      expect(result).toContain('click(0.50, 0.30)')
      expect(result).toContain('left button')
    })

    it('renders risk-level + nearby text when metadata is provided', () => {
      const result = formatApprovalPrompt(
        'ComputerClick',
        { sessionId: 's1', x: 0.5, y: 0.3 },
        'level 3 click',
        {
          metadata: {
            checkName: 'computerUseSafetyCheck',
            riskLevel: 3,
            riskCategory: 'irreversible',
            evidence: { nearbyText: 'Delete account' },
          },
        },
      )
      expect(result).toContain('Risk:    level 3 (irreversible)')
      expect(result).toContain('Target:  «Delete account»')
    })

    it('renders fieldType when present in metadata.evidence', () => {
      const result = formatApprovalPrompt(
        'ComputerType',
        { sessionId: 's1', text: 'x', sensitive: true },
        'sensitive input',
        {
          metadata: {
            checkName: 'computerUseSafetyCheck',
            riskLevel: 2,
            riskCategory: 'sensitive_input',
            evidence: { fieldType: 'password' },
          },
        },
      )
      expect(result).toContain('Field:   password')
    })

    it('redacts text content when sensitive=true', () => {
      const result = formatApprovalPrompt(
        'ComputerType',
        { sessionId: 's1', text: 'hunter2', sensitive: true },
        'sensitive',
      )
      expect(result).toContain('<redacted 7 chars>')
      expect(result).not.toContain('hunter2')
    })

    it('falls back gracefully when sessionLookup returns null', () => {
      const result = formatApprovalPrompt(
        'ComputerNavigate',
        { sessionId: 'unknown-id', url: 'https://example.com' },
        'navigate',
        { sessionLookup: () => null },
      )
      expect(result).toContain('Session: unknown-…')
      expect(result).toContain('navigate(https://example.com)')
    })

    it('handles ComputerStart (no sessionId in input)', () => {
      const result = formatApprovalPrompt(
        'ComputerStart',
        { headless: false },
        'requires approval',
      )
      // ComputerStart has no sessionId, so the Computer branch is skipped;
      // falls through to the generic JSON renderer.
      expect(result).toContain('Tool:    ComputerStart')
      expect(result).toContain('Input:')
      expect(result).toContain('headless')
    })

    it('non-Computer tools ignore opts.metadata (no Risk: line)', () => {
      const result = formatApprovalPrompt(
        'Bash',
        { command: 'ls' },
        'requires approval',
        {
          metadata: {
            checkName: 'computerUseSafetyCheck',
            riskLevel: 3,
            riskCategory: 'irreversible',
          },
        },
      )
      expect(result).toContain('Cmd:     ls')
      expect(result).not.toContain('Risk:')
    })
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
