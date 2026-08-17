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
 */
export function renamePage(pageId: string, title: string): void {
  useTabsStore.getState().renamePage(pageId, title)
  useRecentPagesStore.getState().renamePage(pageId, title)
  useResolveStore.getState().set(pageId, title, false)
  notifyPageRenamed(pageId, title)
}
