import type React from 'react'

import type { BulletListNode, OrderedListNode, ParagraphNode } from '../../../editor/types'
import type { RenderContext } from '../context'
import { renderInlineContent } from './inline'

/**
 * Render an orderedList node as an ordered list. Each item's leading paragraph
 * is flattened into the `<li>`; nested `bulletList`/`orderedList` children
 * (created by Tab/sinkListItem, #1513) are rendered as a sublist inside the
 * `<li>` via the `renderNestedList` dispatcher (passed in to avoid an import
 * cycle with block.tsx).
 */
export function renderOrderedListBlock(
  block: OrderedListNode,
  key: string,
  ctx: RenderContext,
  renderNestedList?: (
    list: OrderedListNode | BulletListNode,
    key: string,
    ctx: RenderContext,
  ) => React.ReactNode,
): React.ReactElement {
  const content = block.content ?? []
  const items: React.ReactNode[] = []
  for (let i = 0; i < content.length; i++) {
    const item = content[i]
    const itemKey = `${key}-${i}`
    const liChildren: React.ReactNode[] = []
    const children = item?.content ?? []
    for (let j = 0; j < children.length; j++) {
      const child = children[j]
      if (child?.type === 'orderedList' || child?.type === 'bulletList') {
        if (renderNestedList) liChildren.push(renderNestedList(child, `${itemKey}-${j}`, ctx))
        continue
      }
      const p = child as ParagraphNode | undefined
      if (p?.content) {
        liChildren.push(...renderInlineContent(p.content, `${itemKey}-${j}`, ctx))
      }
    }
    items.push(<li key={itemKey}>{liChildren}</li>)
  }
  return (
    <ol key={key} className="list-decimal list-inside">
      {items}
    </ol>
  )
}
