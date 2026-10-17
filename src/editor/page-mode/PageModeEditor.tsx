/**
 * PageModeEditor — the page edited as one document (#5691), in place of the
 * block tree, the way source mode replaces it (`PageEditor`). Desktop only, up
 * to `PAGE_MODE_BLOCK_CAP` blocks: ProseMirror renders the whole document.
 *
 * It saves continuously through the block commands (`page-save.ts`): 700 ms
 * after typing stops, on blur, on `flush` (the mode switch) and on unmount
 * (leaving the page). A reload of the page store (a sync, an MCP write)
 * patches the blocks changed elsewhere into the document (`remote-patch.ts`).
 * `PageEditor` reaches it only through a dynamic import, so TipTap stays off
 * the startup path.
 */

import type { Transaction } from '@tiptap/pm/state'
import { EditorContent, useEditor } from '@tiptap/react'
import type React from 'react'
import { useEffect, useImperativeHandle, useRef, useState } from 'react'

import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { getActiveEditor, setActiveEditor } from '@/editor/active-editor'
import { pageDocContent } from '@/editor/page-mode/page-document'
import { pageModeExtensions } from '@/editor/page-mode/page-mode-extensions'
import {
  createSaveState,
  type PageSaveApi,
  savePage,
  type TreeRow,
} from '@/editor/page-mode/page-save'
import { adoptPatched, REMOTE_PATCH, remotePatch } from '@/editor/page-mode/remote-patch'
import { CONTENT_COMMIT_DEBOUNCE_MS } from '@/hooks/useDebouncedContentCommit'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { newBlockId } from '@/lib/block-id'
import { t } from '@/lib/i18n'
import { createBlock } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { requireActiveScope } from '@/lib/space-scope'
import { buildFlatTree, type FlatBlock } from '@/lib/tree-utils'
import { usePageBlockStoreApi } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

/** The most blocks page mode opens; a longer page stays in block mode. */
export const PAGE_MODE_BLOCK_CAP = 500

/** The cap, which only the perf harness's e2e build may raise (`e2e/perf.spec.ts`, `-g 'page mode'`). */
function blockCap(): number {
  if (import.meta.env.VITE_E2E) {
    const raised = (window as { __pageModeBlockCap?: unknown }).__pageModeBlockCap
    if (typeof raised === 'number') return raised
  }
  return PAGE_MODE_BLOCK_CAP
}

/** The User Timing measure each save leaves, the latest only: the perf harness reads it. */
export const SAVE_MEASURE = 'page-mode-save'

/** The save each page's last page-mode session left running, which the next one waits for. */
const savesInFlight = new Map<string, Promise<void>>()

export interface PageModeEditorHandle {
  /** Save whatever is not saved yet; resolves once that save has run. */
  flush: () => Promise<void>
}

export interface PageModeEditorProps {
  pageId: string
  /** Called instead of opening when the page holds more blocks than page mode takes. */
  onOverCap: (blockCount: number, cap: number) => void
  ref?: React.Ref<PageModeEditorHandle>
}

export function PageModeEditor({
  pageId,
  onOverCap,
  ref,
}: PageModeEditorProps): React.ReactElement {
  const pageStore = usePageBlockStoreApi()
  const [opened, setOpened] = useState<readonly FlatBlock[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const open = async (): Promise<void> => {
      await savesInFlight.get(pageId)
      const store = pageStore.getState()
      // Nothing has loaded the store yet when the page opened in page mode.
      if (store.loading && store.blocks.length === 0) await store.load()
      if (cancelled) return
      const { blocks, truncatedTotal } = pageStore.getState()
      const count = truncatedTotal ?? blocks.length
      if (count > blockCap()) onOverCap(count, blockCap())
      else setOpened(blocks)
    }
    void open()
    return () => {
      cancelled = true
    }
  }, [pageId, pageStore, onOverCap])

  if (opened === null) return <LoadingSkeleton count={3} />
  return <PageModeDocument pageId={pageId} blocks={opened} ref={ref} />
}

function commandsApi(pageId: string): PageSaveApi {
  const spaceId = (): string => useSpaceStore.getState().currentSpaceId ?? ''
  return {
    create: async (id, parentId, index, markdown) =>
      (
        await createBlock({
          blockType: 'content',
          content: markdown,
          parentId,
          index,
          spaceId: spaceId(),
          blockId: id,
        })
      ).op_refs,
    restore: async (id, deletedAt) => {
      unwrap(await commands.restoreBlock(id, deletedAt))
    },
    move: async (id, parentId, index) =>
      unwrap(await commands.moveBlock(id, parentId, index)).op_refs,
    edit: async (id, markdown) => unwrap(await commands.editBlock(id, markdown)).op_refs,
    remove: async (id) => {
      const deleted = unwrap(await commands.deleteBlock(id))
      return { deletedAt: deleted.deleted_at, refs: deleted.op_refs }
    },
    tree: async () => {
      const subtree = unwrap(await commands.loadPageSubtree(pageId, requireActiveScope(spaceId())))
      return buildFlatTree(subtree.blocks, pageId)
    },
  }
}

interface PageModeDocumentProps {
  pageId: string
  blocks: readonly FlatBlock[]
  ref?: React.Ref<PageModeEditorHandle> | undefined
}

function PageModeDocument({ pageId, blocks, ref }: PageModeDocumentProps): React.ReactElement {
  const resolve = useBlockResolve()
  const pageStore = usePageBlockStoreApi()
  // One options object for the editor's life: `useEditor` re-applies options
  // that change identity.
  const [options] = useState(() => ({
    extensions: pageModeExtensions(resolve),
    content: pageDocContent(blocks, newBlockId),
    // Built in an effect: a lazily loaded editor built during render can be
    // reclaimed by TipTap's unmount timer before it mounts (use-roving-editor).
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': t('pageMode.editorLabel'),
        'data-testid': 'page-mode-editor',
        class: '[&_[data-page-block]]:py-0.5',
      },
    },
  }))
  const editor = useEditor(options)
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve())

  // Once per editor: the save state is built from the page as the document opened on it.
  useEffect(() => {
    if (editor === null) return
    const rows: TreeRow[] = blocks.map(({ id, parent_id, content }) => ({ id, parent_id, content }))
    const save = createSaveState(pageId, rows, editor.state.doc)
    const api = commandsApi(pageId)
    let doc = editor.state.doc
    let chain = Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined

    const runSave = async (): Promise<void> => {
      const start = performance.now()
      const result = await savePage(doc, save, api)
      performance.clearMeasures(SAVE_MEASURE)
      performance.measure(SAVE_MEASURE, { start })
      if (result.refs.length > 0) useUndoStore.getState().onNewAction(pageId, result.refs)
      if (result.error !== undefined) {
        logger.warn('PageModeEditor', 'Failed to save page mode changes', { pageId }, result.error)
        notify.error(t('pageMode.saveFailed'), { id: `page-mode-save-${pageId}` })
      }
    }
    const flush = (): Promise<void> => {
      clearTimeout(timer)
      chain = chain.then(runSave).catch((err: unknown) => {
        logger.error('PageModeEditor', 'Page mode save threw', { pageId }, err)
      })
      return chain
    }
    flushRef.current = flush

    const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
      doc = editor.state.doc
      if (!transaction.docChanged || transaction.getMeta(REMOTE_PATCH) === true) return
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), CONTENT_COMMIT_DEBOUNCE_MS)
    }
    const onBlur = (): void => {
      void flush()
    }
    const onFocus = (): void => setActiveEditor(editor)
    editor.on('transaction', onTransaction)
    editor.on('blur', onBlur)
    editor.on('focus', onFocus)

    const unsubscribe = pageStore.subscribe((state, previous) => {
      if (state.blocks === previous.blocks || state.loading || editor.isDestroyed) return
      const patch = remotePatch(editor.state, save, state.blocks)
      if (patch === null) return
      editor.view.dispatch(patch.tr)
      adoptPatched(editor.state.doc, save, patch.patched)
    })

    return () => {
      unsubscribe()
      editor.off('transaction', onTransaction)
      editor.off('blur', onBlur)
      editor.off('focus', onFocus)
      if (getActiveEditor() === editor) setActiveEditor(null)
      // Leaving the page: the save outlives the editor, and the page's next
      // page-mode session waits for it before it reads the page.
      const leaving = flush()
      savesInFlight.set(pageId, leaving)
      void leaving.then(() => {
        if (savesInFlight.get(pageId) === leaving) savesInFlight.delete(pageId)
      })
    }
  }, [editor, pageId, blocks, pageStore])

  useImperativeHandle(ref, () => ({ flush: () => flushRef.current() }), [])

  return <EditorContent editor={editor} />
}
