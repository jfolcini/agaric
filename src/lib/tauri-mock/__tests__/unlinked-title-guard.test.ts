/**
 * #4159 item 3 — `list_unlinked_references` resolved the search title from ANY
 * block. `eval_unlinked_references` guards the lookup with `block_type = 'page'
 * AND deleted_at IS NULL` (`src-tauri/agaric-store/src/backlink/grouped.rs`) so a
 * conflict-copy page id never drives the search — while leaving the ALIAS half
 * unguarded (`:601-605`), which the mock's `blocks.get(pageId)` early-return
 * also got wrong, in the other direction.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearMock, id, setSpace } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, pageAliases } from '@/lib/tauri-mock/seed'

interface GroupedResponse {
  groups: Array<{ page_id: string; page_title: string | null; blocks: Array<{ id: string }> }>
}

// ---------------------------------------------------------------------------
// Item 3 — the guarded title lookup, and the unguarded alias lookup
// ---------------------------------------------------------------------------

describe('list_unlinked_references — item 3: title lookup guard (#4159)', () => {
  const TARGET = id('ULRP')
  const OTHER = id('ULRQ')
  const MENTION = id('ULRM')
  const PLAIN = id('ULRN')
  const IMPOSTOR = id('ULRC')
  const DELETED = id('ULRD')
  const SPACE = id('ULRS')

  function unlinked(pageId: string): GroupedResponse {
    return dispatch('list_unlinked_references', {
      pageId,
      scope: { kind: 'active', space_id: SPACE },
    }) as GroupedResponse
  }

  function mentionIds(res: GroupedResponse): string[] {
    return res.groups.flatMap((g) => g.blocks.map((b) => b.id))
  }

  beforeEach(() => {
    clearMock()
    blocks.set(TARGET, makeBlock(TARGET, 'page', 'Zebrafish', null, 0))
    blocks.set(OTHER, makeBlock(OTHER, 'page', 'Lab Notes', null, 0))
    setSpace(OTHER, SPACE)
    blocks.set(MENTION, makeBlock(MENTION, 'content', 'notes on zebrafish habitat', OTHER, 1))
    blocks.set(PLAIN, makeBlock(PLAIN, 'content', 'a second zebrafish sighting', OTHER, 2))
    // A CONTENT block whose text happens to read like the page title — the
    // shape the backend's `block_type = 'page'` predicate exists to reject.
    blocks.set(IMPOSTOR, makeBlock(IMPOSTOR, 'content', 'Zebrafish', OTHER, 3))
    const deleted = makeBlock(DELETED, 'page', 'Zebrafish', null, 0)
    deleted['deleted_at'] = '2026-01-01T00:00:00Z'
    blocks.set(DELETED, deleted)
  })

  it('still searches on a live page title', () => {
    expect(mentionIds(unlinked(TARGET)).toSorted()).toEqual([IMPOSTOR, MENTION, PLAIN].toSorted())
  })

  it('answers empty for a pageId naming a content block', () => {
    expect(unlinked(IMPOSTOR).groups).toEqual([])
  })

  it('answers empty for a soft-deleted page', () => {
    expect(unlinked(DELETED).groups).toEqual([])
  })

  it('still searches a soft-deleted page on its ALIAS, which carries no guard', () => {
    // `SELECT alias FROM page_aliases WHERE page_id = ?1` is unconditional
    // (`src-tauri/agaric-store/src/backlink/grouped.rs:601-605`), and `title = None` is not an early return on the
    // backend — so the alias term alone drives the search.
    pageAliases.set(DELETED, ['habitat'])
    expect(mentionIds(unlinked(DELETED))).toEqual([MENTION])
  })
})
