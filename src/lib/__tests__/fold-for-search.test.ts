/**
 * Tests for the fix — Unicode-aware case-insensitive
 * substring matching used by PageBrowser and HighlightMatch.
 *
 * The baseline JS `.toLowerCase()` has known substring-match failure
 * modes for Turkish, German, accented and Greek text — the last of
 * these because Final_Sigma makes it context-sensitive.  These tests
 * lock in the behaviour of [`foldForSearch`] and
 * [`matchesSearchFolded`] so a future refactor cannot regress the
 * case-insensitive filter contract.
 */

import { describe, expect, it } from 'vitest'

import {
  findFoldedMatch,
  foldForSearch,
  indexOfFolded,
  matchesSearchFolded,
} from '@/lib/fold-for-search'

// ─────────────────────────────────────────────────────────────────────────
// #4514 — the three Greek sigma forms, written as escapes because
// Σ / σ / ς are easy to confuse by eye and the whole point of these cases
// is *which* lowercase form comes out of the fold. Inputs matter as much
// as expectations: normalise a lowercase input's final ς to σ and the
// surrounding assertion degrades into a tautology that is green with or
// without the collapse, so both sides use these constants.
//
// Uppercase words below (ΟΔΟΣ, ΑΣΑ, ΟΞΟΣ, ΑΒΓ) stay pasted: Σ has a single
// uppercase form, so there is nothing to confuse it with and nothing a
// silent substitution could weaken.
// ─────────────────────────────────────────────────────────────────────────
const SIGMA_CAP = '\u03A3' // Σ — capital
const SIGMA_MID = '\u03C3' // σ — non-final lowercase (U+03C3)
const SIGMA_FINAL = '\u03C2' // ς — word-final lowercase (U+03C2)

// The two lowercase spellings of ΟΔΟΣ, differing only in their last
// character. Every case using them turns on which sigma that is, so the
// tail is always a constant and never a pasted glyph.
const ODOS_FINAL = `οδο${SIGMA_FINAL}`
const ODOS_MID = `οδο${SIGMA_MID}`

// U+1D6D3 MATHEMATICAL BOLD SMALL FINAL SIGMA — NFKD-decomposes straight
// to a literal ς, in any position, with no help from Final_Sigma.
const MATH_BOLD_SIGMA_FINAL = '\u{1D6D3}'

describe('foldForSearch', () => {
  describe('ASCII fast path', () => {
    it('lowercases ASCII letters', () => {
      expect(foldForSearch('Projects')).toBe('projects')
      expect(foldForSearch('HELLO')).toBe('hello')
      expect(foldForSearch('already lower')).toBe('already lower')
    })

    it('preserves digits and punctuation', () => {
      expect(foldForSearch('Page 42: TODO!')).toBe('page 42: todo!')
      expect(foldForSearch('')).toBe('')
    })
  })

  describe('Turkish dotted I / dotless i', () => {
    // `İ` (U+0130) decomposes to `I` + U+0307; stripping the combining
    // mark produces `I`, then lowercasing gives `i` — the user's
    // expected behaviour.
    it('folds Turkish İ to lowercase i', () => {
      expect(foldForSearch('İstanbul')).toBe('istanbul')
    })

    it('folds Turkish İ embedded mid-string', () => {
      expect(foldForSearch('aİb')).toBe('aib')
    })

    it('preserves ASCII I as plain i after folding', () => {
      expect(foldForSearch('ISTANBUL')).toBe('istanbul')
    })
  })

  describe('German eszett', () => {
    it('folds Straße to strasse', () => {
      expect(foldForSearch('Straße')).toBe('strasse')
    })

    it('folds standalone ß to ss', () => {
      expect(foldForSearch('ß')).toBe('ss')
    })

    it('ALL CAPS SS stays ss', () => {
      expect(foldForSearch('STRASSE')).toBe('strasse')
    })
  })

  describe('Accent stripping', () => {
    it('strips acute accents', () => {
      expect(foldForSearch('café')).toBe('cafe')
      expect(foldForSearch('ÉCLAIR')).toBe('eclair')
    })

    it('strips umlauts', () => {
      expect(foldForSearch('Österreich')).toBe('osterreich')
      expect(foldForSearch('naïve')).toBe('naive')
    })

    it('strips tildes and cedillas', () => {
      expect(foldForSearch('niño')).toBe('nino')
      expect(foldForSearch('façade')).toBe('facade')
    })
  })

  // ───────────────────────────────────────────────────────────────────
  // #4514 — Unicode's Final_Sigma rule makes `.toLowerCase()`
  // context-sensitive: `Σ` lowercases to `ς` at the end of a word and to
  // `σ` everywhere else. Folding both sides of a comparison therefore did
  // NOT line the two sides up: the same character came out differently
  // depending on its surroundings. The fold collapses `ς` onto `σ` to
  // restore context-freedom.
  // ───────────────────────────────────────────────────────────────────
  describe('Greek final sigma', () => {
    // Tamper-detector for the constants above. Every case in this
    // describe block turns on which sigma an *input* carries, and the two
    // lowercase glyphs are indistinguishable by eye: silently normalise
    // SIGMA_FINAL (or ODOS_FINAL's last character) to σ and most of the
    // assertions below become tautologies that hold with or without the
    // collapse. This test is what makes that edit visible.
    it('the sigma constants are the code points they claim to be', () => {
      expect(SIGMA_CAP.codePointAt(0)).toBe(0x03a3)
      expect(SIGMA_MID.codePointAt(0)).toBe(0x03c3)
      expect(SIGMA_FINAL.codePointAt(0)).toBe(0x03c2)
      expect(MATH_BOLD_SIGMA_FINAL.codePointAt(0)).toBe(0x1d6d3)
      // The two ΟΔΟΣ spellings must differ, and differ only in their tail.
      expect(ODOS_FINAL).not.toBe(ODOS_MID)
      expect(ODOS_FINAL.slice(0, -1)).toBe(ODOS_MID.slice(0, -1))
      expect(ODOS_FINAL.at(-1)).toBe(SIGMA_FINAL)
      expect(ODOS_MID.at(-1)).toBe(SIGMA_MID)
      // ...and ODOS_FINAL really is what Final_Sigma produces from ΟΔΟΣ,
      // which is the whole reason the stored form ends in ς at all.
      expect('ΟΔΟΣ'.toLowerCase()).toBe(ODOS_FINAL)
    })

    it('folds every sigma form to σ in isolation', () => {
      expect(foldForSearch(SIGMA_CAP)).toBe(SIGMA_MID)
      expect(foldForSearch(SIGMA_MID)).toBe(SIGMA_MID)
      expect(foldForSearch(SIGMA_FINAL)).toBe(SIGMA_MID)
    })

    it('folds a word-final sigma to σ, not ς (ΟΔΟΣ)', () => {
      // Pin the exact folded value, not merely that two folds agree:
      // `fold(a) === fold(b)` is equally satisfied by a fold that returns
      // '' for every input.
      expect(foldForSearch('ΟΔΟΣ')).toBe(ODOS_MID)
      expect(foldForSearch(ODOS_FINAL)).toBe(ODOS_MID)
      expect(foldForSearch('ΟΔΟΣ')).toHaveLength(4)
    })

    it('folds a mid-word sigma to σ as before (ΑΣΑ — regression guard)', () => {
      // Already correct before the fix; pinned so the collapse cannot be
      // "fixed" by breaking the non-final case it never affected.
      expect(foldForSearch('ΑΣΑ')).toBe(`α${SIGMA_MID}α`)
    })

    it('folds ΣΣ to two identical σ, not σ followed by ς', () => {
      expect(foldForSearch(`${SIGMA_CAP}${SIGMA_CAP}`)).toBe(`${SIGMA_MID}${SIGMA_MID}`)
    })

    it('collapses an NFKD-produced ς that Final_Sigma never touched (U+1D6D3)', () => {
      // MATHEMATICAL BOLD SMALL FINAL SIGMA decomposes to a literal ς
      // under NFKD, with `toLowerCase` playing no part — the
      // decomposition is already lowercase, and it comes out ς in any
      // position, not only word-finally. So the collapse earns its keep
      // twice: it undoes Final_Sigma, and it normalises final sigmas
      // that arrive as raw content. A rule phrased as "did `toLowerCase`
      // just apply Final_Sigma?" would fix the first and miss this.
      //
      // This case does NOT pin the collapse's *position*: any position
      // after `normalize('NFKD')` catches it. The position constraint —
      // after `toLowerCase` — is pinned by the ΟΔΟΣ case above.
      expect(MATH_BOLD_SIGMA_FINAL.normalize('NFKD')).toBe(SIGMA_FINAL) // premise
      expect(foldForSearch(MATH_BOLD_SIGMA_FINAL)).toBe(SIGMA_MID)
      // Non-final position: no Final_Sigma anywhere in the story.
      expect(foldForSearch(`${MATH_BOLD_SIGMA_FINAL}α`)).toBe(`${SIGMA_MID}α`)
      expect(matchesSearchFolded(MATH_BOLD_SIGMA_FINAL, SIGMA_CAP)).toBe(true)
      expect(matchesSearchFolded(SIGMA_MID, MATH_BOLD_SIGMA_FINAL)).toBe(true)
    })

    it('does not collapse unrelated Greek letters onto sigma', () => {
      // Negative control: a fold that mapped everything together — or to
      // '' — would satisfy every equality above. These must stay distinct.
      expect(foldForSearch('ΟΞΟΣ')).not.toBe(foldForSearch('ΟΔΟΣ'))
      expect(foldForSearch('ΑΒΓ')).toBe('αβγ')
    })

    it('stays idempotent for a word-final sigma', () => {
      const once = foldForSearch('ΟΔΟΣ')
      expect(foldForSearch(once)).toBe(once)
    })
  })

  describe('idempotent on folded strings', () => {
    it('folding an already-folded string is a no-op', () => {
      const input = 'İstanbul'
      const once = foldForSearch(input)
      const twice = foldForSearch(once)
      expect(twice).toBe(once)
    })
  })
})

describe('matchesSearchFolded', () => {
  describe('ASCII parity with the pre-existing behaviour', () => {
    it('matches case-insensitively for ASCII substrings', () => {
      expect(matchesSearchFolded('Projects', 'projects')).toBe(true)
      expect(matchesSearchFolded('Projects', 'PROJECTS')).toBe(true)
      expect(matchesSearchFolded('projects', 'Projects')).toBe(true)
    })

    it('returns true for empty query (preserves pre-filter default)', () => {
      expect(matchesSearchFolded('anything', '')).toBe(true)
      expect(matchesSearchFolded('', '')).toBe(true)
    })

    it('returns false when there is no substring match', () => {
      expect(matchesSearchFolded('Meeting Notes', 'zzz')).toBe(false)
    })
  })

  describe('Turkish dotted I regression cases', () => {
    it('matches "İstanbul" when query is "istanbul"', () => {
      // This is the canonical Turkish failure case:
      // `"İstanbul".toLowerCase().includes("istanbul")` is `false`
      // because `İ.toLowerCase()` is two code points (`i` + U+0307).
      expect(matchesSearchFolded('İstanbul', 'istanbul')).toBe(true)
    })

    it('matches "ISTANBUL" when query is "istanbul"', () => {
      expect(matchesSearchFolded('ISTANBUL', 'istanbul')).toBe(true)
    })

    it('matches "istanbul" when query is "İstanbul"', () => {
      expect(matchesSearchFolded('istanbul', 'İstanbul')).toBe(true)
    })
  })

  describe('German eszett regression cases', () => {
    it('matches "Straße" when query is "strasse"', () => {
      expect(matchesSearchFolded('Straße', 'strasse')).toBe(true)
    })

    it('matches "Straße" when query is "straße"', () => {
      expect(matchesSearchFolded('Straße', 'straße')).toBe(true)
    })

    it('matches "STRASSE" when query is "straße"', () => {
      expect(matchesSearchFolded('STRASSE', 'straße')).toBe(true)
    })
  })

  describe('Greek final sigma regression cases (#4514)', () => {
    it('matches the word-final sigma of ΟΔΟΣ whichever form the user types', () => {
      expect(matchesSearchFolded('ΟΔΟΣ', SIGMA_CAP)).toBe(true)
      expect(matchesSearchFolded('ΟΔΟΣ', SIGMA_MID)).toBe(true)
      expect(matchesSearchFolded('ΟΔΟΣ', SIGMA_FINAL)).toBe(true)
    })

    it('makes the three sigma forms mutually interchangeable', () => {
      expect(matchesSearchFolded(SIGMA_CAP, SIGMA_MID)).toBe(true)
      expect(matchesSearchFolded(SIGMA_CAP, SIGMA_FINAL)).toBe(true)
      expect(matchesSearchFolded(SIGMA_MID, SIGMA_CAP)).toBe(true)
      expect(matchesSearchFolded(SIGMA_MID, SIGMA_FINAL)).toBe(true)
      expect(matchesSearchFolded(SIGMA_FINAL, SIGMA_CAP)).toBe(true)
      expect(matchesSearchFolded(SIGMA_FINAL, SIGMA_MID)).toBe(true)
    })

    it('matches a whole word in either case, in either direction', () => {
      expect(matchesSearchFolded('ΟΔΟΣ', ODOS_FINAL)).toBe(true)
      expect(matchesSearchFolded(ODOS_FINAL, 'ΟΔΟΣ')).toBe(true)
      expect(matchesSearchFolded(ODOS_FINAL, SIGMA_CAP)).toBe(true)
      // The consumer-facing case: stored word ends in ς, typed word in σ.
      expect(matchesSearchFolded(ODOS_FINAL, ODOS_MID)).toBe(true)
    })

    it('mid-word sigma still matches (ΑΣΑ — regression guard)', () => {
      expect(matchesSearchFolded('ΑΣΑ', SIGMA_CAP)).toBe(true)
      expect(matchesSearchFolded('ΑΣΑ', SIGMA_FINAL)).toBe(true)
    })

    it('does not match sigma against Greek text that has none', () => {
      expect(matchesSearchFolded('ΑΒΓ', SIGMA_CAP)).toBe(false)
      expect(matchesSearchFolded('ΑΒΓ', SIGMA_FINAL)).toBe(false)
      expect(matchesSearchFolded('ΟΔΟΣ', 'ΑΒΓ')).toBe(false)
    })
  })

  describe('accent regression cases', () => {
    it('matches "naïve" when query is "naive"', () => {
      expect(matchesSearchFolded('naïve', 'naive')).toBe(true)
    })

    it('matches "café" when query is "cafe"', () => {
      expect(matchesSearchFolded('café', 'cafe')).toBe(true)
    })

    it('matches "café" when query is "CAFÉ"', () => {
      expect(matchesSearchFolded('café', 'CAFÉ')).toBe(true)
    })
  })
})

describe('indexOfFolded', () => {
  it('returns 0 for empty needle', () => {
    expect(indexOfFolded('anything', '')).toBe(0)
  })

  it('locates ASCII matches at the correct offset', () => {
    expect(indexOfFolded('Hello World', 'hello')).toBe(0)
    expect(indexOfFolded('Hello World', 'world')).toBe(6)
    expect(indexOfFolded('Hello World', 'xyz')).toBe(-1)
  })

  it('locates the Turkish İstanbul match at offset 0', () => {
    expect(indexOfFolded('İstanbul', 'istanbul')).toBe(0)
  })

  it('locates the German Straße match at offset 0', () => {
    expect(indexOfFolded('Straße', 'strasse')).toBe(0)
  })

  it('locates the accented café match at offset 0', () => {
    expect(indexOfFolded('café', 'cafe')).toBe(0)
  })

  it('returns -1 for non-matching non-ASCII query', () => {
    expect(indexOfFolded('İstanbul', 'ankara')).toBe(-1)
  })

  it('finds non-ASCII match past an ASCII prefix', () => {
    // "Trip to İstanbul" — offset 8 in original (`İ` is 1 code unit)
    const haystack = 'Trip to İstanbul'
    const offset = indexOfFolded(haystack, 'istanbul')
    // The slice starting at `offset` for the folded-length of the
    // match should visually read as `İstanbul`.
    expect(haystack.slice(offset, offset + 'İstanbul'.length)).toBe('İstanbul')
  })

  it('locates a word-final sigma whichever form is searched for (#4514)', () => {
    expect(indexOfFolded('ΟΔΟΣ', SIGMA_CAP)).toBe(3)
    expect(indexOfFolded('ΟΔΟΣ', SIGMA_MID)).toBe(3)
    expect(indexOfFolded('ΟΔΟΣ', SIGMA_FINAL)).toBe(3)
    // Non-final sigma keeps its own offset — not the same position.
    expect(indexOfFolded('ΑΣΑ', SIGMA_CAP)).toBe(1)
  })

  // -------------------------------------------------------------------
  // Incremental-fold cases
  //
  // The reverse-mapping scan in `indexOfFolded` builds the folded
  // prefix one code unit at a time instead of refolding the growing
  // prefix from scratch on every iteration. These cases exercise each
  // class of fold transformation (length-changing ligature decomposition,
  // combining-mark stripping, CJK no-op fold, all-ASCII fast-path) so
  // the incremental walker has to handle each correctly.
  // -------------------------------------------------------------------
  describe('incremental fold across transformation classes', () => {
    it('ligature ﬁ (U+FB01) folds to "fi" — match offset lands on the ligature', () => {
      // 'aﬁx' folds to 'afix'. Searching for 'fi' must locate the
      // ligature at code-unit index 1 in the original.
      const haystack = 'aﬁx'
      const offset = indexOfFolded(haystack, 'fi')
      expect(offset).toBe(1)
      expect(haystack[offset]).toBe('ﬁ')
    })

    it('ligature ﬁ — full-string match returns offset 0', () => {
      expect(indexOfFolded('ﬁle', 'fi')).toBe(0)
      expect(indexOfFolded('ﬁle', 'file')).toBe(0)
    })

    it('combining marks: precomposed é (U+00E9) folds to "e"', () => {
      // 'café' — precomposed é at index 3.
      const haystack = 'café'
      expect(indexOfFolded(haystack, 'e')).toBe(3)
    })

    it('combining marks: decomposed e + U+0301 also folds to "e"', () => {
      // Decomposed form: 'cafe' + combining acute (U+0301) — equivalent to
      // the precomposed 'café' but expressed as five code points.
      const haystack = 'cafe\u0301'
      // The folded haystack is 'cafe'; the visible 'e' starts at offset 3.
      expect(indexOfFolded(haystack, 'e')).toBe(3)
    })

    it('combining marks: standalone combining mark folds away cleanly', () => {
      // 'a' + combining acute + 'bc' folds to 'abc'. Searching for 'a'
      // must locate the base at offset 0; the combining mark contributes
      // an empty fold, so it does not perturb the offset.
      const haystack = `a${'\u0301'}bc`
      expect(indexOfFolded(haystack, 'a')).toBe(0)
      // Searching for 'b' in this haystack lands on the index just past
      // the folded 'a' (index 1, between the base letter and its
      // combining mark). That's the documented "off by one combining
      // mark" cosmetic case — the assertion pins the actual behavior so
      // a future refactor can't silently shift it.
      expect(indexOfFolded(haystack, 'b')).toBe(1)
    })

    it('CJK characters fold to themselves (no decomposition, no case fold)', () => {
      // CJK ideographs have no NFKD decomposition and no case mapping —
      // the fold is a pure no-op. The match must still land at the
      // correct offset.
      const haystack = 'Hello 世界 Hello'
      expect(indexOfFolded(haystack, '世界')).toBe(6)
      expect(indexOfFolded(haystack, '世')).toBe(6)
      expect(indexOfFolded(haystack, '界')).toBe(7)
    })

    it('CJK no-match returns -1', () => {
      // Force the non-ASCII branch (haystack contains CJK), but query
      // for an ideograph that isn't present.
      expect(indexOfFolded('Hello 世界', '中')).toBe(-1)
    })

    it('all-ASCII fast path: returns the same offset as String.prototype.indexOf', () => {
      // Both arguments ASCII — exercises the early-return at line 96.
      // The result must match `.toLowerCase().indexOf(...)` exactly so
      // the fast path stays a true superset of the slow path.
      const haystack = 'The quick brown fox jumps over the lazy dog'
      expect(indexOfFolded(haystack, 'BROWN')).toBe(haystack.toLowerCase().indexOf('brown'))
      expect(indexOfFolded(haystack, 'lazy')).toBe(haystack.toLowerCase().indexOf('lazy'))
      expect(indexOfFolded(haystack, 'cat')).toBe(-1)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// PAGES-FOLD-MARK — `findFoldedMatch` returns both start AND length of
// the original-string span that produced the folded match, so the
// `<mark>` highlight bound stays correct even when the fold changes
// character length (ß → ss, ﬁ → fi, decomposed combining marks).
// `indexOfFolded` is the start-only thin wrapper; both are tested here
// against the same canonical cases.
// ─────────────────────────────────────────────────────────────────────────

describe('findFoldedMatch (PAGES-FOLD-MARK)', () => {
  it('empty needle returns zero-length match at start', () => {
    expect(findFoldedMatch('anything', '')).toEqual({ start: 0, length: 0 })
  })

  it('returns null when no folded match exists', () => {
    expect(findFoldedMatch('İstanbul', 'ankara')).toBeNull()
  })

  it('ASCII match: length equals needle.length (no fold expansion)', () => {
    expect(findFoldedMatch('Hello World', 'hello')).toEqual({ start: 0, length: 5 })
    expect(findFoldedMatch('Hello World', 'world')).toEqual({ start: 6, length: 5 })
  })

  it('Straße + "strasse": match covers the original 6 code units, not 7', () => {
    // The fold of "Straße" is "strasse" (length 7) but the original
    // string is 6 code units. Using `needle.length` would slice past
    // the end; `findFoldedMatch` returns the correct original length.
    expect(findFoldedMatch('Straße', 'strasse')).toEqual({ start: 0, length: 6 })
  })

  it('"abc Straße." + "strasse": match covers only "Straße", not the period after it', () => {
    // The regression case: with the previous `slice(start, start + needle.length)`
    // approach, the highlight would have extended one char past "Straße"
    // and covered the period. `findFoldedMatch` returns the correct span.
    const haystack = 'abc Straße.'
    const match = findFoldedMatch(haystack, 'strasse')
    expect(match).toEqual({ start: 4, length: 6 })
    if (match === null) throw new Error('expected match')
    expect(haystack.slice(match.start, match.start + match.length)).toBe('Straße')
  })

  it('"Straße" + "rasse": match covers "raße" (4 code units), not "rasse" (5)', () => {
    // Partial-match-through-fold case: the folded "rasse" overlaps the
    // ß boundary. The original span that produces "rasse" via folding
    // is "raße" — 4 code units, not 5.
    const haystack = 'Straße'
    const match = findFoldedMatch(haystack, 'rasse')
    expect(match).toEqual({ start: 2, length: 4 })
    if (match === null) throw new Error('expected match')
    expect(haystack.slice(match.start, match.start + match.length)).toBe('raße')
  })

  it('ligature ﬁ (U+FB01) + "fi": match covers the single ligature code unit', () => {
    // `ﬁ` folds to `fi` (length 2). The original span is just the
    // ligature itself (length 1). Using `needle.length` would extend
    // past the ligature; `findFoldedMatch` returns 1.
    const haystack = 'aﬁx'
    const match = findFoldedMatch(haystack, 'fi')
    expect(match).toEqual({ start: 1, length: 1 })
    if (match === null) throw new Error('expected match')
    expect(haystack.slice(match.start, match.start + match.length)).toBe('ﬁ')
  })

  it('İstanbul + "istanbul": length 8 in the original (İ is one code unit)', () => {
    // `İ` is U+0130 — one code unit in the original. It folds to "i"
    // + U+0307, so the folded haystack is 9 code units but the original
    // is 8. The match span in the original is 8.
    const haystack = 'İstanbul'
    const match = findFoldedMatch(haystack, 'istanbul')
    expect(match).toEqual({ start: 0, length: 8 })
    if (match === null) throw new Error('expected match')
    expect(haystack.slice(match.start, match.start + match.length)).toBe('İstanbul')
  })

  it('café + "cafe": precomposed é counts as one code unit', () => {
    const haystack = 'café'
    const match = findFoldedMatch(haystack, 'cafe')
    expect(match).toEqual({ start: 0, length: 4 })
    if (match === null) throw new Error('expected match')
    expect(haystack.slice(match.start, match.start + match.length)).toBe('café')
  })

  it('decomposed cafe + U+0301: combining mark is consumed inside the match span', () => {
    // The decomposed form is "café" — 5 code units. The folded
    // form is "cafe" — 4. The match span in the original is 5 (the
    // combining mark belongs to the visible "e").
    const haystack = 'café'
    const match = findFoldedMatch(haystack, 'cafe')
    expect(match).toEqual({ start: 0, length: 5 })
  })

  it('supplementary-plane compat character: 𝐀 folds to "a" as one code point (#756)', () => {
    // U+1D400 (MATHEMATICAL BOLD CAPITAL A) is a surrogate pair. Walking
    // per code *unit* folded each lone half to itself (2 units) while the
    // whole-string fold produces "a" (1 unit), desyncing the span math.
    const haystack = '𝐀bc'
    const match = findFoldedMatch(haystack, 'abc')
    expect(match).toEqual({ start: 0, length: 4 })
    if (match === null) throw new Error('expected match')
    expect(haystack.slice(match.start, match.start + match.length)).toBe('𝐀bc')
  })

  it('span math stays aligned for matches after a supplementary-plane character (#756)', () => {
    const haystack = '𝐀 naïve'
    const match = findFoldedMatch(haystack, 'naive')
    expect(match).toEqual({ start: 3, length: 5 })
    if (match === null) throw new Error('expected match')
    expect(haystack.slice(match.start, match.start + match.length)).toBe('naïve')
  })

  it('word-final sigma: the span is the one sigma code unit (#4514)', () => {
    const haystack = 'ΟΔΟΣ'
    const match = findFoldedMatch(haystack, SIGMA_CAP)
    if (match === null) throw new Error('expected match')
    expect(match).toEqual({ start: 3, length: 1 })
    expect(haystack.slice(match.start, match.start + match.length)).toBe(SIGMA_CAP)
  })

  it('ΣΣ searched for Σ yields BOTH sigmas — at 0 and 1, not one hit (#4514)', () => {
    // The issue's third table row. A whole-document search scans the
    // FOLDED text for the folded needle; before the collapse the folded
    // haystack was `σ` + `ς`, so that scan reported a single hit at 0.
    // Assert the positions, not just the count: an over-matching fold —
    // one that folded unrelated letters together — would also report two.
    //
    // Deliberately a scan of the folded string rather than a tail-slicing
    // walk with `findFoldedMatch`: re-folding the tail `Σ` in isolation
    // makes it non-final, which hid the bug from that formulation.
    const haystack = `${SIGMA_CAP}${SIGMA_CAP}`
    const folded = foldForSearch(haystack)
    const needle = foldForSearch(SIGMA_CAP)
    const hits: number[] = []
    for (let i = folded.indexOf(needle); i !== -1; i = folded.indexOf(needle, i + 1)) {
      hits.push(i)
    }
    expect(hits).toEqual([0, 1])
    expect(findFoldedMatch(haystack, SIGMA_CAP)).toEqual({ start: 0, length: 1 })
  })

  it('indexOfFolded stays consistent with findFoldedMatch.start', () => {
    // Spot-check the wrapper across the cases above.
    expect(indexOfFolded('Straße', 'strasse')).toBe(0)
    expect(indexOfFolded('İstanbul', 'istanbul')).toBe(0)
    expect(indexOfFolded('aﬁx', 'fi')).toBe(1)
    expect(indexOfFolded('Hello World', 'world')).toBe(6)
    expect(indexOfFolded('İstanbul', 'ankara')).toBe(-1)
  })
})
