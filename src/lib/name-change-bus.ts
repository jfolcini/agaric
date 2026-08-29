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
 * #4391 — `added` / `renamed` / `removed` all carry `spaceId`, the space the
 * publisher had in hand when it decided to act (the same value it passed to
 * the backend create/mutate call, NOT a fresh read taken at emit time — see
 * below for why that distinction matters). `subscribeToNameChanges`'s one
 * subscriber (`useBlockResolve`) drops any event whose `spaceId` does not
 * equal the space that is LIVE when the event arrives, before the #4008 latch
 * guard. Every publisher already had this
 * value in hand (it is what they passed to `createPageInSpace` /
 * `createBlock` / `editBlock`); the field just gives the subscriber a way to
 * check it.
 *
 * The drop suppresses the CACHE MUTATION only. The subscriber's generation
 * bump (#4055) still runs for EVERY event, matching space or not, and stays
 * ahead of the space check — see the long comment above the bump in
 * `src/components/block-tree/use-block-resolve.ts`. The two answer different
 * questions: the space check asks "is this row RELEVANT to the space we are
 * showing", the generation asks "is a snapshot taken before this event still
 * free of staleness". A fill in flight is pinned to the space it CAPTURED at
 * dispatch, not to the live one, so an A→B→A round trip makes those two
 * diverge: a genuine A-side rename emitted while B is live is irrelevant to
 * B's cache but is exactly what makes A's in-flight snapshot stale. Skipping
 * the bump there reopens #4007 — the pre-rename snapshot persists once the
 * user returns to A, and the `[[` picker serves the old title for the rest of
 * the session.
 *
 * ── When the caller has NO active space ──────────────────────────────────
 *
 * The publishers take `spaceId: string` (required); the one shared fan-out
 * that sits in front of them (`src/stores/page-rename.ts`'s `renamePage`)
 * takes `string | null`, because "no active space" is a real state a caller
 * can be in. Both of the responses in the tree are CORRECT and
 * interchangeable, and this is the one place that says so, so a new call
 * site does not have to infer a policy from whichever precedent it happens
 * to read first:
 *
 *  - SKIP the notification. Cheapest, and what
 *    `src/stores/page-rename.ts:87` and `src/components/TagList.tsx:156` do.
 *  - Fall back to {@link invalidateNameCaches}. Conservative, and what
 *    `src/components/TagList.tsx:197`, `src/components/TagList.tsx:236`,
 *    `src/hooks/usePageDeleteAction.tsx:195`, and — since #4524, through the
 *    shared {@link notifyPagesRemoved} rather than a copy of the branch —
 *    `PageBrowserBatchToolbar`'s `handleTrash` and `handleMoveToSpace` plus
 *    `useBlockMultiSelect`'s `handleBatchDelete` do.
 *
 * They are equivalent because with no active space both name caches are
 * provably EMPTY: `useBlockResolve`'s space-switch subscriber clears both on
 * any `currentSpaceId` transition INCLUDING a transition to `null`, and both
 * lazy fills short-circuit to `[]` while the space is `null`
 * (`searchPagesViaCache`, and `searchTags`'s inline fill). So the
 * invalidation has nothing to drop and the skip loses nothing. Prefer the
 * skip in new code — it is the same outcome without the wasted fan-out — but
 * do not "fix" an existing invalidate to match; the divergence is cosmetic,
 * not a bug, and churning it would only make the next reader wonder which
 * one changed behaviour.
 *
 * NOTE this reasoning is about the picker's NAME caches only. A null-space
 * caller must still run its non-space-scoped fan-out (tabs, recents, the
 * resolve store) unconditionally — that is the half that would silently break
 * if a call site read "skip the notify" as "skip everything".
 *
 * Why "captured at the decision" and not "current at emit": a publisher that
 * instead read the space fresh, right before calling `notifyPageAdded`,
 * would — for the specific race this closes — read the NEW space if the user
 * switched between the backend write and the emit, and so mislabel the event
 * as belonging to the space that happens to be active rather than the space
 * the row actually landed in. That is not a smaller bug than the one this
 * closes: it would tag a foreign-space row as belonging to the *current*
 * space and the subscriber would applaud it in. The row's true space is a
 * fact fixed at the moment the backend call was made; the field must carry
 * that fact, not a re-guess.
 *
 * `paste-internalize.ts` was the widest window (#4391's report): it captures
 * `spaceId` once at internalizer-build time and reuses it for the whole
 * paste, so a switch mid-paste is a real, reachable interleaving, not a
 * theoretical one. It already had the right value in hand — `spaceId`, the
 * same const passed to `createPageInSpace` — so closing the class needed no
 * new capture there, just threading the existing value onto the event.
 *
 * `invalidated` carries no `spaceId` and is NOT scoped: it says "drop
 * everything", which is always a safe (if occasionally wasteful) thing to do
 * regardless of which space is live when it fires — the caller who reaches
 * for it (a restore, a sync/MCP write) does not know a single id to describe
 * a narrower event with, so there is nothing space-specific to compare
 * against in the first place.
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
   * `id` has just been created and displays as `name` (#4338), in `spaceId`
   * (#4391 — the space the publisher captured when it decided to create,
   * not necessarily the space live when this event is dispatched). Subscribers
   * must apply it with the #4008 guard — append ONLY into an already-filled
   * cache — AND the #4391 guard — drop it outright when `spaceId` does not
   * match the live active space — see the module docblock.
   */
  | { kind: 'added'; entity: NameChangeEntity; id: string; name: string; spaceId: string }
  /** `id` now displays as `name` (rename / title edit) in `spaceId` (#4391). */
  | { kind: 'renamed'; entity: NameChangeEntity; id: string; name: string; spaceId: string }
  /** `id` is gone (soft-delete, purge) from `spaceId` (#4391) and must stop being offered. */
  | { kind: 'removed'; entity: NameChangeEntity; id: string; spaceId: string }
  /**
   * Unknown-shape change — subscribers must drop everything they cached.
   * Deliberately carries no `spaceId` (#4391) — see the module docblock.
   */
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
 *
 * `spaceId` (#4391, required — not optional: a call site that has none in
 * hand fails to compile rather than silently emitting an unscoped event) is
 * the space the caller passed to its OWN `createPageInSpace` call — the
 * value it already had, not a fresh read. See the module docblock for why
 * that distinction is load-bearing.
 */
export function notifyPageAdded(pageId: string, title: string, spaceId: string): void {
  emit({ kind: 'added', entity: 'page', id: pageId, name: title, spaceId })
}

/**
 * A tag has just been CREATED and displays as `name` (#4338), in `spaceId`
 * (#4391 — see `notifyPageAdded`). Call AFTER the backend write commits.
 * `notifyPageAdded`'s note applies verbatim; the out-of-hook tag creation
 * sites are `TagList.tsx` (the Tags view create form) and
 * `paste-internalize.ts` (a pasted `#tag` that did not exist).
 */
export function notifyTagAdded(tagId: string, name: string, spaceId: string): void {
  emit({ kind: 'added', entity: 'tag', id: tagId, name, spaceId })
}

/**
 * A page now displays as `title`, in `spaceId` (#4391). Call AFTER the
 * backend write commits.
 */
export function notifyPageRenamed(pageId: string, title: string, spaceId: string): void {
  emit({ kind: 'renamed', entity: 'page', id: pageId, name: title, spaceId })
}

/**
 * A page was deleted (soft-delete or purge) from `spaceId` (#4391). Call
 * AFTER the write commits.
 */
export function notifyPageRemoved(pageId: string, spaceId: string): void {
  emit({ kind: 'removed', entity: 'page', id: pageId, spaceId })
}

/**
 * A tag now displays as `name`, in `spaceId` (#4391). Call AFTER the backend
 * write commits.
 */
export function notifyTagRenamed(tagId: string, name: string, spaceId: string): void {
  emit({ kind: 'renamed', entity: 'tag', id: tagId, name, spaceId })
}

/**
 * A tag was deleted or purged from `spaceId` (#4391). Call AFTER the write
 * commits.
 */
export function notifyTagRemoved(tagId: string, spaceId: string): void {
  emit({ kind: 'removed', entity: 'tag', id: tagId, spaceId })
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

/**
 * #4008 review note 3 — the batch trash's cap is `MAX_TRASH_BATCH_IDS`
 * (1000), and {@link notifyPageRemoved} is a synchronous fan-out: every
 * mounted `useBlockResolve` rebuilds its whole cached pages list with `filter`
 * per event, so the cost is `ids x mounted BlockTrees x pages in space`
 * element copies on the UI thread, with no yield in between. Above this many
 * ids a bulk publisher emits ONE {@link invalidateNameCaches} instead, which
 * is O(listeners) and costs a single re-fetch on the next picker read.
 *
 * 25 is measured, not chosen for roundness. Timing the exact production shape
 * (N per-listener lists of `{id, title}` rows, one `filter` per listener per
 * id) on this machine's V8, for a 3,000-page space:
 *
 *   5 mounted trees:   25 ids 6.8ms | 50 ids 12.6ms | 100 ids 25.6ms | 1000 ids 159ms
 *   7 mounted trees:   25 ids 8.8ms | 50 ids 18.3ms | 100 ids 31.1ms
 *
 * 25 is the largest of the measured batch sizes that stays inside one 16.7ms
 * frame in BOTH configurations (8.8ms worst case, ~2x headroom); 50 already
 * misses a frame with 7 trees mounted, which the journal's week view reaches.
 * Below the threshold the per-id events still fire, so the common small delete
 * keeps its precise patch and pays no re-fetch.
 *
 * #4524 — this lives here rather than in `PageBrowserBatchToolbar`, where it
 * was defined until the second bulk publisher appeared. See
 * {@link notifyPagesRemoved}.
 */
export const NAME_CACHE_FANOUT_MAX_IDS = 25

/**
 * Publish the removal of a COHORT of pages from `spaceId` — the one policy
 * every bulk mutation surface must apply, in one place (#4524).
 *
 * Why this is a shared function and not a documented three-line recipe: it
 * was the recipe, twice over in `PageBrowserBatchToolbar` (`handleTrash` and
 * `handleMoveToSpace`), and `useBlockMultiSelect` — a third bulk surface
 * running the SAME `delete_blocks_by_ids` command from the block tree —
 * published nothing at all, for roots or for the cascaded cohort. Nothing
 * about that omission was visible from either implementation: they are two
 * files that happen to overlap in behaviour, so the asymmetry had no place to
 * show up. A call to this function is a thing a reviewer can notice missing.
 *
 * The three decisions it settles, each of which a copy of the recipe could
 * get individually wrong:
 *
 *  - **De-duplication.** `pageIds` is collapsed into a `Set` before both the
 *    budget check and the fan-out. Callers union their own input list with a
 *    backend-reported cohort that ECHOES it back (`affected_page_ids`
 *    contains the selected roots), so an array-shaped fan-out would emit
 *    every root twice, at O(listeners x pages) each.
 *  - **The budget is measured on what will ACTUALLY be emitted** — the
 *    de-duplicated cohort — not on the caller's selection. #4480 made the
 *    emitted set larger than the selection, so 20 selected roots that cascade
 *    to 30 pages must collapse to one invalidation, and a check against
 *    `ids.length` would wave 30 synchronous events through under a cap of 25.
 *  - **An EMPTY cohort publishes nothing.** Not an invalidation: no page was
 *    removed, so there is nothing for the picker cache to be wrong about.
 *    This is load-bearing for the block tree, whose selections are usually
 *    pure CONTENT blocks — without it, a `spaceId == null` content-only
 *    delete would drop a warm cache to describe a removal of nothing.
 *
 * `spaceId` is the space the pages are LEAVING, captured when the publisher
 * decided to act (see the module docblock — for a move that is the ORIGIN,
 * never the destination). `null` falls back to a full invalidation, the
 * conservative half of the "When the caller has NO active space" section
 * above; it is what both toolbar handlers already did.
 */
export function notifyPagesRemoved(pageIds: Iterable<string>, spaceId: string | null): void {
  const unique = pageIds instanceof Set ? (pageIds as Set<string>) : new Set(pageIds)
  if (unique.size === 0) return
  if (spaceId == null || unique.size > NAME_CACHE_FANOUT_MAX_IDS) {
    invalidateNameCaches()
    return
  }
  for (const id of unique) notifyPageRemoved(id, spaceId)
}
