/**
 * BlockDndOverlay — drag overlay preview for the active dragged block.
 *
 * Renders:
 *   - An SR-only live region announcing the projected drop depth
 *   - A floating preview card of the dragged block content
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
      {activeId && projected && (
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {`Moving to depth ${projected.depth}`}
        </div>
      )}
      {/* Drag overlay: floating preview of the dragged block */}
      <DragOverlay dropAnimation={null}>
        {activeBlock ? (
          <div
            className="sortable-block-overlay rounded border bg-background/90 px-3 py-1.5 shadow-lg text-sm opacity-80"
            style={{ maxWidth: 320 }}
          >
            {(activeBlock.content ?? '').slice(0, 80) || 'Empty block'}
          </div>
        ) : null}
      </DragOverlay>
    </>
  )
}
