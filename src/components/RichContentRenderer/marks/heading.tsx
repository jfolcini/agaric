import type React from 'react'

import { HEADING_CLASSES, type RenderContext } from '@/components/RichContentRenderer/context'
import { renderInlineContent } from '@/components/RichContentRenderer/marks/inline'
import type { HeadingNode } from '@/editor/types'

export function renderHeadingBlock(
  block: HeadingNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const HeadingTag = `h${block.attrs.level}` as keyof React.JSX.IntrinsicElements
  const cls = HEADING_CLASSES[block.attrs.level] ?? ''
  const inlined = block.content ? renderInlineContent(block.content, `${key}-i`, ctx) : []
  return (
    <HeadingTag key={key} className={cls}>
      {inlined}
    </HeadingTag>
  )
}
