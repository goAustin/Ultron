import { describe, it, expect } from 'vitest'

import { detectSecrets } from './secretScanner.js'

describe('detectSecrets', () => {
  // --- High-confidence patterns ---

  it('detects AWS access key (high confidence)', () => {
    const matches = detectSecrets('key = AKIAIOSFODNN7EXAMPLE')
    expect(matches).toHaveLength(1)
    expect(matches[0]!.type).toBe('aws_access_key_id')
    expect(matches[0]!.confidence).toBe('high')
  })

  it('detects Anthropic API key (high confidence)', () => {
    const matches = detectSecrets('ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
    expect(matches).toHaveLength(1)
    expect(matches[0]!.type).toBe('anthropic_api_key')
    expect(matches[0]!.confidence).toBe('high')
  })

  it('detects OpenAI API key but not sk-ant- prefix (high confidence)', () => {
    const openai = detectSecrets('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz')
    expect(openai).toHaveLength(1)
    expect(openai[0]!.type).toBe('openai_api_key')
    expect(openai[0]!.confidence).toBe('high')

    // sk-ant- should NOT match openai_api_key
    const anthropic = detectSecrets('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
    const openaiMatches = anthropic.filter((m) => m.type === 'openai_api_key')
    expect(openaiMatches).toHaveLength(0)
  })

  it('detects GitHub tokens ghp_ and github_pat_ (high confidence)', () => {
    const ghp = detectSecrets('token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl')
    expect(ghp.some((m) => m.type === 'github_token')).toBe(true)

    const pat = detectSecrets('token=github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZab')
    expect(pat.some((m) => m.type === 'github_token')).toBe(true)
  })

  it('detects private key headers (high confidence)', () => {
    const rsa = detectSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')
    expect(rsa).toHaveLength(1)
    expect(rsa[0]!.type).toBe('private_key')
    expect(rsa[0]!.confidence).toBe('high')

    const ec = detectSecrets('-----BEGIN EC PRIVATE KEY-----')
    expect(ec[0]!.type).toBe('private_key')

    const generic = detectSecrets('-----BEGIN PRIVATE KEY-----')
    expect(generic[0]!.type).toBe('private_key')
  })

  // --- Low-confidence patterns ---

  it('detects generic secret assignments (low confidence)', () => {
    const matches = detectSecrets('password = "supersecretpassword123"')
    expect(matches).toHaveLength(1)
    expect(matches[0]!.type).toBe('generic_secret_assignment')
    expect(matches[0]!.confidence).toBe('low')
  })

  it('detects api_key assignments (low confidence)', () => {
    const matches = detectSecrets("api_key: 'my-long-api-key-value-here'")
    expect(matches).toHaveLength(1)
    expect(matches[0]!.type).toBe('generic_secret_assignment')
  })

  // --- Negatives ---

  it('returns empty for normal code', () => {
    const code = `
      function hello() {
        console.log('Hello, world!')
        return 42
      }
    `
    expect(detectSecrets(code)).toHaveLength(0)
  })

  it('returns empty for normal prose', () => {
    expect(detectSecrets('The quick brown fox jumps over the lazy dog.')).toHaveLength(0)
  })

  it('does not match short strings below minimum length', () => {
    // "sk-" followed by < 20 chars should not match openai_api_key
    expect(detectSecrets('sk-short')).toHaveLength(0)

    // AKIA followed by < 16 chars should not match
    expect(detectSecrets('AKIA1234')).toHaveLength(0)

    // password = "short" (< 8 chars) should not match generic
    expect(detectSecrets('password = "short"')).toHaveLength(0)
  })

  it('detects multiple secrets in one text', () => {
    const text = `
      AWS_KEY=AKIAIOSFODNN7EXAMPLE
      OPENAI_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz
    `
    const matches = detectSecrets(text)
    expect(matches.length).toBeGreaterThanOrEqual(2)
    const types = matches.map((m) => m.type)
    expect(types).toContain('aws_access_key_id')
    expect(types).toContain('openai_api_key')
  })
})
