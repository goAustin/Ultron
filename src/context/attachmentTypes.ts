/**
 * Attachment type definitions for Phase 8.
 *
 * Attachments are structured data representing per-turn dynamic context
 * injected into the conversation after tool execution.
 */

import type { ToolUseBlock } from '../core/messages.js'

// ---------------------------------------------------------------------------
// Tool execution result pairing
// ---------------------------------------------------------------------------

export type ToolExecution = {
  readonly toolUse: ToolUseBlock
  readonly result: { readonly content: string; readonly isError: boolean }
}

// ---------------------------------------------------------------------------
// Attachment types
// ---------------------------------------------------------------------------

export type GitStatusAttachment = {
  readonly type: 'git_status'
  readonly status: string
}

export type ProjectInstructionsAttachment = {
  readonly type: 'project_instructions'
  readonly content: string
}

export type FileChangeAttachment = {
  readonly type: 'file_change'
  readonly path: string
  readonly action: 'edited' | 'created'
}

export type DateChangeAttachment = {
  readonly type: 'date_change'
  readonly newDate: string
}

export type Attachment =
  | GitStatusAttachment
  | ProjectInstructionsAttachment
  | FileChangeAttachment
  | DateChangeAttachment
