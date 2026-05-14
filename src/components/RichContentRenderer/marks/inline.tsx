import type React from 'react'
import type { InlineNode } from '../../../editor/types'
import type { RenderContext } from '../context'
import { renderBlockLink } from './blockLink'
import { renderBlockRef } from './blockRef'
import { renderHardBreak } from './hardBreak'
import { renderTagRef } from './tagRef'
import { renderTextInline } from './text'

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
    case 'text':
      return renderTextInline(node, key, ctx)
    case 'tag_ref':
      return renderTagRef(node, key, ctx)
    case 'block_link':
      return renderBlockLink(node, key, ctx)
    case 'block_ref':
      return renderBlockRef(node, key, ctx)
    case 'hardBreak':
      return renderHardBreak(node, key)
    default:
      return null
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
