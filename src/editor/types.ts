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

export interface UnderlineMark {
  readonly type: 'underline'
}

export interface LinkMark {
  readonly type: 'link'
  readonly attrs: { readonly href: string }
}

export type PMMark =
  | BoldMark
  | ItalicMark
  | CodeMark
  | StrikeMark
  | HighlightMark
  | UnderlineMark
  | LinkMark

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

/**
 * Inline math (#1437): a `$…$` span rendered via KaTeX. The LaTeX source is
 * stored verbatim in `attrs.latex` and serializes back to `$…$`. Atomic inline
 * node (the LaTeX is never directly editable as inline text — it is edited
 * through the node view's raw-source affordance).
 */
export interface MathInlineNode {
  readonly type: 'math_inline'
  readonly attrs: { readonly latex: string }
}

/**
 * Image (#1434): a markdown `![alt](url)` image. An atomic INLINE node whose
 * `attrs.alt` holds the alt text and `attrs.src` the image URL. Serializes back
 * to `![alt](url)` (loss-free, escaping `]` in alt and unbalanced parens in the
 * URL exactly as the link serializer does). The leading `!` is what
 * distinguishes it from a `[text](url)` link on parse.
 *
 * SCOPE (#1434 slice): markdown round-trip + render only. Binary image paste /
 * drag-drop → attachment and attachment-ref ↔ export-path resolution are
 * explicit FOLLOW-UPs handled elsewhere; `src` is treated as an opaque URL here.
 */
export interface ImageNode {
  readonly type: 'image'
  readonly attrs: { readonly alt: string; readonly src: string }
}

/**
 * Block (display) math (#1437): a `$$…$$` fenced block rendered via KaTeX in
 * display mode. The LaTeX source is stored verbatim in `attrs.latex` and
 * serializes back to a `$$…$$` fence.
 */
export interface MathBlockNode {
  readonly type: 'math_block'
  readonly attrs: { readonly latex: string }
  /** Math blocks are atomic — never any child content (mirrors HorizontalRuleNode). */
  readonly content?: undefined
}

/**
 * Task state carried on a paragraph block so a GFM task list item
 * (`- [ ]` / `- [x]`) round-trips through markdown (#1435).
 *
 * The app's fixed cycle is TODO → DOING → DONE → CANCELLED. GFM only has
 * checked/unchecked, so the two non-binary states use the de-facto
 * extension markers popularised by the Obsidian Tasks plugin:
 *   - TODO      → `- [ ]`
 *   - DOING     → `- [/]`  (in progress)
 *   - DONE      → `- [x]`
 *   - CANCELLED → `- [-]`
 * `[x]` and `[ ]` stay standard GFM; `[/]` and `[-]` degrade gracefully to
 * an unchecked box in viewers that don't understand them.
 */
export type TodoState = 'TODO' | 'DOING' | 'DONE' | 'CANCELLED'

export interface ParagraphNode {
  readonly type: 'paragraph'
  readonly content?: readonly InlineNode[]
  /** Present iff this paragraph is a task block; carries the GFM checkbox state. */
  readonly attrs?: { readonly todoState: TodoState }
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

export type InlineNode =
  | TextNode
  | TagRefNode
  | BlockLinkNode
  | BlockRefNode
  | HardBreakNode
  | MathInlineNode
  | ImageNode

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

/**
 * A list item holds a leading paragraph followed by any block-level content —
 * the TipTap `ListItem` schema is `paragraph block*`, so beyond nested
 * `bulletList`/`orderedList` children (the structure `Tab`/`sinkListItem`
 * produces) an item can also carry a `codeBlock`, `heading`, `blockquote`,
 * `table`, `math_block` or `horizontalRule` (toggle a code block with the caret
 * in an item, or paste HTML). The serializer and parser preserve this nesting
 * so indented list content round-trips without loss (#1513, #2213).
 */
export interface ListItemNode {
  readonly type: 'listItem'
  readonly content?: readonly BlockLevelNode[]
}

export interface OrderedListNode {
  readonly type: 'orderedList'
  readonly content?: readonly ListItemNode[]
}

export interface BulletListNode {
  readonly type: 'bulletList'
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
  | BulletListNode
  | HorizontalRuleNode
  | MathBlockNode

export interface DocNode {
  readonly type: 'doc'
  readonly content?: readonly BlockLevelNode[]
}

// -- PM position helpers ------------------------------------------------------

type PMPositionNode =
  | BlockLevelNode
  | ListItemNode
  | TableRowNode
  | TableCellNode
  | TableHeaderNode
  | InlineNode

function pmContentSize(content: readonly PMPositionNode[] | undefined): number {
  return content?.reduce((size, child) => size + pmNodeSize(child), 0) ?? 0
}

/** Text contributes its length, leaf atoms one position, and containers two tags. */
function pmNodeSize(node: PMPositionNode): number {
  switch (node.type) {
    case 'text': {
      return node.text.length
    }
    case 'tag_ref':
    case 'block_link':
    case 'block_ref':
    case 'hardBreak':
    case 'math_inline':
    case 'image':
    case 'horizontalRule':
    case 'math_block': {
      return 1
    }
    default: {
      return 2 + pmContentSize(node.content)
    }
  }
}

function pmRightmostTextblockEnd(node: PMPositionNode, start: number): number | undefined {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'codeBlock': {
      return start + 1 + pmContentSize(node.content)
    }
    case 'tag_ref':
    case 'block_link':
    case 'block_ref':
    case 'hardBreak':
    case 'math_inline':
    case 'image':
    case 'text':
    case 'horizontalRule':
    case 'math_block': {
      return undefined
    }
    default: {
      let childStart = start + 1
      let rightmost: number | undefined
      for (const child of node.content ?? []) {
        rightmost = pmRightmostTextblockEnd(child, childStart) ?? rightmost
        childStart += pmNodeSize(child)
      }
      return rightmost
    }
  }
}

/**
 * Compute the ProseMirror cursor position at the end of the rightmost textblock
 * within the first block of a DocNode. Used to position the cursor at the join
 * point after merging two blocks.
 *
 * PM positions count one position for every open wrapper/textblock tag, text
 * length for text nodes, and one for inline atoms such as tag_ref, block_link,
 * and hardBreak. Closed wrapper tags affect sibling starts through `nodeSize`,
 * but the returned position stays inside the final textblock so it is a valid
 * text selection.
 */
export function pmEndOfFirstBlock(doc: DocNode): number {
  const block = doc.content?.[0]
  if (!block) return 1
  return pmRightmostTextblockEnd(block, 0) ?? 1
}
