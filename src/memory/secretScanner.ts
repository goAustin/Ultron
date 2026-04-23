/**
 * Secret scanner — detect common credential patterns in text.
 *
 * Two-tier severity:
 * - High-confidence: specific API key formats, private key headers → deny
 * - Low-confidence: generic keyword + value assignments → ask
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SecretConfidence = 'high' | 'low'

export type SecretMatch = {
  readonly type: string
  readonly confidence: SecretConfidence
  readonly index: number
  readonly length: number
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export const SECRET_PATTERNS: readonly {
  type: string
  confidence: SecretConfidence
  pattern: RegExp
}[] = [
  // High-confidence — specific credential formats
  {
    type: 'aws_access_key_id',
    confidence: 'high',
    pattern: /AKIA[0-9A-Z]{16}/g,
  },
  {
    type: 'anthropic_api_key',
    confidence: 'high',
    pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  },
  {
    type: 'openai_api_key',
    confidence: 'high',
    // Match sk- followed by 20+ chars (alphanumeric, hyphens, underscores), but exclude sk-ant- (Anthropic)
    pattern: /sk-(?!ant-)[a-zA-Z0-9_-]{20,}/g,
  },
  {
    type: 'github_token',
    confidence: 'high',
    pattern: /gh[ps]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{20,}/g,
  },
  {
    type: 'private_key',
    confidence: 'high',
    pattern: /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  // Low-confidence — generic secret assignments
  {
    type: 'generic_secret_assignment',
    confidence: 'low',
    pattern: /(?:password|secret|token|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  },
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan text for secret/credential patterns.
 * Returns all matches found. Empty array means clean.
 */
export function detectSecrets(text: string): readonly SecretMatch[] {
  const matches: SecretMatch[] = []

  for (const { type, confidence, pattern } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0

    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      matches.push({ type, confidence, index: match.index, length: match[0].length })
    }
  }

  return matches
}
