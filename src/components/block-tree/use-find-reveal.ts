/**
 * useFindReveal — mount the row holding in-page find's current match (#6557).
 *
 * Find counts every block in the page store, so its current match can sit
 * under a collapsed block, in a collapsed heading's section (#7040) or past the
 * mount cap, where no row exists to scroll to or paint. This expands the
 * collapsed blocks whose folds hold it and raises the mount cap to the row; `InPageFind` scrolls it in and paints it once it is in the DOM.
 *
 * Unlike the focus reveal (`expandAncestors`), the expansion is saved: the
 * user navigated into the subtree, as with a chevron click, and a transient
 * reveal would be released by the next focus move under the reader. A target
 * outside the active zoom pane is left alone.
 */

import { useEffect } from 'react'

import { foldsOver, outlineOf } from '@/lib/section-fold'
import type { FlatBlock } from '@/lib/tree-utils'
import { useInPageFindStore } from '@/stores/useInPageFindStore'

export function useFindReveal({
  blocks,
  collapsedIds,
  visible,
  expandBlock,
  revealIndex,
}: {
  /** The page's flat tree. */
  blocks: readonly FlatBlock[]
  /** The effective collapsed set. */
  collapsedIds: ReadonlySet<string>
  /** The collapse-filtered rows of the active pane, before the mount cap. */
  visible: readonly FlatBlock[]
  expandBlock: (blockId: string) => void
  revealIndex: (index: number) => void
}): void {
  const targetId = useInPageFindStore((s) => s.revealBlockId)
  useEffect(() => {
    const target = targetId === null ? -1 : blocks.findIndex((b) => b.id === targetId)
    if (target === -1) return
    const folded: number[] = []
    blocks.forEach((b, i) => {
      if (collapsedIds.has(b.id)) folded.push(i)
    })
    for (const index of foldsOver(outlineOf(blocks), target, folded)) {
      expandBlock((blocks[index] as FlatBlock).id)
    }
    // Absent until the expansion above lands; this effect runs again then.
    const index = visible.findIndex((b) => b.id === targetId)
    if (index >= 0) revealIndex(index)
  }, [targetId, blocks, collapsedIds, visible, expandBlock, revealIndex])
}
