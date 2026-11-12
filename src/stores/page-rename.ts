/**
 * Page-rename fan-out (#3322). Besides the resolve cache, the recents MRU and
 * the tab stacks persist their own copy of a page title (shown before the
 * resolve preload lands). A rename that missed the recents copy came back:
 * clicking the entry re-stamped the old title onto the tab, across restarts.
 * This is the one entry point; each store's action is a no-op when current.
 */

import { recordGraphStructureChange } from '@/lib/graph-structure-events'
import { notifyPageRenamed } from '@/lib/name-change-bus'
import { selectRecentPagesForSpace, useRecentPagesStore } from '@/stores/recent-pages'
import { useResolveStore } from '@/stores/resolve'
import { useTabsStore } from '@/stores/tabs'

/**
 * Record a page's new title in every copy (resolve cache, tab stacks and
 * labels, the active space's recents) and broadcast it to the pickers' name
 * caches, which only `@/lib/name-change-bus` reaches (#4007). Call it after the
 * backend write commits; it does no IPC.
 *
 * `spaceId` is the space the caller had before its awaits, required so a new
 * call site cannot silently emit a mislabelled event (#4391). Reading it here
 * would be a fresh read at emit time. `null` skips the bus notification but
 * still updates the three copies, none of which is space-scoped; why that and
 * `invalidateNameCaches()` are interchangeable is in "When the caller has NO
 * active space" in `src/lib/name-change-bus.ts`.
 */
export function renamePage(pageId: string, title: string, spaceId: string | null): void {
  useTabsStore.getState().renamePage(pageId, title)
  useRecentPagesStore.getState().renamePage(pageId, title)
  useResolveStore.getState().set(pageId, title, false)
  if (spaceId != null) notifyPageRenamed(pageId, title, spaceId)
  // Graph node labels and the unlinked-references term are the title, and
  // refresh on the structure counter (#5250).
  recordGraphStructureChange()
}

/**
 * Carry out-of-band renames into the title copies the active space's tabs and
 * recents persist, which only local renames reach otherwise (#5242). Reads the
 * resolve cache a preload just refreshed; `targeted` null means it rescanned
 * all. Also runs after each space switch's preload, for renames that landed
 * while another space was active (#5277).
 */
export function retitleHeldPages(
  targeted: ReadonlySet<string> | null,
  spaceId: string | null,
): void {
  const held = [
    ...useTabsStore.getState().tabs.flatMap((tab) => tab.pageStack),
    ...selectRecentPagesForSpace(useRecentPagesStore.getState(), spaceId),
  ]
  const resolve = useResolveStore.getState()
  const freshTitles = new Map<string, string>()
  for (const { pageId, title } of held) {
    if (targeted && !targeted.has(pageId)) continue
    // `renamePage` re-seeds the entry as not deleted: leave a trashed page alone.
    if (!resolve.isResolved(pageId) || resolve.resolveStatus(pageId) === 'deleted') continue
    const fresh = resolve.resolveTitle(pageId)
    if (fresh !== title) freshTitles.set(pageId, fresh)
  }
  for (const [pageId, title] of freshTitles) renamePage(pageId, title, spaceId)
}
