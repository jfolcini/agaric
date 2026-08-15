/**
 * `seedBulkPages` (`seed.ts`) writes its bulk pages' `op_log` rows in
 * DESCENDING `created_at` order — Bulk Page 001 (dated "now", the NEWEST)
 * pushed FIRST, Bulk Page 003 (dated "now - 2h", the OLDEST of the three)
 * pushed LAST — so `opLog`'s in-memory ARRAY order does not match
 * chronological order for that block of pushes.
 *
 * `list_page_history` and `undo_page_op` (`handlers/history.ts`) both used to
 * assume the array order WAS chronological — `[...opLog].toReversed()` and
 * `undoableOps.length - 1 - undoDepth` respectively — which is exactly
 * backwards once a caller pushes newest-first like `seedBulkPages` does. Both
 * now go through `sortOpLogNewestFirst` (`handlers/shared.ts`), which sorts
 * explicitly on `(created_at DESC, seq DESC)` — the same ordering the real
 * backend's own `ORDER BY created_at DESC, seq DESC, device_id DESC` uses in
 * both `list_page_history` (`agaric-store/src/pagination/history.rs:180,222`)
 * and `undo_page_op_inner` (`src-tauri/src/commands/history.rs:1574`), and
 * the same ordering `find_undo_group` already used before this fix. Sorting
 * explicitly closes the whole class rather than merely re-seeding this one
 * fixture in ascending order: any FUTURE non-chronological push (a different
 * fixture, a multi-device merge) would silently reopen the same bug in a
 * handler that trusted array order instead.
 *
 * Only reachable via the opt-in `__mockExtraPages` fixture (no assertion in
 * any other spec moved when the ordering bug was introduced), which is why
 * this file exists on its own rather than piggybacking on a spec that
 * exercises the fixture for an unrelated reason.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, opLog, seedBlocks } from '@/lib/tauri-mock/seed'

const SPACE = 'SPACE_PERSONAL'

/** Seed with `count` extra "Bulk Page NNN" fixtures, off `__mockFacetFixture`. */
function seedWithBulkPages(count: number): void {
  globalThis.localStorage.setItem('__mockExtraPages', String(count))
  globalThis.localStorage.removeItem('__mockFacetFixture')
  seedBlocks()
}

/** Resolve a seeded page's id from its title (bulk pages get random ids). */
function pageIdByTitle(title: string): string {
  for (const b of blocks.values()) {
    if (b['block_type'] === 'page' && b['content'] === title) return b['id'] as string
  }
  throw new Error(`no seeded page titled ${title}`)
}

interface HistoryItem {
  payload: string
  created_at: string
}
interface HistoryPage {
  items: HistoryItem[]
}

function listHistory(): HistoryItem[] {
  return (
    dispatch('list_page_history', {
      pageId: pageIdByTitle('Bulk Page 001'),
      opTypeFilter: null,
      scope: { kind: 'active', space_id: SPACE },
      cursor: null,
      limit: null,
    }) as HistoryPage
  ).items
}

describe('seedBulkPages op_log ordering — list_page_history / undo_page_op read chronological order, not push order', () => {
  beforeEach(() => {
    seedWithBulkPages(3)
  })

  it('list_page_history orders every returned entry by created_at DESC', () => {
    const items = listHistory()
    // Sanity: the bulk pages' stamps are actually present, so this isn't
    // vacuously true over an empty/short list.
    expect(items.length).toBeGreaterThanOrEqual(3 + 6)
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1] as HistoryItem
      const cur = items[i] as HistoryItem
      expect(prev.created_at >= cur.created_at).toBe(true)
    }
  })

  it("undo_page_op's undo_depth 0 reverses the chronologically NEWEST op, not the last one pushed", () => {
    const bulk1 = pageIdByTitle('Bulk Page 001') // stamped "now" — the newest op-log entry overall
    const expectedOp = opLog.find(
      (o) => (JSON.parse(o.payload) as Record<string, unknown>)['block_id'] === bulk1,
    )
    expect(expectedOp).toBeDefined()

    const result = dispatch('undo_page_op', { pageId: bulk1, undoDepth: 0 }) as {
      reversed_op: { device_id: string; seq: number }
    }

    // seedBulkPages pushes Bulk Page 003's (oldest, "now - 2h") stamp LAST,
    // so a handler that trusted array/push order instead of `created_at`
    // would reverse Bulk Page 003's op here instead of Bulk Page 001's.
    expect(result.reversed_op.seq).toBe(expectedOp?.seq)
  })
})
