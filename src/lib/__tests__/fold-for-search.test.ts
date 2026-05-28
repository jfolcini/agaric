/**
 * Tests for the UX-247 fix — Unicode-aware case-insensitive
 * substring matching used by PageBrowser and HighlightMatch.
 *
 * The baseline JS `.toLowerCase()` has known substring-match failure
 * modes for Turkish, German, and accented characters.  These tests
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
} from '../fold-for-search'

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
  describe('ASCII parity with the pre-UX-247 behaviour', () => {
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

  describe('UX-247 — Turkish dotted I regression cases', () => {
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

  describe('UX-247 — German eszett regression cases', () => {
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

  describe('UX-247 — accent regression cases', () => {
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

  // -------------------------------------------------------------------
  // PEND-27 P2 — incremental-fold cases
  //
  // The reverse-mapping scan in `indexOfFolded` builds the folded
  // prefix one code unit at a time instead of refolding the growing
  // prefix from scratch on every iteration. These cases exercise each
  // class of fold transformation (length-changing ligature decomposition,
  // combining-mark stripping, CJK no-op fold, all-ASCII fast-path) so
  // the incremental walker has to handle each correctly.
  // -------------------------------------------------------------------
  describe('PEND-27 P2 — incremental fold across transformation classes', () => {
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

  it('indexOfFolded stays consistent with findFoldedMatch.start', () => {
    // Spot-check the wrapper across the cases above.
    expect(indexOfFolded('Straße', 'strasse')).toBe(0)
    expect(indexOfFolded('İstanbul', 'istanbul')).toBe(0)
    expect(indexOfFolded('aﬁx', 'fi')).toBe(1)
    expect(indexOfFolded('Hello World', 'world')).toBe(6)
    expect(indexOfFolded('İstanbul', 'ankara')).toBe(-1)
  })
})
