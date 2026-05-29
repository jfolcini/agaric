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
}

export function BlockDndOverlay({
  activeBlock,
  projected,
  activeId,
}: BlockDndOverlayProps): React.ReactElement {
  return (
    <>
      {/* SR announcement for DnD projected drop position */}
      {activeId &&
        projected && (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- intentional SR-only live region (aria-live/atomic); native <output> has implicit aria-live differences and an "Output" semantic role
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {`Moving to depth ${projected.depth}`}
          </div>
        )}
      {/* Drag overlay: tiny pill follows the cursor. No content so the
          user can see the list reflow underneath as the drop projection
          changes. */}
      <DragOverlay dropAnimation={null}>
        {activeBlock ? (
          <div
            className="sortable-block-overlay h-1.5 w-20 rounded-full bg-primary/70 shadow-sm pointer-events-none"
            data-testid="sortable-block-overlay"
            aria-hidden="true"
          />
        ) : null}
      </DragOverlay>
    </>
  )
}
