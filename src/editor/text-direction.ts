import type { EditorView } from '@tiptap/pm/view'

/**
 * The text at `pos` runs right to left, as its block's `dir="auto"` resolved it
 * (#7040). The horizontal arrows then point the other way through it.
 */
export function isRtlAt(view: EditorView, pos: number): boolean {
  const { node } = view.domAtPos(pos)
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return element !== null && getComputedStyle(element).direction === 'rtl'
}
