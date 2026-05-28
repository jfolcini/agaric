import type React from 'react'

import type { OrderedListNode, ParagraphNode } from '../../../editor/types'
import type { RenderContext } from '../context'
import { renderInlineContent } from './inline'

export function renderOrderedListBlock(
  block: OrderedListNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const content = block.content ?? []
  const items: React.ReactNode[] = []
  for (let i = 0; i < content.length; i++) {
    const item = content[i]
    const itemKey = `${key}-${i}`
    const liChildren: React.ReactNode[] = []
    const paragraphs = item?.content ?? []
    for (let j = 0; j < paragraphs.length; j++) {
      const p = paragraphs[j] as ParagraphNode | undefined
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
