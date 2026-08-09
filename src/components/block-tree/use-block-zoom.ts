/**
 * useBlockZoom — manages zoom state, breadcrumb trail, and zoomed-view filtering.
 *
 * Extracted from BlockTree to encapsulate:
 * - Zoomed block ID state
 * - Zoom in/out/reset navigation callbacks
 * - Breadcrumb trail computation
 * - Visible blocks filtered and depth-adjusted for the zoomed view
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { BACK_PRIORITY_ZOOM, registerBackHandler } from '@/lib/back-chain'
import type { FlatBlock } from '@/lib/tree-utils'
import { getDragDescendants } from '@/lib/tree-utils'
import type { SelectAllScopeIds, ZoomedBlocks } from '@/lib/zoom-scope'

export interface BreadcrumbItem {
  id: string
  content: string
}

/**
 * The ONLY mints of the `'view'` and `'select-all'` brands (#3344 — the types
 * themselves live in `@/lib/zoom-scope`, see that module's header for why).
 * Deliberately not exported: a caller able to reach these could launder the
 * page-wide list back into a command path, which is the whole defect class
 * the brand exists to close.
 */
function viewScope(list: readonly FlatBlock[]): ZoomedBlocks {
  return list as ZoomedBlocks
}

function selectAllScope(ids: readonly string[]): SelectAllScopeIds {
  return ids as SelectAllScopeIds
}

export interface UseBlockZoomReturn {
  zoomedBlockId: string | null
  zoomIn: (blockId: string) => void
  zoomOut: () => void
  zoomToRoot: () => void
  breadcrumbs: BreadcrumbItem[]
  /** Blocks visible in the zoomed view (depth-adjusted). Falls back to collapseVisible when not zoomed. */
  zoomedVisible: ZoomedBlocks
  /**
   * Ids Ctrl/Cmd+A selects. At the page root this is the documented page-wide
   * scope (the FULL tree, including collapsed rows); while zoomed it is the
   * complete zoom projection. Deliberately separate from the rendered
   * projection: `zoomedVisible` is later mount-capped for React, but the
   * SEMANTIC contents of the active zoom are not capped, so Ctrl+A must not
   * be either.
   *
   * Derived here rather than at the call site because this is precisely the
   * branch that has to be trusted — the page-wide list is only ever branded on
   * the `zoomedBlockId === null` arm, where the page IS the active scope.
   *
   * Carries the `'select-all'` brand kind, not `'view'`: at the page root it
   * legitimately includes collapse-hidden rows, so it must not be accepted by
   * anything whose contract is the rendered projection.
   */
  selectAllIds: SelectAllScopeIds
}

/**
 * @param blocks       The full flat block list (unfiltered).
 * @param collapseVisible  Blocks after collapse filtering (before zoom).
 */
export function useBlockZoom(
  blocks: FlatBlock[],
  collapseVisible: FlatBlock[],
): UseBlockZoomReturn {
  const [zoomedBlockId, setZoomedBlockId] = useState<string | null>(null)

  const zoomIn = useCallback((blockId: string) => {
    setZoomedBlockId(blockId)
  }, [])

  const zoomOut = useCallback(() => {
    // Navigate up one level: find the zoomed block's parent and zoom to it
    if (!zoomedBlockId) return
    const zoomedBlock = blocks.find((b) => b.id === zoomedBlockId)
    if (!zoomedBlock?.parent_id) {
      setZoomedBlockId(null)
      return
    }
    // Check if parent is in our block list (i.e. not the root page)
    const parentInList = blocks.find((b) => b.id === zoomedBlock.parent_id)
    if (parentInList) {
      setZoomedBlockId(zoomedBlock.parent_id)
    } else {
      setZoomedBlockId(null)
    }
  }, [zoomedBlockId, blocks])

  const zoomToRoot = useCallback(() => {
    setZoomedBlockId(null)
  }, [])

  // #716 — while zoomed, the Android system back button should zoom out
  // one level before any view/page navigation happens. Registering is a
  // no-op on desktop: the chain is only ever run by the Android-only
  // plugin listener (`useAndroidBackButton`). LIFO tie-breaking in the
  // registry means the most recently zoomed BlockTree wins when several
  // are mounted (journal week/month views).
  useEffect(() => {
    if (zoomedBlockId === null) return
    return registerBackHandler(() => {
      zoomOut()
      return true
    }, BACK_PRIORITY_ZOOM)
  }, [zoomedBlockId, zoomOut])

  const breadcrumbs = useMemo<BreadcrumbItem[]>(() => {
    if (!zoomedBlockId) return []
    const trail: BreadcrumbItem[] = []
    let currentId: string | null = zoomedBlockId
    while (currentId) {
      const block = blocks.find((b) => b.id === currentId)
      if (!block) break
      trail.unshift({ id: block.id, content: block.content ?? '' })
      currentId = block.parent_id
    }
    return trail
  }, [zoomedBlockId, blocks])

  const zoomedVisible = useMemo<ZoomedBlocks>(() => {
    if (!zoomedBlockId) return viewScope(collapseVisible)
    const zoomedBlock = blocks.find((b) => b.id === zoomedBlockId)
    if (!zoomedBlock) return viewScope(collapseVisible)
    const depthOffset = zoomedBlock.depth + 1
    const descendants = getDragDescendants(blocks, zoomedBlockId)
    return viewScope(
      collapseVisible
        .filter((b) => descendants.has(b.id))
        .map((b) => Object.assign({}, b, { depth: b.depth - depthOffset })),
    )
  }, [zoomedBlockId, blocks, collapseVisible])

  // See `UseBlockZoomReturn.selectAllIds` for why the page-wide arm is legal.
  const selectAllIds = useMemo<SelectAllScopeIds>(
    () => selectAllScope((zoomedBlockId === null ? blocks : zoomedVisible).map((b) => b.id)),
    [zoomedBlockId, blocks, zoomedVisible],
  )

  return {
    zoomedBlockId,
    zoomIn,
    zoomOut,
    zoomToRoot,
    breadcrumbs,
    zoomedVisible,
    selectAllIds,
  }
}
