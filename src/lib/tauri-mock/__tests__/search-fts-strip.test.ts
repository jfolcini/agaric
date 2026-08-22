/**
 * #3938 / #3943 — the mock's `fts_blocks` stand-in.
 *
 * Two divergences this file pins, both found while reviewing #3927:
 *
 *  - #3938: the FTS candidate set was `matchesSearchFolded` over RAW
 *    `blocks.content`. The backend matches a trigram index over
 *    `fts_blocks.stripped` — `strip_for_fts_with_maps`'s output
 *    (`src-tauri/agaric-store/src/fts/strip.rs:114-163`) — and its tokenizer
 *    (`tokenize = 'trigram case_sensitive 0'`, migration `0006`) folds CASE
 *    ONLY. So the mock both over-matched (diacritic-insensitively, which the
 *    index cannot do) and under-matched (blind to markup-hidden terms and to
 *    the tag / page names `#[ULID]` / `[[ULID]]` resolve to).
 *
 *  - #3943: the FTS arm reported `has_more: true` with `next_cursor: null`, so
 *    page 2 of a mock search was unreachable while the mock insisted it
 *    existed. `search_fts` mints a `(rank, id)` cursor there
 *    (`agaric-store/src/fts/search/cursor.rs`).
 *
 * The two are one issue in practice: an arm with no rank ORDER has nothing to
 * mint a keyset cursor from, and the rank has to run over the same stripped
 * text the narrowing does or the keyset stops being monotonic (see
 * `approximateFtsRank`'s zero-occurrence guard).
 *
 * #4030 adds the four residuals the #3938 review left behind, each of which
 * lives next to the block above that it belongs to:
 *
 *  - `search_blocks_partitioned` returned INSERTION order where both partitions
 *    are `ORDER BY fts.rank, b.id` (`fts/search/fetch.rs:292`, routed through
 *    `fts_fetch_rows` by `src-tauri/agaric-store/src/fts/search/partitioned.rs:165-212`);
 *  - `decodeSearchCursor` ran on the two PAGING arms only, where
 *    `PageRequest::new` decodes before `search_with_toggles` dispatches
 *    (`src-tauri/src/commands/queries.rs:228`) — so the refusal is the
 *    COMMAND's, on all four arms;
 *  - a malformed `version` is `cursor: invalid version field`
 *    (`pagination/mod.rs:658-668`), not the `unsupported version …` mismatch
 *    message — and "malformed" is a property of the LEXEME `serde_json` read,
 *    not of the number it produced, so `1.0` and `-0` are malformed while `1`
 *    is not. `JSON.parse`'s reviver `source` is what makes that expressible
 *    here;
 *  - `limit` is validated, not clamped: `PageRequest::new` takes `1..=200`
 *    (`pagination/mod.rs:855-866`) and `search_blocks_inner` then rejects
 *    anything above `MAX_SEARCH_RESULTS` (`src-tauri/src/commands/queries.rs:239-245`).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearMock, id, setSpace } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  cursorVersionSlotIsU8,
  foldForFtsIndex,
  matchesFtsIndex,
  stripForFts,
} from '@/lib/tauri-mock/handlers/search'
import { blocks, makeBlock } from '@/lib/tauri-mock/seed'

const SPACE = 'SPACE_S'.padStart(26, '0')

/** The `SpaceScope::Active` every step below runs under — not a user filter
 *  (`has_filters` excludes it), so a `filter` carrying only this is "unfiltered". */
const SCOPE = { kind: 'active', space_id: SPACE }

interface SearchResponse {
  items: Array<Record<string, unknown>>
  next_cursor: string | null
  has_more: boolean
  total_count: number | null
}

function search(args: Record<string, unknown>): SearchResponse {
  return dispatch('search_blocks', {
    filter: { scope: { kind: 'active', space_id: SPACE } },
    limit: 50,
    ...args,
  }) as SearchResponse
}

function ids(res: SearchResponse): string[] {
  return res.items.map((b) => b['id'] as string)
}

// ---------------------------------------------------------------------------
// #3938 — `strip_for_fts_with_maps`, step by step
// ---------------------------------------------------------------------------

describe('stripForFts — models strip_for_fts_with_maps (strip.rs:114-163)', () => {
  beforeEach(clearMock)

  // Step 1 — `strip_inline_markup` (strip.rs:63-83), all five delimiters.
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

  // `cap_indexed_text` (strip.rs:179-195). Unreachable through any fixture —
  // asserted through the export, like `approximateFtsRank`'s two guard
  // branches, because an omission a comment merely NAMES still diverges
  // silently the day a fixture grows past it.
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

  // Steps 2 + 3 — reference resolution through the `load_ref_maps` maps
  // (strip.rs:125-138 / 210-236).
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

  // Step 4 — unescape then NFC (strip.rs:141-162).
  it('unescapes the four backslash sequences', () => {
    // Unpaired delimiters, so the markup pass finds nothing and this isolates
    // the unescape. Input: `a \* b \~ c \= d \` e`.
    expect(stripForFts('a \\* b \\~ c \\= d \\` e')).toBe('a * b ~ c = d ` e')
  })

  // The unescape runs AFTER the markup pass, not before (strip.rs:122 then
  // :141) — an ordering with an observable consequence, so it is pinned rather
  // than left to the reader of the two line numbers. Escaped delimiters that
  // happen to PAIR are still eaten as markup, backslashes and all; unescaping
  // first would turn `\*a\*` into `*a*` and then strip it to `a`.
  it('strips markup BEFORE unescaping, as the backend does', () => {
    expect(stripForFts('\\*a\\*')).toBe('\\a\\')
    expect(stripForFts('\\*a\\*')).not.toBe('a')
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

// ---------------------------------------------------------------------------
// #3938 — through `search_blocks`, where the two arms disagree
// ---------------------------------------------------------------------------

describe('search_blocks — the FTS arms match the stripped text (#3938)', () => {
  const PAGE = id('SPAGE')
  const LINKED = id('SLINK')
  const MARKUP = id('SMARK')
  const PLAIN = id('SPLAIN')
  const REFERRER = id('SREF')
  const ACCENT = id('SACC')
  const FILTER_REGEX = { scope: { kind: 'active', space_id: SPACE }, isRegex: true }

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Search Page', null, 0))
    setSpace(PAGE, SPACE)
    blocks.set(LINKED, makeBlock(LINKED, 'page', 'Quarterly Roadmap', null, 1))
    setSpace(LINKED, SPACE)
    for (const [blockId, content] of [
      [MARKUP, 'Sprocket **gad**get inventory'],
      [PLAIN, 'plain gadget inventory'],
      [REFERRER, `depends on [[${LINKED}]]`],
      [ACCENT, 'the naïve approach'],
    ] as Array<[string, string]>) {
      const b = makeBlock(blockId, 'content', content, PAGE, 1)
      b['page_id'] = PAGE
      blocks.set(blockId, b)
    }
  })

  it('finds a term that only the STRIPPED text spells out', () => {
    expect(ids(search({ query: 'gadget' })).toSorted()).toEqual([MARKUP, PLAIN].toSorted())
  })

  it('finds a block by the TITLE of the page it links to', () => {
    expect(ids(search({ query: 'Quarterly Roadmap' })).toSorted()).toEqual(
      // The linked page matches on its own content too; the point is that the
      // REFERRER — whose raw content is a bare `[[ULID]]` — is in the answer.
      [LINKED, REFERRER].toSorted(),
    )
  })

  it('does NOT match a diacritic-folded query', () => {
    expect(ids(search({ query: 'naive' }))).toEqual([])
    // Not vacuous: the accented query finds the row.
    expect(ids(search({ query: 'naïve' }))).toEqual([ACCENT])
  })

  it('does NOT match raw markdown delimiters the index never sees', () => {
    // `**gad**` is in `blocks.content` and absent from `fts_blocks.stripped`.
    expect(ids(search({ query: '**gad**' }))).toEqual([])
    // But regex mode DOES see them — `regex_mode_query` runs against the raw
    // column by contract (`src-tauri/agaric-store/src/fts/toggle_filter.rs:716-741`), which is what makes the
    // assertion above a statement about the FTS arm rather than about the
    // fixture.
    expect(ids(search({ query: '\\*\\*gad\\*\\*', filter: FILTER_REGEX }))).toEqual([MARKUP])
  })

  /**
   * The #3938 falsifier for `search_with_toggles`' `!toggles.any()` fast path
   * (`src-tauri/agaric-store/src/fts/toggle_filter.rs:206-222`).
   *
   * With no toggle on, `compose_literal_pattern` composes `(?i)<escaped
   * query>` — which every FTS candidate satisfies, EXCEPT one whose term
   * survives only in the stripped text: `post_filter_row`
   * (`src-tauri/agaric-store/src/fts/toggle_filter.rs:618-642`) matches that pattern against the RAW
   * `content` column. So the fast path and the post-filter fallthrough
   * disagree on exactly this row and nothing else, which is why the branch was
   * un-falsifiable while the mock folded over raw content.
   *
   * Both arms are asserted, not just the interesting one: the pair is the
   * evidence, and pinning the fast path alone would pass against a mock whose
   * post-filter arm had quietly become a copy of it.
   */
  it('arm 4 keeps a markup-hidden hit that arm 5 post-filters away', () => {
    // Arm 4 — every toggle off.
    expect(ids(search({ query: 'gadget' })).toSorted()).toEqual([MARKUP, PLAIN].toSorted())
    // Arm 5 — `caseSensitive` on, so the SAME FTS candidate set is narrowed by
    // `(?-i)gadget` over raw content. `MARKUP` is dropped; `PLAIN` is not.
    expect(
      ids(
        search({
          query: 'gadget',
          filter: { scope: { kind: 'active', space_id: SPACE }, caseSensitive: true },
        }),
      ),
    ).toEqual([PLAIN])
    // …and `wholeWord`, the other toggle onto the same arm.
    expect(
      ids(
        search({
          query: 'gadget',
          filter: { scope: { kind: 'active', space_id: SPACE }, wholeWord: true },
        }),
      ),
    ).toEqual([PLAIN])
  })
})

describe('search_blocks_partitioned — same stripped haystack as search_blocks (#3938)', () => {
  const PAGE = id('PPAGE')
  const MARKUP = id('PMARK')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Partition Page', null, 0))
    setSpace(PAGE, SPACE)
    const b = makeBlock(MARKUP, 'content', 'Sprocket **gad**get inventory', PAGE, 1)
    b['page_id'] = PAGE
    blocks.set(MARKUP, b)
  })

  it('finds the markup-hidden term and rejects the diacritic-folded query', () => {
    const res = dispatch('search_blocks_partitioned', {
      query: 'gadget',
      pageLimit: 10,
      blockLimit: 10,
    }) as { blocks: SearchResponse }
    expect(ids(res.blocks)).toEqual([MARKUP])

    const folded = dispatch('search_blocks_partitioned', {
      query: 'naive',
      pageLimit: 10,
      blockLimit: 10,
    }) as { blocks: SearchResponse }
    expect(ids(folded.blocks)).toEqual([])
  })
})

/**
 * #4030 item 1 — BOTH partitions are rank-ordered.
 *
 * `search_fts_partitioned` runs its two scans through `fts_fetch_rows`
 * (`src-tauri/agaric-store/src/fts/search/partitioned.rs:165-212`), whose SQL ends `ORDER BY fts.rank, b.id`
 * (`src-tauri/agaric-store/src/fts/search/fetch.rs:292`) — the SAME clause the single-partition `search_fts` arm
 * pages on. `src-tauri/agaric-store/src/fts/search/partitioned.rs:55-60` documents both partitions as "in rank
 * order". #4026 moved this handler's HAYSTACK onto `stripForFts` and left its
 * SEQUENCE at `blocks` Map insertion order, so the two sibling commands agreed
 * on which blocks match and disagreed on their order.
 *
 * The fixture is inserted in an order that is none of the candidate answers:
 * the expected `(rank, id)` order is not insertion order, and the two
 * IDENTICALLY-ranked rows are inserted with the LATER id first, so a rank-only
 * sort (JS `Array#toSorted` is stable) still returns them the wrong way round.
 * A fix that sorts by rank and forgets `b.id` therefore fails, as does one that
 * sorts only the `blocks` partition and leaves `pages` alone.
 */
describe('search_blocks_partitioned — both partitions are (rank, id)-ordered (#4030)', () => {
  // Identical content ⇒ identical rank; only the `b.id` tiebreak separates
  // them, and `TIE_LO < TIE_HI` byte-wise.
  const TIE_LO = id('QPA1')
  const TIE_HI = id('QPA2')
  // A content-typed row, so the `pages` partition is a strictly smaller set
  // than `blocks` and the two expectations cannot be satisfied by one list.
  const MIDDLE = id('QCB3')
  const WORST = id('QPA4')

  beforeEach(() => {
    clearMock()
    // Insertion order: WORST, TIE_HI, MIDDLE, TIE_LO — deliberately neither
    // the expected order nor its reverse.
    for (const [blockId, type, content] of [
      [WORST, 'page', 'gizmo with a good deal of additional unrelated padding text here'],
      [TIE_HI, 'page', 'gizmo'],
      [MIDDLE, 'content', 'gizmo gizmo'],
      [TIE_LO, 'page', 'gizmo'],
    ] as Array<[string, string, string]>) {
      const b = makeBlock(blockId, type, content, null, 1)
      b['page_id'] = blockId
      blocks.set(blockId, b)
      setSpace(blockId, SPACE)
    }
  })

  function partitioned(args: Record<string, unknown>): {
    pages: SearchResponse
    blocks: SearchResponse
  } {
    return dispatch('search_blocks_partitioned', {
      query: 'gizmo',
      pageLimit: 10,
      blockLimit: 10,
      ...args,
    }) as { pages: SearchResponse; blocks: SearchResponse }
  }

  it('orders the unrestricted partition by rank, then id', () => {
    expect(ids(partitioned({}).blocks)).toEqual([TIE_LO, TIE_HI, MIDDLE, WORST])
  })

  it('orders the page-only partition by rank, then id', () => {
    // Same rule over the `block_type = 'page'` pre-filter — MIDDLE is absent,
    // so this is not the assertion above restated.
    expect(ids(partitioned({}).pages)).toEqual([TIE_LO, TIE_HI, WORST])
  })

  it('caps each partition at the best-ranked rows, not the first-inserted ones', () => {
    // The cap is `take(limit)` AFTER the ORDER BY, so a 2-row page is the two
    // BEST rows. Under insertion order it would be [WORST, TIE_HI].
    const res = partitioned({ pageLimit: 2, blockLimit: 2 })
    expect(ids(res.blocks)).toEqual([TIE_LO, TIE_HI])
    expect(ids(res.pages)).toEqual([TIE_LO, TIE_HI])
    // `has_more` still rides the `limit + 1` probe, in both directions.
    expect(res.blocks.has_more).toBe(true)
    expect(res.pages.has_more).toBe(true)
    const all = partitioned({ pageLimit: 10, blockLimit: 10 })
    expect(all.blocks.has_more).toBe(false)
    expect(all.pages.has_more).toBe(false)
  })

  it('mints no cursor on either partition', () => {
    // `search_blocks_partitioned_inner` hardcodes `next_cursor: None`
    // (`src-tauri/src/commands/queries.rs:783-796`) — the palette does not paginate. Ordering the
    // partitions through the `search_fts` seam must not start emitting one.
    const res = partitioned({ pageLimit: 2, blockLimit: 2 })
    expect(res.pages.next_cursor).toBeNull()
    expect(res.blocks.next_cursor).toBeNull()
  })

  it('answers a zero limit with an empty partition and no has_more', () => {
    // `src-tauri/agaric-store/src/fts/search/partitioned.rs:237-238` — `page_limit_usize > 0 && …`. Zero is a legal
    // ask HERE (the command's own range is `[0, 100]`, `src-tauri/src/commands/queries.rs:735-741`),
    // unlike `search_blocks`'s `PageRequest::new`, which refuses it.
    const res = partitioned({ pageLimit: 0, blockLimit: 0 })
    expect(res.pages.items).toEqual([])
    expect(res.pages.has_more).toBe(false)
    expect(res.blocks.items).toEqual([])
    expect(res.blocks.has_more).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// #3943 — the `(rank, id)` cursor
// ---------------------------------------------------------------------------

/**
 * `cursorShape`'s rendering of a `pagination::Cursor` (the conformance
 * harness's #3893 projection): `v<version>:{<populated slots, sorted>}`.
 * Reimplemented here rather than imported so this file asserts the WIRE bytes,
 * not the harness's agreement with itself.
 */
function decodeCursorSlots(raw: string): { version: unknown; slots: string[]; id: string } {
  expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
  const json = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
    ),
  ) as Record<string, unknown>
  return {
    version: json['version'],
    slots: Object.keys(json)
      .filter((k) => k !== 'version')
      .toSorted(),
    id: json['id'] as string,
  }
}

describe('search_blocks — the FTS arm mints a resumable (rank, id) cursor (#3943)', () => {
  const PAGE = id('CPAGE')
  // Ids ascending. All four carry IDENTICAL content, so all four rank
  // identically and `id` ASC alone decides the order — the same tiebreak
  // `ORDER BY fts.rank, b.id` (`fts/search/fetch.rs:292`) applies, and the one
  // case where a mock page is comparable to a backend page at all.
  const ROWS = ['C1', 'C2', 'C3', 'C4'].map((label) => id(label))

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Cursor Page', null, 0))
    setSpace(PAGE, SPACE)
    for (const blockId of ROWS) {
      const b = makeBlock(blockId, 'content', 'gizmo calibration record', PAGE, 1)
      b['page_id'] = PAGE
      blocks.set(blockId, b)
    }
  })

  it('walks every row exactly once across pages, in (rank, id) order', () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 8; page++) {
      const res: SearchResponse = search({ query: 'gizmo', limit: 2, cursor })
      seen.push(...ids(res))
      if (!res.has_more) {
        expect(res.next_cursor).toBeNull()
        break
      }
      expect(res.next_cursor).not.toBeNull()
      cursor = res.next_cursor
    }
    // The whole set, once each, in id order — page 2 is REACHABLE, which is
    // the entirety of #3943. A `next_cursor: null` regression makes the second
    // request re-deliver page 1, so `seen` becomes [C1,C2,C1,C2,…] and both
    // assertions fail.
    expect(seen).toEqual(ROWS)
    expect(new Set(seen).size).toBe(ROWS.length)
  })

  it('mints the `v1:{id,rank}` keyset shape the backend does', () => {
    const res = search({ query: 'gizmo', limit: 2 })
    expect(res.has_more).toBe(true)
    const cursor = res.next_cursor
    expect(cursor).not.toBeNull()
    const decoded = decodeCursorSlots(cursor as string)
    // `Cursor::for_id_and_rank` populates exactly these two slots; the other
    // three are `skip_serializing_if = "Option::is_none"` and must be ABSENT,
    // because presence is what the harness records as the keyset.
    expect(decoded.slots).toEqual(['id', 'rank'])
    expect(decoded.version).toBe(1)
    // Minted from the LAST RETURNED row, not from the discarded probe row
    // (`cursor.rs`: `rows[limit_usize - 1]`). Off-by-one the other way and
    // page 2 would skip C3.
    expect(decoded.id).toBe(ROWS[1])
  })

  it('the filter-only arm mints `v1:{id}` — no rank slot', () => {
    const res = search({
      query: '',
      limit: 2,
      filter: { scope: { kind: 'active', space_id: SPACE }, parentId: PAGE },
    })
    expect(res.has_more).toBe(true)
    expect(decodeCursorSlots(res.next_cursor as string).slots).toEqual(['id'])
  })

  // `has_more` is DERIVED from the cursor (#3943's closing note), so the
  // inconsistent state cannot be constructed. Asserted on BOTH paging arms and
  // in BOTH directions: the last page must be `false` + `null` and no page may
  // be `true` + `null`.
  it.each([
    ['fts', { query: 'gizmo' }],
    [
      'filter-only',
      { query: '', filter: { scope: { kind: 'active', space_id: SPACE }, parentId: PAGE } },
    ],
  ])('%s arm: has_more is true exactly when a cursor was minted', (_label, extra) => {
    for (const limit of [1, 2, 3, 4, 5]) {
      const res = search({ limit, ...extra })
      expect(
        res.has_more,
        `limit=${limit} has_more=${res.has_more} next_cursor=${JSON.stringify(res.next_cursor)}`,
      ).toBe(res.next_cursor !== null)
    }
    // Not vacuous — the sweep spans the boundary in both directions.
    expect(search({ limit: 3, ...extra }).has_more).toBe(true)
    expect(search({ limit: 4, ...extra }).has_more).toBe(false)
  })

  // `PageRequest::new` decodes the cursor BEFORE `search_with_toggles` picks an
  // arm (`src-tauri/src/commands/queries.rs:228`) and propagates
  // `AppError::Validation`, so a malformed cursor is a refusal on EVERY arm —
  // not a silent restart from row 0. One case per guard in
  // `decodeSearchCursor`, because a guard nothing reaches is decoration; and
  // both paging arms, because they share the decoder and pinning one would
  // leave the other free to grow its own lenient copy back.
  const ARMS: Array<[string, Record<string, unknown>]> = [
    ['fts', { query: 'gizmo' }],
    [
      'filter-only',
      { query: '', filter: { scope: { kind: 'active', space_id: SPACE }, parentId: PAGE } },
    ],
  ]

  /** URL-safe unpadded base64 of `bytes`, however malformed. */
  function b64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
  }
  function b64urlJson(value: unknown): string {
    return b64url(new TextEncoder().encode(JSON.stringify(value)))
  }

  const MALFORMED: Array<[string, string, RegExp]> = [
    ['a non-base64url alphabet', 'not base64!!', /invalid cursor: invalid base64/],
    // 0xFF is not a valid UTF-8 lead byte, and the decode is `fatal: true` —
    // a non-fatal decoder would substitute U+FFFD and then fail as bad JSON,
    // which is the WRONG one of the engine's four modes.
    ['bytes that are not UTF-8', b64url(new Uint8Array([0xff, 0xfe])), /invalid cursor UTF-8/],
    ['valid UTF-8 that is not JSON', b64url(new TextEncoder().encode('{oops')), /not valid JSON/],
    ['JSON that is not an object', b64urlJson([1, 2]), /not an object/],
    ['an object with no `id`', b64urlJson({ rank: 1, version: 1 }), /missing `id`/],
    ['a non-numeric `rank`', b64urlJson({ id: 'x', rank: 'abc', version: 1 }), /not a number/],
    // The case a silent restart hides best: the bytes decode cleanly and only
    // the version is wrong.
    [
      'a version the codec does not support',
      b64urlJson({ id: 'x', version: 99 }),
      /unsupported version 99/,
    ],
    // ORDER, not just the guards: `Cursor::decode` reads `version` off the
    // untyped `Value` and rejects a mismatch BEFORE `serde_json::from_value`
    // ever looks for `id` (`pagination/mod.rs:654-676`). Checking the fields
    // first reports `missing id` here — a different refusal for the same
    // bytes, and the only input that can tell the two orders apart.
    [
      'a stale version, before it complains about the missing `id`',
      b64urlJson({ version: 99 }),
      /unsupported version 99/,
    ],
    // #4030 item 3 — a MALFORMED `version` is its own refusal, distinct from
    // the mismatch above. `Cursor::decode` (`pagination/mod.rs:658-668`) reads
    // the slot off the untyped `Value`: a non-`Number` is rejected outright,
    // and a `Number` that is not a `u8` (`as_u64().and_then(u8::try_from)`)
    // fails the same way — both with `cursor: invalid version field`, BEFORE
    // any comparison to `CURRENT_CURSOR_VERSION` happens. Accept/reject parity
    // held without this (every case below is a refusal either way), so only the
    // exact TEXT can tell the two guards apart — hence `^…$` rather than a
    // substring match, and hence the mismatch case above stays in the table as
    // the other half of the pair: a decoder that answered "invalid version
    // field" for everything would fail it.
    [
      'a `version` that is not a number',
      b64urlJson({ id: 'x', version: '1' }),
      /^cursor: invalid version field$/,
    ],
    [
      'a JSON `null` `version`',
      b64urlJson({ id: 'x', version: null }),
      /^cursor: invalid version field$/,
    ],
    [
      'a fractional `version`',
      b64urlJson({ id: 'x', version: 1.5 }),
      /^cursor: invalid version field$/,
    ],
    [
      'a negative `version`',
      b64urlJson({ id: 'x', version: -1 }),
      /^cursor: invalid version field$/,
    ],
    // `as_u64()` succeeds and `u8::try_from` does not — the second half of the
    // Rust `and_then`, which a bare "is it an integer" check would let through.
    [
      'a `version` above `u8::MAX`',
      b64urlJson({ id: 'x', version: 256 }),
      /^cursor: invalid version field$/,
    ],
  ]

  for (const [armLabel, extra] of ARMS) {
    it.each(MALFORMED)(`${armLabel} arm: rejects %s`, (_label, cursor, message) => {
      expect(() => search({ limit: 2, cursor, ...extra })).toThrow(
        expect.objectContaining({ kind: 'validation', message: expect.stringMatching(message) }),
      )
    })
  }

  // The decoder is not simply throwing on everything: a WELL-FORMED cursor of
  // the other arm's shape is accepted, which is what makes the table above a
  // statement about malformed input rather than about the decoder being broken.
  it.each(ARMS)('%s arm: accepts a well-formed cursor', (_label, extra) => {
    const first = search({ limit: 2, ...extra })
    expect(first.next_cursor).not.toBeNull()
    expect(() => search({ limit: 2, cursor: first.next_cursor, ...extra })).not.toThrow()
  })

  // #4030 item 2 — the OTHER two arms. `search_blocks_inner` decodes the cursor
  // in `PageRequest::new` (`src-tauri/src/commands/queries.rs:228`) BEFORE `search_with_toggles` picks
  // an arm, so the refusal belongs to the command; an arm that happens to
  // ignore the decoded value still cannot be reached with a cursor that does
  // not decode. Both of these return before the mock's paging helpers ever run,
  // which is exactly why they were the two that let a malformed cursor through.
  const NON_PAGING_ARMS: Array<[string, Record<string, unknown>]> = [
    // Regex mode BYPASSES FTS5 and never emits a cursor (`toggle_filter.rs`).
    ['regex', { query: 'gizmo', filter: { scope: SCOPE, isRegex: true } }],
    // A blank query with no structural filter is the empty page by construction.
    ['blank-unfiltered', { query: '', filter: { scope: SCOPE } }],
  ]

  for (const [armLabel, extra] of NON_PAGING_ARMS) {
    it.each(MALFORMED)(`${armLabel} arm: rejects %s`, (_label, cursor, message) => {
      expect(() => search({ limit: 2, cursor, ...extra })).toThrow(
        expect.objectContaining({ kind: 'validation', message: expect.stringMatching(message) }),
      )
    })
  }

  // …and the other half: a cursor that DECODES is accepted and then ignored,
  // because neither arm has a keyset to resume. Without this the block above
  // would pass against a handler that refused every cursor outright — a
  // different divergence in the same place.
  it.each(NON_PAGING_ARMS)('%s arm: accepts a well-formed cursor and ignores it', (_l, extra) => {
    const wellFormed = b64urlJson({ id: ROWS[1], rank: 5, version: 1 })
    const withCursor = search({ limit: 2, cursor: wellFormed, ...extra })
    const without = search({ limit: 2, ...extra })
    expect(ids(withCursor)).toEqual(ids(without))
    expect(withCursor.next_cursor).toBeNull()
  })

  // The regex arm's row set is non-empty, so the equality above is a real
  // comparison there rather than `[] === []` (the blank-unfiltered arm's answer
  // IS the empty page, and that arm is pinned by the refusal table instead).
  it('regex arm: the ignored-cursor comparison is over a non-empty page', () => {
    expect(
      ids(search({ limit: 2, query: 'gizmo', filter: { scope: SCOPE, isRegex: true } })).length,
    ).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // #4030 item 3, the LEXEME half
  // -------------------------------------------------------------------------

  /**
   * `Cursor::decode` judges the `version` slot by the lexeme `serde_json`
   * parsed, not by the number it produced: `1` is an integer `Number` and
   * `1.0` is an `f64`, whose `as_u64()` is `None`. `JSON.parse` erases that —
   * `1`, `1.0`, `1e0` and `-0` are one JS number — so the mock read the VALUE
   * and diverged on every lexeme that is not an integer but whose value is a
   * `u8`. `JSON.parse`'s reviver `context.source` (ES2025) hands back the raw
   * lexeme and closes it.
   *
   * The expectations below are MEASURED, not derived: the middle column is the
   * output of a `serde_json` probe over exactly these lexemes, run through the
   * same `match` arms `pagination/mod.rs:656-667` uses. That is the point —
   * `1e2` refuses where a reader who only thought about `1.0` would expect
   * `unsupported version 100`, and `-0` refuses where "is it an integer ≥ 0"
   * says yes.
   *
   * The last column is the FALLBACK, for a runtime that withholds `source`. It
   * is here rather than in prose because the residue has to be exact to be
   * honest: `1.0` / `1e0` are ACCEPTED there (an accept/reject divergence, the
   * only one), and `2.0` / `0.0` / `255.0` / `1e2` / `1E2` / `-0` report the
   * MISMATCH message instead of the malformed one (a text divergence — the very
   * parity item 3 exists to restore). Every other row agrees on both paths.
   */
  const VERSION_LEXEMES: Array<[string, string | null, string | null]> = [
    // lexeme,  with `source` (the backend's answer),  without `source`
    ['1', null, null],
    [
      '0',
      'cursor: unsupported version 0 (expected 1)',
      'cursor: unsupported version 0 (expected 1)',
    ],
    [
      '2',
      'cursor: unsupported version 2 (expected 1)',
      'cursor: unsupported version 2 (expected 1)',
    ],
    [
      '255',
      'cursor: unsupported version 255 (expected 1)',
      'cursor: unsupported version 255 (expected 1)',
    ],
    ['256', 'cursor: invalid version field', 'cursor: invalid version field'],
    ['1.5', 'cursor: invalid version field', 'cursor: invalid version field'],
    ['-1', 'cursor: invalid version field', 'cursor: invalid version field'],
    ['"1"', 'cursor: invalid version field', 'cursor: invalid version field'],
    ['null', 'cursor: invalid version field', 'cursor: invalid version field'],
    ['true', 'cursor: invalid version field', 'cursor: invalid version field'],
    // Non-primitives carry no `source` on ANY runtime, so both columns are the
    // value test — which rejects them for not being numbers.
    ['[]', 'cursor: invalid version field', 'cursor: invalid version field'],
    ['{}', 'cursor: invalid version field', 'cursor: invalid version field'],
    // The whole of the difference between the two columns starts here.
    ['1.0', 'cursor: invalid version field', null],
    ['1e0', 'cursor: invalid version field', null],
    ['2.0', 'cursor: invalid version field', 'cursor: unsupported version 2 (expected 1)'],
    ['0.0', 'cursor: invalid version field', 'cursor: unsupported version 0 (expected 1)'],
    ['255.0', 'cursor: invalid version field', 'cursor: unsupported version 255 (expected 1)'],
    ['1e2', 'cursor: invalid version field', 'cursor: unsupported version 100 (expected 1)'],
    ['1E2', 'cursor: invalid version field', 'cursor: unsupported version 100 (expected 1)'],
    ['-0', 'cursor: invalid version field', 'cursor: unsupported version 0 (expected 1)'],
  ]

  /**
   * Feature detection, recomputed here rather than imported, so the test states
   * its own premise: if this ever reads `false` the table below silently
   * switches columns, and that has to be visible in the test output.
   */
  const HAS_JSON_SOURCE = ((): boolean => {
    let seen: unknown
    try {
      ;(JSON.parse as unknown as (t: string, r: unknown) => unknown)(
        '{"v":1.0}',
        (key: string, value: unknown, ctx?: { source?: string }) => {
          if (key === 'v') seen = ctx?.source
          return value
        },
      )
    } catch {
      return false
    }
    return seen === '1.0'
  })()

  /** Base64url of RAW JSON text. `b64urlJson` cannot express these cases at
   *  all: `JSON.stringify` normalises `1.0` and `1e0` to `1`, and `-0` to `0`,
   *  destroying the very lexeme under test before it reaches the encoder. */
  function b64urlRaw(text: string): string {
    return b64url(new TextEncoder().encode(text))
  }

  it('the runtime under test exposes `JSON.parse` source text', () => {
    // Not an assertion about the mock — an assertion about which COLUMN of the
    // table below was exercised. Node ≥ 22 and Chrome ≥ 114 both expose it; if
    // this ever fails, the suite is pinning the fallback and the strict rule is
    // covered only by the pure-predicate test that follows.
    expect(HAS_JSON_SOURCE).toBe(true)
  })

  it.each(VERSION_LEXEMES)(
    'refuses (or accepts) a `version` lexeme of %s exactly as `serde_json` does',
    (lexeme, strict, fallback) => {
      const expected = HAS_JSON_SOURCE ? strict : fallback
      const cursor = b64urlRaw(`{"id":${JSON.stringify(ROWS[1])},"version":${lexeme}}`)
      if (expected === null) {
        expect(() => search({ query: 'gizmo', limit: 2, cursor })).not.toThrow()
        return
      }
      expect(() => search({ query: 'gizmo', limit: 2, cursor })).toThrow(
        expect.objectContaining({ kind: 'validation', message: expected }),
      )
    },
  )

  // The pure rule, both ways round, so BOTH columns are pinned on every runtime
  // rather than only whichever one this engine happens to take. `true` means
  // "the slot is a `u8`" — the mismatch rows reach the `!==` comparison and are
  // refused there instead, which is the backend's own division of labour.
  it.each(VERSION_LEXEMES)(
    'the %s slot predicate agrees with the table on both paths',
    (lexeme, strict, fallback) => {
      const value = (JSON.parse(`{"v":${lexeme}}`) as { v: unknown }).v
      expect(cursorVersionSlotIsU8(value, lexeme), `lexeme path for ${lexeme}`).toBe(
        strict !== 'cursor: invalid version field',
      )
      expect(cursorVersionSlotIsU8(value, undefined), `value path for ${lexeme}`).toBe(
        fallback !== 'cursor: invalid version field',
      )
    },
  )

  // The reviver sees EVERY `version` key in the document, and it sees nested
  // ones FIRST when the nested object is declared first. `Cursor::decode` reads
  // `value.get("version")` — the root object's own slot and nothing else — so
  // the lexeme has to be narrowed to the root holder. Taking the last-seen
  // source instead would refuse this well-formed cursor for a lexeme buried in
  // a key the backend never looks at.
  it('reads the ROOT `version` lexeme, not a nested one', () => {
    const nestedFirst = b64urlRaw(
      `{"version":1,"nested":{"version":1.0},"id":${JSON.stringify(ROWS[1])}}`,
    )
    expect(() => search({ query: 'gizmo', limit: 2, cursor: nestedFirst })).not.toThrow()
    // …and the mirror image: a malformed ROOT lexeme is still caught when a
    // well-formed nested one follows it.
    const rootMalformed = b64urlRaw(
      `{"version":1.0,"nested":{"version":1},"id":${JSON.stringify(ROWS[1])}}`,
    )
    expect(() => search({ query: 'gizmo', limit: 2, cursor: rootMalformed })).toThrow(
      expect.objectContaining({ kind: 'validation', message: 'cursor: invalid version field' }),
    )
  })

  it('the two columns actually differ, so the fallback residue is not vacuous', () => {
    const diverging = VERSION_LEXEMES.filter(([, strict, fallback]) => strict !== fallback)
    expect(diverging.map(([lexeme]) => lexeme)).toEqual([
      '1.0',
      '1e0',
      '2.0',
      '0.0',
      '255.0',
      '1e2',
      '1E2',
      '-0',
    ])
  })
})

/**
 * The rank ORDER itself, and the OTHER arm of the keyset predicate.
 *
 * The identical-content fixture above exercises the tie arm of
 * `src-tauri/agaric-store/src/fts/search/fetch.rs:199-201`'s OR — `|rank - cursor_rank| <= eps AND id > cursor_id` —
 * because every row ranks the same and `id` alone separates them. This fixture
 * ranks every row DIFFERENTLY, so it exercises the strict arm
 * (`rank > cursor_rank + eps`) instead. Pinning one and leaving the other open
 * would credit the predicate from half its inputs.
 *
 * It also pins the ORDER, which the tie fixture cannot: there, `(rank, id)`
 * order and insertion order coincide. Here they are three different
 * permutations.
 */
describe('search_blocks — the FTS arm orders by (rank, id), not insertion (#3943)', () => {
  const PAGE = id('RPAGE')
  // Inserted in id order R1 < R2 < R3, with content chosen so that
  // `approximateFtsRank` (length / occurrences, ascending = best) ranks them in
  // the REVERSE order. So `(rank, id)` is neither insertion order, nor id ASC,
  // nor id DESC.
  const WORST = id('R1')
  const MIDDLE = id('R2')
  const BEST = id('R3')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Rank Page', null, 0))
    setSpace(PAGE, SPACE)
    for (const [blockId, content] of [
      [WORST, 'gizmo and a good deal of additional unrelated padding text here'],
      [MIDDLE, 'gizmo gizmo'],
      [BEST, 'gizmo'],
    ] as Array<[string, string]>) {
      const b = makeBlock(blockId, 'content', content, PAGE, 1)
      b['page_id'] = PAGE
      blocks.set(blockId, b)
    }
  })

  it('returns the page in rank order', () => {
    expect(ids(search({ query: 'gizmo' }))).toEqual([BEST, MIDDLE, WORST])
    // Not vacuous — the expected order is none of the orders a missing sort
    // would produce.
    expect([BEST, MIDDLE, WORST]).not.toEqual([WORST, MIDDLE, BEST])
    expect([BEST, MIDDLE, WORST]).not.toEqual([WORST, MIDDLE, BEST].toSorted())
  })

  it('resumes across STRICTLY-increasing ranks, one row per page', () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 8; page++) {
      const res: SearchResponse = search({ query: 'gizmo', limit: 1, cursor })
      seen.push(...ids(res))
      if (!res.has_more) break
      cursor = res.next_cursor
      expect(cursor).not.toBeNull()
    }
    expect(seen).toEqual([BEST, MIDDLE, WORST])
  })
})

/**
 * #4030 item 4 — `limit` is VALIDATED, not clamped.
 *
 * Two checks, in the order `search_blocks_inner` runs them:
 *
 *  1. `PageRequest::new` (`pagination/mod.rs:855-866`) accepts `1..=200` and
 *     refuses anything else — `0` included. The mock clamped only the UPPER
 *     bound (`Math.min(…, SEARCH_MAX_RESULTS)`), so `limit: 0` reached the
 *     paging helpers and answered `items: []` with `has_more: false` even with
 *     rows left to serve: a client's "no more results" where the backend
 *     refuses the request. The backend cannot get there at all —
 *     `rows[limit_usize - 1]` would underflow.
 *  2. `search_blocks_inner` then rejects `limit > MAX_SEARCH_RESULTS`
 *     (`src-tauri/src/commands/queries.rs:239-245`) rather than letting `search_fts`'s `min` silently
 *     shrink the ask, so `101..=200` is a refusal too — with a DIFFERENT
 *     message, since it is a different guard in a different function.
 *
 * Every case asserts the exact string, because a test that only asserted "it
 * threw" cannot tell the two guards apart, and both of them fire on inputs the
 * other would also reject.
 */
describe('search_blocks — the limit range is a refusal, not a clamp (#4030)', () => {
  const PAGE = id('LPAGE')
  const ROWS = ['L1', 'L2', 'L3'].map((label) => id(label))

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Limit Page', null, 0))
    setSpace(PAGE, SPACE)
    for (const blockId of ROWS) {
      const b = makeBlock(blockId, 'content', 'gizmo calibration record', PAGE, 1)
      b['page_id'] = PAGE
      blocks.set(blockId, b)
    }
  })

  /** Every arm, so the refusal is the COMMAND's and not one helper's (#4030
   *  item 2's point, applied to the guard that runs before dispatch). */
  const ALL_ARMS: Array<[string, Record<string, unknown>]> = [
    ['fts', { query: 'gizmo' }],
    ['filter-only', { query: '', filter: { scope: SCOPE, parentId: PAGE } }],
    ['regex', { query: 'gizmo', filter: { scope: SCOPE, isRegex: true } }],
    ['blank-unfiltered', { query: '', filter: { scope: SCOPE } }],
  ]

  const OUT_OF_RANGE: Array<[number, string]> = [
    // The zero-means-zero case: the mock's `items.at(-1)` returned `undefined`
    // here, so it answered an empty page instead of refusing.
    [
      0,
      'pagination limit must be in [1, 200]; got 0. For larger result sets, use cursor pagination.',
    ],
    [
      -1,
      'pagination limit must be in [1, 200]; got -1. For larger result sets, use cursor pagination.',
    ],
    [
      201,
      'pagination limit must be in [1, 200]; got 201. For larger result sets, use cursor pagination.',
    ],
    // Inside `PageRequest::new`'s range and outside the FTS scan ceiling — the
    // SECOND guard, which is what makes this a pair rather than one boundary.
    [101, 'search limit must be in [1, 100]; got 101'],
    [200, 'search limit must be in [1, 100]; got 200'],
  ]

  for (const [armLabel, extra] of ALL_ARMS) {
    it.each(OUT_OF_RANGE)(`${armLabel} arm: refuses limit %i`, (limit, message) => {
      expect(() => search({ limit, ...extra })).toThrow(
        expect.objectContaining({ kind: 'validation', message }),
      )
    })
  }

  // The other half of every pair above: an IN-RANGE limit still serves rows, on
  // the same fixture and the same arms. Without this a handler that refused
  // every request — or returned an empty page for every limit — would pass the
  // table above, which is the failure the `limit: 0` bug actually was.
  it.each(ALL_ARMS)('%s arm: an in-range limit still answers', (label, extra) => {
    for (const limit of [1, 3, 100]) {
      const res = search({ limit, ...extra })
      // The blank-unfiltered arm's answer is the empty page BY CONSTRUCTION
      // (`has_filters` false), so it is the one arm where rows are not expected.
      const expected = label === 'blank-unfiltered' ? 0 : Math.min(limit, ROWS.length)
      expect(res.items.length, `${label} limit=${limit}`).toBe(expected)
    }
  })

  // The range test accepts a value rather than rejecting two bounds, so a
  // non-integer cannot slip past both comparisons into `slice(0, limit + 1)`
  // (where `'5' + 1` is the string `'51'`).
  //
  // NEITHER the kind NOR the text is asserted against the backend here, and the
  // distinction matters: the two cases above never reach `PageRequest::new` on
  // the real stack. Tauri's `Option<i64>` deserialisation refuses them at the
  // IPC boundary, and that failure is not an `AppError` — it carries no kind
  // for the mock's `validation` to be in parity WITH, so this is the documented
  // exception to the #2463 kind-parity rule rather than an instance of it. What
  // is pinned is only that the mock REFUSES rather than computing a fractional
  // slice bound. `50.5` is reachable from a typed caller (`limit: number |
  // null` in `bindings.ts`); the string case is not, and is here because the
  // guard's shape is what rules it out.
  it.each([[50.5], ['5' as unknown as number]])(
    'refuses a non-integer limit %p (the mock, not the backend, chooses this kind)',
    (limit) => {
      expect(() => search({ query: 'gizmo', limit })).toThrow(
        expect.objectContaining({ kind: 'validation' }),
      )
    },
  )

  it('defaults an omitted limit to DEFAULT_PAGE_SIZE rather than refusing', () => {
    // `PageRequest::new`'s `None => DEFAULT_PAGE_SIZE` (50) — an absent limit is
    // not an out-of-range one, and `null` deserialises to the same `None`.
    expect(ids(search({ query: 'gizmo', limit: undefined }))).toEqual(ROWS)
    expect(ids(search({ query: 'gizmo', limit: null }))).toEqual(ROWS)
  })

  // ORDER, not just the guards. The three checks run in one fixed sequence
  // inside `search_blocks_inner`, and each pair below has exactly one input
  // that can tell two of them apart.
  it('checks the limit RANGE before decoding the cursor', () => {
    // `PageRequest::new` validates `limit` and only then calls
    // `Cursor::decode` (`pagination/mod.rs:856-869`), so a request that is bad
    // in both ways reports the LIMIT.
    expect(() => search({ query: 'gizmo', limit: 0, cursor: 'not base64!!' })).toThrow(
      expect.objectContaining({
        message:
          'pagination limit must be in [1, 200]; got 0. For larger result sets, use cursor pagination.',
      }),
    )
  })

  it('decodes the cursor before rejecting an over-cap limit', () => {
    // …and the FTS ceiling is checked AFTER `PageRequest::new` returns
    // (`src-tauri/src/commands/queries.rs:230-246`), so a 150-limit request with a broken cursor
    // reports the CURSOR. Same two malformed inputs as the case above, opposite
    // answer — which is what pins the sequence rather than the set.
    expect(() => search({ query: 'gizmo', limit: 150, cursor: 'not base64!!' })).toThrow(
      expect.objectContaining({ message: 'invalid cursor: invalid base64' }),
    )
  })
})
