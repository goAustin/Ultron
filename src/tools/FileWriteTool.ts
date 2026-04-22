/**
 * FileWriteTool — create new files or overwrite existing ones.
 *
 * Requires prior read for overwrites (stale detection via mtime).
 * File creation without prior read is allowed.
 * Sync critical section between staleness check and write.
 */

import { promises as fs } from 'fs'
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'fs'
import path from 'path'

import { buildTool } from '../core/tools/types.js'
import { hasBeenRead, getReadState, markRead } from '../core/tools/fileStateCache.js'

export const FileWriteTool = buildTool({
  name: 'FileWrite',
  description: 'Create or overwrite a file with the given content. The file_path must be an absolute path.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to write' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['file_path', 'content'],
  },
  getPath: (input) => (typeof input.file_path === 'string' ? path.resolve(input.file_path) : ''),

  async validateInput(input, context) {
    if (typeof input.file_path !== 'string' || input.file_path.trim() === '') {
      return { valid: false, message: 'file_path must be a non-empty string' }
    }
    if (typeof input.content !== 'string') {
      return { valid: false, message: 'content must be a string' }
    }

    const filePath = path.resolve(input.file_path)

    // Check if file exists
    let exists = false
    try {
      await fs.stat(filePath)
      exists = true
    } catch {
      // File doesn't exist — creation is allowed without prior read
    }

    if (exists) {
      if (!hasBeenRead(context.readFileState, filePath)) {
        return {
          valid: false,
          message: 'File has not been read yet. Read it first before overwriting.',
        }
      }
      const cached = getReadState(context.readFileState, filePath)!
      let currentStat
      try {
        currentStat = await fs.stat(filePath)
      } catch {
        return { valid: false, message: 'File disappeared during validation' }
      }
      if (currentStat.mtimeMs > cached.mtime) {
        return {
          valid: false,
          message: 'File has been modified since it was last read. Read it again before overwriting.',
        }
      }
    }

    return { valid: true }
  },

  async call(input, context) {
    const filePath = path.resolve(input.file_path as string)
    const content = input.content as string

    // Async prep: ensure parent directory exists
    mkdirSync(path.dirname(filePath), { recursive: true })

    // Determine if this is a create or update
    let isUpdate = false
    try {
      const currentStat = statSync(filePath)
      isUpdate = true

      // Sync critical section: re-check staleness before write
      const cached = getReadState(context.readFileState, filePath)
      if (cached && currentStat.mtimeMs > cached.mtime) {
        return {
          content: 'File has been modified since it was last read. Read it again before overwriting.',
          isError: true,
        }
      }
    } catch {
      // File doesn't exist — creating new file
    }

    // Write
    writeFileSync(filePath, content, 'utf8')

    // Update readFileState
    const newStat = statSync(filePath)
    markRead(context.readFileState, filePath, content, newStat.mtimeMs)

    const action = isUpdate ? 'File updated' : 'File created'
    return { content: `${action}: ${filePath}`, isError: false }
  },
})
