/**
 * SortableBlockWrapper — per-block row wrapper for BlockListRenderer (MAINT-55).
 *
 * Extracted from BlockListRenderer's `visibleItems.map` body so the parent's
 * cognitive complexity stays within the Biome threshold. This component owns
 * the branching between the virtualized placeholder `<li>` and the full
 * `<li>` that renders the drop indicator and `<SortableBlock>`. No new
 * behaviour — pure render reorganisation.
 *
 * Per-block action callbacks and reference resolvers used to be drilled
 * through this component verbatim. They now flow via
 * `BlockActionsProvider` / `BlockResolversProvider` (MAINT-118), so this
 * file no longer mentions them at all — SortableBlock reads them directly
 * from context.
 */

import type React from 'react'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import type { ViewportObserver } from '../hooks/useViewportObserver'
import type { FlatBlock, Projection } from '../lib/tree-utils'
import { cn } from '../lib/utils'
import { SortableBlock } from './SortableBlock'

export interface SortableBlockWrapperProps {
  /** The flat block to render at this row. */
  block: FlatBlock
  /** Currently focused block id (null if none). */
  focusedBlockId: string | null
  /** True if this block is part of the active multi-selection. */
  isSelected: boolean

  // ── DnD state ──────────────────────────────────────────────────────
  projected: Projection | null
  activeId: string | null
  overId: string | null

  // ── Viewport + editor ─────────────────────────────────────────────
  viewport: ViewportObserver
  rovingEditor: RovingEditorHandle

  // ── Tree / collapse state ──────────────────────────────────────────
  hasChildren: boolean
  anyBlockHasChildren: boolean
  isCollapsed: boolean
  /** True when this row is a descendant of a just-expanded parent. */
  isAnimating: boolean
  /** Precomputed aria-setsize / aria-posinset for the sibling group. */
  siblingAria: { setsize: number; posinset: number } | undefined
  /** Custom block properties to render as inline chips. */
  properties: Array<{ key: string; value: string }> | undefined
}

export function SortableBlockWrapper({
  block,
  focusedBlockId,
  isSelected,
  projected,
  activeId,
  overId,
  viewport,
  rovingEditor,
  hasChildren,
  anyBlockHasChildren,
  isCollapsed,
  isAnimating,
  siblingAria,
  properties,
}: SortableBlockWrapperProps): React.ReactElement {
  const isFocused = focusedBlockId === block.id
  // Show projected depth during drag for the active item's over target
  const projectedDepth =
    projected && activeId && overId === block.id ? projected.depth : block.depth

  // Per-id memoized ref callback — same function identity across
  // renders for a given block.id, and unobserves the exact element
  // on unmount (BUG-29).
  const observeRef = viewport.createObserveRef(block.id)

  // Focused block is never virtualized — always render fully
  if (!isFocused && viewport.isOffscreen(block.id)) {
    return (
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-level is valid on listitem per WAI-ARIA spec
      <li
        ref={observeRef}
        data-block-id={block.id}
        aria-level={block.depth + 1}
        aria-setsize={siblingAria?.setsize}
        aria-posinset={siblingAria?.posinset}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        className="block-placeholder list-none m-0 p-0"
        style={{ minHeight: viewport.getHeight(block.id) }}
      />
    )
  }

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-level is valid on listitem per WAI-ARIA spec
    <li
      ref={observeRef}
      data-block-id={block.id}
      aria-level={block.depth + 1}
      aria-setsize={siblingAria?.setsize}
      aria-posinset={siblingAria?.posinset}
      aria-expanded={hasChildren ? !isCollapsed : undefined}
      className={cn('list-none m-0 p-0', isAnimating && 'block-children-enter')}
    >
      {/* Drop indicator: shows where the dragged block will land */}
      {projected && overId === block.id && activeId !== block.id && (
        <div
          className="drop-indicator h-[5px] bg-primary rounded-full ring-2 ring-primary/20"
          style={{ marginLeft: `calc(var(--indent-width) * ${projected.depth})` }}
        />
      )}
      <SortableBlock
        blockId={block.id}
        content={block.content ?? ''}
        isFocused={isFocused}
        depth={block.id === activeId ? projectedDepth : block.depth}
        rovingEditor={rovingEditor}
        hasChildren={hasChildren}
        anyBlockHasChildren={anyBlockHasChildren}
        isCollapsed={isCollapsed}
        todoState={block.todo_state ?? null}
        priority={block.priority ?? null}
        dueDate={block.due_date ?? null}
        scheduledDate={block.scheduled_date ?? null}
        properties={properties}
        isSelected={isSelected}
      />
    </li>
  )
}
