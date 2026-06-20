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
import { SortableBlockWrapper } from '@/components/editor/SortableBlockWrapper'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import type { ViewportObserver } from '@/hooks/useViewportObserver'
import type { FlatBlock, Projection } from '@/lib/tree-utils'
import { SENTINEL_ID } from '@/lib/tree-utils'
import { cn } from '@/lib/utils'

export interface BlockListRendererProps {
  /** Blocks visible during drag (descendants of active item excluded). */
  visibleItems: FlatBlock[]
  /** Full block list (used for empty-state check). */
  blocks: FlatBlock[]
  /** Whether the block list is loading. */
  loading: boolean
  /** Root parent ID (for empty-state message). */
  rootParentId: string | null
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
  blockProperties: Record<string, Array<{ key: string; value: string }>>
}

export function BlockListRenderer({
  visibleItems,
  blocks,
  loading,
  rootParentId,
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
  blockProperties,
}: BlockListRendererProps): React.ReactElement {
  const { t } = useTranslation()

  // #1267 — publish the per-move DnD state to a ref-backed external store with
  // per-id subscription instead of threading `projected`/`overId`/`dropAfter`
  // as props to every row. `projected` is a fresh reference on every pointer
  // move, so forwarding it defeated the `React.memo` on ALL N visible
  // `SortableBlockWrapper`s. Now each row subscribes (via `useRowDragState`) to
  // a tiny derived snapshot for its OWN id; a move that changes only the
  // over-row notifies just the affected rows (old over-row, new over-row,
  // active row) and leaves the rest memoized. Mirrors the #1067 viewport store.
  const dragStoreRef = useRef<DragStateStore | undefined>(undefined)
  if (!dragStoreRef.current) dragStoreRef.current = new DragStateStore()
  const dragStore = dragStoreRef.current

  // Apply the new drag state DURING render so rows rendering in this same pass
  // (newly mounted, or any already re-rendering) read the fresh snapshot, then
  // notify the changed-but-memoized rows in a layout effect. Splitting it this
  // way avoids a mount-time idle→drag race: a single layout-effect publish can
  // fire before `useSyncExternalStore`'s subscription is registered, losing the
  // first notify. `applyState` is idempotent for unchanged inputs.
  dragStore.applyState({ projected, activeId, overId, dropAfter })
  useLayoutEffect(() => {
    dragStore.notifyPending()
  })

  const anyBlockHasChildren = hasChildrenSet.size > 0

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
  // Compute aria-setsize / aria-posinset for each block by grouping siblings
  // that share the same parent in the flat list. Single-pass O(N) algorithm
  // We keep a `lastAtDepth` map that records the most-recent index
  // seen at each depth. Each block's parent is simply `lastAtDepth[depth-1]`,
  // matching the semantics of the previous backward-scan — each block is
  // grouped with the nearest preceding block at its parent's depth. Roots
  // (depth 0) share the `-1` sentinel group.
  const siblingAriaProps = useMemo(() => {
    const result = new Map<string, { setsize: number; posinset: number }>()
    const groups = new Map<number, number[]>()
    const lastAtDepth = new Map<number, number>()

    for (let i = 0; i < visibleItems.length; i++) {
      const block = visibleItems[i]
      if (!block) continue
      const parentIdx = block.depth > 0 ? (lastAtDepth.get(block.depth - 1) ?? -1) : -1
      let list = groups.get(parentIdx)
      if (!list) {
        list = []
        groups.set(parentIdx, list)
      }
      list.push(i)
      lastAtDepth.set(block.depth, i)
    }

    for (const indices of groups.values()) {
      const setsize = indices.length
      for (let j = 0; j < indices.length; j++) {
        const idx = indices[j]
        const block = idx != null ? visibleItems[idx] : undefined
        if (block) {
          result.set(block.id, { setsize, posinset: j + 1 })
        }
      }
    }

    return result
  }, [visibleItems])

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
    <DragStateContext.Provider value={dragStore}>
      <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
        {blocks.length === 0 && !loading ? (
          rootParentId ? (
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
                    anyBlockHasChildren={anyBlockHasChildren}
                    isCollapsed={collapsedIds.has(block.id)}
                    isAnimating={animatingBlockIds.has(block.id)}
                    siblingSetsize={aria?.setsize}
                    siblingPosinset={aria?.posinset}
                    properties={blockProperties[block.id]}
                  />
                )
              })}
              {/* Sentinel droppable zone for dropping after last block */}
              {!loading && visibleItems.length > 0 && (
                <SentinelDropZone activeId={activeId} overId={overId} projected={projected} />
              )}
            </ul>
          </div>
        )}
      </SortableContext>
    </DragStateContext.Provider>
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
