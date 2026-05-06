import { describe, expect, it } from 'vitest'

import {
  readlinePrompt,
  renderHelp,
  renderPromptLine,
  renderReplyHeader,
  renderSessionHeader,
  renderToolBody,
  renderToolHeader,
  renderWelcome,
  resolveWidth,
  truncateLeft,
  visibleLength,
} from './render.js'
import { buildTheme } from './themes.js'

const T = buildTheme('light', { color: false })

describe('resolveWidth', () => {
  it('clamps to [40, 100]', () => {
    expect(resolveWidth({ columns: 200 })).toBe(100)
    expect(resolveWidth({ columns: 10 })).toBe(40)
    expect(resolveWidth({ columns: 80 })).toBe(80)
  })
  it('falls back to 80 when columns is missing', () => {
    expect(resolveWidth({})).toBe(80)
    expect(resolveWidth(undefined)).toBe(80)
  })
})

describe('visibleLength', () => {
  it('strips ANSI SGR escapes', () => {
    expect(visibleLength('\x1b[38;2;1;2;3mhello\x1b[0m')).toBe(5)
    expect(visibleLength('\x1b[1m\x1b[31mhi\x1b[0m')).toBe(2)
  })
})

describe('truncateLeft', () => {
  it('returns input when shorter than max', () => {
    expect(truncateLeft('abc', 10)).toBe('abc')
  })
  it('prefixes with ellipsis when truncating, total length stays at max', () => {
    expect(truncateLeft('abcdefghij', 5)).toBe('…ghij')
    expect('…ghij'.length).toBe(5)
  })
})

describe('renderSessionHeader', () => {
  it('puts model on the left and cwd on the right', () => {
    const out = renderSessionHeader(T, { model: 'claude-opus-4-7', cwd: '~/projects/garden', width: 80 })
    const [top, rule] = out.split('\n')
    expect(top).toContain('ultron')
    expect(top).toContain('claude-opus-4-7')
    expect(top).toContain('~/projects/garden')
    expect(top!.length).toBe(80)
    expect(rule).toMatch(/^─{80}$/)
  })

  it('truncates a long cwd from the left', () => {
    const cwd = '/' + 'x'.repeat(200)
    const out = renderSessionHeader(T, { model: 'm', cwd, width: 50 })
    const top = out.split('\n')[0]!
    expect(top.length).toBe(50)
    expect(top).toContain('…')
  })
})

describe('renderWelcome', () => {
  it('contains greeting and command grid', () => {
    const out = renderWelcome(T)
    expect(out).toContain('Hello.')
    expect(out).toContain("I'm ultron")
    expect(out).toContain('ask')
    expect(out).toContain('/run')
    expect(out).toContain('/read')
    expect(out).toContain('/web')
    expect(out).toContain('/help')
  })

  it('lays out hints in a 2-col grid (3 rows × 2 cols, column-major)', () => {
    const out = renderWelcome(T, { width: 80 })
    // With 6 hints column-major across 3 rows: col-A = ask /run /read,
    // col-B = /web /help ctrl-c. Each grid row should hold both columns.
    const lines = out.split('\n')
    expect(lines.some(l => /\bask\b/.test(l) && /\/web/.test(l))).toBe(true)
    expect(lines.some(l => /\/run\b/.test(l) && /\/help/.test(l))).toBe(true)
    expect(lines.some(l => /\/read\b/.test(l) && /ctrl-c/.test(l))).toBe(true)
  })

  it('drops trailing whitespace on each grid row in no-color mode', () => {
    const out = renderWelcome(T, { width: 80 })
    for (const line of out.split('\n')) {
      expect(line).toBe(line.replace(/\s+$/, ''))
    }
  })
})

describe('renderHelp', () => {
  it('lists key commands and reflects the light/dark theme split', () => {
    const out = renderHelp(T)
    expect(out).toContain('/model')
    expect(out).toContain('/theme')
    expect(out).toContain('light · dark')
    expect(out).toContain('/glyph')
    expect(out).toContain('/quit')
    expect(out).toContain('esc')
    expect(out).not.toContain('/paint')
  })
})

describe('renderPromptLine / readlinePrompt', () => {
  it('echoes a user line with the glyph', () => {
    expect(renderPromptLine(T, '❯', 'hi')).toBe('❯ hi\n')
  })
  it('readlinePrompt is glyph + space (no newline)', () => {
    expect(readlinePrompt(T, '❯')).toBe('❯ ')
  })
})

describe('renderReplyHeader', () => {
  it('uppercases the assistant label', () => {
    expect(renderReplyHeader(T)).toBe('ULTRON\n')
    expect(renderReplyHeader(T, 'jarvis')).toBe('JARVIS\n')
  })
})

describe('renderToolHeader', () => {
  it('produces aligned header with kind, name, and time', () => {
    const out = renderToolHeader(T, {
      kind: 'shell',
      name: 'git status',
      status: 'done',
      time: '0.18s',
      width: 80,
    })
    expect(out).toContain('●')
    expect(out).toContain('SHELL')
    expect(out).toContain('git status')
    expect(out).toContain('0.18s')
    expect(out.replace(/\n$/, '').length).toBe(80)
  })

  it('omits time when not provided', () => {
    const out = renderToolHeader(T, { kind: 'web', name: 'search', status: 'running' })
    expect(out).not.toMatch(/\ds/)
    expect(out).toContain('WEB')
    expect(out).toContain('search')
  })
})

describe('renderToolBody', () => {
  it('indents each line with 4 spaces', () => {
    const out = renderToolBody(T, 'a\nb\nc')
    expect(out).toBe('    a\n    b\n    c\n')
  })
  it('returns empty string for empty body', () => {
    expect(renderToolBody(T, '')).toBe('')
  })
})
