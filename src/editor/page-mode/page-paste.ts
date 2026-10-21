/**
 * Page mode's paste of Markdown text (#5691): text of more than one line, with
 * no HTML beside it, comes in as the blocks it reads as. Each list item,
 * paragraph, heading or fence is a block, a nested item one deeper than its
 * item, with its marks and links as marks; the save creates them as it
 * creates typed blocks. A task item keeps its checkbox as text, which becomes
 * its task state once the caret has left it (`page-tasks.ts`).
 *
 * Block mode hands such text to the backend's import grammar, which writes
 * the blocks itself (`HtmlPaste`, `paste_blocks`). Here the document owns the
 * page, and no command reads that grammar without writing, so the text is
 * read with the editor's own Markdown parser: a heading does not take the
 * blocks after it as children, and a numbered item is a plain block.
 *
 * One line (but a bullet or task line, as block mode reads them), lines with
 * no Markdown in them, a plain-text paste (Shift), and a paste into code, or
 * into a list or a table in a block's content, keep ProseMirror's own paste.
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
import type { EditorProps } from '@tiptap/pm/view'

import { parse } from '@/editor/markdown-serializer'
import { depthOf, insideListOrTable, PAGE_BLOCK } from '@/editor/page-mode/page-document'
import { isTodoState, TASK_STATE_TO_MARKER } from '@/lib/task-states'

export interface PastedBlock {
  /** Below the block pasted into: 0 is its level. */
  depth: number
  content: JSONContent[]
}

const isList = (node: JSONContent): boolean =>
  node.type === 'bulletList' || node.type === 'orderedList'

/** A task paragraph as page mode holds a typed one: its checkbox as text. */
function withCheckboxText(node: JSONContent): JSONContent {
  const state: unknown = node.attrs?.['todoState']
  if (node.type !== 'paragraph' || !isTodoState(state)) return node
  const checkbox = { type: 'text', text: `[${TASK_STATE_TO_MARKER[state]}] ` }
  return { type: 'paragraph', content: [checkbox, ...(node.content ?? [])] }
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

/**
 * The blocks Markdown `text` reads as, in order; none when it holds no
 * Markdown, only lines of text, which ProseMirror's paste makes a block each.
 */
export function pastedBlocks(text: string): PastedBlock[] {
  const nodes = (parse(text.replace(/\r\n?/g, '\n')).content ?? []) as JSONContent[]
  if (nodes.every(plainText)) return []
  const blocks: PastedBlock[] = []
  const read = (siblings: readonly JSONContent[], depth: number): void => {
    for (const node of siblings) {
      if (isList(node)) {
        for (const item of node.content ?? []) {
          const own = (item.content ?? []).filter((child) => !isList(child))
          blocks.push({
            depth,
            content: own.length === 0 ? [{ type: 'paragraph' }] : own.map(withCheckboxText),
          })
          read((item.content ?? []).filter(isList), depth + 1)
        }
      } else if (node.type !== 'paragraph' || (node.content?.length ?? 0) > 0) {
        blocks.push({ depth, content: [withCheckboxText(node)] })
      }
    }
  }
  read(nodes, 0)
  return blocks
}

const BULLET_LINE = /^\s*[-*+]\s+\S/

/** Text worth reading as blocks: more than one line that holds something, or one bullet or task line. */
function holdsLines(text: string): boolean {
  return (
    text.split(/\r\n?|\n/).filter((line) => line.trim() !== '').length > 1 || BULLET_LINE.test(text)
  )
}

/** How deep `node`'s edge is open: into its textblock, so the text at the cursor joins it. */
const openDepth = (node: PMNode | null): number => (node?.isTextblock === true ? 2 : 1)

/**
 * `blocks` as a slice of new blocks under `depth`: the first joins the text
 * before the cursor and the last the text after it, as Enter would split them.
 */
function blocksSlice(schema: Schema, blocks: readonly PastedBlock[], depth: number): Slice {
  const type = schema.nodes[PAGE_BLOCK]
  if (type === undefined) throw new Error(`the schema has no ${PAGE_BLOCK}`)
  const nodes = blocks.map((block) =>
    type.create(
      { blockId: null, depth: depth + block.depth },
      Fragment.fromJSON(schema, block.content),
    ),
  )
  const first = nodes[0] ?? null
  const last = nodes.at(-1) ?? null
  return new Slice(
    Fragment.from(nodes),
    openDepth(first?.firstChild ?? null),
    openDepth(last?.lastChild ?? null),
  )
}

/** What `text`, pasted at `$context`, brings in; null leaves it to ProseMirror's own paste. */
function pastedSlice(text: string, $context: ResolvedPos, plain: boolean): Slice | null {
  if (plain || !holdsLines(text) || insideListOrTable($context)) return null
  const blocks = pastedBlocks(text)
  if (blocks.length === 0) return null
  const depth = $context.depth === 0 ? 0 : depthOf($context.node(1))
  return blocksSlice($context.doc.type.schema, blocks, depth)
}

export const PagePaste = Extension.create({
  name: 'pagePaste',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('pagePaste'),
        props: {
          // ProseMirror reads the text itself when this returns null (`someProp`), which the type leaves out.
          clipboardTextParser: pastedSlice as NonNullable<EditorProps['clipboardTextParser']>,
        },
      }),
    ]
  },
})
