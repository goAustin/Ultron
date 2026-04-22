/**
 * Attachment generation — detects workspace changes after tool execution
 * and injects per-turn context updates as system-reminder messages.
 *
 * Volatile state (git status, project instructions) lives here, not in
 * the system prompt. The system prompt is static policy only.
 */

import { randomUUID } from 'node:crypto'

import type { UserMessage, ToolUseBlock } from '../core/messages.js'
import { createUserMessage, messageId } from '../core/messages.js'
import type { Attachment, DateChangeAttachment, ToolExecution } from './attachmentTypes.js'
import { getProjectInstructions, clearUserContextCache } from './userContext.js'
import { getSystemContext, clearSystemContextCache } from './systemContext.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GetAttachmentsFn = (
  executions: readonly ToolExecution[],
) => Promise<UserMessage[]>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WRITE_TOOL_NAMES = new Set(['FileEdit', 'FileWrite', 'Bash'])

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderAttachment(attachment: Attachment): string {
  switch (attachment.type) {
    case 'git_status':
      return `<system-reminder>\nGit status has been updated after tool execution:\n${attachment.status}\n</system-reminder>`
    case 'project_instructions':
      return `<system-reminder>\nProject instructions (CLAUDE.md) have been updated:\n${attachment.content}\n</system-reminder>`
    case 'file_change':
      return `<system-reminder>\nFile ${attachment.action}: ${attachment.path}\n</system-reminder>`
    case 'date_change':
      return `<system-reminder>\nThe date has changed. Today's date is now ${attachment.newDate}.\n</system-reminder>`
  }
}

// ---------------------------------------------------------------------------
// Initial attachments (first turn)
// ---------------------------------------------------------------------------

/**
 * Generate attachment messages for session start.
 * Provides git status and project instructions as the initial context.
 * Called by the session caller before query(), prepended to params.messages.
 */
export async function getInitialAttachments(cwd: string): Promise<UserMessage[]> {
  const [projectInstructions, systemCtx] = await Promise.all([
    getProjectInstructions(cwd),
    getSystemContext(cwd),
  ])

  const attachments: Attachment[] = []

  if (systemCtx.gitStatus) {
    attachments.push({ type: 'git_status', status: systemCtx.gitStatus })
  }

  if (projectInstructions) {
    attachments.push({ type: 'project_instructions', content: projectInstructions })
  }

  return attachments.map(toMessage)
}

// ---------------------------------------------------------------------------
// Per-turn attachment factory
// ---------------------------------------------------------------------------

/**
 * Build a GetAttachmentsFn that captures `cwd` and tracks date state.
 * Called after tool execution in the query loop to inject context updates.
 */
export function buildGetAttachments(cwd: string): GetAttachmentsFn {
  let lastEmittedDate = new Date().toISOString().slice(0, 10)

  return async (executions: readonly ToolExecution[]): Promise<UserMessage[]> => {
    const attachments: Attachment[] = []

    // Identify successful write tools
    const successfulWrites = executions.filter(
      (e) => WRITE_TOOL_NAMES.has(e.toolUse.name) && !e.result.isError,
    )

    if (successfulWrites.length === 0) {
      // Only check date change when no writes happened
      const dateAttachment = checkDateChange(lastEmittedDate)
      if (dateAttachment) {
        lastEmittedDate = dateAttachment.newDate
        return [toMessage(dateAttachment)]
      }
      return []
    }

    // File change attachments (FileEdit/FileWrite only, not Bash)
    const modifiedPaths: string[] = []
    for (const exec of successfulWrites) {
      if (exec.toolUse.name === 'Bash') continue

      const filePath = extractFilePath(exec.toolUse)
      if (!filePath) continue

      modifiedPaths.push(filePath)
      attachments.push({
        type: 'file_change',
        path: filePath,
        action: exec.toolUse.name === 'FileEdit' ? 'edited' : 'created',
      })
    }

    // Project instructions refresh (if CLAUDE.md was modified)
    const claudeMdModified = modifiedPaths.some((p) => p.endsWith('CLAUDE.md'))
    if (claudeMdModified) {
      clearUserContextCache(cwd)
      const instructions = await getProjectInstructions(cwd)
      if (instructions) {
        attachments.push({ type: 'project_instructions', content: instructions })
      }
    }

    // Git status refresh (any write tool succeeded)
    clearSystemContextCache(cwd)
    const systemCtx = await getSystemContext(cwd)
    if (systemCtx.gitStatus) {
      attachments.push({ type: 'git_status', status: systemCtx.gitStatus })
    }

    // Date change
    const dateAttachment = checkDateChange(lastEmittedDate)
    if (dateAttachment) {
      lastEmittedDate = dateAttachment.newDate
      attachments.push(dateAttachment)
    }

    return attachments.map(toMessage)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFilePath(toolUse: ToolUseBlock): string | null {
  const fp = toolUse.input.file_path
  return typeof fp === 'string' && fp.trim() ? fp : null
}

function checkDateChange(lastDate: string): DateChangeAttachment | null {
  const now = new Date().toISOString().slice(0, 10)
  if (now === lastDate) return null
  return { type: 'date_change', newDate: now }
}

function toMessage(attachment: Attachment): UserMessage {
  return createUserMessage(renderAttachment(attachment), {
    id: messageId(randomUUID()),
    flags: { isAttachment: true },
  })
}
