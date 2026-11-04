/**
 * ModeSwap — hands a page over from block mode's tree to page mode (#5691) with no frame showing
 * neither, for `PageEditor` and `DayPageEditor`. No TipTap here: page mode's `PageModeSlot` loads it.
 */

import type React from 'react'
import { createContext, useCallback, useRef, useState } from 'react'

/** `ModeSwap`'s word that page mode shows the page, read by `PageModeSlot`; nothing outside one. */
export const ShownContext = createContext<(() => void) | undefined>(undefined)

/**
 * Block mode's tree, or page mode once it is wanted. Page mode reads the page and builds its
 * editor before it can draw, so the tree stays on screen over it, inert and as tall as it was,
 * until page mode has drawn: a switch never shows a skeleton or loses the scroll to one. The tree
 * goes as page mode shows, never later: block mode's editor sweeps every picker popup as it
 * unmounts, page mode's included.
 * Back to block mode is at once: the tree draws from the page store, already loaded.
 */
export function ModeSwap({
  pageId,
  pageMode,
  page,
  blocks,
}: {
  pageId: string
  pageMode: boolean
  /** Page mode's `PageModeSlot`. */
  page: React.ReactNode
  blocks: React.ReactNode
}): React.ReactElement {
  const [held, setHeld] = useState(false)
  const [was, setWas] = useState({ pageId, pageMode })
  if (was.pageId !== pageId || was.pageMode !== pageMode) {
    setWas({ pageId, pageMode })
    // Another page opens as it opens, with no tree of its own drawn yet to hold.
    setHeld(pageMode && was.pageId === pageId)
  }
  const frame = useRef<HTMLDivElement>(null)
  // As the tree leaves the flow, what is below it stays put.
  const hold = useCallback((el: HTMLDivElement | null) => {
    if (frame.current !== null)
      frame.current.style.minHeight = el === null ? '' : `${el.offsetHeight}px`
  }, [])
  const onShown = useCallback(() => setHeld(false), [])
  const holding = pageMode && held
  return (
    <div ref={frame} className="relative" data-testid="mode-swap">
      {(!pageMode || holding) && (
        <div
          ref={holding ? hold : undefined}
          className={holding ? 'absolute inset-x-0 top-0 z-10' : undefined}
          inert={holding || undefined}
          aria-hidden={holding || undefined}
          data-testid={holding ? 'mode-swap-outgoing' : undefined}
        >
          {blocks}
        </div>
      )}
      {pageMode && (
        // Transparent, not hidden: page mode takes its caret while the tree still covers it.
        <div
          className={holding ? 'opacity-0' : undefined}
          data-testid={holding ? 'mode-swap-incoming' : undefined}
        >
          <ShownContext value={onShown}>{page}</ShownContext>
        </div>
      )}
    </div>
  )
}
