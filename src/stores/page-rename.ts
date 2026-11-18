/**
 * Page-rename fan-out (#3322). Besides the resolve cache, the recents MRU and
 * the tab stacks persist their own copy of a page title (shown before the
 * resolve preload lands). A rename that missed the recents copy came back:
 * clicking the entry re-stamped the old title onto the tab, across restarts.
 * This is the one entry point; each store's action is a no-op when current.
 */

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notifyPageRenamed, notifyTagRenamed } from '@/lib/name-change-bus'
import { nameKey, tagOfPageTitle, tagPageTitle } from '@/lib/name-tokens'
import { requireActiveScope } from '@/lib/space-scope'
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
 * still updates the three copies, none of which is space-scoped; why the skip
 * loses nothing is in "When the caller has NO active space" in
 * `src/lib/name-change-bus.ts`.
 */
export function renamePage(pageId: string, title: string, spaceId: string | null): void {
  useTabsStore.getState().renamePage(pageId, title)
  useRecentPagesStore.getState().renamePage(pageId, title)
  useResolveStore.getState().set(pageId, title, false)
  if (spaceId != null) notifyPageRenamed(pageId, title, spaceId)
}

/**
 * #6755 — a tag and its page `Tag/<tag>` are renamed together, so after a
 * rename that moved both (its `edit_block` answered two op refs) the other
 * one's copies follow: a renamed tag's page, found by its new title, or a
 * renamed page's tag, found by either name, as the tag list may not have
 * caught up with the rename yet. Never rejects: the rename went through.
 */
export async function renameTagPagePartner(
  blockType: string,
  from: string,
  to: string,
  spaceId: string | null,
): Promise<void> {
  if (spaceId == null) return
  try {
    const scope = requireActiveScope(spaceId)
    if (blockType === 'tag') {
      const page = unwrap(await commands.resolvePageTitle(tagPageTitle(to), scope))
      if (page.page_id !== null) renamePage(page.page_id, page.title, spaceId)
      return
    }
    const was = tagOfPageTitle(from)
    const name = tagOfPageTitle(to)
    if (was === null || name === null) return
    const keys = new Set([nameKey(was), nameKey(name)])
    const tags = unwrap(await commands.listAllTagsInSpace(scope))
    const tag = tags.find((row) => keys.has(nameKey(row.name)))
    if (tag === undefined) return
    renamePage(tag.tag_id, name, spaceId)
    notifyTagRenamed(tag.tag_id, name, spaceId)
  } catch (err) {
    logger.warn('pageRename', 'Failed to carry a rename to its tag or page', { from, to }, err)
  }
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
