/**
 * PageModeEditor — the page edited as one document (#5691), in place of the
 * block tree, the way source mode replaces it (`PageEditor`). Desktop only,
 * and only for a page whose blocks hold nothing it cannot show yet
 * (`page-mode-fit.ts`): ProseMirror renders the whole document.
 *
 * It saves continuously through the block commands (`page-save.ts`): 700 ms
 * after typing stops, on blur, on `flush` (the mode switch, an export through
 * `flushActiveDraft`), when the window is hidden or closed, and on unmount
 * (leaving the page). Saves, and what changed elsewhere, take turns on one
 * chain. A reload of the page store (a sync, MCP, a page-level undo) is
 * brought into the document by id (`remote-patch.ts`); one that overlapped a
 * save may predate it, so the store is read again first. A save a write
 * refused reads the page again and saves once more: a block deleted elsewhere
 * while edited here is then kept as a new block, with a notice.
 *
 * A task marker or a `#name` left as text in a block becomes the block's task
 * state or the tag once the caret leaves that block or page mode closes
 * (`page-tasks.ts`, `page-tags.ts`); the checkbox shows the state the page
 * store holds, and cycles it through the todo-state command.
 *
 * Chips go where block mode's go (`useBlockNavigateToLink`, a block of this
 * page by moving the cursor to it), and each save's ops reach `UndoStore`
 * as block mode records them. `PageEditor` reaches this module only through a
 * dynamic import, so TipTap stays off the startup path.
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { type Editor, EditorContent, useEditor } from '@tiptap/react'
import type React from 'react'
import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  collectUncachedLinkIds,
  fetchAndCacheLinks,
} from '@/components/block-tree/use-block-link-resolve'
import { useBlockNavigateToLink } from '@/components/block-tree/use-block-navigate-to-link'
import { useBlockProperties } from '@/components/block-tree/use-block-properties'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { SelectionBubbleMenu } from '@/components/editor-toolbar/SelectionBubbleMenu'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { getActiveEditor, setActiveEditor } from '@/editor/active-editor'
import {
  changedBlocks,
  firstTokenPos,
  pageDocContent,
  REMOTE_PATCH,
} from '@/editor/page-mode/page-document'
import { pageModeExtensions } from '@/editor/page-mode/page-mode-extensions'
import { type PageModeBlocker, pageModeBlocker } from '@/editor/page-mode/page-mode-fit'
import {
  createSaveState,
  type PageSaveApi,
  savePage,
  type TreeRow,
} from '@/editor/page-mode/page-save'
import { commitPageTags } from '@/editor/page-mode/page-tags'
import { commitPageTask } from '@/editor/page-mode/page-tasks'
import { applyRemote } from '@/editor/page-mode/remote-patch'
import { blockIdOf } from '@/editor/token-ids'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { CONTENT_COMMIT_DEBOUNCE_MS } from '@/hooks/useDebouncedContentCommit'
import { useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { registerActiveDraftFlush } from '@/lib/active-draft-flush'
import { retryOnPoolBusy, unwrap } from '@/lib/app-error'
import { commands, type OpRef } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { newBlockId } from '@/lib/block-id'
import { t } from '@/lib/i18n'
import { createBlock } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { FlatBlock } from '@/lib/tree-utils'
import { useNavigationStore } from '@/stores/navigation'
import { usePageBlockStoreApi } from '@/stores/page-blocks'
import { notifyUndoNewAction } from '@/stores/page-blocks-reducers'
import { useSpaceStore } from '@/stores/space'

/** The User Timing measure each save leaves, the latest only: the perf harness reads it. */
export const SAVE_MEASURE = 'page-mode-save'

/** The save each page's last page-mode session left running, which the next one waits for. */
const savesInFlight = new Map<string, Promise<void>>()

export interface PageModeEditorHandle {
  /** Save whatever is not saved yet; resolves once that save has run. */
  flush: () => Promise<void>
  /** The block the cursor is in, for the mode switch to keep it there. */
  cursorBlockId: () => string | null
}

export interface PageModeEditorProps {
  pageId: string
  /** Called instead of opening, or while open, when the page holds what page mode cannot show. */
  onBlocked: (blocker: PageModeBlocker) => void
  onNavigateToPage?: NavigateToPageFn | undefined
  /** The block to put the cursor in once open: the one block mode was editing. */
  cursorBlockId?: string | null | undefined
  ref?: React.Ref<PageModeEditorHandle>
}

const spaceId = (): string | null => useSpaceStore.getState().currentSpaceId

/** Resolve the titles of the pages and blocks `blocks` link to, so their chips open showing them. */
async function resolveLinks(blocks: readonly FlatBlock[], isCancelled: () => boolean) {
  const ids = collectUncachedLinkIds(blocks, spaceId())
  if (ids.size > 0) await fetchAndCacheLinks(ids, spaceId(), isCancelled)
}

export function PageModeEditor({
  pageId,
  onBlocked,
  onNavigateToPage,
  cursorBlockId,
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
      const blocker = await pageModeBlocker(blocks, truncatedTotal ?? blocks.length)
      if (cancelled) return
      if (blocker !== null) {
        onBlocked(blocker)
        return
      }
      await resolveLinks(blocks, () => cancelled)
      if (!cancelled) setOpened(blocks)
    }
    open().catch((err: unknown) => {
      logger.error('PageModeEditor', 'Failed to open page mode', { pageId }, err)
      notify.error(t('error.loadBlocksFailed'))
    })
    return () => {
      cancelled = true
    }
  }, [pageId, pageStore, onBlocked])

  if (opened === null) return <LoadingSkeleton count={3} />
  return (
    <PageModeDocument
      pageId={pageId}
      blocks={opened}
      onBlocked={onBlocked}
      onNavigateToPage={onNavigateToPage}
      cursorBlockId={cursorBlockId ?? null}
      ref={ref}
    />
  )
}

/** The page's rows as the save and the remote patch read them. */
function treeRows(blocks: readonly FlatBlock[]): TreeRow[] {
  return blocks.map(({ id, parent_id, content }) => ({ id, parent_id, content }))
}

/** The block commands, retried while the database is busy, as the page store's actions are. */
function commandsApi(read: () => Promise<TreeRow[]>): PageSaveApi {
  const space = (): string => spaceId() ?? ''
  return {
    create: async (id, parentId, index, markdown) =>
      (
        await retryOnPoolBusy(() =>
          createBlock({
            blockType: 'content',
            content: markdown,
            parentId,
            index,
            spaceId: space(),
            blockId: id,
          }),
        )
      ).op_refs,
    restore: async (id, deletedAt) => {
      await retryOnPoolBusy(() => commands.restoreBlock(id, deletedAt).then(unwrap))
    },
    move: async (id, parentId, index) =>
      (await retryOnPoolBusy(() => commands.moveBlock(id, parentId, index).then(unwrap))).op_refs,
    edit: async (id, markdown) =>
      (await retryOnPoolBusy(() => commands.editBlock(id, markdown).then(unwrap))).op_refs,
    remove: async (id) => {
      const deleted = await retryOnPoolBusy(() => commands.deleteBlock(id).then(unwrap))
      return { deletedAt: deleted.deleted_at, refs: deleted.op_refs }
    },
    tree: read,
  }
}

/** The block `id` of `doc`, or null. */
function blockById(doc: PMNode, id: string): PMNode | null {
  let found: PMNode | null = null
  doc.forEach((node) => {
    if (found === null && blockIdOf(node) === id) found = node
  })
  return found
}

/** Put the cursor at the start of block `id` and show it; false when the page has no such block. */
function cursorInto(editor: Editor, id: string): boolean {
  let at = -1
  editor.state.doc.forEach((node, pos) => {
    if (at === -1 && blockIdOf(node) === id) at = pos
  })
  const node = at === -1 ? null : editor.state.doc.nodeAt(at)
  if (node === null) return false
  editor.chain().setTextSelection(firstTokenPos(node, at)).scrollIntoView().focus().run()
  return true
}

interface PageModeDocumentProps {
  pageId: string
  blocks: readonly FlatBlock[]
  onBlocked: (blocker: PageModeBlocker) => void
  onNavigateToPage?: NavigateToPageFn | undefined
  cursorBlockId: string | null
  ref?: React.Ref<PageModeEditorHandle> | undefined
}

function PageModeDocument({
  pageId,
  blocks,
  onBlocked,
  onNavigateToPage,
  cursorBlockId,
  ref,
}: PageModeDocumentProps): React.ReactElement {
  const { t: translate } = useTranslation()
  const resolve = useBlockResolve()
  const pageStore = usePageBlockStoreApi()
  const onTagClick = useTagClickHandler()
  const { handleToggleTodo } = useBlockProperties()
  const editorRef = useRef<Editor | null>(null)
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const cycleRef = useRef<(id: string) => void>(() => {})
  // Block mode's chip navigation: another page opens; a block of this page takes the cursor.
  const noRovingEditor = useRef<RovingEditorHandle | null>(null)
  const handleFlushRef = useRef(() => {
    void flushRef.current()
    return null
  })
  const { handleNavigateRef } = useBlockNavigateToLink({
    rovingEditorRef: noRovingEditor,
    handleFlushRef,
    pageStore,
    load: () => pageStore.getState().load(),
    setFocused: (id) => {
      if (id !== null && editorRef.current !== null) cursorInto(editorRef.current, id)
    },
    rootParentId: pageId,
    onNavigateToPage,
    t: translate,
  })
  // One options object for the editor's life: `useEditor` re-applies options
  // that change identity.
  // oxlint-disable-next-line react/refs -- `handleNavigateRef` is read inside the chips' click closure, which TipTap invokes on a click, never during this render; handing a ref to a consumer that defers the read is the intended use; see #4406
  const [options] = useState(() => ({
    extensions: pageModeExtensions({
      ...resolve,
      onNavigate: (id: string) => handleNavigateRef.current(id),
      onTagClick,
      placeholder: t('pageMode.placeholder'),
      tasks: {
        stateOf: (id: string) => pageStore.getState().blocksById.get(id)?.todo_state ?? null,
        subscribe: (listener: () => void) => pageStore.subscribe(listener),
        cycle: (id: string) => cycleRef.current(id),
      },
    }),
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
        class: 'page-mode-editor',
      },
    },
  }))
  const editor = useEditor(options)
  useEffect(() => {
    editorRef.current = editor
  }, [editor])
  // The session reads these as they are when it needs them, not as it was built with.
  const blocked = useEffectEvent((blocker: PageModeBlocker) => onBlocked(blocker))
  const openingCursor = useEffectEvent(() => cursorBlockId)
  const cycleTask = useEffectEvent((id: string) => handleToggleTodo(id))

  // Once per editor: the save state is built from the page as the document opened on it.
  useEffect(() => {
    if (editor === null) return
    const save = createSaveState(pageId, treeRows(blocks), editor.state.doc)
    let chain = Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    // The store's own reads, which the save and the patch make, are not changes from elsewhere.
    let reading = false
    const read = async (): Promise<FlatBlock[]> => {
      reading = true
      try {
        await pageStore.getState().load()
      } finally {
        reading = false
      }
      return pageStore.getState().blocks
    }
    const api = commandsApi(async () => treeRows(await read()))
    const cursorBlock = (): string | null => {
      const { $head } = editor.state.selection
      return $head.depth < 1 ? null : blockIdOf($head.node(1))
    }
    // The blocks changed whose task markers and `#name`s are not committed yet,
    // each as it was before (`commitPageTask`), and the caret's block.
    const typedIn = new Map<string, PMNode | null>()
    let caretIn = cursorBlock()

    /** Bring the page as the store holds it into the document, unless it holds what page mode cannot show. */
    const bringIn = async (
      fresh: readonly FlatBlock[],
      refused?: ReadonlySet<string>,
    ): Promise<void> => {
      const blocker = await pageModeBlocker(
        fresh,
        pageStore.getState().truncatedTotal ?? fresh.length,
      )
      if (editor.isDestroyed) return
      if (blocker !== null) {
        blocked(blocker)
        return
      }
      await resolveLinks(fresh, () => editor.isDestroyed)
      if (editor.isDestroyed) return
      const { keptAsNew } = applyRemote(editor.view, save, treeRows(fresh), newBlockId, refused)
      if (keptAsNew > 0) {
        notify.info(t('pageMode.keptAsNew', { count: keptAsNew }), {
          id: `page-mode-kept-${pageId}`,
        })
      }
    }

    /**
     * Commit the task markers, then the tags, typed in the blocks changed and
     * left, or in all of them when page mode closes.
     */
    const commitTyped = async (closing: boolean): Promise<OpRef[]> => {
      const refs: OpRef[] = []
      // A copy: a block typed in again while a commit awaits is for the next save, not this loop.
      const pending = [...typedIn]
      for (const [id, loaded] of pending) {
        // Never the caret's block: its marker or name may still be being typed.
        if (!closing && cursorBlock() === id) continue
        typedIn.delete(id)
        const task = await commitPageTask(id, loaded, save, api, pageStore)
        refs.push(...task.refs, ...(await commitPageTags(id, save, api, task.markdown)))
      }
      return refs
    }

    const runSave = async (closing: boolean): Promise<void> => {
      const start = performance.now()
      let result = await savePage(editor.state.doc, save, api)
      if (result.error !== undefined && !editor.isDestroyed) {
        // A refused write: the page may have changed elsewhere (a block deleted
        // under the text typed in it). Read it again, bring that in, save once more.
        logger.warn('PageModeEditor', 'A page mode write was refused', { pageId }, result.error)
        const refs = result.refs
        const { failed } = result
        const refused = failed?.kind === 'create' || failed?.kind === 'restore' ? failed.id : null
        await bringIn(await read(), new Set(refused === null ? [] : [refused]))
        result = await savePage(editor.state.doc, save, api)
        result.refs.unshift(...refs)
      }
      performance.clearMeasures(SAVE_MEASURE)
      performance.measure(SAVE_MEASURE, { start })
      const typedRefs = await commitTyped(closing)
      if (typedRefs.length > 0) {
        result.refs.push(...typedRefs)
        // The text the commits wrote comes back as a change from elsewhere does.
        if (!editor.isDestroyed) await bringIn(await read())
      }
      const coalesce = result.structural ? undefined : `edit:${cursorBlock() ?? pageId}`
      if (result.refs.length > 0) notifyUndoNewAction(pageId, result.refs, coalesce)
      if (result.error !== undefined) {
        logger.warn('PageModeEditor', 'Failed to save page mode changes', { pageId }, result.error)
        notify.error(t('pageMode.saveFailed'), { id: `page-mode-save-${pageId}` })
      }
    }
    const enqueue = (step: () => Promise<void>): Promise<void> => {
      chain = chain.then(step).catch((err: unknown) => {
        logger.error('PageModeEditor', 'Page mode save threw', { pageId }, err)
      })
      return chain
    }
    const flush = (closing = false): Promise<void> => {
      clearTimeout(timer)
      return enqueue(() => runSave(closing))
    }
    // Its callers close page mode: the mode switch, source mode, a blocker, a link away.
    flushRef.current = () => flush(true)
    // After the save, so the block exists: an empty one is created for it (`keep`).
    cycleRef.current = (id) => {
      clearTimeout(timer)
      void enqueue(async () => {
        save.keep.add(id)
        try {
          await runSave(false)
        } finally {
          save.keep.delete(id)
        }
        if (editor.isDestroyed || !save.saved.has(id)) return
        // A block created here since the store last loaded: the cycle reads its state there.
        if (!pageStore.getState().blocksById.has(id)) await read()
        await cycleTask(id)
      })
    }

    const onTransaction = ({
      transaction,
      appendedTransactions,
    }: {
      transaction: Transaction
      appendedTransactions: Transaction[]
    }): void => {
      const was = caretIn
      caretIn = cursorBlock()
      if (transaction.docChanged && transaction.getMeta(REMOTE_PATCH) !== true) {
        const maps = [transaction, ...appendedTransactions].flatMap((tr) => tr.mapping.maps)
        for (const id of changedBlocks(editor.state.doc, maps)) {
          if (!typedIn.has(id)) typedIn.set(id, blockById(transaction.before, id))
        }
        clearTimeout(timer)
        timer = setTimeout(() => void flush(), CONTENT_COMMIT_DEBOUNCE_MS)
      }
      // Block mode commits what was typed as the block is left: here, as the caret leaves it.
      if (was !== caretIn && was !== null && typedIn.has(was)) void flush()
    }
    let unregisterDraft = (): void => {}
    // As block mode's focused block: an export flushes this first (`flushActiveDraft`).
    const onFocus = (): void => {
      setActiveEditor(editor)
      unregisterDraft()
      unregisterDraft = registerActiveDraftFlush(pageId, () => flush())
    }
    const onBlur = (): void => void flush()
    // As block mode's draft autosave: the window hidden or closing saves now.
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') void flush()
    }
    const onPageHide = (): void => void flush()
    editor.on('transaction', onTransaction)
    editor.on('focus', onFocus)
    editor.on('blur', onBlur)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)

    // A reload of the store from elsewhere; one that overlapped a write may predate it.
    let writesAtRead = save.writes
    const unsubscribe = pageStore.subscribe((state, previous) => {
      if (reading || editor.isDestroyed) return
      if (state.loading && !previous.loading) writesAtRead = save.writes
      if (state.loading || state.blocks === previous.blocks) return
      const fresh = state.blocks
      const since = writesAtRead
      void enqueue(async () => {
        await bringIn(save.writes === since ? fresh : await read())
      })
    })

    const opening = openingCursor()
    if (opening !== null) cursorInto(editor, opening)

    return () => {
      unsubscribe()
      editor.off('transaction', onTransaction)
      editor.off('focus', onFocus)
      editor.off('blur', onBlur)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      unregisterDraft()
      if (getActiveEditor() === editor) setActiveEditor(null)
      // Leaving the page: the save outlives the editor, and the page's next
      // page-mode session waits for it before it reads the page.
      const leaving = flush(true)
      savesInFlight.set(pageId, leaving)
      void leaving.then(() => {
        if (savesInFlight.get(pageId) === leaving) savesInFlight.delete(pageId)
      })
    }
  }, [editor, pageId, blocks, pageStore])

  // A link from elsewhere to a block of this page lands the cursor on it.
  const selectedBlockId = useNavigationStore((s) => s.selectedBlockId)
  useEffect(() => {
    if (editor === null || selectedBlockId === null) return
    if (!cursorInto(editor, selectedBlockId)) notify.error(t('error.blockNotFound'))
    useNavigationStore.getState().clearSelection()
  }, [editor, selectedBlockId])

  useImperativeHandle(
    ref,
    () => ({
      flush: () => flushRef.current(),
      cursorBlockId: () => {
        const head = editorRef.current?.state.selection.$head
        return head === undefined || head.depth < 1 ? null : blockIdOf(head.node(1))
      },
    }),
    [],
  )

  return (
    <>
      <EditorContent editor={editor} />
      {/* Block mode's own: the marks and the link on a selection, and Ctrl+K. */}
      {editor !== null && <SelectionBubbleMenu editor={editor} />}
    </>
  )
}
