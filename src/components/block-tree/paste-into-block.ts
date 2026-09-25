/**
 * #5160 D4 — land a paste the editor routed to the block path, into the block
 * it was made in, and offer to take it back.
 *
 * The editor sends the block's text before and after the selection (the
 * `splice`); `paste_blocks` joins the first pasted block into the anchor and
 * the text after the cursor into the last, as one write and one undo entry.
 *
 * The roving editor still holds the pre-paste document, and the tree's reload
 * unmounts the focused block, which saves what the editor holds as a draft and
 * flushes it over the block. So the editor is remounted on the anchor's new
 * text as soon as the paste returns, before the reload (`onSpliced`). For the
 * same reason a pending debounced commit is flushed first (`flushActiveDraft`,
 * as the slash commands do), and the toast's actions leave the pasted blocks
 * before they undo. After the reload the caret goes where a text editor leaves
 * it: in the last pasted block, just before the text that followed the cursor.
 *
 * A paste of several blocks raises a toast: **Undo** reverts the paste,
 * **Paste as text** reverts it and puts the text into the block as literal
 * lines (`asText`, computed by the editor at paste time). Both act only while
 * the paste is still the page's latest undo entry; otherwise they would revert
 * something else.
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import type { StoreApi } from 'zustand'

import type { PasteBlocksDetail } from '@/editor/extensions/html-paste'
import { parse } from '@/editor/markdown-serializer'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { performPageUndo } from '@/hooks/useUndoShortcuts'
import { flushActiveDraft } from '@/lib/active-draft-flush'
import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { useBlockStore } from '@/stores/blocks'
import type { PageBlockState } from '@/stores/page-blocks'
import { useUndoStore } from '@/stores/undo'

export interface PasteIntoBlockTarget {
  /** The focused block the paste lands in. */
  blockId: string
  /** The page the undo entry belongs to. */
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  /** The live roving editor (read at each use: its handle changes). */
  rovingEditor: () => RovingEditorHandle
}

/** What the editor's paste carries (`splice` and `asText` only from the editor). */
export type PastePayload = Pick<PasteBlocksDetail, 'input'> &
  Partial<Pick<PasteBlocksDetail, 'splice' | 'asText'>>

/** Show `content` in the editor if it is still on the target block. */
function remount(target: PasteIntoBlockTarget, content: string): void {
  const editor = target.rovingEditor()
  if (editor.activeBlockId !== target.blockId) return
  editor.mount(target.blockId, content, { cursorPlacement: 'end' })
}

/** The inline positions `node` holds: one per character and per inline atom. */
function inlineSize(node: PMNode): number {
  let size = 0
  node.descendants((child) => {
    if (child.isInline) size += child.nodeSize
    return !child.isInline
  })
  return size
}

/** The position in `doc` that its last `tail` inline positions follow. */
function posBeforeTail(doc: PMNode, tail: number): number | null {
  let skip = Math.max(0, inlineSize(doc) - tail)
  let pos: number | null = null
  doc.descendants((child, offset) => {
    if (pos !== null) return false
    if (!child.isInline) return true
    if (skip < child.nodeSize) pos = offset + skip
    else skip -= child.nodeSize
    return false
  })
  return pos
}

/**
 * Put the editor on the last pasted block with the caret just before `after`,
 * the text that followed the cursor, if the editor is still on the target.
 */
function caretAtJoin(target: PasteIntoBlockTarget, ids: readonly string[], after: string): void {
  const handle = target.rovingEditor()
  const last = ids.at(-1)
  if (last === undefined || handle.activeBlockId !== target.blockId) return
  if (last !== target.blockId) useBlockStore.getState().setFocused(last)
  const content = target.pageStore.getState().blocksById.get(last)?.content ?? ''
  handle.mount(last, content, { cursorPlacement: 'end' })
  const editor = handle.editor
  if (editor === null || after === '') return
  const pos = posBeforeTail(editor.state.doc, inlineSize(editor.schema.nodeFromJSON(parse(after))))
  if (pos !== null) editor.commands.setTextSelection(pos)
}

function topUndoEntry(pageId: string): unknown {
  return useUndoStore.getState().pages.get(pageId)?.undoStack[0]
}

/**
 * Revert the paste, if it is still the page's latest undo entry, and with
 * `asText` put the text into the block as literal lines.
 */
async function takeBack(
  target: PasteIntoBlockTarget,
  pageId: string,
  entry: unknown,
  pasted: readonly string[],
  asText?: string,
): Promise<void> {
  if (topUndoEntry(pageId) !== entry) {
    notify(t('block.pasteUndoStale'))
    return
  }
  const focus = useBlockStore.getState()
  const focused = focus.focusedBlockId
  if (focused === target.blockId || (focused !== null && pasted.includes(focused))) {
    focus.setFocused(null)
  }
  if (!(await performPageUndo(pageId)) || asText === undefined) return
  await target.pageStore.getState().edit(target.blockId, asText)
}

/** Paste `payload` into the target block; see the module doc. */
export async function pasteIntoBlock(
  target: PasteIntoBlockTarget,
  payload: PastePayload,
): Promise<void> {
  const { input, splice, asText } = payload
  await flushActiveDraft()
  const ids = await target.pageStore
    .getState()
    .pasteBlocks(target.blockId, input, splice, (content) => remount(target, content))
  if (splice) caretAtJoin(target, ids, splice.after)
  const pageId = target.rootParentId
  if (ids.length < 2 || pageId == null) return
  const entry = topUndoEntry(pageId)
  notify(t('block.pastedBlocks', { count: ids.length }), {
    action: { label: t('action.undo'), onClick: () => void takeBack(target, pageId, entry, ids) },
    ...(asText !== undefined && {
      cancel: {
        label: t('block.pasteAsText'),
        onClick: () => void takeBack(target, pageId, entry, ids, asText),
      },
    }),
  })
}
