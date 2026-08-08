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

export interface BreadcrumbItem {
  id: string
  content: string
}

// ── Zoom-scope brand (#3344) ──────────────────────────────────────────────
//
// T5: a render transform applied to the view but NOT to the command path.
// The rendered projection and the un-zoomed page list are both `FlatBlock[]` /
// `string[]`, so handing a command path the wrong one typechecks — which is
// exactly how #3251 (arrow keys / Backspace-merge stepping onto unrendered
// rows) and #3252 (Ctrl+A selecting the whole page while zoomed, then batch
// deleting it) happened. The brand makes that wiring unrepresentable: the
// command-path hooks below accept ONLY a list this module derived.
//
// `ZOOM_SCOPED` is `declare const` (ambient, erased at emit) so the brand has
// no runtime cost and no runtime representation to forge.
declare const ZOOM_SCOPED: unique symbol

/**
 * Which projection a branded list is. Two lists come out of this module and
 * they are NOT interchangeable, so the brand carries which one it is rather
 * than a single "derived here" bit:
 *
 * - `'view'` — the rendered projection, in rendered document order. Every row
 *   in it is a row the pane shows.
 * - `'select-all'` — Ctrl/Cmd+A's scope. At the page root this is the
 *   DOCUMENTED page-wide list, which includes collapse-hidden rows, so it is
 *   deliberately *not* the rendered projection.
 *
 * Without the discriminant a one-bit brand would let `selectAllIds` — a
 * page-wide list containing rows the pane never rendered — pass as a
 * `'view'` list into Shift+Arrow extend / range-select, which is the very
 * defect class (#3251/#3252) this brand exists to close.
 */
type ScopeKind = 'view' | 'select-all'

/** Brand applied by {@link useBlockZoom}'s derivation and nothing else. */
type ZoomScoped<T, K extends ScopeKind> = T & { readonly [ZOOM_SCOPED]: K }

/**
 * The blocks of the ACTIVE view projection — the zoom-filtered, depth-rebased
 * slice while zoomed, the collapse-filtered page list at the root view. Only
 * {@link useBlockZoom} can produce one (and {@link useBlockMountLimit}, which
 * merely narrows whatever list it is given and so propagates the brand rather
 * than minting it).
 *
 * Command paths that step through document order — focus prev/next, the
 * Backspace merge target, the delete boundary guard, DnD's drop projection —
 * take this type so the un-zoomed page list is not a legal argument.
 */
export type ZoomedBlocks = ZoomScoped<FlatBlock[], 'view'>

/**
 * Ids of the active view projection, derived from {@link ZoomedBlocks} via
 * {@link zoomScopedIds}. The command paths that step through *rendered* rows
 * — mouse Shift+Click range-select, Shift+Arrow extend — take this type, so
 * they cannot be handed the page-wide list.
 *
 * NOT the Ctrl/Cmd+A scope: see {@link SelectAllScopeIds}.
 */
export type ZoomedIds = ZoomScoped<string[], 'view'>

/**
 * Ids Ctrl/Cmd+A selects. While zoomed this is the complete zoom projection;
 * at the page root it is the documented page-wide list, which contains
 * collapse-hidden rows and rows past the mount cap. That makes it a valid
 * argument for `selectAll` and for NOTHING else — a distinct brand kind from
 * {@link ZoomedIds} precisely so it cannot drift into a command path whose
 * contract is "the rows the pane rendered".
 */
export type SelectAllScopeIds = ZoomScoped<string[], 'select-all'>

/**
 * The ONLY mints. Deliberately not exported: a caller able to reach these
 * could launder the page-wide list back into a command path, which is the
 * whole defect class this brand exists to close. Everything outside this
 * module must obtain a branded list from {@link useBlockZoom} or
 * {@link zoomScopedIds}.
 */
function viewScope<T extends object>(list: T): ZoomScoped<T, 'view'> {
  return list as ZoomScoped<T, 'view'>
}

function selectAllScope(ids: string[]): SelectAllScopeIds {
  return ids as SelectAllScopeIds
}

/**
 * Project a zoom-scoped block list to its ids, carrying the brand across the
 * `FlatBlock[]` → `string[]` change of shape.
 *
 * This is exported but is NOT an escape hatch: it demands a {@link ZoomedBlocks}
 * as input, so it can only re-express a list that was already derived here. It
 * cannot brand an arbitrary array.
 */
export function zoomScopedIds(blocks: ZoomedBlocks): ZoomedIds {
  return viewScope(blocks.map((b) => b.id))
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
