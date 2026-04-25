/**
 * Namespacing rules for MCP tools.
 *
 * Qualified name shape: `mcp__<serverName>__<sanitizedToolName>`.
 *
 * Server names are validated at config load and must match
 * /^[a-z0-9][a-z0-9-]{0,63}$/ — no underscores allowed. Because the server
 * segment has no `_`, the `__` separator is unambiguous: a parser can greedy-
 * split on the first `__` after the `mcp__` prefix and safely recover both
 * parts, even if the tool name itself contains underscores or `__`.
 *
 * Tool names come from the MCP server and cannot be constrained; they are
 * sanitized on ingest (non-alphanumeric → `_`, collapsed, stripped, fallback
 * to `tool_<index>`). Within-server collisions get a `_<index>` suffix.
 */

export const MCP_TOOL_PREFIX = 'mcp__'
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name)
}

export function qualifyToolName(serverName: string, sanitizedToolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${sanitizedToolName}`
}

export function parseQualifiedName(
  qualified: string,
): { serverName: string; toolName: string } | null {
  if (!qualified.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = qualified.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  const serverName = rest.slice(0, sep)
  const toolName = rest.slice(sep + 2)
  if (toolName.length === 0) return null
  if (!isValidServerName(serverName)) return null
  return { serverName, toolName }
}

export function sanitizeToolName(raw: string, fallbackIndex: number): string {
  const replaced = raw.replace(/[^A-Za-z0-9]+/g, '_')
  const collapsed = replaced.replace(/_+/g, '_')
  const stripped = collapsed.replace(/^_+|_+$/g, '')
  if (stripped.length === 0) return `tool_${fallbackIndex}`
  return stripped
}
