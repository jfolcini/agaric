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
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { foldForFtsIndex, matchesFtsIndex, stripForFts } from '@/lib/tauri-mock/handlers/search'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

const SPACE = 'SPACE_S'.padStart(26, '0')

function id(label: string): string {
  return label.padStart(26, '0')
}

function clearMock(): void {
  seedBlocks()
  blocks.clear()
  blockTags.clear()
  properties.clear()
  propertyDefs.clear()
  opLog.length = 0
}

function setSpace(blockId: string, spaceId: string): void {
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set('space', {
    key: 'space',
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: spaceId,
    value_bool: null,
  })
}

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
    // column by contract (`toggle_filter.rs:716-741`), which is what makes the
    // assertion above a statement about the FTS arm rather than about the
    // fixture.
    expect(ids(search({ query: '\\*\\*gad\\*\\*', filter: FILTER_REGEX }))).toEqual([MARKUP])
  })

  /**
   * The #3938 falsifier for `search_with_toggles`' `!toggles.any()` fast path
   * (`toggle_filter.rs:206-222`).
   *
   * With no toggle on, `compose_literal_pattern` composes `(?i)<escaped
   * query>` — which every FTS candidate satisfies, EXCEPT one whose term
   * survives only in the stripped text: `post_filter_row`
   * (`toggle_filter.rs:618-642`) matches that pattern against the RAW
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
})

/**
 * The rank ORDER itself, and the OTHER arm of the keyset predicate.
 *
 * The identical-content fixture above exercises the tie arm of
 * `fetch.rs:199-201`'s OR — `|rank - cursor_rank| <= eps AND id > cursor_id` —
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
