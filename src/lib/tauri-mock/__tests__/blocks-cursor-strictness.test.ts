/**
 * #3942 review notes 3 + 5 — `list_blocks`'s keyset cursor decode
 * (`decodeBlocksCursor`, `handlers/blocks.ts`) diverging from the backend
 * `Cursor` in the OPPOSITE direction from the one this harness exists to
 * close: the mock was STRICTER than production, refusing input the backend
 * happily serves.
 *
 *  - Note 3: a `position`-lead cursor whose payload carries no `position`
 *    threw `validation` here, but `position_keyset_binds`
 *    (`agaric-store/src/pagination/mod.rs:271-276`) is
 *    `c.position.unwrap_or(NULL_POSITION_SENTINEL)` — it ACCEPTS the cursor
 *    and pages from the sentinel. `list_agenda_range`'s own bind
 *    (`pagination/agenda.rs:100`) does the same for its `deleted_at`-slotted
 *    lead.
 *  - Note 5: `decodeBlocksCursor` decoded through `base64UrlToUtf8`, which
 *    rewrites `-`/`_` and re-pads before calling `atob` — and `atob` itself
 *    tolerates the STANDARD base64 alphabet (`+`, `/`) and `=` padding. The
 *    backend's `Cursor::decode` calls `URL_SAFE_NO_PAD.decode`, which rejects
 *    all three outright. A foreign standard-alphabet cursor was therefore
 *    accepted by the mock and refused by the backend.
 *
 * Both cases are asserted through `dispatch('list_blocks', …)` rather than by
 * importing `decodeBlocksCursor` directly — it is not exported, and going
 * through the real IPC surface is what proves the fix reaches production
 * traffic rather than a unit that could drift from what `list_blocks` calls.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { utf8ToBase64Url } from '@/lib/base64url'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, seedBlocks } from '@/lib/tauri-mock/seed'

/** Deterministic 26-char block id from a short numeric-ish label. */
function id(label: string): string {
  return label.padStart(26, '0')
}

/** Reset every mock store to empty (mirrors the conformance harness). */
function clearMock(): void {
  seedBlocks()
  blocks.clear()
}

interface ListBlocksPage {
  items: Record<string, unknown>[]
  has_more: boolean
  next_cursor: string | null
  total_count: number | null
}

function listBlocks(args: Record<string, unknown>): ListBlocksPage {
  return dispatch('list_blocks', args) as ListBlocksPage
}

describe('list_blocks — a position-lead cursor missing `position` is served, not refused (#3942 review note 3)', () => {
  const PAGE = id('P0')
  const CHILD_A = id('A1')
  const CHILD_B = id('A2')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    blocks.set(CHILD_A, makeBlock(CHILD_A, 'text', 'a', PAGE, 1))
    blocks.set(CHILD_B, makeBlock(CHILD_B, 'text', 'b', PAGE, 2))
  })

  /** A hand-built cursor carrying `id` (+ `version`) but NO `position` — a
   *  cursor minted on a DIFFERENT keyset (e.g. `list_by_type`'s
   *  `Cursor::for_id`) and replayed against the `parentId` (position-lead)
   *  branch. */
  function cursorMissingPosition(cursorId: string): string {
    return utf8ToBase64Url(JSON.stringify({ id: cursorId, version: 1 }))
  }

  it('does not throw — the backend pages from the sentinel rather than rejecting', () => {
    const cursor = cursorMissingPosition(CHILD_A)
    expect(() => listBlocks({ parentId: PAGE, cursor })).not.toThrow()
  })

  it('the sentinel-anchored page is empty: every real position sorts BEFORE the sentinel', () => {
    const cursor = cursorMissingPosition(CHILD_A)
    // `NULL_POSITION_SENTINEL` stands in for `position_keyset_binds`' own
    // fallback — every seeded child's real position is far below it, so
    // nothing in this fixture sorts strictly after the cursor key and the
    // page comes back empty rather than erroring.
    expect(listBlocks({ parentId: PAGE, cursor })).toEqual({
      items: [],
      has_more: false,
      next_cursor: null,
      total_count: null,
    })
  })
})

describe('list_blocks — a foreign standard-alphabet cursor is refused, not silently accepted (#3942 review note 5)', () => {
  beforeEach(() => clearMock())

  /**
   * The SAME bytes {@link cursorMissingPosition}-shaped payloads produce,
   * but run through the STANDARD base64 alphabet with padding intact —
   * `atob`'s own tolerance, not `URL_SAFE_NO_PAD`. `Cursor::decode`
   * (`agaric-store/src/pagination/mod.rs`) calls
   * `base64::engine::general_purpose::URL_SAFE_NO_PAD.decode`, which rejects
   * `+`, `/` and `=` outright — deliberately NOT going through
   * `utf8ToBase64Url` (the production mint), since the whole point is a
   * cursor the mock never mints but a foreign client could send.
   */
  function standardAlphabetCursor(cursorId: string): string {
    const json = JSON.stringify({ id: cursorId, version: 1 })
    const bytes = new TextEncoder().encode(json)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary)
  }

  it('a real 26-char id round-trips to a padded standard-alphabet cursor (sanity check on the fixture)', () => {
    // Not itself the assertion under test — just confirms this cursor
    // actually exercises the padding/alphabet gate rather than happening to
    // land on a string `isBase64UrlNoPad` would have accepted anyway.
    expect(standardAlphabetCursor(id('X1'))).toMatch(/=$/)
  })

  it('is rejected as validation, matching the backend refusing the same bytes', () => {
    const cursor = standardAlphabetCursor(id('X1'))
    expect(() => listBlocks({ blockType: 'page', cursor })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })
})
