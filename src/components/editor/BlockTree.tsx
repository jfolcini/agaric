/**
 * BlockTree — thin orchestrator composing extracted feature components.
 *
 * Delegates to:
 * - useBlockCollapse — collapse/expand state
 * - useBlockZoom — zoom navigation + breadcrumbs
 * - useBlockLinkResolve — `[[ULID]]` cache scan + batch resolve (MAINT-128)
 * - useBlockPropertiesBatch — per-block extra-property fetch (MAINT-128)
 * - useBlockNavigateToLink — `handleNavigate` + `handleNavigateRef` (MAINT-128)
 * - useBlockFlush — editor flush + split + checkbox/todo persistence
 * - useBlockAutoCreateFirstBlock — H-9 first-block-on-empty-page effect
 * - useBlockTreeContextBags — memoised action + resolver bags (MAINT-118)
 * - BlockZoomBar — zoom breadcrumb UI
 * - BlockListRenderer — SortableContext + block map
 * - BlockHistorySheet — block history overlay
 * - BlockPropertyDrawerSheet — property drawer overlay
 * - BlockDnDOverlay — drag preview
 */

import { closestCenter, DndContext, MeasuringStrategy } from '@dnd-kit/core'
import type React from 'react'
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { BlockBatchActionMenu } from '@/components/block-tree/BlockBatchActionMenu'
import { BlockDatePicker } from '@/components/block-tree/BlockDatePicker'
import { BlockDndOverlay } from '@/components/block-tree/BlockDndOverlay'
import { TemplatePicker } from '@/components/block-tree/TemplatePicker'
import { useBlockAutoCreateFirstBlock } from '@/components/block-tree/use-block-auto-create-first-block'
import { useBlockFlush } from '@/components/block-tree/use-block-flush'
import { useBlockTreeContextBags } from '@/components/block-tree/use-block-tree-context-bags'
import { useBlockZoomEmptySeed } from '@/components/block-tree/use-block-zoom-empty-seed'
import { QueryBuilderModal } from '@/components/dialogs/QueryBuilderModal'
import { BlockHistorySheet } from '@/components/editor/BlockHistorySheet'
import { BlockListRenderer } from '@/components/editor/BlockListRenderer'
import { BlockPropertyDrawerSheet } from '@/components/editor/BlockPropertyDrawerSheet'
import { BlockZoomBar } from '@/components/editor/BlockZoomBar'
import { EmojiPickerDialog } from '@/components/EmojiPicker'
import { Skeleton } from '@/components/ui/skeleton'
import { getActiveEditor, setActiveEditor } from '@/editor/active-editor'
import { insertEmojiIntoActiveEditor } from '@/editor/insert-emoji'
import type { PickerItem } from '@/editor/SuggestionList'
import { useBlockKeyboard } from '@/editor/use-block-keyboard'
import { type RovingEditorHandle, useRovingEditor } from '@/editor/use-roving-editor'
import { BatchAttachmentsProvider } from '@/hooks/useBatchAttachments'
import { BlockActionsProvider } from '@/hooks/useBlockActions'
import { useBlockCollapse } from '@/hooks/useBlockCollapse'
import { useBlockDatePicker } from '@/hooks/useBlockDatePicker'
import { useBlockDnD } from '@/hooks/useBlockDnD'
import { useBlockKeyboardHandlers } from '@/hooks/useBlockKeyboardHandlers'
import { useBlockLinkResolve } from '@/hooks/useBlockLinkResolve'
import { useBlockMultiSelect } from '@/hooks/useBlockMultiSelect'
import { useBlockNavigateToLink } from '@/hooks/useBlockNavigateToLink'
import { useBlockProperties } from '@/hooks/useBlockProperties'
import { useBlockPropertiesBatch } from '@/hooks/useBlockPropertiesBatch'
import { useBlockResolve } from '@/hooks/useBlockResolve'
import { BlockResolversProvider } from '@/hooks/useBlockResolvers'
import {
  searchPropertyKeys,
  searchSlashCommands,
  useBlockSlashCommands,
} from '@/hooks/useBlockSlashCommands'
import { useBlockTreeEventListeners } from '@/hooks/useBlockTreeEventListeners'
import { useBlockTreeKeyboardShortcuts } from '@/hooks/useBlockTreeKeyboardShortcuts'
import { useBlockZoom } from '@/hooks/useBlockZoom'
import { useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { useViewportObserver } from '@/hooks/useViewportObserver'
import { serializeBlockSubtree } from '@/lib/block-clipboard'
import type { NavigateToPageFn } from '@/lib/block-events'
import type { BlockTypeToken } from '@/lib/block-type-convert'
import { convertBlockContent } from '@/lib/block-type-convert'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { deleteDraft, editBlock, setProperty } from '@/lib/tauri'
import { getDragDescendants } from '@/lib/tree-utils'
import { useBlockStore } from '@/stores/blocks'
import { usePageBlockStore, usePageBlockStoreApi } from '@/stores/page-blocks'

export { processCheckboxSyntax } from '@/lib/block-utils'

export { guessMimeType } from '@/lib/file-utils'

/**
 * Stable DnD measuring config — module-level to avoid re-creation per render.
 *
 * `WhileDragging` re-measures droppables only between drag operations
 * (and on every drag move), not on unrelated state changes. For our
 * usage this is identical to `Always` for drag UX because the tree
 * does not manually invalidate measurements via `measureDroppables()`
 * — the dnd-kit defaults handle the measurement lifecycle. See the
 * `DndContext` block below: only the standard `onDragStart` /
 * `onDragMove` / `onDragOver` / `onDragEnd` / `onDragCancel`
 * callbacks are wired, no manual measurement plumbing depends on
 * `Always`. (design-system-perf-review-2026-05-09.md item 14.)
 */
const DND_MEASURING = {
  droppable: { strategy: MeasuringStrategy.WhileDragging },
} as const

interface BlockTreeProps {
  /** Optional parent block ID -- when set, loads children of this block. */
  parentId?: string | undefined
  /** Navigate to a page in the page editor (cross-page navigation).
   *  Optional blockId scrolls to a specific block within the target page. */
  onNavigateToPage?: NavigateToPageFn | undefined
  /** When true (default), auto-creates an empty first block on empty pages.
   *  Set to false to suppress auto-creation (e.g. weekly/monthly journal views). */
  autoCreateFirstBlock?: boolean | undefined
}

export function BlockTree({
  parentId,
  onNavigateToPage,
  autoCreateFirstBlock = true,
}: BlockTreeProps = {}): React.ReactElement {
  const { t } = useTranslation()
  // Per-page data from context
  const { blocks, blocksById, rootParentId, loading } = usePageBlockStore(
    useShallow((s) => ({
      blocks: s.blocks,
      blocksById: s.blocksById,
      rootParentId: s.rootParentId,
      loading: s.loading,
    })),
  )
  // Global focus/selection
  const { focusedBlockId, selectedBlockIds } = useBlockStore(
    useShallow((s) => ({ focusedBlockId: s.focusedBlockId, selectedBlockIds: s.selectedBlockIds })),
  )

  // Per-page store API for imperative access
  const pageStore = usePageBlockStoreApi()
  const {
    load,
    remove,
    edit,
    splitBlock,
    indent,
    dedent,
    reorder,
    moveToParent,
    moveBlocks,
    moveUp,
    moveDown,
    createBelow,
  } = pageStore.getState()
  // Global focus/selection actions
  const { setFocused, toggleSelected, clearSelected } = useBlockStore.getState()
  const {
    rangeSelect: rawRangeSelect,
    selectAll: rawSelectAll,
    extendSelection,
  } = useBlockStore.getState()

  // ── Collapse hook (state + visible block filtering) ────────────────
  // onBeforeCollapse needs handleFlush (defined later), so use a ref indirection.
  const handleBeforeCollapseRef = useRef<((blockId: string) => void) | undefined>(undefined)
  const {
    collapsedIds,
    toggleCollapse,
    visibleBlocks: collapsedVisible,
    hasChildrenSet,
  } = useBlockCollapse(blocks, {
    onBeforeCollapse: (blockId) => handleBeforeCollapseRef.current?.(blockId),
    // #752 — persistence is scoped per page root (one pruned localStorage
    // entry per page instead of one unbounded global key).
    pageKey: rootParentId,
  })

  // ── Zoom hook (state + breadcrumb + zoomed view) ───────────────────
  const {
    zoomedBlockId,
    zoomIn: handleZoomIn,
    zoomToRoot,
    breadcrumbs: zoomBreadcrumb,
    zoomedVisible,
  } = useBlockZoom(blocks, collapsedVisible)

  // #1063 — the ids of the rows actually rendered (collapsed/zoomed-out blocks
  // filtered out). Both mouse Shift+Click range-select (handleSelect) and the
  // Shift+Arrow keyboard range-select slice against this so neither ever pulls
  // an invisible block into the selection. Memoized so the document keydown
  // listener (useBlockTreeKeyboardShortcuts) doesn't re-attach every render.
  const visibleIds = useMemo(() => zoomedVisible.map((b) => b.id), [zoomedVisible])

  // ── Enter-creates-block refs ───────────────────────────────────────
  const justCreatedBlockIds = useRef(new Set<string>())
  const prevFocusedRef = useRef<string | null>(null)

  // ── History sheet state ────────────────────────────────────────────
  const [historyBlockId, setHistoryBlockId] = useState<string | null>(null)

  // ── Property drawer state ──────────────────────────────────────────
  const [propertyDrawerBlockId, setPropertyDrawerBlockId] = useState<string | null>(null)

  // ── Query builder (#215): /query opens the visual builder; on save we
  // write `{{query …}}` to the block it was launched from. ──────────────
  const [queryBuilderOpen, setQueryBuilderOpen] = useState(false)
  const [queryBuilderBlockId, setQueryBuilderBlockId] = useState<string | null>(null)

  // ── Emoji picker (#286): /emoji opens the browse-grid dialog; on select we
  // insert the chosen native emoji at the caret of the focused block editor. ─
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)

  const handleShowHistory = useCallback((blockId: string) => {
    setHistoryBlockId(blockId)
  }, [])

  const handleShowProperties = useCallback((blockId: string) => {
    setPropertyDrawerBlockId(blockId)
  }, [])

  // ── Extracted hooks ────────────────────────────────────────────────
  const resolve = useBlockResolve()
  const onTagClick = useTagClickHandler()
  const properties = useBlockProperties()
  const { handleToggleTodo, handleTogglePriority } = properties

  // ── Cross-callback ref indirections ────────────────────────────────
  // `useRovingEditor` (below) captures these refs before the matching
  // handlers exist. `handleNavigateRef` is owned by `useBlockNavigateToLink`;
  // the rest are populated further down in this component.
  const handleSlashCommandRef = useRef<(item: PickerItem) => void>(() => {})
  const handleCheckboxRef = useRef<(state: 'TODO' | 'DONE') => void>(() => {})
  const handlePropertySelectRef = useRef<(item: PickerItem) => void>(() => {})

  // ── Refs that bridge handlers defined later in the render ──────────
  // `rovingEditorRef` is read by `handleNavigate` (and others) which run
  // before `useRovingEditor` returns; `handleFlushRef` is read by
  // `handleNavigate` whose hook runs before `handleFlush` is created.
  const rovingEditorRef = useRef<RovingEditorHandle | null>(null)
  const handleFlushRef = useRef<() => string | null>(() => null)

  // ── Block-link navigation hook (owns handleNavigateRef indirection) ─
  const { handleNavigate, handleNavigateRef } = useBlockNavigateToLink({
    rovingEditorRef,
    handleFlushRef,
    load,
    setFocused,
    rootParentId,
    onNavigateToPage,
    t,
  })

  // ── Context-aware placeholder for the editor ────────────────────────
  // UX-309: default empty-block placeholder advertises the slash-command palette,
  // which was previously only discoverable via `?` keyboard help. The first child
  // of an empty page keeps the more specific template hint.
  const editorPlaceholder = useMemo(() => {
    const defaultPlaceholder = t('editor.emptyBlockPlaceholder')
    if (!focusedBlockId || blocks.length === 0) return defaultPlaceholder
    const focused = blocksById.get(focusedBlockId)
    if (!focused) return defaultPlaceholder
    const isFirstChild = blocks[0]?.id === focusedBlockId
    const isEmpty = !focused.content || focused.content.trim() === ''
    if (isFirstChild && isEmpty) {
      return t('editor.templatePlaceholder')
    }
    return defaultPlaceholder
  }, [focusedBlockId, blocks, blocksById, t])

  const rovingEditor = useRovingEditor({
    resolveBlockTitle: resolve.resolveBlockTitle,
    resolveTagName: resolve.resolveTagName,
    onNavigate: (id: string) => handleNavigateRef.current(id),
    onTagClick,
    searchTags: resolve.searchTags,
    searchPages: resolve.searchPages,
    searchBlockRefs: resolve.searchBlockRefs,
    onCreatePage: resolve.onCreatePage,
    onCreateTag: resolve.onCreateTag,
    searchSlashCommands,
    onSlashCommand: (item: PickerItem) => handleSlashCommandRef.current(item),
    onCheckbox: (state: 'TODO' | 'DONE') => handleCheckboxRef.current(state),
    searchPropertyKeys,
    onPropertySelect: (item: PickerItem) => handlePropertySelectRef.current(item),
    placeholder: editorPlaceholder,
  })

  // (#752) `rovingEditorRef` is synced in the consolidated ref-sync layout
  // effect below — writing it here during render was a concurrent-rendering
  // hazard (a thrown/abandoned render would publish a handle from a render
  // that never committed).

  // #82 (PEND-66) — publish this BlockTree's roving editor to the module
  // registry so app-level UI outside the tree (the command palette's
  // `[[Page]]` insert) can run undo-preserving commands. Keyed on FOCUS,
  // not mount: the journal week/month views mount several BlockTrees at
  // once, so "the editor to insert into" is the one the caret was last
  // in — not whichever mounted last. We do NOT clear on blur (opening the
  // palette blurs the editor, yet that editor is still the target); the
  // unmount clear is guarded so it can't clobber another live instance.
  useEffect(() => {
    const editor = rovingEditor.editor
    if (editor == null) return
    const publish = (): void => setActiveEditor(editor)
    if (editor.isFocused) publish()
    editor.on('focus', publish)
    return () => {
      editor.off('focus', publish)
      if (getActiveEditor() === editor) setActiveEditor(null)
    }
  }, [rovingEditor.editor])

  const viewport = useViewportObserver()

  // ── Date picker hook ───────────────────────────────────────────────
  const {
    datePickerOpen,
    datePickerCursorPos,
    setDatePickerOpen,
    setDatePickerMode,
    handleDatePick,
  } = useBlockDatePicker({
    focusedBlockId,
    rootParentId,
    pageStore,
    rovingEditor,
    pagesListRef: resolve.pagesListRef,
    t,
  })

  // ── Query builder (#215) — /query opens the modal for the focused block;
  // on save, write the generated `{{query …}}` expression to that block. ──
  const openQueryBuilder = () => {
    setQueryBuilderBlockId(focusedBlockId)
    // Mark the open as a non-urgent transition: opening it synchronously
    // inside the slash-command handler blurs the editor while React is
    // mid-render, and the editor's blur flush (`flushSync` in useEditorBlur)
    // then warns "flushSync called from inside a lifecycle method".
    // startTransition lets the current commit settle first, avoiding that.
    startTransition(() => setQueryBuilderOpen(true))
  }
  // ── Emoji picker (#286) — /emoji opens the browse-grid dialog for the
  // focused block. Mark the open as a non-urgent transition for the same
  // reason as the query builder (avoid a flushSync-in-render warning from
  // the editor blur flush when the dialog steals focus mid-commit). ──────────
  const openEmojiPicker = () => {
    startTransition(() => setEmojiPickerOpen(true))
  }
  // Insert the chosen native emoji at the caret via the active roving editor.
  // The dialog dismisses itself on select (closeOnSelect default).
  const handleEmojiSelect = useCallback((char: string) => {
    insertEmojiIntoActiveEditor(char)
  }, [])

  const handleQuerySave = async (expression: string) => {
    // Capture the target block once at entry; `queryBuilderBlockId` is read
    // from closure and may change while we await the write (#1016).
    const blockId = queryBuilderBlockId
    if (!blockId) return
    // `edit()` handles its own error path (rollback + generic save-failed
    // toast) and resolves `false` on failure rather than throwing. Keep the
    // dialog open in that case so the user doesn't lose the query they built;
    // only close + reload once the write actually landed.
    const ok = await pageStore.getState().edit(blockId, `{{query ${expression}}}`)
    if (!ok) return
    // Re-validate after the await: if the dialog closed or moved to a
    // different block mid-flight, don't clobber the now-current state.
    if (queryBuilderBlockId !== blockId) return
    setQueryBuilderOpen(false)
    await load()
  }

  // #264 — "Turn into" from the block context-menu. Converts the right-clicked
  // / long-pressed block (which may differ from the focused block) to the
  // chosen type by rewriting its markdown content via the shared
  // `convertBlockContent` helper — the same conversion the `/turn` slash
  // command runs, so the logic is not duplicated.
  const handleTurnInto = useCallback(
    async (blockId: string, blockType: BlockTypeToken) => {
      const current = pageStore.getState().blocksById.get(blockId)
      if (!current) return
      try {
        await editBlock(blockId, convertBlockContent(current.content ?? '', blockType))
        await load()
      } catch (err) {
        logger.error('BlockTree', 'Failed to convert block', { blockId, blockType }, err)
        notify.error(t('slash.turnIntoFailed'))
      }
    },
    [pageStore, load, t],
  )

  // #976 (item 13) — Duplicate a block + its subtree, inserting the copy
  // immediately after the original at the same depth. This reuses the existing
  // copy/paste-outline store ops (`serializeBlockSubtree` → `pasteBlocks`)
  // rather than introducing a new clone op: serialize just this block's subtree
  // to indented markdown, then paste it anchored on the original (paste inserts
  // after the anchor at the anchor's depth). No new store op is required.
  const handleDuplicate = useCallback(
    async (blockId: string) => {
      const state = pageStore.getState()
      if (!state.blocksById.has(blockId)) return
      const markdown = serializeBlockSubtree(state.blocks, [blockId])
      if (markdown.length === 0) return
      try {
        await state.pasteBlocks(blockId, markdown)
      } catch (err) {
        logger.error('BlockTree', 'Failed to duplicate block', { blockId }, err)
        notify.error(t('blockTree.duplicateFailed'))
      }
    },
    [pageStore, t],
  )

  // ── Slash commands hook ────────────────────────────────────────────
  const {
    handleSlashCommand,
    handleTemplateSelect,
    handleCheckboxSyntax,
    templatePickerOpen,
    setTemplatePickerOpen,
    templatePages,
  } = useBlockSlashCommands({
    focusedBlockId,
    rootParentId,
    pageStore,
    rovingEditor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    blocks,
    load,
    t,
    openQueryBuilder,
    openEmojiPicker,
  })

  // ── Multi-select hook ──────────────────────────────────────────────
  const {
    batchDeleteConfirm,
    batchInProgress,
    setBatchDeleteConfirm,
    handleBatchSetTodo,
    handleBatchDelete,
  } = useBlockMultiSelect({
    selectedBlockIds,
    clearSelected,
    rootParentId,
    pageStore,
    t,
  })

  // Reload + reset zoom when the page changes (parentId). `load` and
  // `zoomToRoot` are stable identities, so listing them is safe and only
  // `parentId` actually drives re-runs.
  useEffect(() => {
    load()
    zoomToRoot()
  }, [load, parentId, zoomToRoot])

  // ── H-9: Auto-create first block on empty pages ─────────────────────
  useBlockAutoCreateFirstBlock({
    enabled: autoCreateFirstBlock,
    loading,
    blocksLength: blocks.length,
    rootParentId,
    pageStore,
    t,
  })

  // ── #922: seed a first child when zoomed into an empty (leaf) block ──
  // Keyboard zoom-in no longer requires children, so a zoomed leaf would
  // otherwise show a blank pane. Insert a child UNDER the zoom root via a
  // non-wholesale splice (the page outside the zoom root is preserved).
  useBlockZoomEmptySeed({
    enabled: autoCreateFirstBlock,
    loading,
    zoomedBlockId,
    pageStore,
    t,
  })

  // Scan loaded blocks for [[ULID]] tokens not yet in the resolve cache
  // and batch-fetch them. See `useBlockLinkResolve` for the cache-scope
  // and FEAT-3p7 rationale.
  useBlockLinkResolve(blocks)

  // Per-block "extra" properties (everything except the four built-in
  // todo/priority/due/scheduled fields) for the row-rendering UI.
  const blockProperties = useBlockPropertiesBatch(blocks)

  // ── Editor flush callback (split + checkbox/todo persistence) ──────
  const handleFlush = useBlockFlush({
    rovingEditorRef,
    edit,
    splitBlock,
    rootParentId,
    pageStore,
    t,
  })

  // (`handleFlushRef` — read lazily by `useBlockNavigateToLink` — is synced
  // in the consolidated ref-sync layout effect below, #752.)

  // ── Scroll container ref (for auto-scroll during drag) ──────────────
  const scrollContainerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    scrollContainerRef.current = document.getElementById('main-content')
  }, [])

  // ── DnD hook (needs handleFlush + collapsedVisible) ────────────────
  // #712: when zoomed, the DnD projection's "root" is the zoomed block, not
  // the page root. `zoomedVisible` rebases `depth` to 0 at the zoomed block's
  // children but keeps real `parent_id`s, so a depth-0 drop must resolve to
  // the zoomed block — passing the page `rootParentId` here made every
  // in-place reorder look like a reparent and ejected the block out of the
  // zoomed subtree.
  const dnd = useBlockDnD({
    blocks,
    collapsedVisible: zoomedVisible,
    rootParentId: zoomedBlockId ?? rootParentId,
    rovingEditor,
    // #914 — feed the global multi-selection so dragging a selected block moves
    // the whole selection (the hook collapses it to roots + branches on >1).
    selectedBlockIds,
    handleFlush,
    setFocused,
    reorder,
    moveToParent,
    moveBlocks,
    scrollContainerRef,
  })

  // (`handleBeforeCollapseRef` is wired in the consolidated ref-sync layout
  // effect below, #752, now that `handleFlush` is available.)

  // ── B-14: Clear focus when zoom changes and focused block is outside view ──
  useEffect(() => {
    if (zoomedBlockId === null) return // root view — all blocks visible
    const { focusedBlockId: fid } = useBlockStore.getState()
    if (!fid) return
    const descendants = getDragDescendants(blocks, zoomedBlockId)
    if (!descendants.has(fid)) {
      handleFlush()
      setFocused(null)
    }
  }, [zoomedBlockId, blocks, handleFlush, setFocused])

  const handlePropertySelect = useCallback(
    (item: PickerItem) => {
      if (!focusedBlockId) return
      setProperty({ blockId: focusedBlockId, key: item.label, valueText: '' }).catch(
        (err: unknown) => {
          logger.error(
            'BlockTree',
            'Failed to set property from slash command',
            {
              blockId: focusedBlockId,
              key: item.label,
            },
            err,
          )
          notify.error(t('blockTree.setPropertyFailed'))
        },
      )
    },
    [focusedBlockId, t],
  )

  // ── Consolidated late-bound ref sync (#752) ─────────────────────────
  // These refs bridge handlers created at different points of this render
  // to hooks that captured the ref objects earlier (`useRovingEditor`
  // callbacks, `useBlockNavigateToLink`, `useBlockCollapse`). They used to
  // be written DURING render, which is a concurrent-rendering hazard: a
  // render React throws away (StrictMode double-render, a suspended or
  // aborted concurrent pass) would still have published its handlers. All
  // of these refs are read exclusively at event time, never during render,
  // so syncing them once per commit in a layout effect (before the browser
  // paints, hence before any user event can read them) is equivalent and
  // safe. No dependency array on purpose — the sync must track every commit.
  // (`handleNavigateRef` is owned by `useBlockNavigateToLink` above.)
  useLayoutEffect(() => {
    rovingEditorRef.current = rovingEditor
    handleFlushRef.current = handleFlush
    handleSlashCommandRef.current = handleSlashCommand
    handleCheckboxRef.current = handleCheckboxSyntax
    handlePropertySelectRef.current = handlePropertySelect
    // onBeforeCollapse — rescue focus (flush + clear) when the collapsing
    // subtree contains the focused block.
    handleBeforeCollapseRef.current = (blockId: string) => {
      if (focusedBlockId) {
        const descendants = getDragDescendants(blocks, blockId)
        if (descendants.has(focusedBlockId)) {
          handleFlush()
          setFocused(null)
        }
      }
    }
  })

  // ── Draft discard callback for Escape ────────────────────────────────
  const handleDiscardDraft = useCallback((blockId: string) => {
    deleteDraft(blockId).catch((err: unknown) => {
      logger.warn('BlockTree', 'Failed to delete draft on discard', { blockId }, err)
    })
  }, [])

  // ── Keyboard handlers hook ─────────────────────────────────────────
  const {
    handleFocusPrev,
    handleFocusNext,
    handleDeleteBlock,
    handleIndent: handleIndentKey,
    handleDedent: handleDedentKey,
    handleMoveUp,
    handleMoveDown,
    handleMoveUpById,
    handleMoveDownById,
    handleMergeWithPrev,
    handleMergeById,
    handleEnterSave,
    handleEscapeCancel,
  } = useBlockKeyboardHandlers({
    focusedBlockId,
    collapsedVisible,
    rovingEditor,
    setFocused,
    handleFlush,
    remove,
    edit,
    indent,
    dedent,
    moveUp,
    moveDown,
    createBelow,
    justCreatedBlockIds,
    discardDraft: handleDiscardDraft,
    t,
  })

  // ── Multi-selection handler (Ctrl+Click / Shift+Click) ──────────────
  const handleSelect = useCallback(
    (blockId: string, mode: 'toggle' | 'range') => {
      if (mode === 'toggle') {
        toggleSelected(blockId)
      } else {
        // #1063 — slice against the RENDERED rows only. Passing the full
        // `blocks` list silently pulled every collapsed/zoomed-out block
        // between the two clicked rows into the selection (then batch
        // deleted/modified). Matches the keyboard range-select path.
        rawRangeSelect(blockId, visibleIds)
      }
    },
    [toggleSelected, rawRangeSelect, visibleIds],
  )

  // Stable identities so `useBlockKeyboard` doesn't detach/re-attach the
  // document keydown listener on every BlockTree render (block edits,
  // selection changes, text input). Inline arrows here would defeat that.
  const handleToggleFocusedTodo = useCallback(() => {
    if (focusedBlockId) handleToggleTodo(focusedBlockId)
  }, [focusedBlockId, handleToggleTodo])
  const handleToggleFocusedCollapse = useCallback(() => {
    if (focusedBlockId) toggleCollapse(focusedBlockId)
  }, [focusedBlockId, toggleCollapse])
  const handleShowFocusedProperties = useCallback(() => {
    if (focusedBlockId) handleShowProperties(focusedBlockId)
  }, [focusedBlockId, handleShowProperties])
  // #976 (item 15) — open the block-history drawer for the focused block via
  // the `openBlockHistory` keyboard binding, mirroring the properties path.
  const handleShowFocusedHistory = useCallback(() => {
    if (focusedBlockId) handleShowHistory(focusedBlockId)
  }, [focusedBlockId, handleShowHistory])

  useBlockKeyboard(rovingEditor.editor, {
    onFocusPrev: handleFocusPrev,
    onFocusNext: handleFocusNext,
    onDeleteBlock: handleDeleteBlock,
    onIndent: handleIndentKey,
    onDedent: handleDedentKey,
    onMoveUp: handleMoveUp,
    onMoveDown: handleMoveDown,
    onFlush: handleFlush,
    onMergeWithPrev: handleMergeWithPrev,
    onEnterSave: handleEnterSave,
    onEscapeCancel: handleEscapeCancel,
    onToggleTodo: handleToggleFocusedTodo,
    onToggleCollapse: handleToggleFocusedCollapse,
    onShowProperties: handleShowFocusedProperties,
    onShowHistory: handleShowFocusedHistory,
  })

  // ── Extracted event listeners (custom DOM events from toolbar) ───────
  useBlockTreeEventListeners({
    focusedBlockId,
    rootParentId,
    handleEscapeCancel,
    handleToggleTodo,
    handleTogglePriority,
    handleShowProperties,
    rovingEditor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    pageStore,
    t,
  })

  // ── Empty-block cleanup: delete just-created blocks left empty ─────
  useEffect(() => {
    const prevId = prevFocusedRef.current
    prevFocusedRef.current = focusedBlockId

    if (prevId && prevId !== focusedBlockId && justCreatedBlockIds.current.has(prevId)) {
      justCreatedBlockIds.current.delete(prevId)
      const block = pageStore.getState().blocksById.get(prevId)
      if (block && (!block.content || block.content.trim() === '')) {
        remove(prevId)
      }
    }
  }, [focusedBlockId, remove, pageStore])

  // ── Extracted keyboard shortcuts (document-level keydown listeners) ─
  useBlockTreeKeyboardShortcuts({
    focusedBlockId,
    pageStore,
    selectedBlockIds,
    hasChildrenSet,
    blocks,
    // #922 — Shift+Arrow keyboard range-select steps through the RENDERED list
    // (`zoomedVisible` == `collapsedVisible` at root view), so it matches what
    // the user sees and respects collapsed/zoomed visibility.
    visibleIds,
    toggleCollapse,
    rawSelectAll,
    extendSelection,
    clearSelected,
    handleFlush,
    setFocused,
    handleToggleTodo,
    handleSlashCommand,
    rovingEditor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    zoomedBlockId,
    zoomToRoot,
    zoomIn: handleZoomIn,
  })

  // ── Click on whitespace within block tree closes editor (UX-M9) ──
  const handleContainerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.target !== e.currentTarget) return
      const { focusedBlockId: fid } = useBlockStore.getState()
      if (!fid) return
      // If the editor DOM still has focus, blur it so EditableBlock's
      // handleBlur fires the normal save-and-close path.
      const proseMirror = document.querySelector('.ProseMirror')
      if (proseMirror?.contains(document.activeElement)) {
        ;(document.activeElement as HTMLElement)?.blur()
      } else {
        // Editor is mounted but already unfocused — flush (save + split) before closing
        handleFlush()
        setFocused(null)
      }
    },
    [handleFlush, setFocused],
  )

  // ── Active item for DragOverlay ────────────────────────────────────
  const activeBlock = dnd.activeId ? (blocksById.get(dnd.activeId) ?? null) : null
  // R8 (#407): how many blocks the drag is actually moving (the active block
  // plus its descendant subtree) — surfaced as a badge on the overlay.
  // #752 — count over the FULL `blocks` list, not `collapsedVisible`: a drag
  // always moves the whole subtree, so dragging a COLLAPSED parent (whose
  // children are filtered out of `collapsedVisible`) must still show the
  // real subtree size instead of "1". Memoised: BlockTree re-renders on every
  // drag-move (`offsetLeft`/`overId` state in useBlockDnD), while `blocks`
  // and `activeId` are stable for the whole drag — without the memo the O(n)
  // subtree scan would re-run per pointer move on large pages.
  // #914 — when the drag is a multi-select move, the badge must reflect the
  // number of blocks ACTUALLY moving: every selection root plus its subtree.
  // (Roots are already de-nested, so their subtrees don't overlap.) Otherwise
  // it's the single active block + its subtree, as before.
  const draggingCount = useMemo(() => {
    if (!dnd.activeId) return 1
    if (dnd.isMultiDrag) {
      return dnd.dragRoots.reduce(
        (sum, rootId) => sum + getDragDescendants(blocks, rootId).size + 1,
        0,
      )
    }
    return getDragDescendants(blocks, dnd.activeId).size + 1
  }, [blocks, dnd.activeId, dnd.isMultiDrag, dnd.dragRoots])

  // ── Action / resolver bags published via context (MAINT-118) ────────
  // Memoised so descendants only re-render when callbacks change.
  const { blockActions, blockResolvers } = useBlockTreeContextBags({
    onNavigate: handleNavigate,
    onDelete: remove,
    onIndent: indent,
    onDedent: dedent,
    onMoveUp: handleMoveUpById,
    onMoveDown: handleMoveDownById,
    onMerge: handleMergeById,
    onToggleTodo: handleToggleTodo,
    onTogglePriority: handleTogglePriority,
    onToggleCollapse: toggleCollapse,
    onShowHistory: handleShowHistory,
    onShowProperties: handleShowProperties,
    onZoomIn: handleZoomIn,
    onSelect: handleSelect,
    onTurnInto: handleTurnInto,
    // `void` adapts the async handler to the bag's `(blockId) => void` shape.
    onDuplicate: (blockId: string) => void handleDuplicate(blockId),
    // Fix 6 — bulk-delete the active multi-selection from the long-press /
    // right-click context menu (single IPC + undo toast). `void` adapts the
    // async handler to the bag's `() => void` shape.
    onBatchDelete: () => void handleBatchDelete(),
    resolveBlockTitle: resolve.resolveBlockTitle,
    resolveTagName: resolve.resolveTagName,
    resolveBlockStatus: resolve.resolveBlockStatus,
    resolveTagStatus: resolve.resolveTagStatus,
  })

  // ── Batch attachment counts (MAINT-131) ─────────────────────────────
  // Single IPC for the whole page that publishes block_id → count to all
  // SortableBlock descendants, replacing N per-row `listAttachments` IPCs
  // for the badge count.
  const allBlockIds = useMemo(() => blocks.map((b) => b.id), [blocks])

  if (loading) {
    return (
      <div
        className="block-tree-loading space-y-3 p-2"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level skeleton container; native <output> is display:inline and would collapse the space-y-3 vertical stacking of the skeleton rows
        role="status"
        aria-busy="true"
        aria-label={t('blockTree.loadingLabel')}
      >
        <Skeleton className="h-6 w-full rounded" />
        <Skeleton className="h-6 w-5/6 rounded" />
        <Skeleton className="h-6 w-4/6 rounded" />
        <Skeleton className="h-6 w-full rounded" />
      </div>
    )
  }

  // DnD measuring config: always measure during drag for correct collision detection
  const measuring = DND_MEASURING

  return (
    <BatchAttachmentsProvider blockIds={allBlockIds}>
      <BlockZoomBar
        breadcrumbs={zoomBreadcrumb}
        onNavigate={handleZoomIn}
        onZoomToRoot={zoomToRoot}
      />
      <BlockBatchActionMenu
        selectedBlockIds={selectedBlockIds}
        batchInProgress={batchInProgress}
        batchDeleteConfirm={batchDeleteConfirm}
        onBatchSetTodo={handleBatchSetTodo}
        onBatchDelete={handleBatchDelete}
        onSetBatchDeleteConfirm={setBatchDeleteConfirm}
        onClearSelection={clearSelected}
      />
      <DndContext
        sensors={dnd.sensors}
        collisionDetection={closestCenter}
        measuring={measuring}
        // #752 — disable dnd-kit's built-in edge auto-scroll: `useBlockDnD`
        // already runs the custom `useAutoScrollOnDrag` RAF loop against the
        // #main-content container. Running both is additive (jank), and the
        // built-in one ignores `prefers-reduced-motion`, defeating the custom
        // loop's reduced-motion opt-out.
        autoScroll={false}
        onDragStart={dnd.handleDragStart}
        onDragMove={dnd.handleDragMove}
        onDragOver={dnd.handleDragOver}
        onDragEnd={dnd.handleDragEnd}
        onDragCancel={dnd.handleDragCancel}
      >
        <BlockActionsProvider value={blockActions}>
          <BlockResolversProvider value={blockResolvers}>
            <BlockListRenderer
              visibleItems={dnd.visibleItems}
              blocks={blocks}
              loading={loading}
              rootParentId={rootParentId}
              focusedBlockId={focusedBlockId}
              selectedBlockIds={selectedBlockIds}
              projected={dnd.projected}
              activeId={dnd.activeId}
              overId={dnd.overId}
              dropAfter={dnd.dropAfter}
              viewport={viewport}
              rovingEditor={rovingEditor}
              onContainerPointerDown={handleContainerPointerDown}
              hasChildrenSet={hasChildrenSet}
              collapsedIds={collapsedIds}
              blockProperties={blockProperties}
            />
          </BlockResolversProvider>
        </BlockActionsProvider>
        <BlockDndOverlay
          activeBlock={activeBlock}
          projected={dnd.projected}
          activeId={dnd.activeId}
          count={draggingCount}
        />
      </DndContext>

      {/* Floating date picker for /DATE slash command */}
      {datePickerOpen && (
        <BlockDatePicker
          onSelect={(day) => day && handleDatePick(day)}
          onClose={() => setDatePickerOpen(false)}
        />
      )}

      {/* Floating template picker for /TEMPLATE slash command */}
      {templatePickerOpen && (
        <TemplatePicker
          templatePages={templatePages}
          onSelect={handleTemplateSelect}
          onClose={() => setTemplatePickerOpen(false)}
        />
      )}

      {/* Visual query builder for the /query slash command (#215) */}
      <QueryBuilderModal
        open={queryBuilderOpen}
        onOpenChange={setQueryBuilderOpen}
        onSave={handleQuerySave}
      />

      {/* Browse-grid emoji picker for the /emoji slash command (#286) */}
      <EmojiPickerDialog
        open={emojiPickerOpen}
        onOpenChange={setEmojiPickerOpen}
        onSelect={handleEmojiSelect}
      />

      {/* History side-sheet for per-block history */}
      <BlockHistorySheet
        blockId={historyBlockId}
        open={!!historyBlockId}
        onOpenChange={(open) => {
          if (!open) setHistoryBlockId(null)
        }}
      />

      {/* Property drawer for per-block properties */}
      <BlockPropertyDrawerSheet
        blockId={propertyDrawerBlockId}
        open={!!propertyDrawerBlockId}
        onOpenChange={(open) => {
          if (!open) setPropertyDrawerBlockId(null)
        }}
      />
    </BatchAttachmentsProvider>
  )
}
