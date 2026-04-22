/**
 * FileEditTool — exact string replacement in existing files.
 *
 * Edit-only: rejects nonexistent files. File creation belongs in FileWriteTool.
 * Requires prior read. Stale detection via mtime comparison.
 * Sync critical section between staleness re-check and write.
 */

import { promises as fs } from 'fs'
import { readFileSync, writeFileSync, statSync } from 'fs'
import path from 'path'

import { buildTool } from '../core/tools/types.js'
import { hasBeenRead, getReadState, markRead } from '../core/tools/fileStateCache.js'

export const FileEditTool = buildTool({
  name: 'FileEdit',
  description: 'Replace an exact string occurrence in an existing file. The file must have been read first.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to edit' },
      old_string: { type: 'string', description: 'Exact string to find and replace' },
      new_string: { type: 'string', description: 'Replacement string' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  getPath: (input) => (typeof input.file_path === 'string' ? path.resolve(input.file_path) : ''),

  async validateInput(input, context) {
    if (typeof input.file_path !== 'string' || input.file_path.trim() === '') {
      return { valid: false, message: 'file_path must be a non-empty string' }
    }
    if (typeof input.old_string !== 'string') {
      return { valid: false, message: 'old_string must be a string' }
    }
    if (typeof input.new_string !== 'string') {
      return { valid: false, message: 'new_string must be a string' }
    }

    const oldStr = input.old_string as string
    const newStr = input.new_string as string

    // Reject no-op edits
    if (oldStr === newStr) {
      return { valid: false, message: 'No changes to make: old_string and new_string are the same.' }
    }

    const filePath = path.resolve(input.file_path as string)

    // File must exist (FileEditTool is edit-only)
    let currentStat
    try {
      currentStat = await fs.stat(filePath)
    } catch {
      return { valid: false, message: `File does not exist: ${filePath}` }
    }

    // Require prior read
    if (!hasBeenRead(context.readFileState, filePath)) {
      return { valid: false, message: 'File has not been read yet. Read it first before editing.' }
    }

    // Check staleness
    const cached = getReadState(context.readFileState, filePath)!
    if (currentStat.mtimeMs > cached.mtime) {
      return {
        valid: false,
        message: 'File has been modified since it was last read. Read it again before editing.',
      }
    }

    // Read content and check for old_string
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch (err: unknown) {
      return { valid: false, message: `Error reading file: ${(err as Error).message}` }
    }

    if (!content.includes(oldStr)) {
      return { valid: false, message: `String to replace not found in file.\nString: ${oldStr}` }
    }

    // Check match count
    const replaceAll = input.replace_all === true
    if (!replaceAll) {
      const matches = content.split(oldStr).length - 1
      if (matches > 1) {
        return {
          valid: false,
          message: `Found ${matches} matches of the string to replace, but replace_all is false. Set replace_all to true to replace all occurrences, or provide more context to uniquely identify the instance.`,
        }
      }
    }

    return { valid: true }
  },

  async call(input, context) {
    const filePath = path.resolve(input.file_path as string)
    const oldStr = input.old_string as string
    const newStr = input.new_string as string
    const replaceAll = input.replace_all === true

    // Sync critical section
    const content = readFileSync(filePath, 'utf8')

    // Re-check staleness
    const currentStat = statSync(filePath)
    const cached = getReadState(context.readFileState, filePath)
    if (cached && currentStat.mtimeMs > cached.mtime) {
      return {
        content: 'File has been modified since it was last read. Read it again before editing.',
        isError: true,
      }
    }

    const updated = replaceAll
      ? content.replaceAll(oldStr, newStr)
      : content.replace(oldStr, newStr)

    writeFileSync(filePath, updated, 'utf8')

    // Update readFileState
    const newStat = statSync(filePath)
    markRead(context.readFileState, filePath, updated, newStat.mtimeMs)

    return { content: `File edited: ${filePath}`, isError: false }
  },
})
