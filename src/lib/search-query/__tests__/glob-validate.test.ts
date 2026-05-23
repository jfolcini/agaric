import { describe, expect, it } from 'vitest'
import { EXPANSION_CAP, expandBraces, validateGlob } from '../glob-validate'

describe('validateGlob', () => {
  it('accepts plain globs', () => {
    expect(validateGlob('Journal/*')).toBeNull()
    expect(validateGlob('*meeting*')).toBeNull()
    expect(validateGlob('A')).toBeNull()
    expect(validateGlob('foo?')).toBeNull()
  })

  it('accepts top-level brace expansion', () => {
    expect(validateGlob('{a,b,c}/*')).toBeNull()
    expect(validateGlob('{a,b}/{c,d}')).toBeNull()
  })

  it('accepts character classes', () => {
    expect(validateGlob('[abc]meeting')).toBeNull()
    expect(validateGlob('A[0-9]+')).toBeNull()
  })

  it('rejects nested braces', () => {
    expect(validateGlob('{a,{b,c}}')?.message).toContain('brace nesting')
  })

  it('rejects unbalanced brackets', () => {
    expect(validateGlob('[unclosed')?.message).toContain('unbalanced bracket')
    expect(validateGlob('closed]')?.message).toContain('unbalanced bracket')
  })

  it('rejects escape characters', () => {
    expect(validateGlob('\\{literal\\}')?.message).toContain('escapes')
  })

  it('rejects empty patterns', () => {
    expect(validateGlob('')?.message).toContain('empty')
  })
})

describe('expandBraces', () => {
  it('returns the input verbatim when no braces are present', () => {
    expect(expandBraces('Journal/*')).toEqual(['Journal/*'])
  })

  it('expands a single group', () => {
    expect(expandBraces('{a,b,c}')).toEqual(['a', 'b', 'c'])
  })

  it('expands cartesian groups', () => {
    expect(expandBraces('{a,b}/{c,d}')).toEqual(['a/c', 'a/d', 'b/c', 'b/d'])
  })

  it('drops whitespace-only alternatives', () => {
    expect(expandBraces('{a, ,b}')).toEqual(['a', 'b'])
  })

  it('respects the expansion cap', () => {
    const big = '{a,b,c,d}'.repeat(5)
    const out = expandBraces(big)
    expect(out.length).toBeLessThanOrEqual(EXPANSION_CAP)
  })

  it('truncates at the cap rather than erroring (DSL-A4 contract)', () => {
    // The pattern `{a,b,c,d}` repeated would expand to 4^5 = 1024
    // patterns, far over the cap. The contract — matching the Rust
    // expander's `results.truncate(EXPANSION_CAP)` — is to silently
    // truncate to exactly EXPANSION_CAP entries, never throw or return
    // an error sentinel.
    const big = '{a,b,c,d}'.repeat(5)
    expect(() => expandBraces(big)).not.toThrow()
    const out = expandBraces(big)
    expect(out.length).toBe(EXPANSION_CAP)
    expect(out.every((p) => typeof p === 'string')).toBe(true)
  })
})
