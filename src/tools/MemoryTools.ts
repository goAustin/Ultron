/**
 * Memory tools — MemoryRead / MemoryWrite / MemoryEdit.
 *
 * Exposed to the model as three ordinary tools in the engine's registry.
 * Each tool captures `baseDir` + (for writes) `auditWriter` in its closure,
 * so `ToolUseContext` does not need to carry memory-specific capabilities.
 *
 * Permission posture mirrors the filesystem tools:
 * - Neither tool overrides `checkPermissions`; the cascade in
 *   src/core/permissions/permissions.ts handles rules/mode/fallback.
 * - `memorySecretSafetyCheck` (registered in filesystem.ts) denies
 *   high-confidence secret matches and asks on low-confidence matches
 *   before MemoryWrite / MemoryEdit's `call()` runs.
 * - MemoryWrite/MemoryEdit always pass `allowLowConfidenceSecrets: true`
 *   to the store; the store still rejects high-confidence matches as
 *   defense in depth.
 */

import { buildTool, type Tool, type ToolResult } from '../core/tools/types.js'
import type { AuditWriter } from '../audit/types.js'
import {
  MEMORY_TYPES,
  canRoundTrip,
  serializeEntry,
  validateId,
  type MemoryEntry,
  type MemoryType,
} from '../memory/entry.js'
import {
  EntryNotFoundError,
  EntryTooLargeError,
  InvalidEntryIdError,
  MAX_ENTRY_BYTES,
  MalformedEntryError,
  MemoryFullError,
  SecretInMemoryError,
  TooManyEntriesError,
  listEntries,
  readEntry,
  readIndex,
  writeEntry,
} from '../memory/store.js'

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export type MemoryToolsDeps = {
  readonly baseDir: string
  readonly auditWriter: AuditWriter
}

export function createMemoryTools(deps: MemoryToolsDeps): {
  read: Tool
  write: Tool
  edit: Tool
} {
  return {
    read: buildMemoryReadTool(deps.baseDir),
    write: buildMemoryWriteTool(deps.baseDir, deps.auditWriter),
    edit: buildMemoryEditTool(deps.baseDir, deps.auditWriter),
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const READ_LIST_CAP = 50

/**
 * Memory tools define `getPath` so that `permissionMode: 'acceptEdits'`
 * auto-allows them (the cascade checks `tool.getPath !== undefined` at
 * step 5). They deliberately return an empty string instead of a
 * synthetic `memory:<id>` path: `path.resolve` in
 * workingDirectorySafetyCheck uses `process.cwd()`, not the engine's
 * configured `cwd`, so any non-empty pseudo-path risks resolving outside
 * the allowed working directories and asking spuriously. Empty string
 * short-circuits the two filesystem safety checks (both guard with
 * `if (!filePath) return null`) while keeping the `getPath` function
 * defined for mode handling. Future per-id rule matching (4c) will need
 * a separate tool-metadata channel that does not route through
 * `path.resolve`.
 */
function synthPath(_id: unknown): string {
  return ''
}

function byteLen(entry: MemoryEntry): number {
  return Buffer.byteLength(serializeEntry(entry), 'utf8')
}

function errorResult(
  errorKind: ToolResult['errorKind'],
  content: string,
): ToolResult {
  return { content, isError: true, errorKind }
}

function mapStoreError(err: unknown): ToolResult {
  if (err instanceof InvalidEntryIdError) {
    return errorResult(
      'validation_failed',
      `invalid memory entry id: ${err.id}; must match [a-z0-9][a-z0-9_-]{0,63}`,
    )
  }
  if (err instanceof EntryTooLargeError) {
    return errorResult(
      'execution_error',
      `memory entry too large: ${err.bytes} bytes exceeds ${err.cap} byte cap`,
    )
  }
  if (err instanceof MemoryFullError) {
    return errorResult(
      'execution_error',
      `memory store full: ${err.totalBytes} bytes would exceed ${err.cap} byte cap`,
    )
  }
  if (err instanceof TooManyEntriesError) {
    return errorResult(
      'execution_error',
      `memory store at ${err.cap}-entry cap; delete an entry first`,
    )
  }
  if (err instanceof SecretInMemoryError) {
    const types = [...new Set(err.matches.map((m) => m.type))].join(', ')
    return errorResult(
      'permission_denied',
      `memory entry contains credential pattern: ${types}`,
    )
  }
  if (err instanceof MalformedEntryError) {
    return errorResult(
      'execution_error',
      `memory entry has unencodable content: ${err.message}`,
    )
  }
  if (err instanceof EntryNotFoundError) {
    return errorResult(
      'execution_error',
      `memory entry not found: ${err.id}`,
    )
  }
  return errorResult(
    'execution_error',
    err instanceof Error ? err.message : String(err),
  )
}

// ---------------------------------------------------------------------------
// MemoryRead
// ---------------------------------------------------------------------------

function renderList(entries: readonly MemoryEntry[]): string {
  const header = 'id\ttype\tname\tdescription\tbytes'
  const rows = entries.map((e) => {
    const bytes = byteLen(e)
    return `${e.id}\t${e.type}\t${e.name}\t${e.description}\t${bytes}`
  })
  return [header, ...rows].join('\n')
}

function renderEntry(entry: MemoryEntry): string {
  return [
    `id: ${entry.id}`,
    `type: ${entry.type}`,
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `createdAt: ${new Date(entry.createdAt).toISOString()}`,
    `updatedAt: ${new Date(entry.updatedAt).toISOString()}`,
    '',
    entry.content,
  ].join('\n')
}

function buildMemoryReadTool(baseDir: string): Tool {
  return buildTool({
    name: 'MemoryRead',
    description:
      'Inspect the user-scoped memory store. mode="list" shows all entries ' +
      '(up to 50), mode="get" with id returns one entry in full, mode="index" ' +
      'returns MEMORY.md. Memory persists across sessions under ~/.ultron/memory/.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['list', 'get', 'index'],
          description: 'Which view of the store to return.',
        },
        id: {
          type: 'string',
          description: 'Required when mode="get". Slug: [a-z0-9][a-z0-9_-]{0,63}.',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Optional filter for mode="list".',
        },
      },
      required: ['mode'],
    },
    isMutating: false,
    isReadOnly: true,
    isConcurrencySafe: () => true,
    getPath: (input) => synthPath(input.id),

    async validateInput(input) {
      const mode = input.mode
      if (mode !== 'list' && mode !== 'get' && mode !== 'index') {
        return {
          valid: false,
          message: 'mode must be one of: list, get, index',
        }
      }
      if (mode === 'get') {
        if (typeof input.id !== 'string' || input.id.length === 0) {
          return { valid: false, message: 'mode="get" requires a non-empty id' }
        }
        if (!validateId(input.id)) {
          return {
            valid: false,
            message: 'id must match [a-z0-9][a-z0-9_-]{0,63}',
          }
        }
      }
      if (input.type !== undefined) {
        if (
          typeof input.type !== 'string' ||
          !(MEMORY_TYPES as readonly string[]).includes(input.type)
        ) {
          return {
            valid: false,
            message: 'type must be one of: user, feedback, project, reference',
          }
        }
      }
      return { valid: true }
    },

    async call(input) {
      const mode = input.mode as 'list' | 'get' | 'index'
      try {
        if (mode === 'list') {
          const filter =
            typeof input.type === 'string'
              ? { type: input.type as MemoryType }
              : undefined
          const entries = await listEntries(baseDir, filter)
          if (entries.length === 0) {
            return { content: '(memory is empty)', isError: false }
          }
          const capped = entries.slice(0, READ_LIST_CAP)
          const overflow = entries.length - capped.length
          const body = renderList(capped)
          const content =
            overflow > 0
              ? `${body}\n... ${overflow} more entries (use mode="get" with id to read)`
              : body
          return { content, isError: false }
        }

        if (mode === 'get') {
          const id = input.id as string
          const entry = await readEntry(baseDir, id)
          if (entry === null) {
            return errorResult(
              'execution_error',
              `memory entry "${id}" does not exist`,
            )
          }
          return { content: renderEntry(entry), isError: false }
        }

        // mode === 'index'
        const text = await readIndex(baseDir)
        return {
          content: text.length === 0 ? '(memory is empty)' : text,
          isError: false,
        }
      } catch (err) {
        return mapStoreError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// MemoryWrite
// ---------------------------------------------------------------------------

function buildMemoryWriteTool(
  baseDir: string,
  auditWriter: AuditWriter,
): Tool {
  return buildTool({
    name: 'MemoryWrite',
    description:
      'Create or overwrite a memory entry. Entries are typed ' +
      '(user/feedback/project/reference) and persist across sessions. Use ' +
      'for stable facts the user wants remembered; prefer MemoryEdit for ' +
      'incremental changes. Entry <32 KB; total store <2 MB; max 256 ' +
      'entries. Credentials are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Slug: [a-z0-9][a-z0-9_-]{0,63}',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
        },
        name: { type: 'string' },
        description: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['id', 'type', 'name', 'description', 'content'],
    },
    getPath: (input) => synthPath(input.id),

    async validateInput(input) {
      for (const key of ['id', 'type', 'name', 'description', 'content']) {
        if (typeof input[key] !== 'string') {
          return { valid: false, message: `${key} must be a string` }
        }
      }
      const id = input.id as string
      if (!validateId(id)) {
        return {
          valid: false,
          message: 'id must match [a-z0-9][a-z0-9_-]{0,63}',
        }
      }
      const type = input.type as string
      if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
        return {
          valid: false,
          message: 'type must be one of: user, feedback, project, reference',
        }
      }
      const name = input.name as string
      const description = input.description as string
      if (!canRoundTrip(name)) {
        return {
          valid: false,
          message: 'name contains characters that cannot be encoded',
        }
      }
      if (!canRoundTrip(description)) {
        return {
          valid: false,
          message: 'description contains characters that cannot be encoded',
        }
      }
      // Preview size check — avoids an I/O round trip for obviously-too-big
      // writes. The store enforces authoritatively on write.
      const preview = serializeEntry({
        schemaVersion: 1,
        id,
        type: type as MemoryType,
        name,
        description,
        content: input.content as string,
        createdAt: 0,
        updatedAt: 0,
      })
      if (Buffer.byteLength(preview, 'utf8') > MAX_ENTRY_BYTES) {
        return {
          valid: false,
          message: `entry exceeds ${MAX_ENTRY_BYTES}-byte cap`,
        }
      }
      return { valid: true }
    },

    async call(input) {
      const id = input.id as string
      const type = input.type as MemoryType
      const name = input.name as string
      const description = input.description as string
      const content = input.content as string
      const now = Date.now()

      try {
        const prior = await readEntry(baseDir, id)
        const entry: MemoryEntry = {
          schemaVersion: 1,
          id,
          type,
          name,
          description,
          content,
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        }
        await writeEntry(baseDir, entry, auditWriter, {
          allowLowConfidenceSecrets: true,
        })
        const verb = prior ? 'updated' : 'created'
        return {
          content: `memory entry "${id}" ${verb} (${byteLen(entry)} bytes)`,
          isError: false,
        }
      } catch (err) {
        return mapStoreError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// MemoryEdit
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

function buildMemoryEditTool(
  baseDir: string,
  auditWriter: AuditWriter,
): Tool {
  return buildTool({
    name: 'MemoryEdit',
    description:
      'Edit an existing memory entry. Either full-body replace (content) or ' +
      'exact substring replace (old_string/new_string, optional replace_all). ' +
      'Optional name/description/type overwrite metadata. Fails if entry absent.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: {
          type: 'string',
          description: 'Full replacement body. Mutually exclusive with old_string/new_string.',
        },
        old_string: {
          type: 'string',
          description: 'Exact substring to replace. Requires new_string.',
        },
        new_string: { type: 'string' },
        replace_all: {
          type: 'boolean',
          description: 'When true, replace every occurrence of old_string.',
        },
        name: { type: 'string' },
        description: { type: 'string' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
        },
      },
      required: ['id'],
    },
    getPath: (input) => synthPath(input.id),

    async validateInput(input) {
      if (typeof input.id !== 'string') {
        return { valid: false, message: 'id must be a string' }
      }
      if (!validateId(input.id)) {
        return {
          valid: false,
          message: 'id must match [a-z0-9][a-z0-9_-]{0,63}',
        }
      }

      const hasContent = typeof input.content === 'string'
      const hasOld = typeof input.old_string === 'string'
      const hasNew = typeof input.new_string === 'string'

      if (hasContent && (hasOld || hasNew)) {
        return {
          valid: false,
          message: 'content and old_string/new_string are mutually exclusive',
        }
      }
      if (!hasContent && !(hasOld && hasNew)) {
        return {
          valid: false,
          message:
            'provide either content (full replace) or both old_string and new_string',
        }
      }
      if (hasOld && hasNew && input.old_string === input.new_string) {
        return {
          valid: false,
          message: 'old_string and new_string are identical; no change to apply',
        }
      }

      if (typeof input.name === 'string' && !canRoundTrip(input.name)) {
        return {
          valid: false,
          message: 'name contains characters that cannot be encoded',
        }
      }
      if (
        typeof input.description === 'string' &&
        !canRoundTrip(input.description)
      ) {
        return {
          valid: false,
          message: 'description contains characters that cannot be encoded',
        }
      }
      if (
        input.type !== undefined &&
        (typeof input.type !== 'string' ||
          !(MEMORY_TYPES as readonly string[]).includes(input.type))
      ) {
        return {
          valid: false,
          message: 'type must be one of: user, feedback, project, reference',
        }
      }
      if (input.replace_all !== undefined && typeof input.replace_all !== 'boolean') {
        return { valid: false, message: 'replace_all must be a boolean' }
      }
      return { valid: true }
    },

    async call(input) {
      const id = input.id as string

      try {
        const prior = await readEntry(baseDir, id)
        if (prior === null) {
          return errorResult(
            'execution_error',
            `memory entry "${id}" does not exist; use MemoryWrite to create it`,
          )
        }

        let nextContent: string
        if (typeof input.content === 'string') {
          nextContent = input.content
        } else {
          const oldString = input.old_string as string
          const newString = input.new_string as string
          const count = countOccurrences(prior.content, oldString)
          if (count === 0) {
            return errorResult(
              'execution_error',
              'string to replace not found in entry body',
            )
          }
          const replaceAll = input.replace_all === true
          if (count > 1 && !replaceAll) {
            return errorResult(
              'execution_error',
              `found ${count} matches; pass replace_all=true or narrow old_string`,
            )
          }
          nextContent = replaceAll
            ? prior.content.split(oldString).join(newString)
            : prior.content.replace(oldString, newString)
        }

        const next: MemoryEntry = {
          schemaVersion: 1,
          id: prior.id,
          type:
            typeof input.type === 'string'
              ? (input.type as MemoryType)
              : prior.type,
          name: typeof input.name === 'string' ? input.name : prior.name,
          description:
            typeof input.description === 'string'
              ? input.description
              : prior.description,
          content: nextContent,
          createdAt: prior.createdAt,
          updatedAt: Date.now(),
        }

        await writeEntry(baseDir, next, auditWriter, {
          allowLowConfidenceSecrets: true,
        })
        return {
          content: `memory entry "${id}" edited (${byteLen(next)} bytes)`,
          isError: false,
        }
      } catch (err) {
        return mapStoreError(err)
      }
    },
  })
}
