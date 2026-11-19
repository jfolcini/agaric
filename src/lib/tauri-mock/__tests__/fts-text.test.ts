/**
 * #3938 — the mock's `fts_blocks` stand-in (`fts-text.ts`), which the
 * backlink filters and unlinked references match against. The backend matches
 * a trigram index over `fts_blocks.stripped` — `strip_for_fts_with_maps`'s
 * output (`src-tauri/agaric-store/src/fts/strip.rs`) — and its tokenizer
 * (`tokenize = 'trigram case_sensitive 0'`, migration `0006`) folds CASE ONLY.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearMock, id } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { foldForFtsIndex, matchesFtsIndex, stripForFts } from '@/lib/tauri-mock/fts-text'
import { blocks, makeBlock } from '@/lib/tauri-mock/seed'

// ---------------------------------------------------------------------------
// #3938 — `strip_for_fts_with_maps`, step by step
// ---------------------------------------------------------------------------

describe('stripForFts — models strip_for_fts_with_maps', () => {
  beforeEach(clearMock)

  // Step 1 — the four `strip_inline_markup` delimiters, and code, which the
  // shown-span mask takes first.
  it.each([
    ['**bold**', 'bold'],
    ['*italic*', 'italic'],
    ['`code`', 'code'],
    ['~~struck~~', 'struck'],
    ['==marked==', 'marked'],
    // The delimiter can split a WORD, which is the whole point: `gadget` is
    // absent from the raw string and present in the indexed one.
    ['Sprocket **gad**get inventory', 'Sprocket gadget inventory'],
    // Bold before italic — leftmost-first alternation must prefer the longer
    // delimiter, or `**x**` strips as `*` + `x` + `*` and leaves stray stars.
    ['**bold *italic***', 'bold italic'],
    // Unmatched delimiters are NOT markup and survive verbatim.
    ['a ** b', 'a ** b'],
    // Rust's `.` excludes `\n` and NOTHING else, so a delimiter pair spanning
    // a `\r` / U+2028 / U+2029 IS markup on the backend. JS's `.` excludes all
    // four, which is why the pattern here is spelled `[^\n]`; a `.` regresses
    // every row below to the unstripped input.
    ['**a\rb**', 'a\rb'],
    ['**a\u2028b**', 'a\u2028b'],
    ['**a\u2029b**', 'a\u2029b'],
    // …and `\n` itself is still a non-match on BOTH engines, which is what
    // makes the three above a statement about the line-terminator SET rather
    // than about the pattern having gone multiline.
    ['**a\nb**', '**a\nb**'],
  ])('strips %j to %j', (raw, expected) => {
    expect(stripForFts(raw)).toBe(expected)
  })

  // #5160 D9 — a labelled link indexes the label the reader sees, not the title.
  it('indexes a [[ULID|label]] link as its label', () => {
    const PAGE = 'LABELPAGE'.padStart(26, '0')
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'My Page', null, 1))
    expect(stripForFts(`see [[${PAGE}|the plan]] and [[${PAGE}]]`)).toBe('see the plan and My Page')
  })

  // `cap_indexed_text`. Unreachable through any fixture, so asserted through
  // the export.
  describe('cap_indexed_text — 128 KiB of UTF-8 per block', () => {
    const CAP = 128 * 1024

    it('leaves text at or under the cap untouched', () => {
      const exact = 'a'.repeat(CAP)
      expect(stripForFts(exact)).toHaveLength(CAP)
      expect(stripForFts(exact)).toBe(exact)
    })

    it('truncates past the cap, and the search sees only the head', () => {
      const long = `${'a'.repeat(CAP)}needle`
      expect(stripForFts(long)).toHaveLength(CAP)
      expect(matchesFtsIndex(stripForFts(long), 'needle')).toBe(false)
      // Not vacuous: the same term one byte inside the cap IS indexed.
      const short = `${'a'.repeat(CAP - 'needle'.length)}needle`
      expect(matchesFtsIndex(stripForFts(short), 'needle')).toBe(true)
    })

    it('cuts on a char boundary, never mid-codepoint', () => {
      // `é` is 2 UTF-8 bytes; starting one byte short of the cap puts a
      // multi-byte char astride it, so a naive byte cut would emit U+FFFD.
      const astride = `${'a'.repeat(CAP - 1)}${'é'.repeat(4)}`
      const capped = stripForFts(astride)
      expect(capped).not.toContain('�')
      expect(new TextEncoder().encode(capped).length).toBe(CAP - 1)
    })
  })

  // Steps 2 + 3 — reference resolution through the `load_ref_maps` maps.
  describe('reference resolution', () => {
    const PAGE = id('REFPAGE')
    const TAG = id('REFTAG')
    const GONE = id('REFGONE')

    beforeEach(() => {
      blocks.set(PAGE, makeBlock(PAGE, 'page', 'Quarterly Roadmap', null, 0))
      blocks.set(TAG, makeBlock(TAG, 'tag', 'urgent', null, 0))
      const dead = makeBlock(GONE, 'page', 'Deleted Page', null, 0)
      dead['deleted_at'] = '2025-01-01T00:00:00.000Z'
      blocks.set(GONE, dead)
    })

    it('resolves `[[ULID]]` to the page title and `#[ULID]` to the tag name', () => {
      expect(stripForFts(`see [[${PAGE}]] now`)).toBe('see Quarterly Roadmap now')
      expect(stripForFts(`flag #[${TAG}] please`)).toBe('flag urgent please')
    })

    // `unwrap_or_default()` over a map the SQL filtered: `deleted_at IS NULL`
    // and `block_type = ?` are both map-membership conditions, so a miss on
    // either substitutes the empty string rather than leaving the token.
    it.each([
      ['a missing id', () => id('NOSUCH')],
      ['a tombstoned page', () => GONE],
      ['a block of the wrong type', () => TAG],
    ])('drops a `[[ULID]]` naming %s', (_label, target) => {
      expect(stripForFts(`x [[${target()}]] y`)).toBe('x  y')
    })

    it('drops a `#[ULID]` naming a page rather than a tag', () => {
      expect(stripForFts(`x #[${PAGE}] y`)).toBe('x  y')
    })
  })

  // Step 1 — decode escapes outside code (#6277 B3).
  it('decodes escaped punctuation', () => {
    // Unpaired delimiters, so the markup pass finds nothing and this isolates
    // the unescape. Input: `a \* b \~ c \= d \` e`.
    expect(stripForFts('a \\* b \\~ c \\= d \\` e')).toBe('a * b ~ c = d ` e')
  })

  // An escaped delimiter that happens to PAIR is still literal (#6277 B3).
  it('decodes an escape before the markup pass, so an escaped delimiter is literal', () => {
    expect(stripForFts('\\*a\\*')).toBe('*a*')
  })

  it('NFC-normalises the result', () => {
    // `e` + U+0301 COMBINING ACUTE ⇒ the single code point `é`.
    const nfd = 'café'
    expect(nfd).toHaveLength(5)
    expect(stripForFts(nfd)).toBe('café')
    expect(stripForFts(nfd)).toHaveLength(4)
  })

  it('is total on a null / absent content column', () => {
    expect(stripForFts(null)).toBe('')
    expect(stripForFts(undefined)).toBe('')
  })
})

describe('foldForFtsIndex — case only, NEVER diacritics (#3938)', () => {
  it('folds case', () => {
    expect(matchesFtsIndex('Widget Assembly', 'widget')).toBe(true)
    expect(matchesFtsIndex('widget assembly', 'WIDGET')).toBe(true)
  })

  // The headline #3938 divergence. `matchesSearchFolded` returns TRUE for
  // every pair below (NFKD + combining-mark stripping + `ß`⇒`ss`); the trigram
  // index returns false, so this must too.
  it.each([
    ['naïve', 'naive'],
    ['Straße', 'strasse'],
    ['İstanbul', 'istanbul'],
  ])('does NOT match %j against %j — the index does not fold diacritics', (content, query) => {
    expect(matchesFtsIndex(content, query)).toBe(false)
  })

  // Not vacuous: the same corpus matches when the query carries the diacritic,
  // so the assertions above pin the FOLD and not a broken matcher.
  it.each([
    ['naïve', 'NAÏVE'],
    ['Straße', 'straße'],
    ['İstanbul', 'İSTANBUL'],
  ])('still matches %j against %j', (content, query) => {
    expect(matchesFtsIndex(content, query)).toBe(true)
  })

  // NFC on both sides — the pair to `strip_for_fts`'s NFC and
  // `sanitize_fts_query`'s.
  it('matches an NFC query against NFD-typed text once stripped', () => {
    expect(matchesFtsIndex(stripForFts('café au lait'), 'café')).toBe(true)
    expect(foldForFtsIndex('CAFÉ')).toBe('café')
  })
})
