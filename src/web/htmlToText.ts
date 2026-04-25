/**
 * Minimal HTML → plain text conversion for WebFetch responses.
 *
 * Pure functions, no I/O, no dependency. Quality is "good enough for an
 * LLM to read", not pretty for humans. Drops <script>/<style>/<noscript>,
 * inserts newlines for block tags, strips remaining tags, decodes a
 * fixed entity table plus numeric refs, collapses runs of whitespace.
 *
 * A future swap to `turndown` or `node-html-markdown` for higher fidelity
 * is a clean drop-in behind the same `htmlToText(html)` function.
 */

const ENTITY_TABLE: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const num = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return match
      try {
        return String.fromCodePoint(num)
      } catch {
        return match
      }
    }
    const named = ENTITY_TABLE[body.toLowerCase()]
    return named ?? match
  })
}

export function collapseWhitespace(s: string): string {
  // Collapse runs of spaces/tabs to a single space, runs of newlines to
  // at most two, strip whitespace around newlines.
  let out = s.replace(/[ \t\f\v]+/g, ' ')
  out = out.replace(/ ?\n ?/g, '\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out
}

export function htmlToText(html: string): string {
  let s = html
  // Drop noisy blocks entirely.
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, '')
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, '')
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
  // Drop comments.
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  // Block-introducing tags → newline.
  s = s.replace(/<(br|p|li|tr|div|h[1-6])\b[^>]*>/gi, '\n')
  s = s.replace(/<\/(p|li|tr|div|h[1-6])>/gi, '\n')
  // Strip everything else.
  s = s.replace(/<[^>]+>/g, '')
  // Decode entities AFTER tag strip so &lt;script&gt; in body text doesn't
  // become a real <script> match.
  s = decodeEntities(s)
  s = collapseWhitespace(s)
  return s.trim()
}
