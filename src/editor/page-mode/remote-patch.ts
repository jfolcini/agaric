/**
 * Page mode after the page store reloads (#5691): a block that changed
 * elsewhere (a peer, MCP, another view) is patched into the document in place,
 * as long as page mode holds no unsaved edit of its text. All of it is one
 * transaction kept out of undo history, so Ctrl+Z never takes back someone
 * else's edit, and only the part of a block that differs is replaced, so a
 * cursor elsewhere in it stays where it was. A block with an unsaved edit keeps
 * the local text, which its next save writes over the remote one: block mode's
 * last-write-wins rule (#2459).
 *
 * Only text is patched: a block created, moved or deleted elsewhere shows once
 * page mode is opened again.
 */

import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'

import { parse } from '@/editor/markdown-serializer'
import { blockIdOf } from '@/editor/page-mode/page-document'
import type { PageSaveState } from '@/editor/page-mode/page-save'

/** Meta on the patch's transaction: nothing in it is the user's to save or undo. */
export const REMOTE_PATCH = 'pageModeRemotePatch'

function contentOf(schema: Schema, markdown: string): Fragment {
  return Fragment.fromJSON(schema, parse(markdown).content as unknown as Record<string, unknown>[])
}

/** Replace the content of the block at `pos` in `tr` with `content`, touching only what differs. */
function replaceContent(tr: Transaction, pos: number, content: Fragment): void {
  const block = tr.doc.nodeAt(pos) as PMNode
  const start = block.content.findDiffStart(content)
  const end = block.content.findDiffEnd(content)
  if (start === null || end === null) return
  let { a: endA, b: endB } = end
  const overlap = start - Math.min(endA, endB)
  if (overlap > 0) {
    endA += overlap
    endB += overlap
  }
  const holder = block.type.create(block.attrs, content)
  tr.replace(pos + 1 + start, pos + 1 + endA, holder.slice(start, endB))
  // A range that does not cut cleanly is fitted differently; the whole content always fits.
  const now = tr.doc.nodeAt(pos) as PMNode
  if (!now.content.eq(content)) tr.replaceWith(pos + 1, pos + 1 + now.content.size, content)
}

/**
 * Whether `node` holds what it held when last saved. Not node identity alone:
 * a move or a split at its start makes a new node with the same text, which
 * the save then has nothing to write for, so a peer's text must still show.
 */
function untouched(saved: PMNode | null, node: PMNode): boolean {
  return saved === node || saved?.content.eq(node.content) === true
}

/**
 * The transaction that patches `blocks`, the page as the store just reloaded
 * it, into `state`'s document, and the text each patched block now holds; null
 * when no block needs it. Once it is applied, `adoptPatched` records them.
 */
export function remotePatch(
  state: EditorState,
  save: PageSaveState,
  blocks: ReadonlyArray<{ id: string; content: string | null }>,
): { tr: Transaction; patched: Map<string, string> } | null {
  const fresh = new Map(blocks.map((block) => [block.id, block.content ?? '']))
  const tr = state.tr
  const patched = new Map<string, string>()
  state.doc.forEach((node, offset) => {
    const id = blockIdOf(node)
    const saved = id === null ? undefined : save.saved.get(id)
    const markdown = id === null ? undefined : fresh.get(id)
    if (id === null || saved === undefined || markdown === undefined) return
    if (markdown === saved.markdown || !untouched(saved.node, node)) return
    replaceContent(tr, tr.mapping.map(offset), contentOf(state.schema, markdown))
    patched.set(id, markdown)
  })
  if (patched.size === 0) return null
  tr.setMeta('addToHistory', false).setMeta(REMOTE_PATCH, true)
  return { tr, patched }
}

/** Record the patched blocks as saved at the text the patch gave them. */
export function adoptPatched(doc: PMNode, save: PageSaveState, patched: Map<string, string>): void {
  doc.forEach((node) => {
    const id = blockIdOf(node)
    const markdown = id === null ? undefined : patched.get(id)
    if (id !== null && markdown !== undefined) save.saved.set(id, { node, markdown })
  })
}
