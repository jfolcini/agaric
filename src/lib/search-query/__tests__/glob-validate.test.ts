import { describe, expect, it } from 'vitest'

import {
  EXPANSION_CAP,
  expandBraces,
  globToRegExp,
  MAX_GLOB_LEN,
  prepareGlobs,
  splitTopLevelCommas,
  validateGlob,
} from '@/lib/search-query/glob-validate'

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

  it('rejects a premature close bracket even when a later [ balances the count', () => {
    // `]a[` has one `]` and one `[`, so a naive "count mismatch" check would
    // see them balance out — but the `]` appears BEFORE its `[`, which must
    // still be rejected. This also guards against the bracket-branch's
    // "unbalanced bracket" return being skipped (the trailing `[` would
    // otherwise bring the running bracket count back to 0 and mask the gap).
    expect(validateGlob(']a[')?.message).toContain('unbalanced bracket')
  })

  it('rejects a lone unbalanced brace', () => {
    expect(validateGlob('{')?.message).toContain('unbalanced brace')
  })

  it('rejects a premature close brace even when a later { balances the count', () => {
    expect(validateGlob('}a{')?.message).toContain('unbalanced brace')
  })

  it('rejects escape characters', () => {
    expect(validateGlob('\\{literal\\}')?.message).toContain('escapes')
  })

  it('rejects each escapable character individually', () => {
    expect(validateGlob('\\{')?.message).toContain('escapes')
    expect(validateGlob('\\}')?.message).toContain('escapes')
    expect(validateGlob('\\[')?.message).toContain('escapes')
    expect(validateGlob('\\]')?.message).toContain('escapes')
  })

  it('does not treat a backslash before a non-special char as an escape', () => {
    expect(validateGlob('\\a')).toBeNull()
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

  it('falls back to a single empty alternative when every comma-separated entry is whitespace-only', () => {
    // All alternatives inside the braces are blank after trim/filter — the
    // group must contribute exactly one empty alternative (not zero, which
    // would wipe out the whole cartesian product).
    expect(expandBraces('a{ , }b')).toEqual(['ab'])
  })

  it('keeps literal text preceding a brace group', () => {
    expect(expandBraces('abc{x,y}')).toEqual(['abcx', 'abcy'])
  })

  it('keeps literal text following a brace group', () => {
    expect(expandBraces('{x,y}abc')).toEqual(['xabc', 'yabc'])
  })

  it('treats an unterminated brace group as a literal suffix', () => {
    expect(expandBraces('abc{def')).toEqual(['abc{def'])
  })

  it('respects the expansion cap', () => {
    const big = '{a,b,c,d}'.repeat(5)
    const out = expandBraces(big)
    expect(out.length).toBeLessThanOrEqual(EXPANSION_CAP)
  })

  it('truncates at the cap rather than erroring (contract)', () => {
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

  it('truncates mid-expansion at the exact cap, and stops applying further groups once capped', () => {
    // `{a,b,c}` repeated 5x: group sizes 3, 9, 27, then group 4 overflows
    // (27*3=81 > 64) and must be clamped to exactly 64 entries composed of
    // exactly 4 characters each — group 5 must NOT be applied afterwards.
    // (`{a,b,c,d}` above overflows cleanly on an exact power of the cap at
    // every group boundary, which happens to never exercise the interior
    // "next.length > cap" slice/break at all — this pattern does.)
    const pattern = '{a,b,c}'.repeat(5)
    const out = expandBraces(pattern)
    expect(out.length).toBe(EXPANSION_CAP)
    for (const p of out) {
      expect(p.length).toBe(4)
    }
  })
})

describe('splitTopLevelCommas', () => {
  it('splits plain top-level commas', () => {
    expect(splitTopLevelCommas('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('does not split commas nested inside a brace group', () => {
    expect(splitTopLevelCommas('{a,b},c')).toEqual(['{a,b}', 'c'])
  })

  it('does not let an unmatched close brace push depth negative and desync later splits', () => {
    // A lone `}` should clamp depth at 0, not go negative — otherwise a
    // later `,` could wrongly be treated as top-level once depth "recovers"
    // past zero.
    expect(splitTopLevelCommas('},a')).toEqual(['}', 'a'])
  })

  it('treats doubly-nested braces as depth 2, keeping their outer comma non-top-level', () => {
    // `{{a,b},c}`: the outer `,` sits at depth 1 (inside the outermost
    // brace), so the whole thing is ONE top-level entry.
    expect(splitTopLevelCommas('{{a,b},c}')).toEqual(['{{a,b},c}'])
  })
})

describe('prepareGlobs', () => {
  it('rejects a pattern over MAX_GLOB_LEN, accepts one exactly at the cap', () => {
    const atCap = 'a'.repeat(MAX_GLOB_LEN)
    expect(() => prepareGlobs([atCap])).not.toThrow()

    const overCap = 'a'.repeat(MAX_GLOB_LEN + 1)
    expect(() => prepareGlobs([overCap])).toThrow(/exceeds cap 1024/)
  })

  it('brace-expands each sub-entry rather than passing the raw braced text through', () => {
    expect(prepareGlobs(['{a,b}'])).toEqual(['*a*', '*b*'])
  })

  it('does not throw exactly at the expansion cap, throws just past it', () => {
    // Internally capped to exactly EXPANSION_CAP (64) by expandBraces.
    const atCapPattern = '{a,b,c,d}'.repeat(5)
    expect(prepareGlobs([atCapPattern])).toHaveLength(EXPANSION_CAP)
    expect(() => prepareGlobs([atCapPattern])).not.toThrow()

    expect(() => prepareGlobs([atCapPattern, 'extra'])).toThrow(/expansion exceeded cap 64/)
  })
})

describe('globToRegExp', () => {
  it('anchors matches at both the start and the end', () => {
    const re = globToRegExp('ab')
    expect(re.test('ab')).toBe(true)
    expect(re.test('xab')).toBe(false)
    expect(re.test('abx')).toBe(false)
  })

  it('treats an unterminated [ as a literal instead of throwing', () => {
    const re = globToRegExp('[ab')
    expect(re.test('[ab')).toBe(true)
    expect(re.test('ab')).toBe(false)
  })

  it('matches a non-negated character class and rejects chars outside it', () => {
    const re = globToRegExp('[abc]')
    expect(re.test('a')).toBe(true)
    expect(re.test('b')).toBe(true)
    expect(re.test('r')).toBe(false)
    expect(re.test('z')).toBe(false)
  })

  it('negates a character class with a leading ^', () => {
    const re = globToRegExp('[^abc]')
    expect(re.test('d')).toBe(true)
    // The negation marker itself must not be folded into the excluded set.
    expect(re.test('^')).toBe(true)
    expect(re.test('a')).toBe(false)
  })

  it('treats a ] immediately after [ or [^ as a literal member, not the close', () => {
    const re = globToRegExp('[]abc]')
    expect(re.test(']')).toBe(true)
    expect(re.test('a')).toBe(true)
    expect(re.test('x')).toBe(false)
  })

  // #3142 — the leading `^` must be *consumed* as the negation marker, not
  // merely left in place to double as JS's own negation character. The two are
  // byte-identical for `[^abc]`, but they diverge the moment the very next
  // character is `]`: only a consumed `^` lets the `]` be recognised as the
  // literal first member of the class (SQLite `patternCompare` reads `^` then
  // a leading `]` in exactly that order).
  it('negates a class whose first literal member is ] (leading ^ is consumed)', () => {
    const re = globToRegExp('[^]]')
    // Class is `] only`, negated: any single character other than `]`.
    expect(re.test('a')).toBe(true)
    expect(re.test('^')).toBe(true)
    expect(re.test(']')).toBe(false)
    // A `^` left unconsumed would close the class early, leaving a trailing
    // literal `]` that demands a second character.
    expect(re.test('a]')).toBe(false)
  })

  it('keeps ] as a literal member after ^ when other members follow', () => {
    const re = globToRegExp('[^]a]')
    expect(re.test('b')).toBe(true)
    expect(re.test(']')).toBe(false)
    expect(re.test('a')).toBe(false)
    expect(re.test('ba]')).toBe(false)
  })

  it('treats [^] as an unterminated class, so the [ stays literal', () => {
    // The `]` is the class's first literal member, so nothing closes the
    // class: `compileCharClass` bails and `[` falls through as a literal.
    const re = globToRegExp('a[^]')
    expect(re.test('a[^]')).toBe(true)
    // Not "a followed by any one character".
    expect(re.test('ab')).toBe(false)
    expect(re.test('a]')).toBe(false)
  })

  it('preserves a literal backslash inside a character class', () => {
    const re = globToRegExp('[a\\b]')
    expect(re.test('a')).toBe(true)
    expect(re.test('\\')).toBe(true)
    expect(re.test('c')).toBe(false)
  })

  it('escapes regex-special literal characters outside a class', () => {
    const re = globToRegExp('a.b')
    expect(re.test('a.b')).toBe(true)
    expect(re.test('ab')).toBe(false)
    expect(re.test('axb')).toBe(false)
  })
})
