/**
 * The view's one formatting toolbar (#6562). The focused block's editor surface
 * publishes its bar here, and `ViewToolbarSlot`, which the view owns, renders
 * it pinned under the view header, over the scroller's top padding. The bar
 * neither lives in the block's row nor takes layout space, so focusing a
 * block, moving between blocks and leaving the editor move no text. It stays
 * one mounted bar while the focus moves between blocks, as the slot renders
 * the same component in the same place, and it goes once no block is edited.
 *
 * This module imports no TipTap: the bar arrives as an element.
 */

import type React from 'react'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'

let bar: React.ReactElement | null = null
let owner: object | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Show `next` as the view's toolbar while the calling surface is mounted. */
export function useViewToolbar(next: React.ReactElement): void {
  const [token] = useState(() => ({}))
  useLayoutEffect(() => {
    bar = next
    owner = token
    emit()
  })
  useLayoutEffect(
    () => () => {
      // A surface that mounted in the meantime owns the bar now.
      if (owner !== token) return
      bar = null
      owner = null
      emit()
    },
    [token],
  )
}

export function ViewToolbarSlot(): React.ReactElement | null {
  const shown = useSyncExternalStore(subscribe, () => bar)
  if (shown === null) return null
  return (
    // Sticky offsets count from inside the scroller's padding, which the bar covers.
    // `data-view-toolbar`: the bar showing is no overlay holding the editor (`focusStaysInEditor`).
    <div className="sticky top-0 z-20 h-0" data-view-toolbar="">
      <div className="absolute -inset-x-4 -top-4 md:-inset-x-6 md:-top-6">{shown}</div>
    </div>
  )
}
