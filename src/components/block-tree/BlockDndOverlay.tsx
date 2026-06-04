/**
 * BlockDndOverlay — drag overlay marker for the active dragged block.
 *
 * Renders:
 *   - An SR-only live region announcing the projected drop depth
 *   - A small cursor-following pill (no content) so the list reflow
 *     underneath stays visible.
 *
 * Extracted from BlockTree.tsx for file organization (F-22).
 */

import { DragOverlay } from '@dnd-kit/core'
import type React from 'react'

interface BlockDndOverlayProps {
  activeBlock: { content?: string | null } | null
  projected: { depth: number } | null
  activeId: string | null
  /** Number of blocks being dragged (active block + its descendant subtree). */
  count?: number
}

export function BlockDndOverlay({
  activeBlock,
  projected,
  activeId,
  count = 1,
}: BlockDndOverlayProps): React.ReactElement {
  const isSubtree = count > 1
  return (
    <>
      {/* SR announcement for DnD projected drop position + subtree size */}
      {activeId &&
        projected && (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- intentional SR-only live region (aria-live/atomic); native <output> has implicit aria-live differences and an "Output" semantic role
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {isSubtree
              ? `Moving ${count} blocks to depth ${projected.depth}`
              : `Moving to depth ${projected.depth}`}
          </div>
        )}
      {/* Drag overlay: tiny pill follows the cursor. No content so the user can
          see the list reflow underneath as the drop projection changes. For a
          subtree drag we add a small count badge so the user knows how much is
          moving (R8 #407). */}
      <DragOverlay dropAnimation={null}>
        {activeBlock ? (
          <div
            className="sortable-block-overlay relative h-1.5 w-20 rounded-full bg-primary/70 shadow-sm pointer-events-none"
            data-testid="sortable-block-overlay"
            aria-hidden="true"
          >
            {isSubtree && (
              <span
                className="absolute -top-2 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground shadow"
                data-testid="sortable-block-overlay-count"
              >
                {count}
              </span>
            )}
          </div>
        ) : null}
      </DragOverlay>
    </>
  )
}
