# Phase 14: Add Memory Safeguards

## Context

Ultron stores session transcripts under `~/.ultron/sessions/<uuid>/transcript.jsonl` and permission logs at `~/.ultron/permissions.jsonl`. The filesystem safety layer (Phase 5) already marks `.ultron` as a dangerous directory — mutating tools trigger `ask` via the non-bypassable `dangerousPathSafetyCheck`. But there are no guards against: secrets being written into long-lived memory, unbounded memory growth in the prompt path, or file permission laxity on the data directory.

Phase 14 adds two modules: a secret scanner that rejects writes containing obvious credential patterns, and a local memory guard that enforces size caps and directory permissions.

## Key Design Decisions

1. **Secret scanning is a content safety check, separate from filesystem path safety.** A new `secretContentSafetyCheck` lives in its own module (`src/memory/contentSafety.ts`), not inside `filesystem.ts`. It's added to the safety checks array and fires for mutating file tools (`FileWrite`, `FileEdit`). This keeps `filesystem.ts` focused on path-based checks while content inspection logic has its own clear home.

2. **Secret scanning targets all file writes, not just `~/.ultron/`.** Secrets in any file are a risk. For `FileWrite`: scan the `content` field. For `FileEdit`: compute the post-edit file content (apply `old_string → new_string` replacement against the file in `readFileState`) and scan the result. This catches cases where the replacement reconstructs a secret from partial fragments already in the file.

3. **Two-tier severity: high-confidence → deny, low-confidence → ask.** High-confidence patterns (real API key formats with specific prefixes/lengths, private key headers) return `deny` — these are almost certainly secrets. Low-confidence generic matches (`password = "..."` near keywords) return `ask` — the user decides, avoiding false positives in docs, tests, and examples.

4. **Stable, explicit detection type names.** Types like `aws_access_key_id`, `anthropic_api_key`, `openai_api_key`, `github_token`, `private_key`, `generic_secret_assignment`. These appear in user-facing denial reasons and test assertions, so they must be stable and descriptive.

5. **Pre-read transcript size check.** `resumeSession()` calls `stat()` on the transcript file BEFORE calling `readTranscript()`. If the file exceeds the threshold (default 10 MB), warn to stderr before loading. This protects against consuming all available memory before the warning fires.

6. **Directory permissions enforced on base Ultron directories.** `enforceBaseDirectoryPermissions` targets `~/.ultron/` and `~/.ultron/sessions/` — the important base directories, not individual leaf session directories. Called once on first write via `appendMessage()`. Best-effort — non-fatal if it fails.

7. **No duplicate memory detection for v1.** Deferred to a future phase.

8. **No content redaction from read tools for v1.** Reads are lower risk for a single-user system.

## Architecture

```
src/memory/
  secretScanner.ts       — detectSecrets(), SECRET_PATTERNS, SecretMatch type
  contentSafety.ts       — secretContentSafetyCheck (SafetyCheck for permission cascade)
  localMemoryGuard.ts    — checkTranscriptSize(), enforceBaseDirectoryPermissions()
```

## Files to Create

### `src/memory/secretScanner.ts`

**Purpose:** Detect common secret/credential patterns in text.

```typescript
export type SecretConfidence = 'high' | 'low'

export type SecretMatch = {
  readonly type: string              // stable name: aws_access_key_id, anthropic_api_key, etc.
  readonly confidence: SecretConfidence
  readonly index: number             // start position in text
}

export const SECRET_PATTERNS: readonly { type: string; confidence: SecretConfidence; pattern: RegExp }[]

export function detectSecrets(text: string): readonly SecretMatch[]
```

**High-confidence patterns (→ deny):**
- `aws_access_key_id`: `/AKIA[0-9A-Z]{16}/`
- `anthropic_api_key`: `/sk-ant-[a-zA-Z0-9_-]{20,}/`
- `openai_api_key`: `/sk-[a-zA-Z0-9]{20,}/` (but not `sk-ant-`)
- `github_token`: `/gh[ps]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{20,}/`
- `private_key`: `/-----BEGIN\s+(RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE KEY-----/`

**Low-confidence patterns (→ ask):**
- `generic_secret_assignment`: `/(?:password|secret|token|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i`

`detectSecrets` returns all matches found. Empty array means clean.

**Tests (co-located):**
- Detects AWS access key (high confidence)
- Detects Anthropic API key (high confidence)
- Detects OpenAI API key but not `sk-ant-` prefix (high confidence)
- Detects GitHub tokens ghp_, gho_, github_pat_ (high confidence)
- Detects private key headers (high confidence)
- Detects generic secret assignments (low confidence)
- Returns empty for normal code/text
- Returns empty for short strings below minimum length

### `src/memory/contentSafety.ts`

**Purpose:** Content-level safety check for the permission cascade. Separate from filesystem path safety.

```typescript
export const secretContentSafetyCheck: SafetyCheck
```

**Logic:**
- Only fires for `FileWrite` and `FileEdit`
- For `FileWrite`: scan `input.content`
- For `FileEdit`: compute post-edit content by applying `old_string → new_string` replacement against the file content from `context.readFileState`, then scan the result. Falls back to scanning `new_string` alone if file content is not in cache.
- If any high-confidence matches: return `{ behavior: 'deny', reason: { type: 'safetyCheck', message } }`
- If only low-confidence matches: return `{ behavior: 'ask', reason: { type: 'safetyCheck', message } }`
- If no matches: return `null` (pass through)

**Tests (co-located):**
- FileWrite with API key → deny
- FileEdit with secret in post-edit content → deny
- FileWrite with `password = "test"` → ask (low confidence)
- FileWrite with normal content → null (pass through)
- FileRead → null (not a mutating tool)
- FileEdit fallback to new_string when file not in readFileState

### `src/memory/localMemoryGuard.ts`

**Purpose:** Transcript size checking and base directory permission enforcement.

```typescript
export const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024  // 10 MB soft cap

export function checkTranscriptSize(transcriptPath: string): { ok: boolean; bytes: number }

export async function enforceBaseDirectoryPermissions(baseDir: string): Promise<void>
```

**`checkTranscriptSize`:** `stat()` the file, return `{ ok: bytes <= MAX_TRANSCRIPT_BYTES, bytes }`. If file doesn't exist, return `{ ok: true, bytes: 0 }`. Never throws.

**`enforceBaseDirectoryPermissions`:** `chmod(baseDir, 0o700)` on `~/.ultron/` and `~/.ultron/sessions/`. Best-effort — warns to stderr on failure, never throws.

**Tests (co-located):**
- `checkTranscriptSize` returns ok for small files
- `checkTranscriptSize` returns not ok for files over cap
- `checkTranscriptSize` returns ok for nonexistent files
- `enforceBaseDirectoryPermissions` sets mode 0o700 on directory
- `enforceBaseDirectoryPermissions` swallows errors gracefully

## Files to Modify

### `src/core/permissions/filesystem.ts`

**Import and add `secretContentSafetyCheck` to the `filesystemSafetyChecks` array.**

```typescript
import { secretContentSafetyCheck } from '../../memory/contentSafety.js'

export const filesystemSafetyChecks: readonly SafetyCheck[] = [
  dangerousPathSafetyCheck,
  workingDirectorySafetyCheck,
  secretContentSafetyCheck,    // new
]
```

No content-inspection logic inside `filesystem.ts` — it just imports the check from its own module.

### `src/session/resume.ts`

**Add pre-read transcript size check.**

In `resumeSession()`, BEFORE calling `readTranscript()`:

```typescript
import { checkTranscriptSize } from '../memory/localMemoryGuard.js'

// Before readTranscript():
const transcriptPath = join(dir, 'transcript.jsonl')
const sizeCheck = checkTranscriptSize(transcriptPath)
if (!sizeCheck.ok) {
  process.stderr.write(
    `Warning: session transcript is large (${(sizeCheck.bytes / 1024 / 1024).toFixed(1)} MB). Loading may be slow.\n`
  )
}
const allMessages = await readTranscript(dir)
```

### `src/session/transcript.ts`

**Enforce base directory permissions on first write.**

In `appendMessage()`, after `mkdir()`:

```typescript
import { enforceBaseDirectoryPermissions } from '../memory/localMemoryGuard.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

// After mkdir(sessionDir, { recursive: true }):
await enforceBaseDirectoryPermissions(join(homedir(), '.ultron'))
```

## Implementation Order

1. `src/memory/secretScanner.ts` + tests — standalone, no deps
2. `src/memory/localMemoryGuard.ts` + tests — standalone, no deps
3. `src/memory/contentSafety.ts` + tests — depends on secretScanner
4. `src/core/permissions/filesystem.ts` — import and add secretContentSafetyCheck
5. `src/session/resume.ts` — add pre-read transcript size check
6. `src/session/transcript.ts` — enforce base directory permissions

Steps 1-2 independent. Step 3 depends on 1. Steps 4-6 depend on 2-3.

## What Phase 14 Does NOT Do

- No semantic duplicate detection (deferred)
- No hard transcript size trimming (soft cap + warn for v1)
- No content redaction from read tools
- No ML-based secret detection (regex only)
- No encrypted transcript storage
- No multi-user access control (single-user by design)
- No secret scanning for Bash tool output (only file content writes)
- No token-level caps on memory injection (byte cap only for v1)

## Verification

1. `detectSecrets` catches AWS keys, API keys, private keys, GitHub tokens (high confidence)
2. `detectSecrets` catches generic secret assignments (low confidence)
3. `detectSecrets` returns empty for normal code and prose
4. `secretContentSafetyCheck` denies FileWrite containing a high-confidence secret
5. `secretContentSafetyCheck` asks for FileWrite containing a low-confidence secret
6. `secretContentSafetyCheck` denies FileEdit when post-edit content contains a secret
7. `secretContentSafetyCheck` falls back to scanning `new_string` when file not in readFileState
8. `secretContentSafetyCheck` allows FileWrite with no secrets
9. `secretContentSafetyCheck` does not fire for FileRead (read-only tool)
10. Pre-read transcript size warning emitted BEFORE loading large transcripts
11. Base directory permissions (`~/.ultron/`, `~/.ultron/sessions/`) set to 0o700
12. All existing filesystem safety tests still pass
13. All tests pass, typecheck clean
