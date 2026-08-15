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

import { base64UrlToUtf8 } from '@/lib/base64url'
import { compareMetaRows, encodeNextCursor, type PageMetaRow } from '@/lib/tauri-mock/handlers'

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
        const decoded = JSON.parse(
          base64UrlToUtf8(encodeNextCursor(first, scenario.sort)),
        ) as Record<string, unknown>
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
      const decoded = JSON.parse(
        base64UrlToUtf8(encodeNextCursor(toMetaRow(sampleRow), s)),
      ) as Record<string, unknown>
      return decoded['position']
    })
    expect(new Set(discriminators).size).toBe(wireSorts.length)
  })
})

/**
 * #3888 review note 2 — the SAME `btoa`-on-user-text bug #3863 fixed in
 * `run_advanced_query`'s cursor, in the sibling `list_pages_with_metadata`
 * handler.
 *
 * Under `sort: 'alphabetical'` the cursor payload's `deleted_at` slot carries
 * `last.content` — the raw page TITLE — so the encoder sees arbitrary user
 * text. The backend's `Cursor::encode`
 * (`agaric-store/src/pagination/mod.rs`) is
 * `URL_SAFE_NO_PAD.encode(json.as_bytes())`, i.e. the UTF-8 bytes of the JSON.
 * `btoa` maps each string CODE UNIT to one byte and therefore has two
 * DIFFERENT failure modes, both asserted below:
 *
 *   - em dash (U+2014): `btoa` throws `InvalidCharacterError`, and `dispatch`
 *     (`handlers.ts`) has no try/catch, so a raw DOMException escapes the IPC
 *     boundary from `list_pages_with_metadata` instead of a page of results.
 *   - `é` (U+00E9): no throw — `btoa` silently emits the single Latin-1 byte
 *     0xE9 where the backend emits the UTF-8 pair 0xC3 0xA9.
 *
 * Expected strings are built from an INDEPENDENT base64url encoder over
 * `TextEncoder` bytes and from a hand-written JSON literal, not from the
 * production helpers, so this cannot go tautological if both drift together.
 */
describe('encodeNextCursor — non-ASCII titles (#3888 note 2)', () => {
  /** URL-safe, unpadded base64 alphabet — `base64::URL_SAFE_NO_PAD`. */
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

  /**
   * Independent `URL_SAFE_NO_PAD.encode(json.as_bytes())`: UTF-8 encode, then
   * hand-rolled base64 over the raw bytes. Deliberately does NOT go through
   * `btoa`/`atob` or `@/lib/base64url`.
   */
  function rustCursorBytes(json: string): string {
    const bytes = new TextEncoder().encode(json)
    let out = ''
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i] ?? 0
      const b1 = bytes[i + 1]
      const b2 = bytes[i + 2]
      out += B64URL[b0 >> 2] ?? ''
      out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? ''
      if (b1 === undefined) break
      out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? ''
      if (b2 === undefined) break
      out += B64URL[b2 & 0x3f] ?? ''
    }
    return out
  }

  const ID = '00000000000000000000000001'

  function rowTitled(title: string): PageMetaRow {
    return toMetaRow({
      id: ID,
      content: title,
      lastModifiedAt: '2024-01-01T00:00:00.000Z',
      inboundLinkCount: 0,
      childBlockCount: 0,
    })
  }

  /**
   * The exact JSON `encodeNextCursor` builds for `alphabetical`, written out by
   * hand (insertion order `id`, `version`, `position`, `deleted_at`).
   * `position: 5` is the `default`/`alphabetical` discriminator.
   */
  function alphabeticalJson(title: string): string {
    return `{"id":"${ID}","version":1,"position":5,"deleted_at":${JSON.stringify(title)}}`
  }

  it('encodes an above-U+00FF title (em dash) instead of throwing InvalidCharacterError', () => {
    const TITLE = 'Q3 — Roadmap' // U+2014
    expect(encodeNextCursor(rowTitled(TITLE), 'alphabetical')).toBe(
      rustCursorBytes(alphabeticalJson(TITLE)),
    )
  })

  it('encodes a U+0080–U+00FF title (é) as UTF-8, not as a single Latin-1 byte', () => {
    const TITLE = 'Café Notes' // U+00E9
    expect(encodeNextCursor(rowTitled(TITLE), 'alphabetical')).toBe(
      rustCursorBytes(alphabeticalJson(TITLE)),
    )
  })

  it('round-trips a non-ASCII cursor back through the decoder the handler uses', () => {
    // A wrong DECODER breaks resume even behind a right encoder: a Latin-1
    // read of UTF-8 bytes yields a mojibake title and a mangled id.
    const encoded = encodeNextCursor(rowTitled('Q3 — Roadmap'), 'alphabetical')
    expect(JSON.parse(base64UrlToUtf8(encoded)) as Record<string, unknown>).toEqual({
      id: ID,
      version: 1,
      position: 5,
      deleted_at: 'Q3 — Roadmap',
    })
  })
})
