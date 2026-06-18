import type React from 'react'

import type { BlockLevelNode } from '../../../editor/types'
import type { RenderContext } from '../context'
import { renderBlockquoteBlock } from './blockquote'
import { renderCodeBlock } from './code'
import { renderHeadingBlock } from './heading'
import { renderHorizontalRuleBlock } from './horizontalRule'
import { renderInlineContent } from './inline'
import { renderMathBlock } from './math'
import { renderOrderedListBlock } from './orderedList'
import { renderTableBlock } from './table'

/**
 * Dispatch a block-level node to its sub-renderer. Paragraphs return an
 * array of inline elements (no wrapping <p>) to preserve legacy behavior;
 * every other block type returns a single React element.
 */
export function renderBlock(
  block: BlockLevelNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement | React.ReactNode[] | null {
  switch (block.type) {
    case 'heading':
      return renderHeadingBlock(block, key, ctx)
    case 'codeBlock':
      return renderCodeBlock(block, key)
    case 'blockquote':
      return renderBlockquoteBlock(block, key, ctx)
    case 'orderedList':
      return renderOrderedListBlock(block, key, ctx)
    case 'horizontalRule':
      return renderHorizontalRuleBlock(key)
    case 'table':
      return renderTableBlock(block, key, ctx)
    case 'math_block':
      return renderMathBlock(block, key)
    case 'paragraph':
      return block.content ? renderInlineContent(block.content, key, ctx) : null
    default:
      return null
  }
}
