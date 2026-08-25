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
 * {@link notifyPageAdded} / {@link notifyTagAdded} (#4338) describe a row
 * that has just come into existence. Until #4338 this module documented that
 * there was deliberately NO "added" event, on the grounds that an EMPTY cache
 * means "not fetched for this space yet", so inserting a single row would
 * latch a one-row list as if it were the whole space.
 *
 * That objection is answered — but only by a subscriber that carries the same
 * guard the in-hook create path carries. `useBlockResolve`'s apply functions
 * append an 'added' row ONLY into an already-filled list, exactly as
 * `recordCreatedRow` does for `onCreatePage` / `onCreateTag`, so an 'added'
 * event reaching an EMPTY cache leaves it empty (still "not fetched yet") and
 * the next picker read re-fetches the whole space. The unconditional
 * generation bump the subscriber already performs before applying supplies
 * the other half (#4275 item 1 / #4319): a fill in flight from before the
 * create cannot persist its pre-create snapshot. A future subscriber that
 * cannot make the append-only-into-a-filled-list promise must treat 'added'
 * as an {@link invalidateNameCaches}, not as an insert.
 *
 * {@link invalidateNameCaches} remains the escape hatch for a mutation that
 * ADDS rows back but CANNOT describe them one at a time — a restore-from-
 * trash, or an out-of-band write (sync / MCP). The empty-cache latch is not
 * what rules an insert out there, the caller's ignorance is: a restore
 * cascades to descendants and the bulk paths report only a count, so the
 * caller does not know the full set of rows that reappeared, and emitting
 * 'added' for the one id it does know would leave the cache confidently wrong
 * about the rest. (Note this is NOT because the restored title is
 * unavailable: `usePageDeleteAction` does carry it.) Dropping both caches
 * instead is always safe — the next picker read re-fetches.
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
  /**
   * `id` has just been created and displays as `name` (#4338). Subscribers
   * must apply it with the #4008 guard — append ONLY into an already-filled
   * cache — see the module docblock.
   */
  | { kind: 'added'; entity: NameChangeEntity; id: string; name: string }
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

/**
 * A page has just been CREATED and displays as `title` (#4338). Call AFTER
 * the backend write commits.
 *
 * Why this exists: before #4338 no create anywhere in the app published, so a
 * `pagesListRef` warmed by an earlier picker read went stale the moment a page
 * was created from any surface other than the `[[` picker's own "Create new
 * page" — and stayed stale until a space switch or an unrelated invalidation.
 * Worse, the staleness was self-perpetuating: `applyPageNameChange`'s
 * 'renamed' arm bails when the id is absent from the list, so a page created
 * and then TITLED (the ordinary "New Page" → type a heading flow) was dropped
 * by the create *and* by the rename, and never entered a warm cache at all.
 *
 * The enumeration behind the call sites (#4358 acceptance — recorded here so
 * the next person adding a creation site does not have to redo it). Every
 * `createPageInSpace` caller outside `useBlockResolve` publishes, because
 * `list_all_pages_in_space` — the query that fills `pagesListRef` — excludes
 * nothing: no template filter, no journal filter, no "Untitled" filter. A
 * warm cache that lacks any of these rows is simply wrong about the space:
 *
 *  - `App.tsx` (sidebar / New Page button), `useAppKeyboardShortcuts.ts`
 *    (the `createNewPage` chord) and `palette-commands.ts` (the palette
 *    command) create an "Untitled" page and navigate to it. Not picker-
 *    relevant at the moment of creation — but they are the flow the
 *    dropped-rename paragraph above is about.
 *  - `usePageCreation.ts` (the Pages view create form) and
 *    `TemplatesView.tsx` create a NAMED page the user just typed; a `[[`
 *    link to it is the next thing they are likely to want.
 *  - `useJournalBlockCreation.ts` creates a date page — #4358's subject, and
 *    the same shape as the date picker's own create (#4319).
 *  - `paste-internalize.ts` creates a page for a pasted `[[Name]]` that did
 *    not exist. The strongest case: the name is already being used as a link.
 *  - `WelcomeModal.tsx` seeds the onboarding sample pages. Usually there is
 *    no warm cache to update (first boot), but "Show the welcome tour again"
 *    re-runs the flow mid-session, so it is not unreachable.
 *
 * Deliberately NOT publishing: `useBlockResolve`'s own `onCreatePage` /
 * `onCreateTag` / `registerCreatedPage`. They already carry both invariants
 * for their OWN hook instance via `recordCreatedRow` (#4275 item 1, #4008,
 * #4319). Routing them through the bus as well would additionally fan their
 * creates out to SIBLING hook instances (the journal mounts one `BlockTree`
 * per day panel) — a real gap, but a distinct behaviour change to working
 * code rather than part of the missing-publisher bug #4338 describes, and one
 * that deserves its own test for the cross-instance case.
 */
export function notifyPageAdded(pageId: string, title: string): void {
  emit({ kind: 'added', entity: 'page', id: pageId, name: title })
}

/**
 * A tag has just been CREATED and displays as `name` (#4338). Call AFTER the
 * backend write commits. `notifyPageAdded`'s note applies verbatim; the
 * out-of-hook tag creation sites are `TagList.tsx` (the Tags view create
 * form) and `paste-internalize.ts` (a pasted `#tag` that did not exist).
 */
export function notifyTagAdded(tagId: string, name: string): void {
  emit({ kind: 'added', entity: 'tag', id: tagId, name })
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
 * Drop every cached name list. For mutations that put rows BACK but cannot
 * enumerate them (restore from trash, an inbound sync or MCP write): the bus
 * DOES have an 'added' event (#4338), but it describes exactly one row, and
 * these callers do not know the full set — a restore cascades to descendants
 * and the bulk paths report only a count. See the module docblock.
 */
export function invalidateNameCaches(): void {
  emit({ kind: 'invalidated' })
}
