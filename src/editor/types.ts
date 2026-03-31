/**
 * Standalone ProseMirror JSON types for the block-notes content format.
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

export interface LinkMark {
  readonly type: 'link'
  readonly attrs: { readonly href: string }
}

export type PMMark = BoldMark | ItalicMark | CodeMark | LinkMark

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

export type InlineNode = TextNode | TagRefNode | BlockLinkNode | HardBreakNode

export type BlockLevelNode = ParagraphNode | HeadingNode | CodeBlockNode

export interface DocNode {
  readonly type: 'doc'
  readonly content?: readonly BlockLevelNode[]
}

export type PMNode = DocNode | BlockLevelNode | InlineNode

// -- Builder helpers (for tests + internal use) -------------------------------

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

export function doc(...blocks: BlockLevelNode[]): DocNode {
  if (blocks.length === 0) return { type: 'doc' }
  return { type: 'doc', content: blocks }
}
