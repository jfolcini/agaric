/**
 * Page mode's paste of Markdown text (#5691): text of more than one line, with
 * no HTML beside it, comes in as the blocks it reads as. It is read as block
 * mode's paste reads it (`parsePastedText`, the backend's
 * `import::parse_pasted_text`, #6190), so both modes make the same blocks from
 * the same text: each list item, paragraph, heading or fence is a block, a
 * nested item one deeper than its item, with its marks and links as marks; the
 * save creates them as it creates typed blocks. A `- x` or `* x` item is a
 * bulleted block and a `1. x` item a numbered one, the style written once the
 * block is saved, as a typed `- ` writes it (`page-lists.ts`); a `+ x` item is
 * a plain block. A task item keeps its checkbox as text, and a property line
 * stays a line of its block's text, each becoming its block's task state or
 * property once the caret has left it (`page-tasks.ts`, `page-properties.ts`).
 *
 * One line (but a list or task line where it starts a block, as block mode
 * reads them), lines with no Markdown in them, a plain-text paste (Shift), and
 * a paste into code, or into a list or a table in a block's content, keep
 * ProseMirror's own paste.
 */

import { Extension, type JSONContent } from '@tiptap/core'
import {
  Fragment,
  type Node as PMNode,
  type ResolvedPos,
  type Schema,
  Slice,
} from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorProps, EditorView } from '@tiptap/pm/view'

import { parse } from '@/editor/markdown-serializer'
import { depthOf, insideListOrTable, PAGE_BLOCK } from '@/editor/page-mode/page-document'
import type { PageListSource } from '@/editor/page-mode/page-lists'
import { type DocumentBlock, parsePastedText } from '@/editor/source-buffer-document'
import { blockIdOf, pasteKeepingIds } from '@/editor/token-ids'
import type { ListStyle } from '@/lib/list-style'
import { isTodoState, TASK_STATE_TO_MARKER } from '@/lib/task-states'

export interface PastedBlock {
  /** Below the block pasted into: 0 is its level. */
  depth: number
  content: JSONContent[]
  /** The style its list marker gives, written once the block is saved. */
  listStyle: ListStyle
}

/** A paragraph of text alone: no task, no mark, nothing but text and line breaks. */
function plainText(node: JSONContent): boolean {
  return (
    node.type === 'paragraph' &&
    !isTodoState(node.attrs?.['todoState']) &&
    (node.content ?? []).every(
      (child) => child.type === 'hardBreak' || (child.type === 'text' && !child.marks?.length),
    )
  )
}

/** `block` of `lines` as page mode holds a new one: its checkbox and property lines as text. */
function blockContent(block: DocumentBlock, lines: readonly string[]): JSONContent[] {
  const checkbox = block.todoState === null ? '' : `[${TASK_STATE_TO_MARKER[block.todoState]}] `
  const properties = block.propertyLines.map((line) => `\n${lines[line - 1]?.trimStart() ?? ''}`)
  return (parse(`${checkbox}${block.content}${properties.join('')}`).content ?? []) as JSONContent[]
}

/**
 * The blocks Markdown `text` reads as, in order; none when it holds no
 * Markdown, only lines of text, which ProseMirror's paste makes a block each.
 */
export function pastedBlocks(text: string): PastedBlock[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (((parse(normalized).content ?? []) as JSONContent[]).every(plainText)) return []
  const lines = normalized.split('\n')
  return parsePastedText(normalized).map((block) => ({
    depth: block.depth,
    content: blockContent(block, lines),
    listStyle: block.listStyle ?? 'none',
  }))
}

/** A list or task line with text, as block mode tells one: `-`, `*`, `+`, `1.` or `1)`. */
const LIST_LINE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/

/**
 * Text worth reading as blocks: more than one line holding something, or one
 * list line where it starts its block. After text it stays the text pasted,
 * where its item would drop the marker.
 */
function holdsLines(text: string, startsBlock: boolean): boolean {
  return (
    text.split(/\r\n?|\n/).filter((line) => line.trim() !== '').length > 1 ||
    (startsBlock && LIST_LINE.test(text))
  )
}

/** `blocks` as a slice of new blocks under `depth`. */
function blocksSlice(schema: Schema, blocks: readonly PastedBlock[], depth: number): Slice {
  const type = schema.nodes[PAGE_BLOCK]
  if (type === undefined) throw new Error(`the schema has no ${PAGE_BLOCK}`)
  const nodes = blocks.map((block) =>
    type.create(
      { blockId: null, depth: depth + block.depth },
      Fragment.fromJSON(schema, block.content),
    ),
  )
  return new Slice(Fragment.from(nodes), 0, 0)
}

/** A paste's blocks' styles, and whether it starts its block, which then takes the first one's. */
interface PastedStyles {
  styles: ListStyle[]
  atBlockStart: boolean
}

/** What `text`, pasted at `$context`, brings in; null leaves it to ProseMirror's own paste. */
function pastedSlice(
  text: string,
  $context: ResolvedPos,
  plain: boolean,
): { slice: Slice; styles: PastedStyles } | null {
  const atBlockStart = $context.depth >= 2 && $context.index(1) === 0 && $context.parentOffset === 0
  if (plain || !holdsLines(text, atBlockStart) || insideListOrTable($context)) return null
  const blocks = pastedBlocks(text)
  if (blocks.length === 0) return null
  const depth = $context.depth === 0 ? 0 : depthOf($context.node(1))
  return {
    slice: blocksSlice($context.doc.type.schema, blocks, depth),
    styles: { styles: blocks.map((block) => block.listStyle), atBlockStart },
  }
}

/** The ids of `doc`'s blocks, in order. */
function blockIds(doc: PMNode): string[] {
  const ids: string[] = []
  doc.forEach((node) => {
    const id = blockIdOf(node)
    if (id !== null) ids.push(id)
  })
  return ids
}

/**
 * Paste `slice` as the id rules paste blocks (`page-block-ids.ts`), then give
 * each block it landed as the style its item gave: the block the paste was in,
 * which the first joins, and the new ones after it, in order. The first only
 * when the paste starts its block, as block mode's anchor takes it only there.
 * A paste that landed as other than its blocks, over whole blocks, gives none.
 */
function pasteWithStyles(
  view: EditorView,
  slice: Slice,
  { styles, atBlockStart }: PastedStyles,
  setStyle: PageListSource['setStyle'],
): void {
  const { state } = view
  const { $from } = state.selection
  const anchor = $from.depth >= 1 ? blockIdOf($from.node(1)) : null
  const before = new Set(blockIds(state.doc))
  const tr = pasteKeepingIds(state.tr, slice, false)
  view.dispatch(tr.setMeta('paste', true).setMeta('uiEvent', 'paste'))
  const ids = blockIds(view.state.doc).filter((id) => id === anchor || !before.has(id))
  if (ids.length !== styles.length) return
  ids.forEach((id, k) => {
    const style = styles[k] ?? 'none'
    if (style !== 'none' && (k > 0 || atBlockStart)) setStyle(id, style)
  })
}

/** Page mode's paste of Markdown text, which gives a list item `lists`' style; none gives none. */
export const PagePaste = Extension.create<{ lists: PageListSource | undefined }>({
  name: 'pagePaste',
  // Ahead of the id rules (`page-block-ids.ts`), whose paste lands the blocks with no style.
  priority: 101,
  addOptions: () => ({ lists: undefined }),
  addProseMirrorPlugins() {
    const { lists } = this.options
    // What this paste's text read as; each paste's DOM event clears it, so no other paste takes it.
    let read: PastedStyles | null = null
    const parser = (text: string, $context: ResolvedPos, plain: boolean): Slice | null => {
      const pasted = pastedSlice(text, $context, plain)
      read = pasted?.styles ?? null
      return pasted?.slice ?? null
    }
    return [
      new Plugin({
        key: new PluginKey('pagePaste'),
        props: {
          // ProseMirror reads the text itself when this returns null (`someProp`), which the type leaves out.
          clipboardTextParser: parser as NonNullable<EditorProps['clipboardTextParser']>,
          handleDOMEvents: {
            paste: () => {
              read = null
              return false
            },
          },
          handlePaste(view, _event, slice) {
            const styles = read
            read = null
            if (lists === undefined || styles === null) return false
            if (styles.styles.every((style) => style === 'none')) return false
            pasteWithStyles(view, slice, styles, lists.setStyle)
            return true
          },
        },
      }),
    ]
  },
})
