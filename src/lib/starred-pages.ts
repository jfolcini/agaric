/**
 * Page bookmarks — a `bookmark` property on the page (#6544).
 *
 * A page is bookmarked while it carries the key, and the property's number is
 * its place in the sidebar list, so one synced property carries both the
 * bookmark and its order. The list sorts by that number, then title, then id,
 * so two devices that gave two bookmarks the same number still agree on the
 * order. The key is internal (`INTERNAL_PROPERTY_KEYS`), so no property picker
 * or column shows it.
 *
 * This is the ONE list behind every bookmark affordance: the page header's
 * button, the Pages browser's row toggles and batch action, the command
 * palette's recents rows, and the sidebar's Bookmarks section, all through
 * `useStarredPages`. The identifiers still say `starred`; every surface says
 * bookmark.
 *
 * Bookmarks used to be a per-device localStorage list (`starred-pages`);
 * `migrateDeviceBookmarks` moves it into the property once and deletes it.
 */

import { isNotFound, isValidation, unwrap } from '@/lib/app-error'
import { type BlockRow, commands, type PageResponse } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { PREFERENCES, readPreference, removePreference, writePreference } from '@/lib/preferences'
import { queryClient } from '@/lib/query-client'
import { PAGINATION_MAX, paginationLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/space-scope'

const BOOKMARK_PROPERTY_KEY = 'bookmark'

/** A bookmarked page and its number; a list of them is held in sidebar order. */
export interface Bookmark {
  id: string
  order: number
}

const BOOKMARKS_QUERY_ROOT = 'bookmarks'

export function bookmarksQueryKey(spaceId: string): readonly [string, string] {
  return [BOOKMARKS_QUERY_ROOT, spaceId]
}

/** Re-read every space's bookmarks, after a write that did not go through `useStarredPages`. */
export function invalidateBookmarks(): void {
  void queryClient.invalidateQueries({ queryKey: [BOOKMARKS_QUERY_ROOT] })
}

/** A bookmark's number: `value_num`, or the text an import writes it as. */
function bookmarkOrder(row: { value_num: number | null; value_text: string | null }): number {
  if (row.value_num !== null) return row.value_num
  const parsed = Number(row.value_text ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** Code-unit order, the same on every device whatever its locale. */
function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** The live bookmarked pages of `spaceId`, in sidebar order. */
export async function loadBookmarks(spaceId: string): Promise<Bookmark[]> {
  const rows: Array<Bookmark & { title: string }> = []
  let cursor: string | null = null
  do {
    const page: PageResponse<BlockRow> = unwrap(
      await commands.queryByProperty(
        {
          key: BOOKMARK_PROPERTY_KEY,
          valueText: null,
          valueDate: null,
          operator: null,
          cursor,
          limit: paginationLimit(PAGINATION_MAX),
          excludeParentId: null,
          contentNonEmpty: null,
          blockType: 'page',
          valueTextIn: null,
          valueDateRange: null,
          excludeTodoStates: null,
        },
        requireActiveScope(spaceId),
      ),
    )
    const ids = page.items.map((block) => block.id)
    const props = ids.length > 0 ? unwrap(await commands.getBatchProperties(ids)) : {}
    for (const block of page.items) {
      const row = props[block.id]?.find((p) => p.key === BOOKMARK_PROPERTY_KEY)
      if (row === undefined) continue
      rows.push({ id: block.id, title: block.content ?? '', order: bookmarkOrder(row) })
    }
    cursor = page.has_more ? page.next_cursor : null
  } while (cursor !== null)
  rows.sort((a, b) => a.order - b.order || compareText(a.title, b.title) || compareText(a.id, b.id))
  return rows.map(({ id, order }) => ({ id, order }))
}

function highestOrder(list: readonly Bookmark[]): number {
  return list.reduce((max, b) => Math.max(max, b.order), 0)
}

/** A change to a space's bookmarks: the list it leaves, and the writes that make it. */
export interface BookmarkPlan {
  next: Bookmark[]
  writes: Bookmark[]
  removals: string[]
}

/** Bookmark `ids` after the last bookmark, in the order given; ids already in `list` stay put. */
export function planAdd(list: readonly Bookmark[], ids: readonly string[]): BookmarkPlan {
  const held = new Set(list.map((b) => b.id))
  let order = highestOrder(list)
  const writes: Bookmark[] = []
  for (const id of new Set(ids)) {
    if (held.has(id)) continue
    order += 1
    writes.push({ id, order })
  }
  return { next: [...list, ...writes], writes, removals: [] }
}

/** Remove the bookmarks of `ids`. */
export function planRemove(list: readonly Bookmark[], ids: readonly string[]): BookmarkPlan {
  const removed = new Set(ids)
  return {
    next: list.filter((b) => !removed.has(b.id)),
    writes: [],
    removals: list.filter((b) => removed.has(b.id)).map((b) => b.id),
  }
}

/**
 * Move `pageId` to `overId`'s place, as a sortable drop does. The moved page
 * takes a number between its new neighbours; when none fits (equal neighbours,
 * or a gap halved past what a double holds) the list is renumbered 1..n.
 * `null` when the move changes nothing.
 */
export function planMove(
  list: readonly Bookmark[],
  pageId: string,
  overId: string,
): BookmarkPlan | null {
  const from = list.findIndex((b) => b.id === pageId)
  const to = list.findIndex((b) => b.id === overId)
  const entry = list[from]
  if (entry === undefined || to === -1 || from === to) return null
  const moved = list.filter((b) => b.id !== pageId)
  moved.splice(to, 0, entry)
  const before = moved[to - 1]
  const after = moved[to + 1]
  let order: number
  if (before === undefined) order = (after?.order ?? 0) - 1
  else if (after === undefined) order = before.order + 1
  else order = (before.order + after.order) / 2
  const fits =
    (before === undefined || before.order < order) && (after === undefined || order < after.order)
  if (fits) {
    const write = { id: pageId, order }
    return { next: moved.map((b) => (b.id === pageId ? write : b)), writes: [write], removals: [] }
  }
  const next = moved.map((b, i) => ({ id: b.id, order: i + 1 }))
  return { next, writes: next.filter((b, i) => moved[i]?.order !== b.order), removals: [] }
}

/**
 * Every bookmark write goes through one queue, so a quick bookmark and
 * unbookmark of the same page reach the backend in the order they were made.
 */
let writeQueue: Promise<void> = Promise.resolve()

/** Make `plan`'s writes and removals, after every earlier call's. */
export function writeBookmarks({ writes, removals }: BookmarkPlan): Promise<void> {
  const run = writeQueue.then(async () => {
    for (const { id, order } of writes) {
      unwrap(
        await commands.setProperty(id, BOOKMARK_PROPERTY_KEY, {
          value_text: null,
          value_num: order,
          value_date: null,
          value_ref: null,
          value_bool: null,
        }),
      )
    }
    for (const id of removals) {
      unwrap(await commands.deleteProperty(id, BOOKMARK_PROPERTY_KEY))
    }
  })
  // The caller receives and reports a failure through `run`; the queue only
  // needs to know it settled, so the next call still runs.
  writeQueue = run.catch(() => undefined)
  return run
}

/**
 * Add ids to the device's old bookmark list, for `migrateDeviceBookmarks` to
 * move. Only the recent-pages store's rescue of pre-consolidation `pinned`
 * rows calls this; it runs before the spaces load, so the same boot migrates
 * them.
 */
export function addDeviceBookmarks(ids: readonly string[]): void {
  const stored = readPreference(PREFERENCES.starredPages)
  writePreference(PREFERENCES.starredPages, [...new Set([...stored, ...ids])])
}

/**
 * Move this device's localStorage bookmarks into the `bookmark` property,
 * once. Each page goes after the highest bookmark of every space, in the
 * stored order; a page that already carries the property (a retry, or another
 * device's bookmark that synced first) keeps it, and a page that is purged or
 * in the trash is dropped. The list is deleted only once every id is written
 * or dropped, so a failure retries on the next boot.
 */
export async function migrateDeviceBookmarks(spaceIds: readonly string[]): Promise<void> {
  const stored = readPreference(PREFERENCES.starredPages)
  if (stored.length === 0) return
  try {
    const held = new Set<string>()
    let order = 0
    for (const spaceId of spaceIds) {
      const list = await loadBookmarks(spaceId)
      for (const b of list) held.add(b.id)
      order = Math.max(order, highestOrder(list))
    }
    for (const id of new Set(stored)) {
      if (held.has(id)) continue
      try {
        unwrap(
          await commands.setProperty(id, BOOKMARK_PROPERTY_KEY, {
            value_text: null,
            value_num: order + 1,
            value_date: null,
            value_ref: null,
            value_bool: null,
          }),
        )
        order += 1
      } catch (err) {
        // Purged (not found) or in the trash (refused): nothing to bookmark.
        if (!isNotFound(err) && !isValidation(err)) throw err
      }
    }
    removePreference(PREFERENCES.starredPages)
  } catch (err) {
    logger.warn(
      'starred-pages',
      'moving the device bookmarks into the page property failed; retrying next boot',
      { count: stored.length },
      err,
    )
  }
  invalidateBookmarks()
}
