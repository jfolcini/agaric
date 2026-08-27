/**
 * Page-rename fan-out (#3322).
 *
 * `src/stores/resolve.ts` calls itself the "single source of truth for
 * resolving block/tag ULIDs to display titles", but two other stores keep
 * their own PERSISTED copy of a page title: `PageRef.title` in
 * `recent-pages.ts` and `PageEntry.title` / `Tab.label` in `tabs.ts`. Every
 * rename therefore has to write three stores, and every call site that
 * existed wrote only two — `PageHeader.persistTitle`, the PageHeader
 * undo/redo title refresh and `useUndoShortcuts.refreshAfterUndoRedo` all
 * updated tabs + resolve and left the recents entry stale. Because that entry
 * is persisted AND is the argument the recents strip passes back into
 * `tabs.navigateToPage(pageId, title)` — which re-stamps it via `recordVisit`
 * and pushes it onto the tab stack — one click on a renamed page in the
 * recents strip resurrected the OLD title in the tab, across restarts, while
 * `PageHeader` rendered the new one.
 *
 * The denormalised copies are kept (they are the pre-hydration placeholder
 * the strip and the tab bar render before the resolve preload lands), but
 * fanning out is no longer something a call site can half-do: this is the ONE
 * entry point, and each store's own action is a no-op when its copy is
 * already current.
 */

import { notifyPageRenamed } from '@/lib/name-change-bus'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useResolveStore } from '@/stores/resolve'
import { useTabsStore } from '@/stores/tabs'

/**
 * Record a page's new title in every store that holds a copy: the resolve
 * cache (chips / rich-content links), the tab stacks + labels, and the
 * active space's recents MRU — then broadcast the rename to the picker's
 * name caches (#4007), which are React refs rather than stores and so can
 * only be reached through `@/lib/name-change-bus`.
 *
 * Call this AFTER the backend write commits — it does no IPC of its own.
 *
 * #4391 — `spaceId` is the space the CALLER had in hand when it decided to
 * rename, threaded in rather than read here. It is required (not defaulted,
 * not optional) so a new call site fails to compile instead of silently
 * emitting a mislabelled event, and it is `string | null` because "no active
 * space" is a real state the callers can be in.
 *
 * This function cannot capture the value itself. It is synchronous, so
 * "capture at entry" and "read at emit" are the same tick and the same
 * value — capturing here would be a no-op. The `await` that matters is in
 * every one of the five callers, BETWEEN the user's decision and this call:
 * `PageHeader.persistTitle` (after `editBlock`), `PageHeader`'s undo/redo
 * title refresh (after the undo IPC, `load()` and `getBlock`),
 * `HistoryPanel`'s restore and undo-restore (after `getBlock` / `editBlock`),
 * and `useUndoShortcuts.refreshAfterUndoRedo` (after the undo/redo IPC and
 * `load()`). A read taken here would therefore be a FRESH read at emit time,
 * which the name-change-bus docblock explains is worse than no scoping: a
 * rename started in space A while the user switches to B would be labelled
 * `B` and let into B's warm cache, aborting an in-flight B fill (the
 * one-keystroke empty picker at `src/components/block-tree/use-block-resolve.ts:1132-1142`).
 *
 * `null` skips the bus notification — there is no space to scope a
 * picker-cache patch to — but the tabs/recents/resolve fan-out above still
 * runs unconditionally; none of those three are space-scoped. That second
 * half is the load-bearing part: a rename must reach the tab labels, the
 * recents MRU and the resolve store whether or not there is an active space.
 *
 * Sibling publishers answer the null case the other way, falling back to
 * `invalidateNameCaches()`. Both are correct and the reason they are
 * interchangeable is written down ONCE, for all of them, in the "When the
 * caller has NO active space" section of `src/lib/name-change-bus.ts`. Read
 * that rather than copying whichever precedent you happen to open first.
 */
export function renamePage(pageId: string, title: string, spaceId: string | null): void {
  useTabsStore.getState().renamePage(pageId, title)
  useRecentPagesStore.getState().renamePage(pageId, title)
  useResolveStore.getState().set(pageId, title, false)
  if (spaceId != null) notifyPageRenamed(pageId, title, spaceId)
}
