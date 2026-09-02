/**
 * BlockListRenderer — presentational component for the sorted block list.
 *
 * Renders the SortableContext wrapper, viewport-aware placeholders, drop
 * indicators, and SortableBlock components. Extracted from BlockTree.tsx
 * (subtask 5) for file organization — no state of its own.
 *
 * Per-block action callbacks (onDelete / onIndent / …) and reference
 * resolvers (resolveBlockTitle / …) flow via `BlockActionsProvider` /
 * `BlockResolversProvider` published by BlockTree, so this
 * component no longer accepts or forwards them.
 */

import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { FileText } from 'lucide-react'
import type React from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { DragStateContext, DragStateStore } from '@/components/editor/drag-state-store'
import { ListMarkerProvider } from '@/components/editor/ListMarkerContext'
import type { ListMarkerValue } from '@/components/editor/ListMarkerContext'
import { SortableBlockWrapper } from '@/components/editor/SortableBlockWrapper'
import { Button } from '@/components/ui/button'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { useExtraBlockProperties } from '@/hooks/useExtraBlockProperties'
import { useListStyles } from '@/hooks/useListStyles'
import type { ViewportObserver } from '@/hooks/useViewportObserver'
import { computeListOrdinals } from '@/lib/list-ordinals'
import type { ListStyle } from '@/lib/list-style'
import { computeSiblingAriaProps } from '@/lib/outline-aria'
import type { FlatBlock, Projection } from '@/lib/tree-utils'
import { SENTINEL_ID } from '@/lib/tree-utils'
import { cn } from '@/lib/utils'

/** True iff two id→ordinal maps have identical entries (mirrors useListStyles.ts's `mapsEqual`). */
function ordinalsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, ordinal] of a) {
    if (b.get(id) !== ordinal) return false
  }
  return true
}

export interface BlockListRendererProps {
  /** Blocks visible during drag (descendants of active item excluded). */
  visibleItems: readonly FlatBlock[]
  /** Full block list (distinguishes an empty page from an empty projection). */
  blocks: FlatBlock[]
  /** Whether the block list is loading. */
  loading: boolean
  /** Root parent ID (for empty-state message). */
  rootParentId: string | null
  /** Whether the active projection is zoomed into a block. */
  isZoomed: boolean
  /** Safely leaves the zoomed projection when it has no visible rows. */
  onExitZoom: () => void
  /** Currently focused block ID. */
  focusedBlockId: string | null
  /** Currently selected block IDs. */
  selectedBlockIds: string[]

  // ── DnD state ──────────────────────────────────────────────────────
  projected: Projection | null
  activeId: string | null
  overId: string | null
  /**
   * #923 — true when the projected drop lands after the over-row (dragging
   * downward); the drop indicator then renders below the over-row instead of
   * above it.
   */
  dropAfter: boolean

  // ── Viewport observer ──────────────────────────────────────────────
  viewport: ViewportObserver

  // ── Roving editor ──────────────────────────────────────────────────
  rovingEditor: RovingEditorHandle

  // ── Container event handler ─────────────────────────────────────────
  /** Pointer-down handler for the `<ul>` container (used to clear focus). */
  onContainerPointerDown: (e: React.PointerEvent) => void

  // ── Collapse / tree state ──────────────────────────────────────────
  hasChildrenSet: Set<string>
  collapsedIds: Set<string>

  // ── Mount envelope (#2467) ──────────────────────────────────────────
  /**
   * Count of rows past the mount limit (`useBlockMountLimit`) that are not
   * in `visibleItems` at all — not placeholders, simply unmounted. Zero for
   * the vast majority of pages (below the cap).
   */
  hiddenMountCount: number
  /** Reveals the next batch of hidden rows (mounts them). */
  onExpandMount: () => void
}

export function BlockListRenderer({
  visibleItems,
  blocks,
  loading,
  rootParentId,
  isZoomed,
  onExitZoom,
  focusedBlockId,
  selectedBlockIds,
  projected,
  activeId,
  overId,
  dropAfter,
  viewport,
  rovingEditor,
  onContainerPointerDown,
  hasChildrenSet,
  collapsedIds,
  hiddenMountCount,
  onExpandMount,
}: BlockListRendererProps): React.ReactElement {
  const { t } = useTranslation()

  // #2288 — project the row-UI property chips from the SINGLE page-wide
  // batch published by the `BatchPropertiesProvider` (mounted by BlockTree,
  // one `getBatchProperties` IPC over the windowed ids). Previously BlockTree
  // fired a SECOND identical batch via `useExtraBlockProperties` and threaded
  // the map in as a prop; both consumed the same backend data with divergent
  // invalidation. Deriving here (inside the provider) collapses them to one
  // fetch. Outside a provider (isolated unit renders) the hook returns `{}`.
  const blockProperties = useExtraBlockProperties(visibleItems)

  // #3000 — project each block's `listStyle` from the same page-wide property
  // batch (absent ⇒ 'none') and compute the ordered-list ordinals from
  // consecutive same-depth siblings. Both are derived here (once) and published
  // via `ListMarkerProvider` so `StaticBlock` and the roving editor's marker
  // decoration read their own block's marker by id — no prop-drilling through
  // the memoized row-wrapper chain. Ordinals are display-only, never stored.
  const listStyles = useListStyles(visibleItems)
  const ordinals = useMemo(() => {
    const styleOf = (id: string): ListStyle => listStyles.get(id) ?? 'none'
    return computeListOrdinals(visibleItems, styleOf)
  }, [visibleItems, listStyles])

  // #3277 — keep the published context value referentially stable across a
  // plain content edit. `visibleItems` gets a new array identity on EVERY
  // committed edit (the store reallocates `state.blocks` via `.slice()`), but
  // a content edit cannot change any block's list marker. Re-publishing a new
  // `listMarkerValue` object on every such edit forced every mounted row's
  // `useListMarker` consumer to re-render (Context propagation bypasses
  // ancestor `React.memo`s), even though `listStyles` and `ordinals` were
  // unchanged in CONTENT. Compare `ordinals` by content (mirroring the
  // `mapsEqual` pattern in useListStyles.ts) and only mint a new value object
  // — and thus a new context identity — when a marker actually changed.
  const prevMarkerRef = useRef<{
    listStyles: Map<string, ListStyle>
    ordinals: Map<string, number>
    value: ListMarkerValue
  } | null>(null)
  const listMarkerValue = useMemo<ListMarkerValue>(() => {
    // oxlint-disable-next-line react/refs -- `prevMarkerRef` is read during render on purpose (#3277 context-identity reuse); the WRITE is confined to the `useLayoutEffect` below, so this can only ever read a triple the tree actually committed; see #4406
    const prev = prevMarkerRef.current
    // oxlint-disable-next-line react/refs -- same same-render read of the committed `prevMarkerRef` triple as the line above — the reuse gate #3277 exists for; see #4406
    if (prev && prev.listStyles === listStyles && ordinalsEqual(prev.ordinals, ordinals)) {
      return prev.value
    }
    const styleOf = (id: string): ListStyle => listStyles.get(id) ?? 'none'
    return { styleOf, ordinalOf: (id) => ordinals.get(id) }
  }, [listStyles, ordinals])

  // #4012 item 3 — the cache is populated AFTER commit, never during render.
  // This memo previously assigned `prevMarkerRef.current` inline, which made
  // render impure: under concurrent rendering React may run (and then discard)
  // a render whose output is never committed, and such a render would still
  // have published its `listStyles`/`ordinals`/`value` triple as "previous" —
  // so a later render could reuse a value derived from state the tree never
  // actually showed. Syncing in an effect confines the WRITE to commit.
  //
  // The memo above still READS the mutable ref during render, so the render is
  // not PURE — it is merely SAFE, and only because of this effect: the ref can
  // now only ever hold a triple the tree actually committed, so whatever a
  // render reads is a value that really was published, whether or not that
  // render is itself thrown away.
  //
  // The tradeoff, stated rather than hidden: this memo is strictly WEAKER than
  // the render-time write it replaces. Between mount and the first effect flush
  // the ref is null, so a re-render landing inside that window mints a fresh
  // `ListMarkerValue` where the old code would have reused one — a new context
  // identity, hence one extra re-render of every marker consumer, which is
  // exactly what #3277 exists to suppress. `useLayoutEffect` is what keeps that
  // window theoretical rather than merely unlikely: it runs before the browser
  // paints and before this commit can schedule further work, so nothing the
  // user can see renders while the ref is still null. The reuse gate itself is
  // unchanged, so from the first flush onward a content edit that leaves every
  // marker untouched still republishes the same identity and leaves the
  // memoized rows alone.
  useLayoutEffect(() => {
    prevMarkerRef.current = { listStyles, ordinals, value: listMarkerValue }
    // oxlint-disable-next-line react/refs -- `listMarkerValue` in this dep array is the memo above, which reads `prevMarkerRef` during render; the effect is what keeps that read safe; see #4406
  }, [listStyles, ordinals, listMarkerValue])

  // #1267 — publish the per-move DnD state to a ref-backed external store with
  // per-id subscription instead of threading `projected`/`overId`/`dropAfter`
  // as props to every row. `projected` is a fresh reference on every pointer
  // move, so forwarding it defeated the `React.memo` on ALL N visible
  // `SortableBlockWrapper`s. Now each row subscribes (via `useRowDragState`) to
  // a tiny derived snapshot for its OWN id; a move that changes only the
  // over-row notifies just the affected rows (old over-row, new over-row,
  // active row) and leaves the rest memoized. Mirrors the #1067 viewport store.
  const dragStoreRef = useRef<DragStateStore | undefined>(undefined)
  // oxlint-disable-next-line react/refs -- React's documented lazy-ref-init idiom for the per-move DnD store (#1267); constructing `DragStateStore` in a `useState` initialiser would not change when it is read; see #4406
  if (!dragStoreRef.current) dragStoreRef.current = new DragStateStore()
  const dragStore = dragStoreRef.current

  // Apply the new drag state DURING render so rows rendering in this same pass
  // (newly mounted, or any already re-rendering) read the fresh snapshot, then
  // notify the changed-but-memoized rows in a layout effect. Splitting it this
  // way avoids a mount-time idle→drag race: a single layout-effect publish can
  // fire before `useSyncExternalStore`'s subscription is registered, losing the
  // first notify. `applyState` is idempotent for unchanged inputs.
  // oxlint-disable-next-line react/refs -- publishing the drag snapshot DURING render is deliberate (#1267): rows rendering in this same pass must read it, and `applyState` is idempotent — see the note above and #4406
  dragStore.applyState({ projected, activeId, overId, dropAfter })
  useLayoutEffect(() => {
    dragStore.notifyPending()
  })

  // #1069 — derive a Set once per render so per-row membership is O(1).
  // `selectedBlockIds` stays a string[] in the store; the lookup below ran
  // before the React.memo gate, making selection-changing renders N×O(N).
  // Mirrors the collapsedIds / hasChildrenSet Set pattern used in this file.
  const selectedSet = useMemo(() => new Set(selectedBlockIds), [selectedBlockIds])

  // ── Expand animation ──────────────────────────────────────
  // Track previous collapsedIds to detect which parents were just expanded.
  // Children of those parents get a CSS enter animation.
  const prevCollapsedRef = useRef(collapsedIds)
  const animatingBlockIds = useMemo(() => {
    // oxlint-disable-next-line react/refs -- `prevCollapsedRef` is read same-render (compared against the current `collapsedIds` to detect just-expanded parents) but written only from the effect below, never during render; see #4406 and frontend.md's ref-directive buckets
    const prev = prevCollapsedRef.current
    if (prev === collapsedIds) return new Set<string>()

    // IDs that were collapsed before but are no longer collapsed → just expanded
    const justExpanded = new Set<string>()
    for (const id of prev) {
      if (!collapsedIds.has(id)) justExpanded.add(id)
    }
    if (justExpanded.size === 0) return new Set<string>()

    // Collect descendants of each just-expanded parent in the flat list
    const animated = new Set<string>()
    for (let i = 0; i < visibleItems.length; i++) {
      const block = visibleItems[i]
      if (!block || !justExpanded.has(block.id)) continue
      const parentDepth = block.depth
      for (let j = i + 1; j < visibleItems.length; j++) {
        const child = visibleItems[j]
        if (!child || child.depth <= parentDepth) break
        animated.add(child.id)
      }
    }
    return animated
  }, [collapsedIds, visibleItems])

  useEffect(() => {
    prevCollapsedRef.current = collapsedIds
  }, [collapsedIds])

  // ── Sibling aria props ─────────────────────────────────────
  // #4550 — the single-pass grouping now lives in `@/lib/outline-aria` so an
  // embedded subtree computes `aria-setsize` / `aria-posinset` with the SAME
  // algorithm over the same notion of depth. That matters more than the
  // de-duplication: an embed's rows are announced relative to the host tree,
  // and "relative to the host tree" is only meaningful if both sides agree on
  // how a sibling group is formed. Behaviour here is unchanged.
  const siblingAriaProps = useMemo(() => computeSiblingAriaProps(visibleItems), [visibleItems])

  const sortableItems = useMemo(
    () => [...visibleItems.map((b) => b.id), ...(visibleItems.length > 0 ? [SENTINEL_ID] : [])],
    [visibleItems],
  )

  // B4 (#290) — deepest currently-visible indent level; the drag-time indent
  // guides draw a boundary at each level up to one past it (so the next-deeper
  // drop target is also hinted).
  const maxDepth = useMemo(
    () => visibleItems.reduce((m, b) => Math.max(m, b.depth), 0),
    [visibleItems],
  )

  return (
    // oxlint-disable-next-line react/refs -- `listMarkerValue` is the memo above that reads `prevMarkerRef` during render; publishing it is the point of #3277; see #4406
    <ListMarkerProvider value={listMarkerValue}>
      {/* oxlint-disable-next-line react/refs -- `dragStore` is the lazily-initialised `dragStoreRef.current` (#1267); publishing it as a stable context value is the point; see #4406 */}
      <DragStateContext.Provider value={dragStore}>
        <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
          {visibleItems.length === 0 && !loading ? (
            isZoomed ? (
              <EmptyState
                message={t('blockTree.emptyZoom')}
                description={t('blockTree.emptyZoomHint')}
                action={
                  <Button type="button" variant="outline" className="mt-4" onClick={onExitZoom}>
                    {t('blockZoom.exitZoom')}
                  </Button>
                }
              />
            ) : rootParentId && blocks.length === 0 ? (
              <EmptyState message={t('blockTree.emptyPage')} />
            ) : (
              <EmptyState
                icon={FileText}
                message={t('blockTree.noBlocks')}
                description={t('blockTree.emptyPageHint')}
              />
            )
          ) : (
            <div className="relative">
              {/* B4 (#290): faint indent-boundary guides during a drag so the
              20px DEAD_ZONE_PX reads as deliberate snap-to-grid and the indent
              width is legible. Behind the rows (z-0) and pointer-events-none. */}
              {activeId !== null && (
                <DragIndentGuides levels={maxDepth + 1} activeDepth={projected?.depth ?? null} />
              )}
              <ul
                // #992 — vertical rhythm comes from the single-source-of-truth
                // `--block-row-gap` CSS var (defined in index.css alongside
                // `--indent-width`): 4px desktop, 6px touch (one scale step up).
                // Replaces the divergent `space-y-0.5` / `space-y-1.5` literals so
                // every BlockTree mount (page + journal day/week/month) shares it.
                className="block-tree relative z-10 list-none m-0 p-0 space-y-[var(--block-row-gap)]"
                data-testid="block-tree"
                aria-label={t('blockTree.treeLabel')}
                onPointerDown={onContainerPointerDown}
              >
                {visibleItems.map((block) => {
                  const aria = siblingAriaProps.get(block.id)
                  return (
                    <SortableBlockWrapper
                      key={block.id}
                      block={block}
                      focusedBlockId={focusedBlockId}
                      isSelected={selectedSet.has(block.id)}
                      viewport={viewport}
                      rovingEditor={rovingEditor}
                      hasChildren={hasChildrenSet.has(block.id)}
                      isCollapsed={collapsedIds.has(block.id)}
                      isAnimating={animatingBlockIds.has(block.id)}
                      siblingSetsize={aria?.setsize}
                      siblingPosinset={aria?.posinset}
                      properties={blockProperties[block.id]}
                    />
                  )
                })}
                {/* #2467 — mount-envelope boundary. Rows beyond the mount limit
                are not mounted at all (not placeholders); this affordance lets
                the user reveal (mount) the next batch on demand. */}
                {!loading && hiddenMountCount > 0 && (
                  <MountBoundaryRow hiddenCount={hiddenMountCount} onExpand={onExpandMount} />
                )}
                {/* Sentinel droppable zone for dropping after last block */}
                {!loading && visibleItems.length > 0 && (
                  <SentinelDropZone activeId={activeId} overId={overId} projected={projected} />
                )}
              </ul>
            </div>
          )}
        </SortableContext>
      </DragStateContext.Provider>
    </ListMarkerProvider>
  )
}

// ── Drag indent guides (B4 / #290) ─────────────────────────────────────

/**
 * Faint full-height vertical guides at each indent boundary, shown only while
 * a drag is in progress. They make the 20px `DEAD_ZONE_PX` (the horizontal
 * slop before an indent level changes — see `tree-utils.getProjection`) read
 * as a deliberate snap-to-grid rather than laggy tracking, and teach the
 * indent width. Aligned to `--indent-width` so they sit exactly where each
 * depth's content begins (`SortableBlock` pads by `--indent-width * depth`).
 * Decorative: `aria-hidden`, `pointer-events-none`, painted behind the rows.
 *
 * #993 — resting guides stay faint (`w-px bg-primary/15`); the single line at
 * the level the projection will land on (`activeDepth`) is drawn bold
 * (`w-0.5 bg-primary/70`) so the snap target is legible during rapid moves
 * without darkening every line into clutter. No animation. `activeDepth` is
 * the in-scope `projected.depth` (0-based) or null when there's no projection.
 */
function DragIndentGuides({
  levels,
  activeDepth,
}: {
  levels: number
  activeDepth: number | null
}): React.ReactElement | null {
  if (levels <= 0) return null
  return (
    <div
      aria-hidden="true"
      data-testid="drag-indent-guides"
      className="pointer-events-none absolute inset-0 z-0"
    >
      {Array.from({ length: levels }, (_, i) => i + 1).map((level) => {
        const isTarget = activeDepth != null && level === activeDepth
        return (
          <span
            key={level}
            data-testid={`drag-indent-guide-${level}`}
            data-target={isTarget ? 'true' : undefined}
            className={cn(
              'absolute inset-y-0',
              isTarget ? 'w-0.5 bg-primary/70' : 'w-px bg-primary/15',
            )}
            style={{ left: `calc(var(--indent-width) * ${level})` }}
          />
        )
      })}
    </div>
  )
}

// ── Mount envelope boundary (#2467) ─────────────────────────────────────

/**
 * Renders where the mounted row list ends and the deferred (unmounted) tail
 * begins. Clicking it mounts the next batch — the same "nothing renders
 * until asked for" contract as expanding a collapsed block, just keyed on
 * position in the flat list instead of collapse state.
 */
function MountBoundaryRow({
  hiddenCount,
  onExpand,
}: {
  hiddenCount: number
  onExpand: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <li className="list-none m-0 p-0" data-testid="block-tree-mount-boundary">
      <button
        type="button"
        className="w-full rounded-lg border border-dashed border-border bg-transparent p-2 text-sm text-muted-foreground hover:bg-accent"
        onClick={onExpand}
      >
        {t('blockTree.mountBoundary', { count: hiddenCount })}
      </button>
    </li>
  )
}

// ── Sentinel drop zone ─────────────────────────────────────────────────

function SentinelDropZone({
  activeId,
  overId,
  projected,
}: {
  activeId: string | null
  overId: string | null
  projected: Projection | null
}): React.ReactElement {
  const { setNodeRef } = useDroppable({ id: SENTINEL_ID })

  // #991 — committed faint row-level tint so dropping after the last block
  // matches the over-row affordance in SortableBlockWrapper. Static class (no
  // transition), reduced-motion safe by construction.
  const showDropIndicator = projected != null && overId === SENTINEL_ID && activeId != null

  return (
    <li
      ref={setNodeRef}
      className={cn('list-none m-0 p-0', showDropIndicator && 'bg-primary/8')}
      aria-hidden
    >
      {/* Drop indicator when hovering over sentinel */}
      {showDropIndicator && (
        <div
          className="drop-indicator h-[5px] bg-primary rounded-full ring-2 ring-primary/20"
          style={{ marginLeft: 0 }}
        />
      )}
      <div className="min-h-[60px]" />
    </li>
  )
}
