/**
 * Pointer-event drags for dnd-kit's PointerSensor in the test DOM. Every point
 * is the centre of an element's box when the helper runs, never a hand-picked
 * offset: near an edge, an auto-scrolling container (`useAutoScrollOnDrag`)
 * moves under the pointer and the drop misses.
 */
import { fireEvent } from '@testing-library/react'

/** dnd-kit's `{ distance: 8 }` activation: the first move must go past it. */
const ACTIVATION_PX = 20

function centreOf(el: Element): { clientX: number; clientY: number } {
  const { left, top, width, height } = el.getBoundingClientRect()
  return { clientX: left + width / 2, clientY: top + height / 2 }
}

/** Move the held pointer onto the centre of `target`. */
export function moveOver(target: Element): void {
  fireEvent.pointerMove(document, { ...centreOf(target), isPrimary: true })
}

/** Press `source`, pass the activation distance and carry it over `target`. */
export function dragToTarget(source: HTMLElement, target: Element): void {
  const at = centreOf(source)
  fireEvent.pointerDown(source, { ...at, isPrimary: true, button: 0 })
  fireEvent.pointerMove(document, { ...at, clientX: at.clientX + ACTIVATION_PX, isPrimary: true })
  moveOver(target)
}

export function releasePointer(): void {
  fireEvent.pointerUp(document, { isPrimary: true, button: 0 })
}
