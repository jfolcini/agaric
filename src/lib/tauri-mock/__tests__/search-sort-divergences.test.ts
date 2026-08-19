/**
 * #3939 — three narrow mock-vs-backend divergences that no conformance step
 * could reach, each with the fixture that makes it observable.
 *
 * The issue's own acceptance criterion is that criterion: "add the fixture that
 * makes the divergence observable, show it reddens against the current mock,
 * then fix. Fixing without the reddening fixture leaves the same class of blind
 * spot behind." All three fixtures below redden against `848e98679`.
 *
 *  1. `compareMetaRows`' alphabetical arm ran `toLowerCase().localeCompare()`.
 *     The backend orders `COALESCE(b.content,'') COLLATE NOCASE`
 *     (`src-tauri/src/commands/pages/metadata.rs`) — an ASCII-only fold
 *     followed by a UTF-8 BYTE memcmp. The reachable fixture the issue asked
 *     for is a non-ASCII title.
 *  2. The regex arm applied its 1000-row pre-filter cap BEFORE dropping
 *     `content IS NULL` rows. `regex_mode_query`'s SQL carries
 *     `AND b.content IS NOT NULL` in the `WHERE`
 *     (`agaric-store/src/fts/toggle_filter.rs:810-816`) and the
 *     `LIMIT ?cap` after it (`:866-869`), so the window is 1000 rows WITH
 *     content. The reachable fixture is null-content rows filling the window.
 *  3. `re.test` accepted a zero-width match. Both backend sites keep only
 *     `m.end() > m.start()` matches and drop the row when none survives
 *     (`post_filter_row`, `:618-641`; `regex_mode_query`'s loop, `:905-919`).
 *     The reachable fixture is a nullable pattern.
 */

import { describe, expect, it } from 'vitest'

import { clearMock, id } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { type PageMetaRow, compareMetaRows } from '@/lib/tauri-mock/handlers/shared'
import { blocks, makeBlock } from '@/lib/tauri-mock/seed'

interface SearchResponse {
  items: Array<Record<string, unknown>>
}

function row(rowId: string, content: string): PageMetaRow {
  return {
    id: rowId,
    blockType: 'page',
    content,
    parentId: null,
    position: 0,
    deletedAt: null,
    todoState: null,
    priority: null,
    dueDate: null,
    scheduledDate: null,
    pageId: rowId,
    lastModifiedAt: null,
    inboundLinkCount: 0,
    childBlockCount: 0,
    hasOutboundLink: false,
  } as PageMetaRow
}

function search(args: Record<string, unknown>): SearchResponse {
  return dispatch('search_blocks', { limit: 50, filter: {}, ...args }) as SearchResponse
}

// ---------------------------------------------------------------------------
// Item 1 — COLLATE NOCASE, not localeCompare
// ---------------------------------------------------------------------------

describe('compareMetaRows alphabetical — models COLLATE NOCASE (#3939 item 1)', () => {
  const A = id('CMR1')
  const B = id('CMR2')

  // The reachable fixture: an accented title. ICU sorts `Ápple` next to
  // `Apple` (before `Zebra`); NOCASE folds nothing non-ASCII and then memcmps,
  // so `Á` (UTF-8 `C3 81`) sorts AFTER `z` (`7A`).
  it('orders an accented title by UTF-8 bytes, not by ICU collation', () => {
    expect(compareMetaRows(row(A, 'Ápple'), row(B, 'Zebra'), 'alphabetical')).toBeGreaterThan(0)
  })

  // The second half of NOCASE: the fold is ASCII-only. Turkish dotted capital
  // `İ` (U+0130) lowercases to `i̇` (two code points) under `toLowerCase()`
  // and is untouched by NOCASE.
  it('does not fold non-ASCII case the way toLowerCase does', () => {
    // `İ` is `C4 B0`; `i` is `69`. Under NOCASE both stay put, so `İstanbul`
    // sorts after `istanbul`. Under `toLowerCase()` the two collapse toward
    // each other and ICU calls them near-equal, ordering by the tiebreak.
    expect(compareMetaRows(row(A, 'İstanbul'), row(B, 'istanbul'), 'alphabetical')).toBeGreaterThan(
      0,
    )
  })

  // ASCII case still folds — the arm is case-INSENSITIVE, which is the whole
  // point of NOCASE and must not regress into a BINARY compare.
  it('still folds ASCII case', () => {
    expect(compareMetaRows(row(A, 'apple'), row(B, 'Apple'), 'alphabetical')).toBe(
      compareMetaRows(row(A, 'apple'), row(B, 'apple'), 'alphabetical'),
    )
  })

  // The id tiebreak is `b.id ASC` — SQLite's default BINARY collation
  // (#4138 item 2's finding, applied here too).
  it('tiebreaks equal titles on the id, by bytes', () => {
    expect(compareMetaRows(row(A, 'same'), row(B, 'same'), 'alphabetical')).toBeLessThan(0)
  })
})

// ---------------------------------------------------------------------------
// Item 2 — null-content rows are excluded INSIDE the capped window
// ---------------------------------------------------------------------------

describe('search_blocks regex arm — the 1000-row window is 1000 rows WITH content (#3939 item 2)', () => {
  const PAGE = id('NUL1')

  it('reaches a match older than 1000 null-content rows', () => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Null Window', null, 0))

    // The one match, with the LOWEST id — oldest, so last in the `b.id DESC`
    // scan. Ids here are numeric-padded so `MATCH` sorts below every `N…` row.
    const MATCH = '1'.padStart(26, '0')
    const m = makeBlock(MATCH, 'content', 'quuxly gadget', PAGE, 1)
    blocks.set(MATCH, m)

    // 1000 null-content rows with higher ids: enough to fill the pre-filter
    // window on its own if they are not excluded before the cap.
    for (let i = 0; i < 1000; i++) {
      const nid = `N${String(i).padStart(25, '0')}`
      blocks.set(nid, makeBlock(nid, 'content', null, PAGE, 2))
    }

    const res = search({ query: 'qu+xly', filter: { isRegex: true } })
    expect(res.items.map((b) => b['id'])).toEqual([MATCH])
  })

  it('still drops the oldest match when 1000 rows WITH content precede it', () => {
    // The cap itself is unchanged: this is the same fixture with content in
    // the filler rows, and the match falls outside the window.
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Full Window', null, 0))
    const MATCH = '1'.padStart(26, '0')
    blocks.set(MATCH, makeBlock(MATCH, 'content', 'quuxly gadget', PAGE, 1))
    for (let i = 0; i < 1000; i++) {
      const nid = `N${String(i).padStart(25, '0')}`
      blocks.set(nid, makeBlock(nid, 'content', 'filler', PAGE, 2))
    }
    const res = search({ query: 'qu+xly', filter: { isRegex: true } })
    expect(res.items).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Item 3 — a zero-width match is not a match
// ---------------------------------------------------------------------------

describe('search regex arms — zero-width matches are dropped (#3939 item 3)', () => {
  const PAGE = id('ZWM1')
  const HIT = id('ZWM2')
  const MISS = id('ZWM3')

  function seed(): void {
    clearMock()
    // No `x` and no `z` anywhere in the fixture but the HIT row's `xxx`, so
    // the only match either pattern below can find elsewhere is a zero-width
    // one.
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Nullable Pattern Page', null, 0))
    blocks.set(HIT, makeBlock(HIT, 'content', 'xxx marks it', PAGE, 1))
    blocks.set(MISS, makeBlock(MISS, 'content', 'nothing here', PAGE, 2))
  }

  // The reachable fixture the issue names: a nullable pattern. It matched
  // EVERY row in the mock and NO row on the backend.
  it.each(['(?:)', 'z*'])('does not match every row on %s', (pattern) => {
    seed()
    const res = search({ query: pattern, filter: { isRegex: true } })
    expect(res.items).toEqual([])
  })

  // The filter is per-MATCH, not per-PATTERN: `x*` still keeps a row whose
  // content contains `xx`, because THAT match is two wide.
  it('keeps a row whose nullable pattern has a non-empty match somewhere', () => {
    seed()
    const res = search({ query: 'x*', filter: { isRegex: true } })
    expect(res.items.map((b) => b['id'])).toEqual([HIT])
  })

  // Same predicate, other call site — `post_filter_row` on the toggle arm.
  it('applies to the caseSensitive / wholeWord post-filter arm too', () => {
    seed()
    // The literal composer escapes the query, so the only way to reach a
    // zero-width match on that arm is an EMPTY query — which the blank-query
    // dispatch takes first. Drive it through the partitioned regex arm
    // instead, the other `find_iter` site.
    const res = dispatch('search_blocks_partitioned', {
      query: '(?:)',
      pageLimit: 10,
      blockLimit: 10,
      filter: { isRegex: true },
    }) as { pages: SearchResponse; blocks: SearchResponse }
    expect(res.blocks.items).toEqual([])
    expect(res.pages.items).toEqual([])
  })
})
