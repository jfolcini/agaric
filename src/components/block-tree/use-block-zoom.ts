/**
 * useBlockZoom — manages zoom state, breadcrumb trail, and zoomed-view filtering.
 *
 * Extracted from BlockTree to encapsulate:
 * - Zoomed block ID state
 * - Zoom in/out/reset navigation callbacks
 * - Breadcrumb trail computation
 * - Visible blocks filtered and depth-adjusted for the zoomed view
 *
 * Scope of the collapse filter (#4038): the zoomed projection is derived from
 * the UNFILTERED tree and re-applies collapse WITHIN the pane, instead of
 * filtering the page-wide collapse-filtered list. A zoom root is the pane's
 * root, so the collapse state of blocks at or ABOVE it is out of scope — it
 * describes a page layout the pane is not showing. Filtering the page-wide
 * list let a collapsed ANCESTOR of the zoom root delete the pane's entire
 * contents, rendering breadcrumbs over an empty pane; see `zoomedVisible`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

/**
 * #3253 — per-row memo for the zoomed projection's depth rebase: `id → {source
 * block object, depth offset it was rebased with, emitted object}`. A hit
 * (same source reference AND same offset) re-emits the previous object so an
 * unedited row keeps its identity across recomputes; anything else re-clones.
 */
type RebaseCache = Map<string, { src: FlatBlock; depthOffset: number; out: FlatBlock }>

export interface UseBlockZoomReturn {
  zoomedBlockId: string | null
  zoomIn: (blockId: string) => void
  zoomOut: () => void
  zoomToRoot: () => void
  breadcrumbs: BreadcrumbItem[]
  /**
   * Blocks visible in the zoomed view (depth-adjusted). Falls back to
   * `collapseVisible` when not zoomed — at the page root the page-wide
   * collapse filter IS the pane's filter. While zoomed the pane re-derives
   * its own collapse filtering from the full tree (#4038, see below).
   */
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
 * @param collapseVisible  Blocks after page-wide collapse filtering (before
 *   zoom). Used for the NOT-zoomed projection only.
 * @param collapsedIds The EFFECTIVE collapsed set (`useBlockCollapse`'s
 *   persisted layout minus its transient reveal overlay) — the same set
 *   `collapseVisible` was filtered by. Required, not optional: the zoomed
 *   projection re-applies collapse itself (#4038), so a caller that forgot to
 *   pass it would silently render a pane with every collapsed subtree open.
 */
export function useBlockZoom(
  blocks: FlatBlock[],
  collapseVisible: FlatBlock[],
  collapsedIds: ReadonlySet<string>,
): UseBlockZoomReturn {
  const [zoomedBlockId, setZoomedBlockId] = useState<string | null>(null)

  // See `RebaseCache` — carries the zoomed projection's rebased row objects
  // across `zoomedVisible` recomputes so unedited rows keep their identity.
  const rebaseCacheRef = useRef<RebaseCache>(undefined)
  rebaseCacheRef.current ??= new Map()

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

  // #4038 — the pane is derived from `blocks` (unfiltered) and re-filtered by
  // the collapsed ids found INSIDE it, rather than by filtering the page-wide
  // `collapseVisible`. The page-wide list bakes in the collapse state of the
  // zoom root's ancestors, and those rows are not part of this pane: with
  // ancestor `A` collapsed and a zoom into its descendant `C`, `C` and
  // everything under it are absent from `collapseVisible` altogether, so the
  // pane filtered down to `[]` and rendered breadcrumbs over nothing. That
  // became reachable when #4002 made the navigation reveal transient — the
  // reveal holding `A` open is released by the next focus move (a same-page
  // search hit or backlink, which `PageEditor` applies unconditionally),
  // which silently emptied the open pane. Resolving the pane against the
  // unfiltered tree removes the whole class: nothing above the zoom root can
  // subtract from the pane's contents, whatever releases it and whenever.
  //
  // Collapse INSIDE the pane still filters, by the same single-pass
  // skip-the-collapsed-subtree scan as `useBlockCollapse`'s page-wide
  // `visibleBlocks` (kept inline here because this pass also restricts to the
  // zoom root's descendants and rebases `depth` in the same walk). The zoom
  // root's own collapsed flag is deliberately NOT consulted: it is the pane's
  // root, and "zoom into a block" means show its contents.
  const zoomedVisible = useMemo<ZoomedBlocks>(() => {
    if (!zoomedBlockId) return viewScope(collapseVisible)
    const zoomedBlock = blocks.find((b) => b.id === zoomedBlockId)
    if (!zoomedBlock) return viewScope(collapseVisible)
    const depthOffset = zoomedBlock.depth + 1
    const descendants = getDragDescendants(blocks, zoomedBlockId)
    // #3253 — reuse the previously-emitted rebased object whenever the SOURCE
    // block object and `depthOffset` are both unchanged. Without this every
    // recompute (any store write to `blocks`, any collapse toggle) minted a
    // fresh object for every row, so each `SortableBlockWrapper`'s React.memo
    // missed on its `block` prop and the whole pane re-rendered — throwing
    // away the byte-for-byte reference stability the store preserves upstream
    // (#2527). The cache is rebuilt per run so it never outgrows the pane.
    const prevRebased = rebaseCacheRef.current as RebaseCache
    const nextRebased: RebaseCache = new Map()
    const result: FlatBlock[] = []
    const skipUntilDepth: number[] = []
    for (const block of blocks) {
      if (!descendants.has(block.id)) continue
      while (skipUntilDepth.length > 0 && block.depth <= (skipUntilDepth.at(-1) as number)) {
        skipUntilDepth.pop()
      }
      if (skipUntilDepth.length > 0) continue
      const cached = prevRebased.get(block.id)
      const rebased =
        cached !== undefined && cached.src === block && cached.depthOffset === depthOffset
          ? cached.out
          : Object.assign({}, block, { depth: block.depth - depthOffset })
      nextRebased.set(block.id, { src: block, depthOffset, out: rebased })
      result.push(rebased)
      if (collapsedIds.has(block.id)) skipUntilDepth.push(block.depth)
    }
    rebaseCacheRef.current = nextRebased
    return viewScope(result)
  }, [zoomedBlockId, blocks, collapseVisible, collapsedIds])

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
