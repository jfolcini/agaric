/**
 * ProseMirror JSON node builders — test-only helpers.
 *
 * Originally lived in `src/editor/types.ts`; moved here so the production
 * type module stays focused on type declarations. The single production
 * consumer (`pmEndOfFirstBlock`) remains in `types.ts`.
 */

import type {
  BlockLevelNode,
  BlockLinkNode,
  BlockquoteNode,
  CodeBlockNode,
  DocNode,
  HardBreakNode,
  HeadingNode,
  HorizontalRuleNode,
  InlineNode,
  ListItemNode,
  OrderedListNode,
  ParagraphNode,
  PMMark,
  TableCellNode,
  TableHeaderNode,
  TableNode,
  TableRowNode,
  TagRefNode,
  TextNode,
} from '../types'

export function text(t: string, marks?: readonly PMMark[]): TextNode {
  const node: TextNode = { type: 'text', text: t }
  if (marks && marks.length > 0) {
    return { ...node, marks }
  }
  return node
}

export function bold(t: string): TextNode {
  return text(t, [{ type: 'bold' }])
}

export function italic(t: string): TextNode {
  return text(t, [{ type: 'italic' }])
}

export function code(t: string): TextNode {
  return text(t, [{ type: 'code' }])
}

export function strike(t: string): TextNode {
  return text(t, [{ type: 'strike' }])
}

export function highlight(t: string): TextNode {
  return text(t, [{ type: 'highlight' }])
}

export function boldItalic(t: string): TextNode {
  return text(t, [{ type: 'bold' }, { type: 'italic' }])
}

export function tagRef(id: string): TagRefNode {
  return { type: 'tag_ref', attrs: { id } }
}

export function blockLink(id: string): BlockLinkNode {
  return { type: 'block_link', attrs: { id } }
}

export function hardBreak(): HardBreakNode {
  return { type: 'hardBreak' }
}

export function paragraph(...nodes: InlineNode[]): ParagraphNode {
  if (nodes.length === 0) return { type: 'paragraph' }
  return { type: 'paragraph', content: nodes }
}

export function heading(level: number, ...nodes: InlineNode[]): HeadingNode {
  if (nodes.length === 0) return { type: 'heading', attrs: { level } }
  return { type: 'heading', attrs: { level }, content: nodes }
}

export function codeBlock(code: string, language?: string): CodeBlockNode {
  const attrs = language ? { language } : undefined
  if (code.length === 0) {
    return attrs ? { type: 'codeBlock', attrs } : { type: 'codeBlock' }
  }
  return attrs
    ? { type: 'codeBlock', attrs, content: [{ type: 'text', text: code }] }
    : { type: 'codeBlock', content: [{ type: 'text', text: code }] }
}

export function blockquote(...blocks: BlockLevelNode[]): BlockquoteNode {
  if (blocks.length === 0) return { type: 'blockquote' }
  return { type: 'blockquote', content: blocks }
}

export function callout(calloutType: string, ...blocks: BlockLevelNode[]): BlockquoteNode {
  if (blocks.length === 0) return { type: 'blockquote', attrs: { calloutType } }
  return { type: 'blockquote', attrs: { calloutType }, content: blocks }
}

export function table(...rows: TableRowNode[]): TableNode {
  if (rows.length === 0) return { type: 'table' }
  return { type: 'table', content: rows }
}

export function tableRow(...cells: (TableCellNode | TableHeaderNode)[]): TableRowNode {
  if (cells.length === 0) return { type: 'tableRow' }
  return { type: 'tableRow', content: cells }
}

export function tableHeader(...paragraphs: ParagraphNode[]): TableHeaderNode {
  if (paragraphs.length === 0) return { type: 'tableHeader' }
  return { type: 'tableHeader', content: paragraphs }
}

export function tableCell(...paragraphs: ParagraphNode[]): TableCellNode {
  if (paragraphs.length === 0) return { type: 'tableCell' }
  return { type: 'tableCell', content: paragraphs }
}

export function doc(...blocks: BlockLevelNode[]): DocNode {
  if (blocks.length === 0) return { type: 'doc' }
  return { type: 'doc', content: blocks }
}

export function listItem(...paragraphs: ParagraphNode[]): ListItemNode {
  if (paragraphs.length === 0) return { type: 'listItem' }
  return { type: 'listItem', content: paragraphs }
}

export function orderedList(...items: ListItemNode[]): OrderedListNode {
  if (items.length === 0) return { type: 'orderedList' }
  return { type: 'orderedList', content: items }
}

export function horizontalRule(): HorizontalRuleNode {
  return { type: 'horizontalRule' }
}
