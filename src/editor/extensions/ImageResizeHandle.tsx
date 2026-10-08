/**
 * Resize handle on the editor's inline image (#4712).
 *
 * Drag the corner, or focus it and use the arrow keys (Shift for a bigger
 * step); a double-click or Home returns the image to its natural size. Each
 * gesture reports one width through `onCommit`, which `ImageNodeView` writes
 * into the alt as Obsidian's `|width` suffix. Only the focused block hosts the
 * editor (invariant 4), so the handle exists there alone; everywhere else the
 * image renders static at its stored width.
 *
 * It renders inside `GatedImage`'s wrapper, beside the `<img>` it measures.
 */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'

/** Narrowest width a resize sets; any smaller and the handle covers the image. */
const MIN_WIDTH = 32
const KEY_STEP = 10
const KEY_STEP_LARGE = 50

/** Arrow keys and the direction they move the width (WAI-ARIA slider pattern). */
const KEY_DIRECTION: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
}

function clampWidth(width: number): number {
  return Math.max(MIN_WIDTH, Math.round(width))
}

interface Drag {
  startX: number
  startWidth: number
}

function widthAt(clientX: number, drag: Drag): number {
  return clampWidth(drag.startWidth + clientX - drag.startX)
}

/** Keeps a touch on the handle from reaching the block row's swipe gestures,
 * whose leftward swipe deletes the block. */
function stopTouch(e: React.TouchEvent): void {
  e.stopPropagation()
}

export interface ImageResizeHandleProps {
  /** Accessible name; it names the image, so two handles in one block differ. */
  label: string
  /** The width to show while a drag is in flight; `null` ends the preview. */
  onPreview: (width: number | null) => void
  /** Persist a width in px, or `null` for the natural size. */
  onCommit: (width: number | null) => void
}

export function ImageResizeHandle({
  label,
  onPreview,
  onCommit,
}: ImageResizeHandleProps): React.ReactElement {
  const ref = useRef<HTMLSpanElement>(null)
  // The image's laid-out width is both the slider's value and where every
  // resize starts, so a stored width wider than the block resizes from what
  // the reader actually sees. No image lays out wider than the editor, so its
  // width is the slider's maximum: without one, ARIA's default of 100 clamps
  // the value a screen reader announces.
  const [range, setRange] = useState({ width: 0, max: 0 })
  const dragRef = useRef<Drag | null>(null)

  useEffect(() => {
    const img = ref.current?.parentElement?.querySelector('img')
    const editor = ref.current?.closest('[contenteditable="true"]')
    if (!img || !editor) return undefined
    const observer = new ResizeObserver(() =>
      setRange({ width: img.offsetWidth, max: editor.clientWidth }),
    )
    observer.observe(img)
    observer.observe(editor)
    return () => observer.disconnect()
  }, [])

  // Keys stay with the handle, away from the page's shortcuts; Tab still moves
  // focus by default. Escape never gets here: the block keyboard handler takes
  // it first, to leave editing.
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    const direction = KEY_DIRECTION[e.key]
    if (direction !== undefined) {
      e.preventDefault()
      const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP
      onCommit(clampWidth(range.width + direction * step))
    } else if (e.key === 'Home') {
      e.preventDefault()
      onCommit(null)
    }
  }

  const endDrag = (): Drag | null => {
    const drag = dragRef.current
    dragRef.current = null
    onPreview(null)
    return drag
  }

  return (
    <span
      ref={ref}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a corner grip that resizes by pointer delta and resets to the natural size on Home; a range input maps pointer position along a track and Home to its minimum
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={range.max}
      aria-valuenow={range.width}
      className="touch-target absolute right-0 bottom-0 flex cursor-nwse-resize touch-none items-end justify-end rounded-sm transition-opacity focus-ring-visible opacity-0 group-hover/image:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
      onPointerDown={(e) => {
        // Cancelling the press suppresses its mousedown, so the editor keeps
        // focus (a blur flushes the block, #1498) and ProseMirror neither
        // selects nor drags the image node.
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        dragRef.current = { startX: e.clientX, startWidth: range.width }
      }}
      onPointerMove={(e) => {
        if (dragRef.current !== null) onPreview(widthAt(e.clientX, dragRef.current))
      }}
      onPointerUp={(e) => {
        const drag = endDrag()
        if (drag !== null && e.clientX !== drag.startX) onCommit(widthAt(e.clientX, drag))
      }}
      onPointerCancel={endDrag}
      onTouchStart={stopTouch}
      onTouchMove={stopTouch}
      onTouchEnd={stopTouch}
      onDoubleClick={() => onCommit(null)}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className="size-3 rounded-sm border border-border bg-background shadow-sm"
      />
    </span>
  )
}
