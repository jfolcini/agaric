/**
 * Cross-impl conformance test for the tauri-mock's sort/cursor
 * re-implementation (#1886, slice 1).
 *
 * The mock's `compareMetaRows` / `encodeNextCursor` re-implement the backend's
 * page-listing sort + cursor logic in TypeScript. This test drives those pure
 * functions from the SHARED golden fixture
 * `conformance/pages-metadata/sort-cursor.vectors.json`, which the Rust query
 * path asserts against too. If backend semantics change, the fixture is
 * regenerated from the Rust side and this test fails until `handlers.ts` is
 * realigned — that is the whole point of the cross-impl gate. See
 * `conformance/pages-metadata/README.md`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareMetaRows, encodeNextCursor, type PageMetaRow } from '../handlers'

// ---------------------------------------------------------------------------
// Fixture types (mirror the shape of sort-cursor.vectors.json)
// ---------------------------------------------------------------------------

interface Row {
  id: string
  content: string
  lastModifiedAt: string
  inboundLinkCount: number
  childBlockCount: number
}

interface ExpectedCursor {
  id: string
  position: number
  seq?: number
}

interface Scenario {
  name: string
  sort: string
  expectedOrder: string[]
  expectedCursorAfterFirst: ExpectedCursor
}

interface Vectors {
  rows: Row[]
  scenarios: Scenario[]
}

// Load WITHOUT a JSON import to sidestep tsconfig resolveJsonModule concerns.
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'pages-metadata',
  'sort-cursor.vectors.json',
)
const vectors = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Vectors

/**
 * Promote a fixture row to a full `PageMetaRow`. Only the fields the sort/cursor
 * logic reads carry real values; everything else is an inert default.
 */
function toMetaRow(row: Row): PageMetaRow {
  return {
    id: row.id,
    content: row.content,
    inboundLinkCount: row.inboundLinkCount,
    childBlockCount: row.childBlockCount,
    lastModifiedAt: row.lastModifiedAt,
    blockType: 'page',
    parentId: null,
    position: null,
    deletedAt: null,
    todoState: null,
    priority: null,
    dueDate: null,
    scheduledDate: null,
    pageId: null,
    hasOutboundLink: false,
    flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
  }
}

describe('sort/cursor cross-impl conformance', () => {
  for (const scenario of vectors.scenarios) {
    describe(scenario.name, () => {
      it('orders rows to the golden expectedOrder', () => {
        const sorted = vectors.rows
          .map(toMetaRow)
          .toSorted((a, b) => compareMetaRows(a, b, scenario.sort))
        expect(sorted.map((r) => r.id)).toEqual(scenario.expectedOrder)
      })

      it('mints a next cursor with the golden discriminator', () => {
        const sorted = vectors.rows
          .map(toMetaRow)
          .toSorted((a, b) => compareMetaRows(a, b, scenario.sort))
        const first = sorted[0]
        if (first === undefined) throw new Error('fixture scenario has no rows')
        const decoded = JSON.parse(atob(encodeNextCursor(first, scenario.sort))) as Record<
          string,
          unknown
        >
        expect(decoded['id']).toBe(scenario.expectedCursorAfterFirst.id)
        expect(decoded['position']).toBe(scenario.expectedCursorAfterFirst.position)
        if (scenario.expectedCursorAfterFirst.seq !== undefined) {
          expect(decoded['seq']).toBe(scenario.expectedCursorAfterFirst.seq)
        }
      })
    })
  }

  it('wire-sort discriminators are pairwise-distinct', () => {
    const sampleRow = vectors.rows[0]
    if (sampleRow === undefined) throw new Error('fixture has no rows')
    const wireSorts = ['default', 'recently-modified', 'most-linked', 'most-content']
    const discriminators = wireSorts.map((s) => {
      const decoded = JSON.parse(atob(encodeNextCursor(toMetaRow(sampleRow), s))) as Record<
        string,
        unknown
      >
      return decoded['position']
    })
    expect(new Set(discriminators).size).toBe(wireSorts.length)
  })
})
