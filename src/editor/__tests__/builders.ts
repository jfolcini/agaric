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
  BlockRefNode,
  BulletListNode,
  CodeBlockNode,
  DocNode,
  HardBreakNode,
  HeadingNode,
  HorizontalRuleNode,
  InlineNode,
  ListItemNode,
  MathInlineNode,
  OrderedListNode,
  ParagraphNode,
  PMMark,
  TableCellNode,
  TableHeaderNode,
  TableNode,
  TableRowNode,
  TagRefNode,
  TextNode,
  TodoState,
} from '@/editor/types'

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

export function underline(t: string): TextNode {
  return text(t, [{ type: 'underline' }])
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

export function blockRef(id: string): BlockRefNode {
  return { type: 'block_ref', attrs: { id } }
}

export function mathInline(latex: string): MathInlineNode {
  return { type: 'math_inline', attrs: { latex } }
}

export function paragraph(...nodes: InlineNode[]): ParagraphNode {
  if (nodes.length === 0) return { type: 'paragraph' }
  return { type: 'paragraph', content: nodes }
}

/** A task paragraph carrying a GFM checkbox `todoState` (#1435). */
export function task(todoState: TodoState, ...nodes: InlineNode[]): ParagraphNode {
  if (nodes.length === 0) return { type: 'paragraph', attrs: { todoState } }
  return { type: 'paragraph', attrs: { todoState }, content: nodes }
}

export function heading(level: number, ...nodes: InlineNode[]): HeadingNode {
  if (nodes.length === 0) return { type: 'heading', attrs: { level } }
  return { type: 'heading', attrs: { level }, content: nodes }
}

export function codeBlock(source: string, language?: string): CodeBlockNode {
  const attrs = language ? { language } : undefined
  if (source.length === 0) {
    return attrs ? { type: 'codeBlock', attrs } : { type: 'codeBlock' }
  }
  return attrs
    ? { type: 'codeBlock', attrs, content: [{ type: 'text', text: source }] }
    : { type: 'codeBlock', content: [{ type: 'text', text: source }] }
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

export function listItem(...children: BlockLevelNode[]): ListItemNode {
  if (children.length === 0) return { type: 'listItem' }
  return { type: 'listItem', content: children }
}

export function orderedList(...items: ListItemNode[]): OrderedListNode {
  if (items.length === 0) return { type: 'orderedList' }
  return { type: 'orderedList', content: items }
}

export function bulletList(...items: ListItemNode[]): BulletListNode {
  if (items.length === 0) return { type: 'bulletList' }
  return { type: 'bulletList', content: items }
}

export function horizontalRule(): HorizontalRuleNode {
  return { type: 'horizontalRule' }
}

/**
 * Every stored text-node string in a parsed doc, depth-first — the inverse of
 * the builders above, for asserting on what a parse actually STORED.
 *
 * Representation-independent by design: a `JSON.stringify(doc).includes('\\r')`
 * check tests the JSON ENCODING, where the two characters `\` + `r` are also
 * how a literal backslash followed by the letter `r` in document text encodes,
 * so it silently stops discriminating the moment a generator's alphabet gains a
 * backslash. Walking the nodes compares the real characters.
 */
export function allStoredText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => allStoredText(v))
  if (value === null || typeof value !== 'object') return []
  const node = value as { type?: string; text?: string; content?: unknown; attrs?: unknown }
  const own = typeof node.text === 'string' ? [node.text] : []
  return [...own, ...allStoredText(node.content), ...allStoredText(node.attrs)]
}
