/**
 * FileReadTool — read file contents with optional line ranges.
 *
 * Read-only, concurrent-safe. Updates readFileState after every read
 * so FileWriteTool/FileEditTool can detect stale overwrites.
 *
 * UTF-8 only. 10 MB size cap. No binary/encoding detection in v1.
 */

import { promises as fs } from 'fs'
import path from 'path'

import { buildTool } from '../core/tools/types.js'
import { markRead } from '../core/tools/fileStateCache.js'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export const FileReadTool = buildTool({
  name: 'FileRead',
  description: 'Read file contents with optional line range. Returns numbered lines. Use this instead of cat/head/tail.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from (0-based)' },
      limit: { type: 'number', description: 'Maximum number of lines to read' },
    },
    required: ['file_path'],
  },
  isMutating: false,
  isReadOnly: true,
  isConcurrencySafe: () => true,
  getPath: (input) => (typeof input.file_path === 'string' ? input.file_path : ''),

  async validateInput(input) {
    if (typeof input.file_path !== 'string' || input.file_path.trim() === '') {
      return { valid: false, message: 'file_path must be a non-empty string' }
    }
    if (input.offset !== undefined && (typeof input.offset !== 'number' || input.offset < 0)) {
      return { valid: false, message: 'offset must be a non-negative number' }
    }
    if (input.limit !== undefined && (typeof input.limit !== 'number' || input.limit < 0)) {
      return { valid: false, message: 'limit must be a non-negative number' }
    }
    return { valid: true }
  },

  async call(input, context) {
    const filePath = path.resolve(input.file_path as string)

    // Stat first — check size, existence, type
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return { content: `File not found: ${filePath}`, isError: true }
      }
      return { content: `Error reading file: ${(err as Error).message}`, isError: true }
    }

    if (stat.isDirectory()) {
      return { content: `Path is a directory, not a file: ${filePath}`, isError: true }
    }

    if (stat.size > MAX_FILE_SIZE) {
      return {
        content: `File is too large to read (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`,
        isError: true,
      }
    }

    // Read full content
    let fullContent: string
    try {
      fullContent = await fs.readFile(filePath, 'utf8')
    } catch (err: unknown) {
      return { content: `Error reading file: ${(err as Error).message}`, isError: true }
    }

    // Cache full content for stale detection (before slicing)
    markRead(context.readFileState, filePath, fullContent, stat.mtimeMs)

    // Apply offset/limit
    const lines = fullContent.split('\n')
    const offset = typeof input.offset === 'number' ? input.offset : 0
    const limit = typeof input.limit === 'number' ? input.limit : lines.length
    const sliced = lines.slice(offset, offset + limit)

    // Format with 1-based line numbers
    const formatted = sliced
      .map((line, i) => `${offset + i + 1}\t${line}`)
      .join('\n')

    return { content: formatted, isError: false }
  },
})
