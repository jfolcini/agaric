/**
 * PageModeEditor — the page edited as one document (#5691), in place of the
 * block tree, the way source mode replaces it (`PageEditor`). Desktop only,
 * and only for a page within its cap (`page-mode-fit.ts`): ProseMirror renders
 * the whole document.
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
 * A task marker, a `key:: value` line or a `#name` left as text in a block
 * becomes the block's task state, property or tag once the caret leaves that
 * block or page mode closes (`page-tasks.ts`, `page-properties.ts`,
 * `page-tags.ts`). The checkbox, the priority badge and the date chips show
 * what the page store holds, and change it through block mode's commands,
 * after the save, on the same chain; a chip opens block mode's date picker.
 * The property chips show what page mode last read of the page's properties,
 * which it reads again with each reload; a chip opens block mode's property
 * editor, the `+N` pill its drawer, and each, once closed, reads them again.
 * The attachments and their badge show what the same read found; what the
 * badge's list deletes or renames, and a file pasted or dropped, which block
 * mode's own upload attaches after the save, read them again.
 * A bullet or numbered block's marker shows its `listStyle` from the same
 * read; the list keys and input rules give a block its style at once, written
 * after the save on the same chain (`page-lists.ts`). A query or embed block
 * shows block mode's results or embed while the caret is not in it
 * (`page-rendered.ts`). An embed of a block of this page shows the page store's
 * rows, as block mode's does, so a save that wrote reads them again; the query
 * builder's write goes on the same chain.
 *
 * Block mode's slash menu and `::` and `{{` pickers act on the caret's block
 * through block mode's own handlers (`page-slash-commands.tsx`): a command that
 * writes to the block runs after the save, on the same chain, and the page is
 * read again after it.
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
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { useBlockDatePicker } from '@/components/block-tree/use-block-date-picker'
import {
  collectUncachedLinkIds,
  fetchAndCacheLinks,
} from '@/components/block-tree/use-block-link-resolve'
import { useBlockNavigateToLink } from '@/components/block-tree/use-block-navigate-to-link'
import { setBlockPriority, useBlockProperties } from '@/components/block-tree/use-block-properties'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { BlockResolversProvider } from '@/components/block-tree/use-block-resolvers'
import { SelectionBubbleMenu } from '@/components/editor-toolbar/SelectionBubbleMenu'
import { processFileAttachments } from '@/components/editor/EditableBlock'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { getActiveEditor, setActiveEditor } from '@/editor/active-editor'
import { PageAttachments } from '@/editor/page-mode/page-attachments'
import {
  changedBlocks,
  firstTokenPos,
  pageDocContent,
  REMOTE_PATCH,
} from '@/editor/page-mode/page-document'
import { PageLists } from '@/editor/page-mode/page-lists'
import { pageModeExtensions } from '@/editor/page-mode/page-mode-extensions'
import { type PageModeBlocker, readPageFit } from '@/editor/page-mode/page-mode-fit'
import { commitPageProperties, PageProperties } from '@/editor/page-mode/page-properties'
import {
  createSaveState,
  type PageSaveApi,
  type PageSaveState,
  savePage,
  type TreeRow,
} from '@/editor/page-mode/page-save'
import {
  runsInDocument,
  searchPageSlashCommands,
  usePageSlashCommands,
} from '@/editor/page-mode/page-slash-commands'
import { commitPageTags } from '@/editor/page-mode/page-tags'
import { commitPageTask, type PageTaskActions } from '@/editor/page-mode/page-tasks'
import { applyRemote } from '@/editor/page-mode/remote-patch'
import type { PickerItem } from '@/editor/SuggestionList'
import { blockIdOf } from '@/editor/token-ids'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { CONTENT_COMMIT_DEBOUNCE_MS } from '@/hooks/useDebouncedContentCommit'
import { useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { registerActiveDraftFlush } from '@/lib/active-draft-flush'
import { retryOnPoolBusy, unwrap } from '@/lib/app-error'
import { subscribeToAttachmentInvalidation } from '@/lib/attachment-invalidation'
import { type AttachmentRow, commands, type OpRef, type PropertyRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { newBlockId } from '@/lib/block-id'
import { parseEmbedToken } from '@/lib/embed-token'
import { t } from '@/lib/i18n'
import { createBlock } from '@/lib/ipc-helpers'
import { type ListStyle, setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { searchPropertyKeys } from '@/lib/slash-commands'
import type { FlatBlock } from '@/lib/tree-utils'
import { useNavigationStore } from '@/stores/navigation'
import { usePageBlockStoreApi } from '@/stores/page-blocks'
import { notifyUndoNewAction } from '@/stores/page-blocks-reducers'
import { useSpaceStore } from '@/stores/space'

const BlockDatePicker = lazy(() =>
  import('@/components/block-tree/BlockDatePicker').then((m) => ({ default: m.BlockDatePicker })),
)
const BlockPropertyDrawer = lazy(() =>
  import('@/components/editor/BlockPropertyDrawer').then((m) => ({
    default: m.BlockPropertyDrawer,
  })),
)

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
  /** Called instead of opening, or while open, when the page is over page mode's cap. */
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
  const [opened, setOpened] = useState<{
    blocks: readonly FlatBlock[]
    properties: Record<string, PropertyRow[]>
    attachments: Record<string, AttachmentRow[]>
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    const open = async (): Promise<void> => {
      await savesInFlight.get(pageId)
      const store = pageStore.getState()
      // Nothing has loaded the store yet when the page opened in page mode.
      if (store.loading && store.blocks.length === 0) await store.load()
      if (cancelled) return
      const { blocks, truncatedTotal } = pageStore.getState()
      const { blocker, properties, attachments } = await readPageFit(
        blocks,
        truncatedTotal ?? blocks.length,
      )
      if (cancelled) return
      if (blocker !== null) {
        onBlocked(blocker)
        return
      }
      await resolveLinks(blocks, () => cancelled)
      if (!cancelled) setOpened({ blocks, properties, attachments })
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
      blocks={opened.blocks}
      properties={opened.properties}
      attachments={opened.attachments}
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

/** Whether a block of the page embeds the page or one of its blocks: that embed shows the page store's rows. */
function embedsOwnBlock(save: PageSaveState): boolean {
  for (const { markdown } of save.saved.values()) {
    const target = parseEmbedToken(markdown)?.targetId
    if (target !== undefined && (target === save.pageId || save.saved.has(target))) return true
  }
  return false
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
  /** The blocks' properties, read with them. */
  properties: Record<string, PropertyRow[]>
  /** The blocks' attachments, read with them. */
  attachments: Record<string, AttachmentRow[]>
  onBlocked: (blocker: PageModeBlocker) => void
  onNavigateToPage?: NavigateToPageFn | undefined
  cursorBlockId: string | null
  ref?: React.Ref<PageModeEditorHandle> | undefined
}

function PageModeDocument({
  pageId,
  blocks,
  properties: openedWith,
  attachments: openedWithAttachments,
  onBlocked,
  onNavigateToPage,
  cursorBlockId,
  ref,
}: PageModeDocumentProps): React.ReactElement {
  const { t: translate } = useTranslation()
  const resolve = useBlockResolve()
  const pageStore = usePageBlockStoreApi()
  const onTagClick = useTagClickHandler()
  const { handleToggleTodo, handleTogglePriority } = useBlockProperties()
  const editorRef = useRef<Editor | null>(null)
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const [properties] = useState(() => new PageProperties(openedWith))
  const [lists] = useState(() => new PageLists(openedWith, blocks))
  const [attachments] = useState(() => new PageAttachments(openedWithAttachments))
  // What the checkbox, the badge, the chips and the keys do, once the session runs.
  const actions = useRef<
    PageTaskActions & {
      pick: (step: () => Promise<void>, readAgain: boolean) => void
      setListStyle: (id: string, style: ListStyle) => void
      command: (item: PickerItem) => void
    }
  >({
    cycle: () => {},
    cyclePriority: () => {},
    setPriority: () => {},
    openDatePicker: () => {},
    openDateLinkPicker: () => {},
    openPropertyDrawer: () => {},
    propertiesEdited: () => {},
    attachmentsChanged: () => {},
    attach: () => {},
    edit: () => {},
    saveQuery: () => Promise.resolve(false),
    pick: () => {},
    setListStyle: () => {},
    command: () => {},
  })
  const [drawerBlockId, setDrawerBlockId] = useState<string | null>(null)
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
        blockOf: (id: string) => pageStore.getState().blocksById.get(id),
        propertiesOf: (id: string) => properties.of(id),
        attachmentsOf: (id: string) => attachments.of(id),
        subscribe: (listener: () => void) => {
          const unsubscribes = [
            pageStore.subscribe(listener),
            properties.subscribe(listener),
            attachments.subscribe(listener),
          ]
          return () => {
            for (const unsubscribe of unsubscribes) unsubscribe()
          }
        },
        cycle: (id: string) => actions.current.cycle(id),
        cyclePriority: (id: string) => actions.current.cyclePriority(id),
        setPriority: (id: string, level: '1' | '2' | '3') => actions.current.setPriority(id, level),
        openDatePicker: (id: string, mode: 'due' | 'schedule') =>
          actions.current.openDatePicker(id, mode),
        openDateLinkPicker: () => actions.current.openDateLinkPicker(),
        openPropertyDrawer: (id: string) => actions.current.openPropertyDrawer(id),
        propertiesEdited: () => actions.current.propertiesEdited(),
        attachmentsChanged: () => actions.current.attachmentsChanged(),
        attach: (id: string, files: File[]) => actions.current.attach(id, files),
        edit: (id: string) => actions.current.edit(id),
        saveQuery: (id: string, expression: string) => actions.current.saveQuery(id, expression),
        navigate: (id: string) => handleNavigateRef.current(id),
        resolveBlockTitle: resolve.resolveBlockTitle,
      },
      lists: {
        lists,
        setStyle: (id: string, style: ListStyle) => actions.current.setListStyle(id, style),
      },
      commands: {
        searchSlashCommands: searchPageSlashCommands,
        onSlashCommand: (item: PickerItem) => actions.current.command(item),
        searchPropertyKeys,
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
  // Block mode's tree publishes them: an embed's rows resolve their chips with them.
  const { resolveBlockTitle, resolveTagName, resolveBlockStatus, resolveTagStatus } = resolve
  const resolvers = useMemo(
    () => ({ resolveBlockTitle, resolveTagName, resolveBlockStatus, resolveTagStatus }),
    [resolveBlockTitle, resolveTagName, resolveBlockStatus, resolveTagStatus],
  )
  // Block mode's date picker: a chip's or a command's date, or a date's page linked at the caret.
  const datePicker = useBlockDatePicker({
    focusedBlockId: null,
    rootParentId: pageId,
    pageStore,
    rovingEditor: { editor },
    registerCreatedPage: resolve.registerCreatedPage,
    t: translate,
  })
  const {
    datePickerOpen,
    datePickerMode,
    setDatePickerOpen,
    setDatePickerMode,
    openDatePickerFor,
    handleDatePick,
  } = datePicker
  const slash = usePageSlashCommands({
    pageId,
    editor,
    pageStore,
    t: translate,
    datePicker,
    openPropertyDrawer: setDrawerBlockId,
    saveQuery: (id, expression) => actions.current.saveQuery(id, expression),
  })
  // The session reads these as they are when it needs them, not as it was built with.
  const blocked = useEffectEvent((blocker: PageModeBlocker) => onBlocked(blocker))
  const openingCursor = useEffectEvent(() => cursorBlockId)
  const cycleTask = useEffectEvent((id: string) => handleToggleTodo(id))
  const cyclePriority = useEffectEvent((id: string) => handleTogglePriority(id))
  const openDatePicker = useEffectEvent((id: string, mode: 'due' | 'schedule') =>
    openDatePickerFor(id, mode),
  )
  const openDateLinkPicker = useEffectEvent(() => {
    setDatePickerMode('date')
    setDatePickerOpen(true)
  })
  const runCommand = useEffectEvent((id: string, item: PickerItem) => slash.run(id, item))

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

    /** Bring the page as the store holds it into the document, unless it is over the cap. */
    const bringIn = async (
      fresh: readonly FlatBlock[],
      refused?: ReadonlySet<string>,
    ): Promise<void> => {
      const fit = await readPageFit(fresh, pageStore.getState().truncatedTotal ?? fresh.length)
      if (editor.isDestroyed) return
      if (fit.blocker !== null) {
        blocked(fit.blocker)
        return
      }
      await resolveLinks(fresh, () => editor.isDestroyed)
      if (editor.isDestroyed) return
      // Before the patch: a block it brings in draws its properties and marker at once.
      properties.take(fit.properties)
      lists.take(fit.properties)
      attachments.take(fit.attachments)
      const { keptAsNew } = applyRemote(editor.view, save, treeRows(fresh), newBlockId, refused)
      if (keptAsNew > 0) {
        notify.info(t('pageMode.keptAsNew', { count: keptAsNew }), {
          id: `page-mode-kept-${pageId}`,
        })
      }
    }

    /**
     * Commit the task markers, then the `key:: value` lines, then the tags,
     * typed in the blocks changed and left, or in all of them when page mode
     * closes.
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
        const lines = await commitPageProperties(id, loaded, save, api, task.markdown)
        refs.push(
          ...task.refs,
          ...lines.refs,
          ...(await commitPageTags(id, save, api, lines.markdown)),
        )
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
      } else if (result.refs.length > 0 && !editor.isDestroyed && embedsOwnBlock(save)) {
        // Block mode's save writes the store, which an embed of this page mirrors (`mirrorToSiblings`).
        await read()
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
    // While a change after its save runs: the flush a command asks for first
    // (`flushActiveDraft`) is that save, and one queued behind it would wait forever.
    let changing = false
    // After the save, so the block exists: an empty one is created for it (`keep`).
    const afterSave = (id: string, change: () => Promise<void>): Promise<void> => {
      clearTimeout(timer)
      return enqueue(async () => {
        save.keep.add(id)
        try {
          await runSave(false)
        } finally {
          save.keep.delete(id)
        }
        if (editor.isDestroyed || !save.saved.has(id)) return
        // A block created here since the store last loaded: the change reads its row there.
        if (!pageStore.getState().blocksById.has(id)) await read()
        changing = true
        try {
          await change()
        } finally {
          changing = false
        }
      })
    }
    const readAgain = (): void => {
      void enqueue(async () => {
        if (!editor.isDestroyed) await bringIn(await read())
      })
    }
    actions.current = {
      cycle: (id) => afterSave(id, () => cycleTask(id)),
      cyclePriority: (id) => afterSave(id, () => cyclePriority(id)),
      setPriority: (id, level) =>
        afterSave(id, () => setBlockPriority(pageStore, pageId, id, level)),
      openDatePicker,
      openDateLinkPicker,
      // After the save, so the block exists: the drawer writes to it.
      openPropertyDrawer: (id) =>
        afterSave(id, () => {
          setDrawerBlockId(id)
          return Promise.resolve()
        }),
      // Read again in turn with the saves: the page, its properties among it.
      propertiesEdited: () => {
        readAgain()
        // An editor closed by Enter or Escape left the focus nowhere: the caret goes
        // back, once that key is done with, or the Enter would split the block.
        setTimeout(() => {
          const focused = document.activeElement
          if (!editor.isDestroyed && (focused === null || focused === document.body)) {
            editor.view.focus()
          }
        })
      },
      attachmentsChanged: readAgain,
      // Block mode's upload, once the block exists; an image also goes in at the caret, as block
      // mode puts it there, if the caret is still in that block once uploaded. It reads the page
      // again itself.
      attach: (id, files) => {
        let attached = false
        void afterSave(id, async () => {
          attached = true
          await processFileAttachments(files, id, t, {
            editor,
            // Read once uploaded, as block mode's roving handle is: the caret may have moved on.
            get activeBlockId() {
              return cursorBlock()
            },
          })
        }).then(() => {
          // The block was gone, or its save failed: say so rather than drop the files.
          if (!attached) notify.error(t('blockTree.attachFileFailed'))
        })
      },
      // As a click on block mode's static block, which takes it into editing.
      edit: (id) => {
        cursorInto(editor, id)
      },
      // Written in turn with the saves: the read its change to the store asks for comes after it.
      saveQuery: (id, expression) => {
        let saved = false
        return afterSave(id, async () => {
          saved = await pageStore.getState().edit(id, `{{query ${expression}}}`)
        }).then(() => saved)
      },
      // A date picked: written in turn with the saves, so no read of a save's overtakes it.
      // An until date is a property, which page mode shows from its own read.
      pick: (step, again) => {
        void enqueue(step)
        if (again) readAgain()
      },
      // Shown at once, so the next key reads it; written once the block exists, as block mode writes it.
      setListStyle: (id, style) => {
        if (lists.styleOf(id) === style) return
        const seq = lists.want(id, style)
        // Refused, or not run as the block was not saved: it shows the style last read.
        let written: ListStyle | null = null
        void afterSave(id, async () => {
          try {
            await setListStyle(id, style)
            written = style
          } catch (err) {
            logger.error('PageModeEditor', 'Failed to write a list style', { id, style }, err)
            notify.error(
              t(
                style === 'none'
                  ? 'blockTree.clearListStyleFailed'
                  : 'blockTree.setListStyleFailed',
              ),
            )
          }
        }).then(() => lists.settle(id, seq, written))
      },
      // Block mode's handler on the caret's block: a command that writes to it after the save.
      command: (item) => {
        const id = cursorBlock()
        if (id === null) return
        if (runsInDocument(item.id)) void runCommand(id, item)
        else void afterSave(id, () => runCommand(id, item)).then(readAgain)
      },
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
      unregisterDraft = registerActiveDraftFlush(pageId, () =>
        changing ? Promise.resolve() : flush(),
      )
    }
    const onBlur = (): void => void flush()
    // As block mode's draft autosave: the window hidden or closing saves now.
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') void flush()
    }
    const onPageHide = (): void => void flush()
    // An upload, or a revert elsewhere, changed attachments outside the list's own handlers.
    const unsubscribeAttachments = subscribeToAttachmentInvalidation(readAgain)
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
      unsubscribeAttachments()
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
  }, [editor, pageId, blocks, pageStore, properties, lists, attachments])

  // The picker closed: the caret goes back where it was. The dialog's own
  // restore aims at its date field, which its autofocus took first.
  const pickerWasOpen = useRef(false)
  useEffect(() => {
    if (datePickerOpen) pickerWasOpen.current = true
    else if (pickerWasOpen.current && editor !== null && !editor.isDestroyed) {
      pickerWasOpen.current = false
      editor.view.focus()
    }
  }, [datePickerOpen, editor])

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
      <BlockResolversProvider value={resolvers}>
        <EditorContent editor={editor} />
      </BlockResolversProvider>
      {/* Block mode's own: the marks and the link on a selection, and Ctrl+K. */}
      {editor !== null && <SelectionBubbleMenu editor={editor} />}
      {datePickerOpen && (
        <Suspense fallback={null}>
          <BlockDatePicker
            onSelect={(day) => {
              if (day === undefined) return
              // Closes now: the pick waits its turn behind the saves, and
              // `handleDatePick` closes the picker only when it runs.
              setDatePickerOpen(false)
              actions.current.pick(() => handleDatePick(day), datePickerMode === 'repeat-until')
            }}
            onClose={() => setDatePickerOpen(false)}
          />
        </Suspense>
      )}
      {drawerBlockId !== null && (
        <Suspense fallback={null}>
          <BlockPropertyDrawer
            blockId={drawerBlockId}
            open
            onOpenChange={(open) => {
              if (open) return
              setDrawerBlockId(null)
              actions.current.propertiesEdited()
            }}
          />
        </Suspense>
      )}
      {slash.dialogs}
    </>
  )
}
