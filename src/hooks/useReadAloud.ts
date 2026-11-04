/**
 * *Read aloud*'s app side (#5745): what each entry point reads, and the hooks that show it.
 * The reading itself is `@/lib/speech/read-aloud`; the words are `spokenUtterances`.
 *
 * - A block reads with its descendants, a block selection with the selected blocks', in tree
 *   order, from the page store that holds them.
 * - The page reads its title, then its blocks.
 * - A text selection in the block being edited reads the selected text, as markdown, through
 *   the same builder, so chips speak their titles.
 *
 * A numbered block's ordinal lives in its `list_style`, outside its content, so it is not read.
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { StoreApi } from 'zustand'

import { getActiveEditor } from '@/editor/active-editor'
import { serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import {
  checkReadAloudSupport,
  getReadAloudSnapshot,
  startReading,
  subscribeReadAloud,
} from '@/lib/speech/read-aloud'
import {
  type SpokenBlock,
  type SpokenTextResolvers,
  splitUtteranceText,
  spokenUtterances,
} from '@/lib/speech/spoken-text'
import { buildIndexById, type FlatBlock, getDragDescendants } from '@/lib/tree-utils'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import { getPageStore, type PageBlockState } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

/** Whether *Read aloud* can speak here; the first caller asks the backend. */
export function useReadAloudSupported(): boolean {
  useEffect(checkReadAloudSupport, [])
  return useSyncExternalStore(subscribeReadAloud, () => getReadAloudSnapshot().supported)
}

export function useIsReadingAloud(): boolean {
  return useSyncExternalStore(subscribeReadAloud, () => getReadAloudSnapshot().reading)
}

/** Whether `blockId` is the block being spoken; only the rows that change re-render. */
export function useIsBlockBeingRead(blockId: string): boolean {
  return useSyncExternalStore(
    subscribeReadAloud,
    () => getReadAloudSnapshot().currentBlockId === blockId,
  )
}

/** The resolve store's titles, as the static renderer shows them; a miss is `undefined`. */
function resolvers(): SpokenTextResolvers {
  const resolve = useResolveStore.getState()
  const title = (id: string) => (resolve.isResolved(id) ? resolve.resolveTitle(id) : undefined)
  return { resolveBlockTitle: title, resolveTagName: title }
}

/** Reads `rootIds` with their descendants, in `blocks`' tree order. */
export function readSubtreesAloud(
  blocks: readonly FlatBlock[],
  rootIds: readonly string[],
  owner: StoreApi<PageBlockState>,
): void {
  const index = buildIndexById(blocks)
  const ids = new Set(rootIds.flatMap((id) => [id, ...getDragDescendants(blocks, id, index)]))
  startReading(
    spokenUtterances(
      blocks.filter((block) => ids.has(block.id)),
      resolvers(),
      t,
    ),
    owner,
  )
}

/** Reads the page open in the page editor: its title, then its blocks. */
export function readOpenPageAloud(): void {
  const page = selectPageStack(useTabsStore.getState()).at(-1)
  const onScreen = useNavigationStore.getState().currentView === 'page-editor'
  const store = page !== undefined && onScreen ? getPageStore(page.pageId) : undefined
  if (page === undefined || store === undefined) {
    notify.error(t('readAloud.noPage'))
    return
  }
  const title = splitUtteranceText(page.title).map((text) => ({ blockId: page.pageId, text }))
  startReading([...title, ...spokenUtterances(store.getState().blocks, resolvers(), t)], store)
}

/**
 * The text selected in the editor on `blockId`, as markdown, or `null` with no editor there or
 * nothing selected. Read when the block menu opens: the menu keeps the editor, and its selection.
 */
export function editorSelectionMarkdown(blockId: string): string | null {
  const editor = getActiveEditor()
  if (editor === null || useBlockStore.getState().focusedBlockId !== blockId) return null
  const { from, to, empty } = editor.state.selection
  if (empty) return null
  return serialize(editor.state.doc.cut(from, to).toJSON() as DocNode)
}

/** Reads `markdown`, selected in block `blockId`, marking that block. */
export function readSelectionAloud(
  blockId: string,
  markdown: string,
  owner: StoreApi<PageBlockState>,
): void {
  const block: SpokenBlock = { id: blockId, content: markdown, todo_state: null }
  startReading(spokenUtterances([block], resolvers(), t), owner)
}
