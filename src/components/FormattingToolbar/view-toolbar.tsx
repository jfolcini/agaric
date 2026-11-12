/**
 * The view's one formatting toolbar (#6562). The focused block's editor surface
 * publishes its bar here, and `ViewToolbarSlot`, which the view owns, renders
 * it pinned under the view header, in room the view keeps for it. The bar
 * does not live in the block's row, so focusing a block, moving between
 * blocks and leaving the editor move no text. It stays
 * one mounted bar while the focus moves between blocks, as the slot renders
 * the same component in the same place, and it goes once no block is edited.
 *
 * This module imports no TipTap: the bar arrives as an element.
 */

import type React from 'react'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'

import { useIsTouch } from '@/hooks/useIsTouch'
import { cn } from '@/lib/utils'

interface ViewBar {
  bar: React.ReactElement
  /** Focus left the bar (or a menu it opened) for `related`. */
  onBlur: (related: Element | null) => void
}

let current: ViewBar | null = null
let owner: object | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Show `bar` as the view's toolbar while the calling surface is mounted. The bar
 * is outside the block, so its blur does not reach the block's: `onBlur` takes it.
 */
export function useViewToolbar(
  bar: React.ReactElement,
  onBlur: (related: Element | null) => void,
): void {
  const [token] = useState(() => ({}))
  useLayoutEffect(() => {
    current = { bar, onBlur }
    owner = token
    emit()
  })
  useLayoutEffect(
    () => () => {
      // A surface that mounted in the meantime owns the bar now.
      if (owner !== token) return
      current = null
      owner = null
      emit()
    },
    [token],
  )
}

/**
 * `room`: the view edits blocks, so the slot keeps the bar's room under the header
 * at all times (with the scroller's top padding, the bar's `h-7`), and showing the
 * bar moves nothing. The bar's buttons line up with the blocks' reading column.
 */
export function ViewToolbarSlot({ room }: { room: boolean }): React.ReactElement | null {
  const shown = useSyncExternalStore(subscribe, () => current)
  const isTouch = useIsTouch()
  const onBlur = (e: React.FocusEvent): void => shown?.onBlur(e.relatedTarget as Element | null)
  // The bar is outside the block: Tab goes back into the editor it heads, as when it was inside.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab' || e.shiftKey) return
    const id = (e.target as Element).closest('[role="toolbar"]')?.getAttribute('aria-controls')
    const text = id
      ? document.getElementById(id)?.querySelector<HTMLElement>('[contenteditable="true"]')
      : null
    if (!text) return
    e.preventDefault()
    text.focus()
  }
  // `data-view-toolbar`: the bar showing is no overlay holding the editor (`focusStaysInEditor`).
  // On touch the bar pins above the keyboard (`ToolbarFrame`) and needs no room here.
  if (isTouch) {
    return (
      shown && (
        // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the toolbar's focus and keys bubble here; the bar inside is the role="toolbar"
        <div data-view-toolbar="" onBlur={onBlur} onKeyDown={onKeyDown}>
          {shown.bar}
        </div>
      )
    )
  }
  return (
    // Sticky offsets count from inside the scroller's padding, which the bar covers.
    <div
      className={cn('pointer-events-none sticky top-0 z-20', room && 'h-3 md:h-1')}
      data-view-toolbar=""
    >
      {shown && (
        // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the toolbar's focus and keys bubble here; the bar inside is the role="toolbar"
        <div
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          className="pointer-events-auto absolute -inset-x-4 -top-4 h-7 border-b border-border/40 bg-background px-4 md:-inset-x-6 md:-top-6 md:px-6"
        >
          {shown.bar}
        </div>
      )}
    </div>
  )
}
