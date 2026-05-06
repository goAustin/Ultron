import { describe, expect, it } from 'vitest'

import {
  buildTheme,
  detectColorDepth,
  detectColorEnabled,
  isThemeName,
  VALID_THEME_NAMES,
} from './themes.js'

describe('themes', () => {
  it('lists exactly the two themes (light, dark)', () => {
    expect(VALID_THEME_NAMES).toEqual(['light', 'dark'])
  })

  it('isThemeName narrows valid strings', () => {
    expect(isThemeName('light')).toBe(true)
    expect(isThemeName('dark')).toBe(true)
    expect(isThemeName('Light')).toBe(false)
    expect(isThemeName('paper')).toBe(false)
    expect(isThemeName('ink')).toBe(false)
    expect(isThemeName('phosphor')).toBe(false)
    expect(isThemeName(undefined)).toBe(false)
  })

  describe('detectColorEnabled', () => {
    it('honors explicit override', () => {
      expect(detectColorEnabled({ color: false, stream: { isTTY: true } })).toBe(false)
      expect(detectColorEnabled({ color: true, stream: { isTTY: false } })).toBe(true)
    })

    it('NO_COLOR=anything disables', () => {
      expect(detectColorEnabled({ env: { NO_COLOR: '1' }, stream: { isTTY: true } })).toBe(false)
      expect(detectColorEnabled({ env: { NO_COLOR: 'true' }, stream: { isTTY: true } })).toBe(false)
    })

    it('NO_COLOR= empty does not disable', () => {
      expect(detectColorEnabled({ env: { NO_COLOR: '' }, stream: { isTTY: true } })).toBe(true)
    })

    it('FORCE_COLOR=0 disables, anything else forces on', () => {
      expect(detectColorEnabled({ env: { FORCE_COLOR: '0' }, stream: { isTTY: true } })).toBe(false)
      expect(detectColorEnabled({ env: { FORCE_COLOR: '1' }, stream: { isTTY: false } })).toBe(true)
    })

    it('falls back to stream.isTTY when no env override', () => {
      expect(detectColorEnabled({ env: {}, stream: { isTTY: true } })).toBe(true)
      expect(detectColorEnabled({ env: {}, stream: { isTTY: false } })).toBe(false)
    })
  })

  describe('detectColorDepth', () => {
    it('opts.depth wins over every other signal', () => {
      expect(
        detectColorDepth({
          depth: 'ansi256',
          env: { COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5' },
          stream: { isTTY: true },
        }),
      ).toBe('ansi256')
      expect(
        detectColorDepth({
          depth: 'truecolor',
          env: { TERM_PROGRAM: 'Apple_Terminal' },
          stream: { isTTY: true },
        }),
      ).toBe('truecolor')
    })

    it("Apple_Terminal → ansi256 even when TERM is xterm-256color (Terminal.app's truecolor escapes paint bg colors)", () => {
      expect(
        detectColorDepth({
          env: { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' },
          stream: { isTTY: true },
        }),
      ).toBe('ansi256')
    })

    it('COLORTERM=truecolor or 24bit → truecolor', () => {
      expect(
        detectColorDepth({ env: { COLORTERM: 'truecolor' }, stream: { isTTY: true } }),
      ).toBe('truecolor')
      expect(
        detectColorDepth({ env: { COLORTERM: '24bit' }, stream: { isTTY: true } }),
      ).toBe('truecolor')
      expect(
        detectColorDepth({ env: { COLORTERM: 'TrueColor' }, stream: { isTTY: true } }),
      ).toBe('truecolor')
    })

    it('iTerm.app v3+ → truecolor; older iTerm → ansi256', () => {
      expect(
        detectColorDepth({
          env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.10' },
          stream: { isTTY: true },
        }),
      ).toBe('truecolor')
      expect(
        detectColorDepth({
          env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '2.9.20140903' },
          stream: { isTTY: true },
        }),
      ).toBe('ansi256')
    })

    it('vscode / WezTerm / Warp / ghostty → truecolor', () => {
      for (const program of ['vscode', 'WezTerm', 'WarpTerminal', 'ghostty']) {
        expect(
          detectColorDepth({ env: { TERM_PROGRAM: program }, stream: { isTTY: true } }),
        ).toBe('truecolor')
      }
    })

    it('TERM=xterm-kitty / alacritty / *-direct → truecolor', () => {
      expect(
        detectColorDepth({ env: { TERM: 'xterm-kitty' }, stream: { isTTY: true } }),
      ).toBe('truecolor')
      expect(
        detectColorDepth({ env: { TERM: 'alacritty' }, stream: { isTTY: true } }),
      ).toBe('truecolor')
      expect(
        detectColorDepth({ env: { TERM: 'xterm-direct' }, stream: { isTTY: true } }),
      ).toBe('truecolor')
    })

    it('TERM=dumb → none even with TTY', () => {
      expect(
        detectColorDepth({ env: { TERM: 'dumb' }, stream: { isTTY: true } }),
      ).toBe('none')
    })

    it('unknown terminal with TTY → ansi256 (safe fallback)', () => {
      expect(
        detectColorDepth({ env: { TERM: 'xterm-256color' }, stream: { isTTY: true } }),
      ).toBe('ansi256')
      expect(detectColorDepth({ env: {}, stream: { isTTY: true } })).toBe('ansi256')
    })

    it('color disabled → none regardless of terminal hints', () => {
      expect(
        detectColorDepth({
          env: { NO_COLOR: '1', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app' },
          stream: { isTTY: true },
        }),
      ).toBe('none')
      expect(detectColorDepth({ color: false, stream: { isTTY: true } })).toBe('none')
    })
  })

  describe('buildTheme', () => {
    it('emits truecolor escapes for light.fg when depth is truecolor', () => {
      const t = buildTheme('light', { depth: 'truecolor' })
      expect(t.colorEnabled).toBe(true)
      expect(t.depth).toBe('truecolor')
      expect(t.code('fg')).toBe('\x1b[38;2;26;24;21m')
      expect(t.style('fg', 'x')).toBe('\x1b[38;2;26;24;21mx\x1b[0m')
      expect(t.reset()).toBe('\x1b[0m')
    })

    it('emits 256-color escapes when depth is ansi256', () => {
      const t = buildTheme('light', { depth: 'ansi256' })
      expect(t.colorEnabled).toBe(true)
      expect(t.depth).toBe('ansi256')
      // No truecolor escapes anywhere — Apple_Terminal would misparse them.
      for (const role of ['fg', 'dim', 'faint', 'rule', 'accent', 'accent2', 'success', 'error', 'user'] as const) {
        const code = t.code(role)
        expect(code).toMatch(/^\x1b\[38;5;\d+m$/)
        expect(code).not.toMatch(/38;2/)
        const idx = Number(code.match(/38;5;(\d+)m/)![1])
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThanOrEqual(255)
      }
    })

    it('Apple_Terminal env never produces a truecolor escape', () => {
      const t = buildTheme('light', {
        env: { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' },
        stream: { isTTY: true },
      })
      expect(t.depth).toBe('ansi256')
      for (const role of ['fg', 'dim', 'faint', 'accent', 'accent2'] as const) {
        expect(t.code(role)).not.toContain('38;2')
      }
    })

    it('emits empty strings (no color) when disabled', () => {
      const t = buildTheme('light', { color: false })
      expect(t.colorEnabled).toBe(false)
      expect(t.depth).toBe('none')
      expect(t.code('fg')).toBe('')
      expect(t.style('accent', 'hello')).toBe('hello')
      expect(t.reset()).toBe('')
    })

    it('light and dark produce different escapes for the same role', () => {
      const light = buildTheme('light', { depth: 'truecolor' })
      const dark = buildTheme('dark', { depth: 'truecolor' })
      expect(light.code('fg')).not.toBe(dark.code('fg'))
      expect(light.code('dim')).not.toBe(dark.code('dim'))
      expect(light.code('accent')).not.toBe(dark.code('accent'))

      const light256 = buildTheme('light', { depth: 'ansi256' })
      const dark256 = buildTheme('dark', { depth: 'ansi256' })
      expect(light256.code('fg')).not.toBe(dark256.code('fg'))
      expect(light256.code('dim')).not.toBe(dark256.code('dim'))
      expect(light256.code('accent')).not.toBe(dark256.code('accent'))
    })

    it('bold combines bold + color escapes', () => {
      const t = buildTheme('light', { depth: 'truecolor' })
      const out = t.bold('accent', 'X')
      expect(out.startsWith('\x1b[1m')).toBe(true)
      expect(out).toContain('\x1b[38;2;60;50;40m')
      expect(out.endsWith('\x1b[0m')).toBe(true)
    })

    it('bold without color is a no-op', () => {
      const t = buildTheme('light', { color: false })
      expect(t.bold(null, 'X')).toBe('X')
      expect(t.bold('accent', 'X')).toBe('X')
    })

    it('light dim is dark enough to be readable on white (>= 4.5:1 contrast)', () => {
      const t = buildTheme('light', { depth: 'truecolor' })
      // Parse the rgb out of the SGR escape and compute luminance contrast vs white.
      const m = t.code('dim').match(/38;2;(\d+);(\d+);(\d+)/)
      expect(m).not.toBeNull()
      const [r, g, b] = [Number(m![1]), Number(m![2]), Number(m![3])]
      expect(contrastVsWhite(r, g, b)).toBeGreaterThanOrEqual(4.5)
    })

    it('dark dim is light enough to be readable on black (>= 4.5:1 contrast)', () => {
      const t = buildTheme('dark', { depth: 'truecolor' })
      const m = t.code('dim').match(/38;2;(\d+);(\d+);(\d+)/)
      expect(m).not.toBeNull()
      const [r, g, b] = [Number(m![1]), Number(m![2]), Number(m![3])]
      expect(contrastVsBlack(r, g, b)).toBeGreaterThanOrEqual(4.5)
    })

    it('256-color light fg/dim/faint/accent stay legible on white (>= 4.5:1 contrast)', () => {
      const t = buildTheme('light', { depth: 'ansi256' })
      for (const role of ['fg', 'dim', 'faint', 'accent', 'accent2', 'error'] as const) {
        const idx = Number(t.code(role).match(/38;5;(\d+)m/)![1])
        const [r, g, b] = ansi256ToRGB(idx)
        expect(contrastVsWhite(r, g, b)).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('256-color dark fg/dim/faint/accent stay legible on black (>= 4.5:1 contrast)', () => {
      const t = buildTheme('dark', { depth: 'ansi256' })
      for (const role of ['fg', 'dim', 'faint', 'accent', 'accent2', 'success', 'error'] as const) {
        const idx = Number(t.code(role).match(/38;5;(\d+)m/)![1])
        const [r, g, b] = ansi256ToRGB(idx)
        expect(contrastVsBlack(r, g, b)).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('accent is non-blue (R+G >= 2·B) in both themes (truecolor)', () => {
      for (const theme of [
        buildTheme('light', { depth: 'truecolor' }),
        buildTheme('dark', { depth: 'truecolor' }),
      ]) {
        const m = theme.code('accent').match(/38;2;(\d+);(\d+);(\d+)/)
        expect(m).not.toBeNull()
        const [r, g, b] = [Number(m![1]), Number(m![2]), Number(m![3])]
        expect(r + g).toBeGreaterThanOrEqual(2 * b)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// WCAG contrast helpers — used to assert the palette stays legible without
// any background painting.
// ---------------------------------------------------------------------------

function relativeLuminance(r: number, g: number, b: number): number {
  const toLin = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b)
}
function contrastVsWhite(r: number, g: number, b: number): number {
  const l = relativeLuminance(r, g, b)
  return (1.0 + 0.05) / (l + 0.05)
}
function contrastVsBlack(r: number, g: number, b: number): number {
  const l = relativeLuminance(r, g, b)
  return (l + 0.05) / 0.05
}

/**
 * Convert a 256-color palette index back to its canonical RGB so contrast
 * tests can verify the fallback stays legible. Mirrors the standard xterm
 * palette: 0–15 ANSI base, 16–231 6×6×6 cube, 232–255 grayscale ramp.
 */
function ansi256ToRGB(idx: number): readonly [number, number, number] {
  if (idx < 0 || idx > 255) throw new Error(`bad ansi256 index: ${idx}`)
  if (idx < 16) {
    // Standard xterm base-16 palette.
    const base: readonly [number, number, number][] = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
      [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
      [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
      [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ]
    return base[idx]!
  }
  if (idx < 232) {
    const i = idx - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i % 36) / 6)
    const b = i % 6
    const cube = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
    return [cube(r), cube(g), cube(b)]
  }
  const v = 8 + (idx - 232) * 10
  return [v, v, v]
}
