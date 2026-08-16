/**
 * Name-change bus (#4007) — the invalidation channel for the picker's
 * client-side name caches.
 *
 * `useBlockResolve` keeps two per-hook-instance name caches so the `[[` and
 * `#` pickers can filter locally instead of issuing an IPC per keystroke:
 * `pagesListRef` and `tagsListRef`. Both are filled once per space and
 * cleared on a space switch (#732), and until #4007 that space switch was
 * their ONLY invalidation: a page or tag renamed or deleted from another
 * surface (PageHeader, undo/redo, the delete flow, the Tags view) kept being
 * offered under its old name — or offered at all, after a delete — for the
 * rest of the session.
 *
 * The caches cannot be invalidated by direct mutation because they are React
 * refs owned by each mounted `useBlockResolve` (the journal mounts one
 * `BlockTree` per day, so several coexist). This module is the smallest thing
 * that closes that: a module-level listener set, one `subscribeToNameChanges`
 * per hook instance, and four notify helpers the mutating surfaces call AFTER
 * their backend write commits.
 *
 * Why a targeted event and not "drop the cache": dropping it would work, but
 * the cache exists to avoid a full `listAllPagesInSpace` /
 * `listAllTagsInSpace` round trip, and a rename carries everything the cache
 * needs. Note also that an EMPTY cache means "not fetched for this space yet"
 * (both call sites re-fetch while empty), so blanket-clearing has a second
 * cost: it re-fetches on every keystroke until the next fill lands.
 *
 * {@link invalidateNameCaches} is the escape hatch for a mutation that ADDS
 * rows back — a restore-from-trash, or an out-of-band write (sync / MCP)
 * whose shape the caller cannot describe. There is deliberately no "added"
 * event: an EMPTY cache means "not fetched for this space yet", so inserting
 * a single restored row would latch a one-row list as if it were the whole
 * space. Dropping both caches instead is always safe — the next picker read
 * re-fetches. (Note this is NOT because the restored title is unavailable:
 * `usePageDeleteAction` does carry it. It is the empty-cache latch, plus the
 * fact that a restore cascades to descendants and the bulk paths report only
 * a count, that make an insert unsafe.)
 *
 * This module does NOT touch the resolve store: `@/stores/resolve` is the
 * source of truth for chip titles and each mutating surface already writes it
 * (see `@/stores/page-rename` for the rename fan-out). This bus is only about
 * the two picker list caches.
 */

import { logger } from '@/lib/logger'

/** The entities whose display names the pickers cache. */
export type NameChangeEntity = 'page' | 'tag'

export type NameChange =
  /** `id` now displays as `name` (rename / title edit). */
  | { kind: 'renamed'; entity: NameChangeEntity; id: string; name: string }
  /** `id` is gone (soft-delete, purge) and must stop being offered. */
  | { kind: 'removed'; entity: NameChangeEntity; id: string }
  /** Unknown-shape change — subscribers must drop everything they cached. */
  | { kind: 'invalidated' }

export type NameChangeListener = (change: NameChange) => void

const listeners = new Set<NameChangeListener>()

/**
 * Register `listener` for every subsequent name change. Returns the
 * unsubscribe function (shaped for a `useEffect` cleanup return).
 */
export function subscribeToNameChanges(listener: NameChangeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Isolates throws: one broken subscriber must never abort the fan-out to the
 * others, and none of these call sites can do anything useful with the error
 * anyway — they are post-commit notifications.
 *
 * Iterating the `Set` live is deliberate and safe: a listener that
 * unsubscribes itself or a sibling mid-dispatch (an unmounting `BlockTree`)
 * only removes entries, and `Set` iteration skips entries deleted before it
 * reaches them rather than shifting past a neighbour the way an array splice
 * would.
 */
function emit(change: NameChange): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch (err) {
      logger.warn('name-change-bus', 'listener threw', { change }, err)
    }
  }
}

/** A page now displays as `title`. Call AFTER the backend write commits. */
export function notifyPageRenamed(pageId: string, title: string): void {
  emit({ kind: 'renamed', entity: 'page', id: pageId, name: title })
}

/** A page was deleted (soft-delete or purge). Call AFTER the write commits. */
export function notifyPageRemoved(pageId: string): void {
  emit({ kind: 'removed', entity: 'page', id: pageId })
}

/** A tag now displays as `name`. Call AFTER the backend write commits. */
export function notifyTagRenamed(tagId: string, name: string): void {
  emit({ kind: 'renamed', entity: 'tag', id: tagId, name })
}

/** A tag was deleted or purged. Call AFTER the write commits. */
export function notifyTagRemoved(tagId: string): void {
  emit({ kind: 'removed', entity: 'tag', id: tagId })
}

/**
 * Drop every cached name list. For mutations that put rows BACK (restore from
 * trash, an inbound sync or MCP write): the bus has no "added" event because
 * an empty cache means "not fetched yet", so inserting one row would latch a
 * one-row list as the whole space. See the module docblock.
 */
export function invalidateNameCaches(): void {
  emit({ kind: 'invalidated' })
}
