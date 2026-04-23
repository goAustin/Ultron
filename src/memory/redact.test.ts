import { describe, it, expect } from 'vitest'
import { redactString, redactSecrets } from './redact.js'

describe('redactString', () => {
  it('redacts an AWS access key id', () => {
    const out = redactString('key=AKIAIOSFODNN7EXAMPLE here')
    expect(out).toBe('key=[REDACTED:aws_access_key_id] here')
  })

  it('redacts an Anthropic API key', () => {
    const out = redactString('sk-ant-aabbccddeeffgghhiijj')
    expect(out).toBe('[REDACTED:anthropic_api_key]')
  })

  it('redacts an OpenAI API key', () => {
    const out = redactString('sk-abcdefghijklmnopqrst')
    expect(out).toBe('[REDACTED:openai_api_key]')
  })

  it('redacts a GitHub personal access token', () => {
    // ghp_ + 36 alphanumeric chars
    const ghp = 'ghp_' + 'a'.repeat(36)
    expect(redactString(ghp)).toBe('[REDACTED:github_token]')
  })

  it('redacts a PEM private key header', () => {
    const out = redactString('-----BEGIN RSA PRIVATE KEY-----\nMIICabc')
    expect(out.startsWith('[REDACTED:private_key]')).toBe(true)
  })

  it('redacts a generic secret assignment', () => {
    const out = redactString('password = "hunter2hunter2"')
    expect(out).toBe('[REDACTED:generic_secret_assignment]')
  })

  it('handles multiple matches on one line', () => {
    const out = redactString('a=AKIAIOSFODNN7EXAMPLE b=sk-ant-aabbccddeeffgghhiijj')
    expect(out).toBe('a=[REDACTED:aws_access_key_id] b=[REDACTED:anthropic_api_key]')
  })

  it('returns the input unchanged when no match', () => {
    expect(redactString('hello world')).toBe('hello world')
  })
})

describe('redactSecrets', () => {
  it('walks a nested object', () => {
    const input = {
      foo: {
        bar: [
          { baz: 'AKIAIOSFODNN7EXAMPLE' },
        ],
      },
    }
    const out = redactSecrets(input) as { foo: { bar: Array<{ baz: string }> } }
    expect(out.foo.bar[0].baz).toBe('[REDACTED:aws_access_key_id]')
  })

  it('passes through null, undefined, numbers, booleans unchanged', () => {
    expect(redactSecrets(null)).toBe(null)
    expect(redactSecrets(undefined)).toBe(undefined)
    expect(redactSecrets(42)).toBe(42)
    expect(redactSecrets(true)).toBe(true)
    expect(redactSecrets(false)).toBe(false)
  })

  it('preserves array order', () => {
    const out = redactSecrets(['a', 'b', 'c']) as string[]
    expect(out).toEqual(['a', 'b', 'c'])
  })

  it('redacts inside an array element', () => {
    const out = redactSecrets(['clean', 'AKIAIOSFODNN7EXAMPLE']) as string[]
    expect(out).toEqual(['clean', '[REDACTED:aws_access_key_id]'])
  })

  it('preserves Error.name and redacts Error.message', () => {
    const err = new Error('leaked AKIAIOSFODNN7EXAMPLE')
    err.name = 'TestError'
    const out = redactSecrets(err) as { name: string; message: string }
    expect(out.name).toBe('TestError')
    expect(out.message).toBe('leaked [REDACTED:aws_access_key_id]')
  })

  it('stops at depth cap and returns a sentinel', () => {
    // Build a chain nested one past MAX_DEPTH (16).
    let node: Record<string, unknown> = { v: 'AKIAIOSFODNN7EXAMPLE' }
    for (let i = 0; i < 20; i++) {
      node = { next: node }
    }
    const out = redactSecrets(node) as unknown
    // Traverse down until we hit the sentinel.
    let cur: unknown = out
    let seenSentinel = false
    for (let i = 0; i < 25; i++) {
      if (cur === '[REDACTED:depth]') {
        seenSentinel = true
        break
      }
      if (cur && typeof cur === 'object' && 'next' in cur) {
        cur = (cur as { next: unknown }).next
      } else {
        break
      }
    }
    expect(seenSentinel).toBe(true)
  })

  it('redacts across nested array + object mix', () => {
    const input = { items: [{ id: 1, key: 'sk-ant-aabbccddeeffgghhiijj' }] }
    const out = redactSecrets(input) as { items: Array<{ id: number; key: string }> }
    expect(out.items[0].id).toBe(1)
    expect(out.items[0].key).toBe('[REDACTED:anthropic_api_key]')
  })
})
