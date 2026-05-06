/**
 * Ultron CLI theme palettes — light / dark.
 *
 * Two themes, each tuned to be **comfortably readable on the user's actual
 * terminal background** without painting any background ourselves:
 *
 * - **light**: for terminals with a white/cream background. Foregrounds run
 *   from near-black down to medium-warm gray; dim text stays well above the
 *   WCAG-AA contrast threshold against pure white.
 * - **dark**: for terminals with a black background (system-wide dark mode).
 *   Foregrounds run from warm off-white down to a mid-tone warm gray; dim
 *   text stays comfortably legible against pure black or near-black.
 *
 * Both palettes share the same set of semantic roles (fg, dim, faint, accent,
 * accent2, success, error, user). Color emission honors NO_COLOR and
 * downgrades to empty strings when the output stream is not a TTY.
 *
 * ## Color depth
 *
 * Each role carries both a 24-bit RGB value and a hand-picked 256-color index.
 * At runtime we detect terminal capability and emit the matching SGR escape:
 *
 * - **truecolor** → `\x1b[38;2;r;g;bm` (modern terminals, iTerm2 ≥ 3, kitty,
 *   alacritty, vscode, anything advertising `COLORTERM=truecolor|24bit`).
 * - **ansi256** → `\x1b[38;5;Nm` (macOS Terminal.app and other 256-only
 *   terminals — emitting `38;2;r;g;b` there gets misparsed as `38`, `2`,
 *   then `r`, `g`, `b` as separate SGR codes, which silently paints
 *   background colors and shreds legibility).
 * - **none** → empty strings (NO_COLOR, FORCE_COLOR=0, or non-TTY).
 */

export type ThemeRole =
  | 'fg'
  | 'dim'
  | 'faint'
  | 'rule'
  | 'accent'
  | 'accent2'
  | 'success'
  | 'error'
  | 'user'

export type ThemeName = 'light' | 'dark'

export type ColorDepth = 'none' | 'ansi256' | 'truecolor'

type RGB = readonly [number, number, number]

type RoleColor = {
  /** 24-bit RGB used in truecolor mode. */
  readonly rgb: RGB
  /** 256-color palette index used as the fallback in ansi256 mode. */
  readonly ansi256: number
}

type Palette = Readonly<Record<ThemeRole, RoleColor>>

const PALETTES: Readonly<Record<ThemeName, Palette>> = {
  // Tuned for white / off-white terminal bgs. dim/faint must remain readable
  // without bg painting — these are darker than the original "paper" values.
  light: {
    fg:      { rgb: [26, 24, 21],     ansi256: 234 }, // near-black, warm
    dim:     { rgb: [74, 70, 64],     ansi256: 239 }, // dark warm gray (~8.9:1 on white)
    faint:   { rgb: [110, 104, 98],   ansi256: 242 }, // medium warm gray (~5.0:1 on white)
    rule:    { rgb: [180, 174, 166],  ansi256: 248 },
    accent:  { rgb: [60, 50, 40],     ansi256: 236 }, // warm near-black — slash labels / prompt glyph
    accent2: { rgb: [138, 74, 24],    ansi256: 130 }, // dark amber (~6.0:1 on white)
    success: { rgb: [45, 88, 40],     ansi256: 22 },  // forest green
    error:   { rgb: [138, 40, 24],    ansi256: 124 }, // dark red
    user:    { rgb: [26, 24, 21],     ansi256: 234 },
  },
  // Tuned for black / near-black terminal bgs.
  dark: {
    fg:      { rgb: [232, 227, 214],  ansi256: 254 }, // warm off-white
    dim:     { rgb: [184, 179, 163],  ansi256: 250 }, // light warm gray (~8.9:1 on black)
    faint:   { rgb: [138, 132, 120],  ansi256: 245 }, // medium gray (~5.5:1 on black)
    rule:    { rgb: [78, 74, 66],     ansi256: 240 },
    accent:  { rgb: [230, 215, 188],  ansi256: 230 }, // warm cream — slash labels / prompt glyph
    accent2: { rgb: [224, 168, 107],  ansi256: 215 }, // warm amber
    success: { rgb: [168, 210, 155],  ansi256: 150 }, // mint green
    error:   { rgb: [230, 159, 134],  ansi256: 209 }, // warm pink
    user:    { rgb: [244, 239, 230],  ansi256: 255 }, // cream white
  },
}

const FULL_RESET = '\x1b[0m'

export type Theme = {
  readonly name: ThemeName
  /** Bare SGR escape for a fg role. Empty when color is off. */
  readonly code: (role: ThemeRole) => string
  /** Wrap text in role color + reset. Returns text unchanged when color is off. */
  readonly style: (role: ThemeRole, text: string) => string
  /** Bold text (with optional role color). */
  readonly bold: (role: ThemeRole | null, text: string) => string
  /** SGR reset escape (empty when color is off). */
  readonly reset: () => string
  /** Whether color emission is currently enabled. */
  readonly colorEnabled: boolean
  /** The detected color depth in use ('none' | 'ansi256' | 'truecolor'). */
  readonly depth: ColorDepth
}

export const VALID_THEME_NAMES: readonly ThemeName[] = ['light', 'dark']

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (VALID_THEME_NAMES as readonly string[]).includes(value)
}

export type ThemeOptions = {
  /** Force color on/off. When omitted, auto-detects from env + stream. */
  readonly color?: boolean
  /**
   * Force a specific color depth, bypassing detection. When set, takes
   * precedence over `color` and all env/TTY signals. Used by tests to make
   * assertions deterministic across developer machines.
   */
  readonly depth?: ColorDepth
  /** Used for auto-detection. Defaults to process.stdout. */
  readonly stream?: { isTTY?: boolean }
  /** Used for NO_COLOR / FORCE_COLOR detection. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * `NO_COLOR=*` (any non-empty value) disables color emission.
 * `FORCE_COLOR=0` disables; any other non-empty value forces it on.
 * Otherwise: enabled when the target stream is a TTY.
 */
export function detectColorEnabled(opts: ThemeOptions = {}): boolean {
  if (opts.color !== undefined) return opts.color
  const env = opts.env ?? process.env
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0'
  const stream = opts.stream ?? (typeof process !== 'undefined' ? process.stdout : undefined)
  return Boolean(stream?.isTTY)
}

/**
 * Pick the right SGR depth for the current terminal.
 *
 * Resolution order:
 *   1. Explicit `opts.depth` override (tests, --color flag in the future).
 *   2. `detectColorEnabled()` returns false → 'none'.
 *   3. `COLORTERM=truecolor|24bit` → 'truecolor' (the canonical positive signal).
 *   4. `TERM_PROGRAM` heuristics:
 *        - `Apple_Terminal` → 'ansi256'  (the load-bearing case — Terminal.app
 *          advertises `xterm-256color` but does NOT parse `38;2;r;g;b`,
 *          which silently paints bg colors).
 *        - `iTerm.app` (≥ v3), `vscode`, `WezTerm`, `WarpTerminal`, `ghostty`,
 *          `Hyper`, `tabby`, `mintty` → 'truecolor'.
 *   5. `TERM` heuristics: `xterm-kitty`, `alacritty*`, `*-direct` → 'truecolor';
 *      `dumb` → 'none'.
 *   6. Fallback → 'ansi256' (safe everywhere; misses some truecolor terminals
 *      but never paints bg colors by accident).
 */
export function detectColorDepth(opts: ThemeOptions = {}): ColorDepth {
  if (opts.depth !== undefined) return opts.depth
  if (!detectColorEnabled(opts)) return 'none'

  const env = opts.env ?? process.env

  const colorterm = env.COLORTERM?.toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'

  const program = env.TERM_PROGRAM
  if (program === 'Apple_Terminal') return 'ansi256'
  if (program === 'iTerm.app') {
    const ver = env.TERM_PROGRAM_VERSION ?? ''
    const major = Number.parseInt(ver.split('.')[0] ?? '0', 10)
    return major >= 3 ? 'truecolor' : 'ansi256'
  }
  if (
    program === 'vscode' ||
    program === 'WezTerm' ||
    program === 'WarpTerminal' ||
    program === 'ghostty' ||
    program === 'Hyper' ||
    program === 'tabby' ||
    program === 'mintty'
  ) {
    return 'truecolor'
  }

  const term = env.TERM ?? ''
  if (term === 'dumb') return 'none'
  if (term === 'xterm-kitty' || term.startsWith('alacritty') || term.endsWith('-direct')) {
    return 'truecolor'
  }

  return 'ansi256'
}

export function buildTheme(name: ThemeName, opts: ThemeOptions = {}): Theme {
  const palette = PALETTES[name]
  const depth = detectColorDepth(opts)
  const colorEnabled = depth !== 'none'

  const codeOf = (role: ThemeRole): string => {
    if (depth === 'none') return ''
    const entry = palette[role]
    if (depth === 'truecolor') {
      const [r, g, b] = entry.rgb
      return `\x1b[38;2;${r};${g};${b}m`
    }
    return `\x1b[38;5;${entry.ansi256}m`
  }

  const reset = (): string => (colorEnabled ? FULL_RESET : '')

  const style = (role: ThemeRole, text: string): string => {
    const code = codeOf(role)
    return code ? `${code}${text}${FULL_RESET}` : text
  }

  const bold = (role: ThemeRole | null, text: string): string => {
    if (!colorEnabled) return text
    const color = role ? codeOf(role) : ''
    return `\x1b[1m${color}${text}${FULL_RESET}`
  }

  return {
    name,
    code: codeOf,
    style,
    bold,
    reset,
    colorEnabled,
    depth,
  }
}
