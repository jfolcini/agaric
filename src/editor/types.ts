/**
 * Standalone ProseMirror JSON types for the agaric content format.
 *
 * These are structurally compatible with TipTap's JSONContent but defined
 * locally so the serializer has zero runtime dependencies. TipTap extensions
 * can import these same types for consistency.
 */

// -- Mark types ---------------------------------------------------------------

export interface BoldMark {
  readonly type: 'bold'
}

export interface ItalicMark {
  readonly type: 'italic'
}

export interface CodeMark {
  readonly type: 'code'
}

export interface StrikeMark {
  readonly type: 'strike'
}

export interface HighlightMark {
  readonly type: 'highlight'
}

export interface LinkMark {
  readonly type: 'link'
  readonly attrs: { readonly href: string }
}

export type PMMark = BoldMark | ItalicMark | CodeMark | StrikeMark | HighlightMark | LinkMark

// -- Node types ---------------------------------------------------------------

export interface TextNode {
  readonly type: 'text'
  readonly text: string
  readonly marks?: readonly PMMark[]
}

export interface TagRefNode {
  readonly type: 'tag_ref'
  readonly attrs: { readonly id: string }
}

export interface BlockLinkNode {
  readonly type: 'block_link'
  readonly attrs: { readonly id: string }
}

export interface BlockRefNode {
  readonly type: 'block_ref'
  readonly attrs: { readonly id: string }
}

export interface HardBreakNode {
  readonly type: 'hardBreak'
}

export interface ParagraphNode {
  readonly type: 'paragraph'
  readonly content?: readonly InlineNode[]
}

export interface HeadingNode {
  readonly type: 'heading'
  readonly attrs: { readonly level: number }
  readonly content?: readonly InlineNode[]
}

export interface CodeBlockNode {
  readonly type: 'codeBlock'
  readonly attrs?: { readonly language: string | null }
  readonly content?: readonly [TextNode]
}

export interface BlockquoteNode {
  readonly type: 'blockquote'
  readonly attrs?: { readonly calloutType?: string }
  readonly content?: readonly BlockLevelNode[]
}

export type InlineNode = TextNode | TagRefNode | BlockLinkNode | BlockRefNode | HardBreakNode

export interface TableCellNode {
  readonly type: 'tableCell'
  readonly content?: readonly ParagraphNode[]
}

export interface TableHeaderNode {
  readonly type: 'tableHeader'
  readonly content?: readonly ParagraphNode[]
}

export interface TableRowNode {
  readonly type: 'tableRow'
  readonly content?: readonly (TableCellNode | TableHeaderNode)[]
}

export interface TableNode {
  readonly type: 'table'
  readonly content?: readonly TableRowNode[]
}

export interface ListItemNode {
  readonly type: 'listItem'
  readonly content?: readonly ParagraphNode[]
}

export interface OrderedListNode {
  readonly type: 'orderedList'
  readonly content?: readonly ListItemNode[]
}

export interface HorizontalRuleNode {
  readonly type: 'horizontalRule'
  readonly content?: undefined
}

export type BlockLevelNode =
  | ParagraphNode
  | HeadingNode
  | CodeBlockNode
  | BlockquoteNode
  | TableNode
  | OrderedListNode
  | HorizontalRuleNode

export interface DocNode {
  readonly type: 'doc'
  readonly content?: readonly BlockLevelNode[]
}

// -- PM position helpers ------------------------------------------------------

/**
 * Compute the ProseMirror cursor position at the end of the first
 * paragraph/heading in a DocNode.  Used to position the cursor at the
 * join point after merging two blocks.
 *
 * PM positions: 0=before doc, 1=paragraph open, 1+n=after n inline
 * positions (text.length for text nodes, 1 for atom nodes like
 * tag_ref / block_link / hardBreak).
 */
export function pmEndOfFirstBlock(doc: DocNode): number {
  const block = doc.content?.[0]
  if (!block) return 1
  if (block.type === 'codeBlock') {
    return 1 + (block.content?.[0]?.text.length ?? 0)
  }
  if (!block.content) return 1
  let pos = 1 // paragraph/heading open tag
  for (const node of block.content) {
    pos += node.type === 'text' ? node.text.length : 1
  }
  return pos
}
