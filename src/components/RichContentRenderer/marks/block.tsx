import type React from 'react'

import type {
  BlockLevelNode,
  BulletListNode,
  ListItemNode,
  ParagraphNode,
  TableNode,
} from '../../../editor/types'
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
 * Render a bulletList node as an unordered list. Mirrors
 * `renderOrderedListBlock`, flattening each list item's paragraphs into the
 * `<li>`. Without this, a bulletList would fall through `renderBlock`'s
 * default case and render nothing at-rest (#1512).
 */
export function renderBulletListBlock(
  block: BulletListNode,
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
    <ul key={key} className="list-disc list-inside">
      {items}
    </ul>
  )
}

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
      return renderBlockquoteBlock(block, key, ctx, renderBlock)
    case 'orderedList':
      return renderOrderedListBlock(block, key, ctx)
    case 'bulletList':
      return renderBulletListBlock(block, key, ctx)
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

/**
 * Flatten a list of `listItem`s into inline nodes for preview/inline mode.
 * Each item's paragraph inline content is emitted, items separated by a
 * single space so they don't visually run together in a one-line preview.
 */
function renderListItemsInline(
  items: readonly ListItemNode[],
  key: string,
  ctx: RenderContext,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out.push(<span key={`${key}-isep-${i}`}> </span>)
    const paragraphs = items[i]?.content ?? []
    for (let j = 0; j < paragraphs.length; j++) {
      const p = paragraphs[j] as ParagraphNode | undefined
      if (p?.content) out.push(...renderInlineContent(p.content, `${key}-${i}-${j}`, ctx))
    }
  }
  return out
}

/** Flatten a table's cell text into inline nodes, cells separated by a space. */
function renderTableInline(block: TableNode, key: string, ctx: RenderContext): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const rows = block.content ?? []
  let cellCount = 0
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r]?.content ?? []
    for (let c = 0; c < cells.length; c++) {
      if (cellCount > 0) out.push(<span key={`${key}-csep-${r}-${c}`}> </span>)
      cellCount++
      const paragraphs = cells[c]?.content ?? []
      for (let p = 0; p < paragraphs.length; p++) {
        const para = paragraphs[p] as ParagraphNode | undefined
        if (para?.content)
          out.push(...renderInlineContent(para.content, `${key}-${r}-${c}-${p}`, ctx))
      }
    }
  }
  return out
}

/**
 * Inline (preview-only) variant of {@link renderBlock}. Returns ONLY inline
 * nodes (text, spans, inline marks) — never block-level elements such as
 * <h*>, <ol>/<ul>, <table>, <pre>, <blockquote> or <div>. This is what the
 * one-line history/diff previews use so their inline wrappers (a clamping
 * <span> or a <p>) stay valid DOM and can actually clamp (#1533). Block
 * structure (heading level, list markers, table grid, code styling) is
 * intentionally dropped — only the readable text survives, which is all a
 * truncated preview shows anyway. The at-rest full-document path keeps using
 * {@link renderBlock}.
 */
export function renderBlockInline(
  block: BlockLevelNode,
  key: string,
  ctx: RenderContext,
): React.ReactNode[] {
  switch (block.type) {
    case 'paragraph':
      return block.content ? renderInlineContent(block.content, key, ctx) : []
    case 'heading':
      return block.content ? renderInlineContent(block.content, key, ctx) : []
    case 'codeBlock': {
      const code = block.content?.[0]?.text ?? ''
      return code ? [<code key={key}>{code}</code>] : []
    }
    case 'blockquote': {
      const out: React.ReactNode[] = []
      const children = block.content ?? []
      for (let i = 0; i < children.length; i++) {
        if (i > 0) out.push(<span key={`${key}-bqsep-${i}`}> </span>)
        out.push(...renderBlockInline(children[i] as BlockLevelNode, `${key}-${i}`, ctx))
      }
      return out
    }
    case 'orderedList':
      return renderListItemsInline(block.content ?? [], key, ctx)
    case 'bulletList':
      return renderListItemsInline(block.content ?? [], key, ctx)
    case 'table':
      return renderTableInline(block, key, ctx)
    case 'math_block': {
      const latex = block.attrs?.latex ?? ''
      return latex ? [<span key={key}>{latex}</span>] : []
    }
    case 'horizontalRule':
      return []
    default:
      return []
  }
}
