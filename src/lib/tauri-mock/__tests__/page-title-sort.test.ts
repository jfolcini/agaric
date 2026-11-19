/**
 * #3939 item 1 — `compareMetaRows`' alphabetical arm ran
 * `toLowerCase().localeCompare()`. The backend orders
 * `pages_cache.title_sort_key` (#5371): NFKD, marks stripped, lowercased, then
 * a UTF-8 BYTE memcmp. The reachable fixture is a non-ASCII title.
 */

import { describe, expect, it } from 'vitest'

import { id } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { type PageSortRow, compareMetaRows, titleSortKey } from '@/lib/tauri-mock/handlers/shared'

function row(rowId: string, content: string): PageSortRow {
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
    titleSortKey: titleSortKey(content),
    openedMs: -1,
  } as PageSortRow
}

// ---------------------------------------------------------------------------
// Item 1 — COLLATE NOCASE, not localeCompare
// ---------------------------------------------------------------------------

describe('compareMetaRows alphabetical — models title_sort_key (#3939 item 1, #5371)', () => {
  const A = id('CMR1')
  const B = id('CMR2')

  // The reachable fixture: an accented title. The key strips the accent, so
  // `Ápple` sorts with `apple`, before `Zebra`.
  it('orders an accented title with its base letter', () => {
    expect(compareMetaRows(row(A, 'Ápple'), row(B, 'Zebra'), 'alphabetical')).toBeLessThan(0)
  })

  // Turkish dotted capital `İ` (U+0130) decomposes to `I` + U+0307; the mark
  // goes and `I` lowercases, so the two titles tie and the id decides.
  it('folds a decomposable non-ASCII capital to its base letter', () => {
    expect(compareMetaRows(row(B, 'İstanbul'), row(A, 'istanbul'), 'alphabetical')).toBeGreaterThan(
      0,
    )
    expect(compareMetaRows(row(A, 'İstanbul'), row(B, 'istanbul'), 'alphabetical')).toBeLessThan(0)
  })

  // A letter with no decomposition keeps its own UTF-8 bytes: `ø` (`C3 B8`)
  // sorts after `z` (`7A`), as SQLite's BINARY compare of the key does.
  it('orders an undecomposable letter by its UTF-8 bytes', () => {
    expect(compareMetaRows(row(A, 'øre'), row(B, 'zebra'), 'alphabetical')).toBeGreaterThan(0)
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
