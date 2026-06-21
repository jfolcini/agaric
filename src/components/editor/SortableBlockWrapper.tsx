/**
 * SortableBlockWrapper — per-block row wrapper for BlockListRenderer.
 *
 * Extracted from BlockListRenderer's `visibleItems.map` body so the parent's
 * cognitive complexity stays within the oxlint eslint/complexity threshold. This component owns
 * the branching between the virtualized placeholder `<li>` and the full
 * `<li>` that renders the drop indicator and `<SortableBlock>`. No new
 * behaviour — pure render reorganisation.
 *
 * Per-block action callbacks and reference resolvers used to be drilled
 * through this component verbatim. They now flow via
 * `BlockActionsProvider` / `BlockResolversProvider`, so this
 * file no longer mentions them at all — SortableBlock reads them directly
 * from context.
 */

import React, { useCallback, useSyncExternalStore } from 'react'

import { SortableBlock } from '@/components/editor/SortableBlock'
import { useRowDragState } from '@/components/editor/use-row-drag-state'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import type { ViewportObserver } from '@/hooks/useViewportObserver'
import type { FlatBlock, Projection } from '@/lib/tree-utils'
import { cn } from '@/lib/utils'

export interface SortableBlockWrapperProps {
  /** The flat block to render at this row. */
  block: FlatBlock
  /** Currently focused block id (null if none). */
  focusedBlockId: string | null
  /** True if this block is part of the active multi-selection. */
  isSelected: boolean

  // ── DnD state (fallback only) ──────────────────────────────────────
  // #1267 — the live per-move drag state normally flows via the
  // `DragStateStore` (DragStateContext) published by BlockListRenderer, read
  // per-id through `useRowDragState`. These props are NOT passed by
  // BlockListRenderer anymore (passing the per-move-fresh `projected` reference
  // here would defeat the `React.memo`). They remain as an optional fallback
  // for standalone renders (unit tests) where no provider is mounted.
  projected?: Projection | null
  activeId?: string | null
  overId?: string | null
  /**
   * #923 — true when the projected drop lands AFTER this over-row (the user is
   * dragging downward). The drop indicator then renders BELOW `<SortableBlock>`
   * instead of above it, so the bar sits where the block will actually land.
   */
  dropAfter?: boolean

  // ── Viewport + editor ─────────────────────────────────────────────
  viewport: ViewportObserver
  rovingEditor: RovingEditorHandle

  // ── Tree / collapse state ──────────────────────────────────────────
  hasChildren: boolean
  isCollapsed: boolean
  /** True when this row is a descendant of a just-expanded parent. */
  isAnimating: boolean
  /**
   * Precomputed aria-setsize / aria-posinset for the sibling group.
   *
   * Split into two primitive props (rather than one `{setsize, posinset}`
   * object) so `React.memo`'s shallow prop comparison short-circuits when
   * the sibling layout is unchanged — even though `BlockListRenderer`
   * rebuilds its `siblingAriaProps` map on every `visibleItems` identity
   * change (i.e. every drag-drop / indent). Without this split, every
   * row would memo-invalidate on every move.
   */
  siblingSetsize: number | undefined
  siblingPosinset: number | undefined
  /** Custom block properties to render as inline chips. */
  properties: Array<{ key: string; value: string }> | undefined
}

function SortableBlockWrapperInner({
  block,
  focusedBlockId,
  isSelected,
  projected = null,
  activeId = null,
  overId = null,
  dropAfter: dropAfterProp = false,
  viewport,
  rovingEditor,
  hasChildren,
  isCollapsed,
  isAnimating,
  siblingSetsize,
  siblingPosinset,
  properties,
}: SortableBlockWrapperProps): React.ReactElement {
  const isFocused = focusedBlockId === block.id

  // #1267 — read ONLY this row's drag-derived state via a per-id external-store
  // subscription (the `DragStateStore` published by BlockListRenderer). A bare
  // pointer-move that doesn't change this row's snapshot no longer re-renders
  // it, so the `React.memo` below holds for the (N − 2) rows that are neither
  // the dragged nor the over-row — instead of every row churning on the
  // per-move-fresh `projected` reference. When no provider is mounted
  // (standalone unit renders), this derives from the DnD props below, keeping
  // the prior contract. See `drag-state-store.ts` / `useRowDragState`.
  const { projectedDepthOverride, showDropIndicator, dropAfter, dropIndicatorDepth } =
    useRowDragState(block.id, {
      projected,
      activeId,
      overId,
      dropAfter: dropAfterProp,
    })

  // B3 (#217) — drag depth preview. While a drag is in progress the dragged
  // source row used to keep its *original* depth, so only the drop indicator
  // (which renders at `projected.depth`) hinted at where the block would land;
  // the lifted row itself stayed put horizontally. Reflect the projected depth
  // on the dragged row too so the indent the block will adopt is legible during
  // the drag (it already rests at `opacity: 0.35` as a "lifted placeholder").
  // The over-target row also previews projected depth so the row under the
  // cursor shows the incoming indent.
  const projectedDepth = projectedDepthOverride ?? block.depth

  // Per-id memoized ref callback — same function identity across
  // renders for a given block.id, and unobserves the exact element
  // On unmount.
  const observeRef = viewport.createObserveRef(block.id)

  // #1067 — subscribe to THIS block's off-screen membership via a per-id
  // external-store source. The `viewport` object identity is now permanently
  // stable, so a scroll tick that flips another block does NOT re-render this
  // row; only a flip of *this* block's membership notifies this subscriber and
  // schedules this wrapper's re-render. (Previously a single `viewport` memo
  // churned on every flip and invalidated all N `React.memo`'d wrappers.)
  const offscreen = useSyncExternalStore(
    useCallback((onChange) => viewport.subscribe(block.id, onChange), [viewport, block.id]),
    () => viewport.isOffscreen(block.id),
  )

  // #923 — the drop indicator shows where the dragged block will land. It
  // renders for the over-row only and never on the active drag row itself
  // (both encoded in `showDropIndicator`, derived per-row in the drag store).
  // `dropAfter` decides placement: ABOVE the row when the drop is before it
  // (dragging upward) and BELOW it (after `<SortableBlock>`) when the drop is
  // after it (dragging downward), so the bar always sits at the true landing
  // edge. The indent (marginLeft) is kept on both placements.
  const dropIndicator = showDropIndicator ? (
    <div
      className="drop-indicator h-[5px] bg-primary rounded-full ring-2 ring-primary/20"
      style={{
        marginLeft: `calc(var(--indent-width) * ${dropIndicatorDepth})`,
      }}
    />
  ) : null

  // Focused block is never virtualized — always render fully
  if (!isFocused && offscreen) {
    return (
      <li
        ref={observeRef}
        data-block-id={block.id}
        aria-level={block.depth + 1}
        aria-setsize={siblingSetsize}
        aria-posinset={siblingPosinset}
        // The operable expand/collapse control with aria-expanded is the
        // chevron <button> inside <SortableBlock> (BlockInlineControls). This
        // row mirrors that state for assistive tech that walks the outline
        // structure. listitem doesn't formally support aria-expanded, and we
        // can't promote it to treeitem without making the parent <ul> a
        // role="tree" (owned by BlockListRenderer, out of scope) — an isolated
        // treeitem under a plain list is itself an a11y violation. axe accepts
        // aria-expanded on listitem; only oxlint's static rule rejects it.
        // oxlint-disable-next-line jsx-a11y/role-supports-aria-props -- see note above; canonical control lives in BlockInlineControls
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        className="block-placeholder list-none m-0 p-0"
        style={{ minHeight: viewport.getHeight(block.id) }}
      />
    )
  }

  return (
    <li
      ref={observeRef}
      data-block-id={block.id}
      aria-level={block.depth + 1}
      aria-setsize={siblingSetsize}
      aria-posinset={siblingPosinset}
      // See the placeholder branch above: aria-expanded mirrors the chevron
      // button's state for the outline structure; the canonical control is in
      // BlockInlineControls.
      // oxlint-disable-next-line jsx-a11y/role-supports-aria-props -- see note above; canonical control lives in BlockInlineControls
      aria-expanded={hasChildren ? !isCollapsed : undefined}
      className={cn(
        'list-none m-0 p-0',
        isAnimating && 'block-children-enter',
        // #991 — committed faint row-level drop-over tint so the whole
        // landing row reads as the target (Notion/Logseq idiom), not just the
        // 5px bar. Gated on the existing `showDropIndicator`, independent of
        // `isFocused`. Static class (no transition) — reduced-motion safe; no
        // `border-l-2` so it never collides with the focused block's
        // `shadow-[inset_2px_0_0_var(--primary)]` left accent.
        showDropIndicator && 'bg-primary/8',
      )}
    >
      {/* #923 — drop indicator ABOVE the row when the drop lands before it. */}
      {!dropAfter && dropIndicator}
      <SortableBlock
        blockId={block.id}
        content={block.content ?? ''}
        isFocused={isFocused}
        depth={projectedDepth}
        rovingEditor={rovingEditor}
        hasChildren={hasChildren}
        isCollapsed={isCollapsed}
        todoState={block.todo_state ?? null}
        priority={block.priority ?? null}
        dueDate={block.due_date ?? null}
        scheduledDate={block.scheduled_date ?? null}
        properties={properties}
        isSelected={isSelected}
      />
      {/* #923 — drop indicator BELOW the row when the drop lands after it. */}
      {dropAfter && dropIndicator}
    </li>
  )
}

/**
 * Memoized to short-circuit per-row re-renders when the parent
 * (`BlockListRenderer` → `BlockTree`) re-renders for reasons unrelated
 * to this specific row. The downstream `SortableBlock` is also
 * `React.memo`-wrapped — but that memo is only effective if this
 * wrapper's props (notably `viewport` and `rovingEditor`, both
 * hook-return objects) have stable identity across renders.
 *
 * Stability of those two props is enforced at their source:
 *  - `useRovingEditor` memoizes its returned handle (deps: `editor`),
 *    so identity only changes when the TipTap editor instance changes.
 *  - `useViewportObserver` returns a PERMANENTLY stable object (#1067):
 *    off-screen membership lives in a ref + per-id `useSyncExternalStore`
 *    subscription (above), so the `viewport` prop never changes identity and
 *    a scroll tick re-renders only the row whose membership actually flipped,
 *    not all N wrappers.
 *
 * (design-system-perf-review-2026-05-09.md item 5; #1067.)
 */
export const SortableBlockWrapper = React.memo(SortableBlockWrapperInner)
SortableBlockWrapper.displayName = 'SortableBlockWrapper'
