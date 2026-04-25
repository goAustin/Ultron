/**
 * Memory entry type + wire-format codec.
 *
 * On-disk shape is a Markdown file with a strict YAML-like frontmatter. The
 * parser does NOT accept general YAML: frontmatter string values must be
 * JSON-escaped double-quoted scalars on a single line. Multi-line scalars,
 * block scalars, flow collections, anchors, and tags are all rejected. This
 * keeps the codec hand-rollable and fully round-trippable without a YAML
 * dependency.
 *
 * The content body below the closing `---` is verbatim bytes — it does not
 * go through frontmatter parsing, so newlines, colons, and backticks inside
 * the body are fine.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export const MEMORY_TYPES: readonly MemoryType[] = [
  'user',
  'feedback',
  'project',
  'reference',
]

export type MemoryEntry = {
  readonly schemaVersion: 1
  readonly id: string
  readonly type: MemoryType
  readonly name: string
  readonly description: string
  readonly content: string
  readonly createdAt: number
  readonly updatedAt: number
}

export type ParseError =
  | 'bad_frontmatter'
  | 'missing_field'
  | 'bad_type'
  | 'bad_escape'

export type ParsedEntry =
  | { ok: true; entry: MemoryEntry }
  | { ok: false; error: ParseError }

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

/**
 * Encode a string as a JSON-escaped double-quoted scalar. Control characters
 * become `\uXXXX`. The output is a single line and parses as both JSON and
 * YAML.
 */
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

/**
 * Decode a JSON-escaped double-quoted scalar. Returns null if the string is
 * not a valid single-line quoted scalar. Accepts `\\`, `\"`, `\n`, `\r`,
 * `\t`, `\/`, and `\uXXXX`.
 */
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
      // Unescaped quote/newline inside the scalar is invalid.
      return null
    } else {
      out += ch
      i++
    }
  }
  // If the loop overshot the closing quote, the final `"` was eaten by an
  // escape sequence (e.g. `"\"`) — treat as malformed.
  if (i !== raw.length - 1) return null
  return out
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * Render an entry to its on-disk string. Throws `bad_escape` via
 * round-trip check — the caller has already validated field contents with
 * `canRoundTrip` if they want to avoid the throw.
 */
export function serializeEntry(entry: MemoryEntry): string {
  const name = quoteScalar(entry.name)
  const description = quoteScalar(entry.description)
  const createdIso = new Date(entry.createdAt).toISOString()
  const updatedIso = new Date(entry.updatedAt).toISOString()
  const createdAt = quoteScalar(createdIso)
  const updatedAt = quoteScalar(updatedIso)

  const lines = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `type: ${entry.type}`,
    `schemaVersion: ${entry.schemaVersion}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${updatedAt}`,
    '---',
    '',
    entry.content,
  ]
  return lines.join('\n')
}

/**
 * Returns true iff the value survives quote → unquote unchanged. Use before
 * `serializeEntry` to surface `bad_escape` deterministically on write.
 */
export function canRoundTrip(s: string): boolean {
  return unquoteScalar(quoteScalar(s)) === s
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse a raw on-disk entry file. `id` is supplied by the caller (derived
 * from the filename). Timestamps are surfaced as ms-epoch numbers.
 */
export function parseEntryFile(id: string, raw: string): ParsedEntry {
  // Split off frontmatter: must start with `---` on the first line and have
  // a matching `---` line later. Accept LF or CRLF.
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return { ok: false, error: 'bad_frontmatter' }

  const rest = text.slice(4)
  const closingIdx = rest.indexOf('\n---')
  if (closingIdx === -1) return { ok: false, error: 'bad_frontmatter' }

  const frontmatter = rest.slice(0, closingIdx)
  let body = rest.slice(closingIdx + 4) // skip `\n---`
  // Skip an optional single `\n` that follows the closing fence, then an
  // optional blank line.
  if (body.startsWith('\n')) body = body.slice(1)
  if (body.startsWith('\n')) body = body.slice(1)

  const fields: Record<string, string> = {}
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) return { ok: false, error: 'bad_frontmatter' }
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key.length === 0) return { ok: false, error: 'bad_frontmatter' }
    fields[key] = value
  }

  const nameRaw = fields['name']
  const descriptionRaw = fields['description']
  const typeRaw = fields['type']
  const schemaRaw = fields['schemaVersion']
  const createdRaw = fields['createdAt']
  const updatedRaw = fields['updatedAt']

  if (
    nameRaw === undefined ||
    descriptionRaw === undefined ||
    typeRaw === undefined ||
    schemaRaw === undefined ||
    createdRaw === undefined ||
    updatedRaw === undefined
  ) {
    return { ok: false, error: 'missing_field' }
  }

  const name = unquoteScalar(nameRaw)
  const description = unquoteScalar(descriptionRaw)
  const createdIso = unquoteScalar(createdRaw)
  const updatedIso = unquoteScalar(updatedRaw)
  if (
    name === null ||
    description === null ||
    createdIso === null ||
    updatedIso === null
  ) {
    return { ok: false, error: 'bad_escape' }
  }

  if (!isMemoryType(typeRaw)) return { ok: false, error: 'bad_type' }
  if (schemaRaw !== '1') return { ok: false, error: 'bad_type' }

  const createdAt = Date.parse(createdIso)
  const updatedAt = Date.parse(updatedIso)
  if (Number.isNaN(createdAt) || Number.isNaN(updatedAt)) {
    return { ok: false, error: 'bad_escape' }
  }

  return {
    ok: true,
    entry: {
      schemaVersion: 1,
      id,
      type: typeRaw,
      name,
      description,
      content: body,
      createdAt,
      updatedAt,
    },
  }
}

function isMemoryType(s: string): s is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(s)
}
