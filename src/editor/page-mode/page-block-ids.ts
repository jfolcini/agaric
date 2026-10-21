/**
 * Page mode's id rules (#5691): the source buffer's (`token-ids.ts`), for
 * blocks rather than lines. A block's first token is the first character of
 * its first textblock or, empty, that textblock's end; its last, the last
 * character of its last textblock, or its last leaf.
 *
 * A paste keeps the ids of this page's blocks, never another page's, so a cut
 * and paste is a move and a copy beside its original is a new block. Pasted
 * from outside, paragraphs (and any other blocks) become as many blocks at the
 * depth of the block pasted into, except inside a list or a table in a block's
 * content, where they stay that list's or table's.
 *
 * A block left without an id gets a fresh one at once: it exists only in the
 * document until it holds something (`page-save.ts`). Depth is kept a tree:
 * the first block at 0, each other at most one deeper than the block before.
 * A transaction marked `REMOTE_PATCH` brings in the backend's own ids
 * (`remote-patch.ts`), which these rules leave as they are. An undo or a redo
 * puts back the ids its history recorded (`restoredIds`).
 */

import { Extension } from '@tiptap/core'
import { isHistoryTransaction } from '@tiptap/pm/history'
import { Fragment, type Node as PMNode, type NodeType, Slice } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'

import {
  depthOf,
  firstTokenPos,
  insideListOrTable,
  lastTokenPos,
  PAGE_BLOCK,
  REMOTE_PATCH,
} from '@/editor/page-mode/page-document'
import {
  blockIdOf,
  idsAfter,
  pasteKeepingIds,
  takesIds,
  type Tokens,
  withPageIds,
} from '@/editor/token-ids'
import { newBlockId } from '@/lib/block-id'

export const pageBlockIdsKey = new PluginKey('pageBlockIds')

export const PAGE_BLOCK_TOKENS: Tokens = { first: firstTokenPos, last: lastTokenPos }

/** Whether `fragment` holds blocks: only ever at its top, as the schema has them only in the document. */
function holdsPageBlock(fragment: Fragment, type: NodeType): boolean {
  let found = false
  fragment.forEach((node) => {
    found ||= node.type === type
  })
  return found
}

/**
 * Whether `tr` can change which block holds which id, or a block's depth: a
 * step outside a single block's content, or one that brings blocks in or sets
 * a block's attributes. Typing inside a block cannot, and is the common case.
 */
export function changesBlocks(tr: Transaction, type: NodeType): boolean {
  return tr.steps.some((step, i) => {
    const doc = tr.docs[i] as PMNode
    // Duck-typed: ProseMirror can be loaded twice, so no `instanceof` (AGENTS.md).
    const { pos, attr, from, to, slice } = step as Partial<{
      pos: number
      attr: string
      from: number
      to: number
      slice: Slice
    }>
    if (attr !== undefined && pos !== undefined) return doc.nodeAt(pos)?.type === type
    if (slice === undefined || from === undefined || to === undefined) return false
    return (
      doc.resolve(from).index(0) !== doc.resolve(to).index(0) || holdsPageBlock(slice.content, type)
    )
  })
}

/**
 * `slice` from outside the page as blocks: each of its top-level blocks in a
 * block of its own at `depth`, so a paste of paragraphs splits the block it
 * lands in as Enter does, and one paragraph joins the text at the cursor.
 */
function asBlocks(slice: Slice, type: NodeType, depth: number): Slice {
  const nodes: PMNode[] = []
  slice.content.forEach((node) => {
    nodes.push(type.create({ blockId: null, depth }, node))
  })
  return new Slice(Fragment.from(nodes), slice.openStart + 1, slice.openEnd + 1)
}

/**
 * Pasted over whole blocks (select all), with no block's content to fit into,
 * the clipboard parser wraps all it brings in one block of its own, with no id:
 * that block's content.
 */
function parserWrapped(slice: Slice, type: NodeType): Slice | null {
  const only = slice.content.childCount === 1 ? slice.content.firstChild : null
  if (only?.type !== type || blockIdOf(only) !== null) return null
  return new Slice(only.content, 0, 0)
}

/** What a paste or a drop brings in: this page's blocks, or anything else as blocks of its own. */
function incoming(slice: Slice, state: EditorState, type: NodeType, known: ReadonlySet<string>) {
  const { $from } = state.selection
  const wrapped = $from.depth === 0 ? parserWrapped(slice, type) : null
  if (wrapped !== null) return asBlocks(wrapped, type, 0)
  if (holdsPageBlock(slice.content, type)) return withPageIds(slice, known)
  if ($from.depth === 0 || insideListOrTable($from) || !type.validContent(slice.content))
    return slice
  return asBlocks(slice, type, depthOf($from.node(1)))
}

/**
 * The ids after an undo or a redo: each block keeps the id its steps put back,
 * unless another block holds it too. History knows which text held which id;
 * the rules (`ids`) follow first tokens, and a peer's text patched in since,
 * outside history, can start a block with a token history never moved. Any
 * other block takes its id by the rules, unless a block kept that id.
 */
function restoredIds(doc: PMNode, ids: ReadonlyArray<string | null>): Array<string | null> {
  const held: Array<string | null> = []
  doc.forEach((node) => held.push(blockIdOf(node)))
  const sole = (id: string | null): id is string =>
    id !== null && held.indexOf(id) === held.lastIndexOf(id)
  const kept = new Set(held.filter(sole))
  return held.map((id, i) => {
    if (sole(id)) return id
    const rule = ids[i] ?? null
    return rule === null || kept.has(rule) ? null : rule
  })
}

interface PageBlockIdsOptions {
  /** Mints a new block's id; a test passes a deterministic one. */
  mintId: () => string
}

export const PageBlockIds = Extension.create<PageBlockIdsOptions>({
  name: 'pageBlockIds',
  addOptions() {
    return { mintId: newBlockId }
  },
  addProseMirrorPlugins() {
    const { mintId } = this.options
    const type = this.editor.schema.nodes[PAGE_BLOCK] as NodeType
    // Every id the document has held: the page's own, which a paste may bring back.
    const known = new Set<string>()
    return [
      new Plugin({
        key: pageBlockIdsKey,
        view(view) {
          view.state.doc.forEach((node) => {
            const id = blockIdOf(node)
            if (id !== null) known.add(id)
          })
          return {}
        },
        appendTransaction(transactions, oldState, newState) {
          const remote = transactions.some((tr) => tr.getMeta(REMOTE_PATCH) === true)
          const structural = transactions.some((tr) => tr.docChanged && changesBlocks(tr, type))
          if (!remote && !structural && !takesIds(transactions)) return null
          const rules = remote
            ? null
            : idsAfter(transactions, oldState.doc, newState.doc, PAGE_BLOCK_TOKENS)
          const ids =
            rules !== null && transactions.some(isHistoryTransaction)
              ? restoredIds(newState.doc, rules)
              : rules
          const tr = newState.tr
          let previousDepth = -1
          newState.doc.forEach((node, offset, i) => {
            const id = (ids === null ? blockIdOf(node) : ids[i]) ?? mintId()
            known.add(id)
            if (blockIdOf(node) !== id) tr.setNodeAttribute(offset, 'blockId', id)
            const depth = Math.max(0, Math.min(depthOf(node), previousDepth + 1))
            if (depthOf(node) !== depth) tr.setNodeAttribute(offset, 'depth', depth)
            previousDepth = depth
          })
          return tr.docChanged ? tr : null
        },
        props: {
          transformPasted: (slice, view) => incoming(slice, view.state, type, known),
          // A paste of this page's blocks where a block starts is a move (`pasteKeepingIds`).
          handlePaste(view, _event, slice) {
            if (!holdsPageBlock(slice.content, type)) return false
            const { $from } = view.state.selection
            const atStart = $from.depth === 2 && $from.index(1) === 0 && $from.parentOffset === 0
            const tr = pasteKeepingIds(view.state.tr, slice, atStart)
            view.dispatch(tr.setMeta('paste', true).setMeta('uiEvent', 'paste'))
            return true
          },
        },
      }),
    ]
  },
})
