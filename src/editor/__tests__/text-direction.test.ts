import type { EditorView } from '@tiptap/pm/view'
import { describe, expect, it } from 'vitest'

import { isRtlAt } from '@/editor/text-direction'

/** A view whose `domAtPos` lands on `node`, all `isRtlAt` reads of it. */
function viewAt(node: Node): EditorView {
  return { domAtPos: () => ({ node, offset: 0 }) } as unknown as EditorView
}

function paragraph(direction: string): HTMLElement {
  const p = document.createElement('p')
  p.style.direction = direction
  p.textContent = 'text'
  document.body.append(p)
  return p
}

describe('isRtlAt (#7040)', () => {
  it('reads right to left from the element holding the text at the position', () => {
    expect(isRtlAt(viewAt(paragraph('rtl').firstChild as Node), 1)).toBe(true)
    expect(isRtlAt(viewAt(paragraph('rtl')), 1)).toBe(true)
  })

  it('reads left to right otherwise, and for a node outside any element', () => {
    expect(isRtlAt(viewAt(paragraph('ltr').firstChild as Node), 1)).toBe(false)
    expect(isRtlAt(viewAt(document.createTextNode('loose')), 1)).toBe(false)
  })
})
