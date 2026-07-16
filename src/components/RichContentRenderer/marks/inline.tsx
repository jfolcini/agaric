import type React from 'react'

import type { RenderContext } from '@/components/RichContentRenderer/context'
import { renderBlockLink } from '@/components/RichContentRenderer/marks/blockLink'
import { renderBlockRef } from '@/components/RichContentRenderer/marks/blockRef'
import { renderHardBreak } from '@/components/RichContentRenderer/marks/hardBreak'
import { renderImage } from '@/components/RichContentRenderer/marks/image'
import { renderMathInline } from '@/components/RichContentRenderer/marks/math'
import { renderTagRef } from '@/components/RichContentRenderer/marks/tagRef'
import { renderTextInline } from '@/components/RichContentRenderer/marks/text'
import type { InlineNode } from '@/editor/types'

/**
 * Dispatch an inline node (text / tag_ref / block_link / block_ref / hardBreak)
 * to its sub-renderer and return a single React element (or null).
 */
function renderInlineNode(
  node: InlineNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement | null {
  switch (node.type) {
    case 'text': {
      return renderTextInline(node, key, ctx)
    }
    case 'tag_ref': {
      return renderTagRef(node, key, ctx)
    }
    case 'block_link': {
      return renderBlockLink(node, key, ctx)
    }
    case 'block_ref': {
      return renderBlockRef(node, key, ctx)
    }
    case 'hardBreak': {
      return renderHardBreak(node, key)
    }
    case 'math_inline': {
      return renderMathInline(node, key)
    }
    case 'image': {
      return renderImage(node, key)
    }
    default: {
      return null
    }
  }
}

export function renderInlineContent(
  content: readonly InlineNode[],
  keyPrefix: string,
  ctx: RenderContext,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  for (let i = 0; i < content.length; i++) {
    const node = content[i] as InlineNode
    const el = renderInlineNode(node, `${keyPrefix}-${i}`, ctx)
    if (el !== null) out.push(el)
  }
  return out
}
