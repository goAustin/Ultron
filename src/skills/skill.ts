/**
 * Skill entry type + wire-format codec.
 *
 * On-disk shape: `<baseDir>/skills/<id>/SKILL.md`, a Markdown file with
 * strict frontmatter (JSON-escaped double-quoted scalars OR bare
 * identifiers) and a verbatim body. The frontmatter uses kebab-case
 * keys (`allowed-tools`, `argument-hint`) matching the Codex/Claude
 * Code skill-package convention; the TypeScript `Skill` type keeps
 * idiomatic camelCase.
 *
 * Required frontmatter: `name`, `description`.
 * Optional frontmatter: `allowed-tools`, `argument-hint`, `schemaVersion`,
 * `createdAt`, `updatedAt`. Missing timestamps fall back to file stat at
 * read time so hand-authored skills from other tools parse without
 * modification.
 *
 * The helpers (`quoteScalar`, `unquoteScalar`, `canRoundTrip`) are
 * copied from `src/memory/entry.ts` rather than shared — keeps 5a
 * strictly additive; cross-module dedup is a separate cleanup.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Skill = {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly description: string
  readonly content: string
  readonly allowedTools?: readonly string[]
  readonly argumentHint?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export type SkillParseError =
  | 'bad_frontmatter'
  | 'missing_field'
  | 'bad_type'
  | 'bad_escape'
  | 'bad_allowed_tools'
  | 'bad_argument_hint'

export type ParsedSkill =
  | { ok: true; skill: Skill }
  | { ok: false; error: SkillParseError }

export type SkillStat = {
  readonly birthtimeMs?: number
  readonly mtimeMs?: number
}

// ---------------------------------------------------------------------------
// ID validation
// ---------------------------------------------------------------------------

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function validateId(id: string): boolean {
  return ID_PATTERN.test(id)
}

// ---------------------------------------------------------------------------
// Escape / unescape (JSON-string subset of YAML)
// ---------------------------------------------------------------------------

export function quoteScalar(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const ch = s[i]
    if (ch === '\\') {
      out += '\\\\'
    } else if (ch === '"') {
      out += '\\"'
    } else if (ch === '\n') {
      out += '\\n'
    } else if (ch === '\r') {
      out += '\\r'
    } else if (ch === '\t') {
      out += '\\t'
    } else if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0')
    } else {
      out += ch
    }
  }
  out += '"'
  return out
}

export function unquoteScalar(raw: string): string | null {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    return null
  }
  let out = ''
  let i = 1
  while (i < raw.length - 1) {
    const ch = raw[i]
    if (ch === '\\') {
      const next = raw[i + 1]
      if (next === undefined) return null
      switch (next) {
        case '\\': out += '\\'; i += 2; break
        case '"':  out += '"';  i += 2; break
        case '/':  out += '/';  i += 2; break
        case 'n':  out += '\n'; i += 2; break
        case 'r':  out += '\r'; i += 2; break
        case 't':  out += '\t'; i += 2; break
        case 'b':  out += '\b'; i += 2; break
        case 'f':  out += '\f'; i += 2; break
        case 'u': {
          const hex = raw.slice(i + 2, i + 6)
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return null
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
          break
        }
        default: return null
      }
    } else if (ch === '"' || ch === '\n' || ch === '\r') {
      return null
    } else {
      out += ch
      i++
    }
  }
  if (i !== raw.length - 1) return null
  return out
}

export function canRoundTrip(s: string): boolean {
  return unquoteScalar(quoteScalar(s)) === s
}

// ---------------------------------------------------------------------------
// Bare-scalar rule — values matching this regex may be emitted unquoted.
// The parser accepts both quoted and unquoted forms.
// ---------------------------------------------------------------------------

const BARE_SCALAR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 _\-./]*[A-Za-z0-9]$|^[A-Za-z0-9]$/

function isBareScalar(s: string): boolean {
  return BARE_SCALAR_PATTERN.test(s)
}

function emitScalar(s: string): string {
  return isBareScalar(s) ? s : quoteScalar(s)
}

function readScalar(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('"')) return unquoteScalar(trimmed)
  // Bare scalar — no quotes, no escape processing.
  return trimmed
}

// ---------------------------------------------------------------------------
// String-array parse/emit — used for `allowed-tools`.
// ---------------------------------------------------------------------------

/**
 * Parse a single-line quoted-string array: `[]`, `["a"]`, `["a", "b"]`,
 * `[ "a" , "b" ]`, `["a","b"]`. Returns null on anything else.
 *
 * Hand-parsed rather than JSON-parsed so the escape rules stay
 * consistent with scalars (no lone \b/\f in bare `"..."` that JSON.parse
 * would accept but our scalar parser wouldn't).
 */
export function parseStringArray(raw: string): readonly string[] | null {
  const trimmed = raw.trim()
  if (trimmed.length < 2) return null
  if (trimmed[0] !== '[' || trimmed[trimmed.length - 1] !== ']') return null

  const inner = trimmed.slice(1, -1).trim()
  if (inner.length === 0) return []

  const out: string[] = []
  let i = 0
  while (i < inner.length) {
    // Skip leading whitespace.
    while (i < inner.length && (inner[i] === ' ' || inner[i] === '\t')) i++
    if (i >= inner.length) return null
    if (inner[i] !== '"') return null

    // Scan a quoted string.
    let j = i + 1
    while (j < inner.length) {
      const ch = inner[j]
      if (ch === '\\') {
        j += 2
        continue
      }
      if (ch === '"') break
      if (ch === '\n' || ch === '\r') return null
      j++
    }
    if (j >= inner.length || inner[j] !== '"') return null

    const quoted = inner.slice(i, j + 1)
    const value = unquoteScalar(quoted)
    if (value === null) return null
    out.push(value)

    i = j + 1

    // Skip trailing whitespace then expect either `,` or end-of-inner.
    while (i < inner.length && (inner[i] === ' ' || inner[i] === '\t')) i++
    if (i >= inner.length) break
    if (inner[i] !== ',') return null
    i++
  }

  return out
}

function emitStringArray(xs: readonly string[]): string {
  return '[' + xs.map((s) => quoteScalar(s)).join(', ') + ']'
}

// ---------------------------------------------------------------------------
// Shape validation for allowed-tools / argument-hint
// ---------------------------------------------------------------------------

export function isValidAllowedTool(s: string): boolean {
  if (s.length === 0 || s.length > 128) return false
  if (s.includes('\n') || s.includes('\r')) return false
  return true
}

export function isValidArgumentHint(s: string): boolean {
  if (s.length === 0 || s.length > 256) return false
  if (s.includes('\n') || s.includes('\r')) return false
  return true
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

export function serializeSkill(skill: Skill): string {
  const createdIso = new Date(skill.createdAt).toISOString()
  const updatedIso = new Date(skill.updatedAt).toISOString()

  const lines: string[] = ['---']
  lines.push(`name: ${emitScalar(skill.name)}`)
  lines.push(`description: ${emitScalar(skill.description)}`)
  if (skill.allowedTools !== undefined) {
    lines.push(`allowed-tools: ${emitStringArray(skill.allowedTools)}`)
  }
  if (skill.argumentHint !== undefined) {
    lines.push(`argument-hint: ${emitScalar(skill.argumentHint)}`)
  }
  lines.push(`schemaVersion: ${skill.schemaVersion}`)
  lines.push(`createdAt: ${quoteScalar(createdIso)}`)
  lines.push(`updatedAt: ${quoteScalar(updatedIso)}`)
  lines.push('---', '', skill.content)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseSkillFile(
  id: string,
  raw: string,
  stat?: SkillStat,
): ParsedSkill {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return { ok: false, error: 'bad_frontmatter' }

  const rest = text.slice(4)
  const closingIdx = rest.indexOf('\n---')
  if (closingIdx === -1) return { ok: false, error: 'bad_frontmatter' }

  const frontmatter = rest.slice(0, closingIdx)
  let body = rest.slice(closingIdx + 4) // skip `\n---`
  if (body.startsWith('\n')) body = body.slice(1)
  if (body.startsWith('\n')) body = body.slice(1)

  const fields: Record<string, string> = {}
  for (const rawLine of frontmatter.split('\n')) {
    if (rawLine.trim() === '') continue
    const colon = rawLine.indexOf(':')
    if (colon === -1) return { ok: false, error: 'bad_frontmatter' }
    const key = rawLine.slice(0, colon).trim()
    const value = rawLine.slice(colon + 1)
    if (key.length === 0) return { ok: false, error: 'bad_frontmatter' }
    fields[key] = value
  }

  const nameRaw = fields['name']
  const descriptionRaw = fields['description']
  if (nameRaw === undefined || descriptionRaw === undefined) {
    return { ok: false, error: 'missing_field' }
  }

  const name = readScalar(nameRaw)
  const description = readScalar(descriptionRaw)
  if (name === null || description === null) {
    return { ok: false, error: 'bad_escape' }
  }

  // Optional: allowed-tools
  let allowedTools: readonly string[] | undefined = undefined
  if (fields['allowed-tools'] !== undefined) {
    const parsed = parseStringArray(fields['allowed-tools'])
    if (parsed === null) return { ok: false, error: 'bad_allowed_tools' }
    for (const item of parsed) {
      if (!isValidAllowedTool(item)) {
        return { ok: false, error: 'bad_allowed_tools' }
      }
    }
    allowedTools = parsed
  }

  // Optional: argument-hint
  let argumentHint: string | undefined = undefined
  if (fields['argument-hint'] !== undefined) {
    const hint = readScalar(fields['argument-hint'])
    if (hint === null) return { ok: false, error: 'bad_argument_hint' }
    if (!isValidArgumentHint(hint)) {
      return { ok: false, error: 'bad_argument_hint' }
    }
    argumentHint = hint
  }

  // Optional: schemaVersion
  let schemaVersion: 1 = 1
  if (fields['schemaVersion'] !== undefined) {
    const sv = fields['schemaVersion'].trim()
    if (sv !== '1') return { ok: false, error: 'bad_type' }
    schemaVersion = 1
  }

  // Optional: timestamps — with stat fallback.
  const fallbackCreated =
    stat?.birthtimeMs ?? stat?.mtimeMs ?? 0
  const fallbackUpdated = stat?.mtimeMs ?? 0

  let createdAt = fallbackCreated
  if (fields['createdAt'] !== undefined) {
    const iso = readScalar(fields['createdAt'])
    if (iso === null) return { ok: false, error: 'bad_escape' }
    const parsed = Date.parse(iso)
    if (Number.isNaN(parsed)) return { ok: false, error: 'bad_escape' }
    createdAt = parsed
  }

  let updatedAt = fallbackUpdated
  if (fields['updatedAt'] !== undefined) {
    const iso = readScalar(fields['updatedAt'])
    if (iso === null) return { ok: false, error: 'bad_escape' }
    const parsed = Date.parse(iso)
    if (Number.isNaN(parsed)) return { ok: false, error: 'bad_escape' }
    updatedAt = parsed
  }

  return {
    ok: true,
    skill: {
      schemaVersion,
      id,
      name,
      description,
      content: body,
      ...(allowedTools !== undefined && { allowedTools }),
      ...(argumentHint !== undefined && { argumentHint }),
      createdAt,
      updatedAt,
    },
  }
}
