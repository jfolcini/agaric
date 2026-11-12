/**
 * useFindReveal — mount the row holding in-page find's current match (#6557).
 *
 * Find counts every block in the page store, so its current match can sit
 * under a collapsed block or past the mount cap, where no row exists to scroll
 * to or paint. This expands the collapsed ancestors and raises the mount cap to
 * the row; `InPageFind` scrolls it in and paints it once it is in the DOM.
 *
 * Unlike the focus reveal (`expandAncestors`), the expansion is saved: the
 * user navigated into the subtree, as with a chevron click, and a transient
 * reveal would be released by the next focus move under the reader. A target
 * outside the active zoom pane is left alone.
 */

import { useEffect } from 'react'

import type { FlatBlock } from '@/lib/tree-utils'
import { useInPageFindStore } from '@/stores/useInPageFindStore'

export function useFindReveal({
  blocksById,
  collapsedIds,
  visible,
  expandBlock,
  revealIndex,
}: {
  blocksById: ReadonlyMap<string, FlatBlock>
  /** The effective collapsed set. */
  collapsedIds: ReadonlySet<string>
  /** The collapse-filtered rows of the active pane, before the mount cap. */
  visible: readonly FlatBlock[]
  expandBlock: (blockId: string) => void
  revealIndex: (index: number) => void
}): void {
  const targetId = useInPageFindStore((s) => s.revealBlockId)
  useEffect(() => {
    if (targetId === null || !blocksById.has(targetId)) return
    const visited = new Set<string>()
    let parentId = blocksById.get(targetId)?.parent_id ?? null
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId)
      if (collapsedIds.has(parentId)) expandBlock(parentId)
      parentId = blocksById.get(parentId)?.parent_id ?? null
    }
    // Absent until the expansion above lands; this effect runs again then.
    const index = visible.findIndex((b) => b.id === targetId)
    if (index >= 0) revealIndex(index)
  }, [targetId, blocksById, collapsedIds, visible, expandBlock, revealIndex])
}
