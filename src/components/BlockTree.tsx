/**
 * BlockTree — thin orchestrator composing extracted feature components.
 *
 * Delegates to:
 * - useBlockCollapse — collapse/expand state
 * - useBlockZoom — zoom navigation + breadcrumbs
 * - useBlockLinkResolve — `[[ULID]]` cache scan + batch resolve (MAINT-128)
 * - useBlockPropertiesBatch — per-block extra-property fetch (MAINT-128)
 * - useBlockNavigateToLink — `handleNavigate` + `handleNavigateRef` (MAINT-128)
 * - BlockZoomBar — zoom breadcrumb UI
 * - BlockListRenderer — SortableContext + block map
 * - BlockHistorySheet — block history overlay
 * - BlockPropertyDrawerSheet — property drawer overlay
 * - BlockDnDOverlay — drag preview
 */

import { closestCenter, DndContext, MeasuringStrategy } from '@dnd-kit/core'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { logger } from '@/lib/logger'
import { parse } from '../editor/markdown-serializer'
import type { PickerItem } from '../editor/SuggestionList'
import { useBlockKeyboard } from '../editor/use-block-keyboard'
import { type RovingEditorHandle, useRovingEditor } from '../editor/use-roving-editor'
import { type BlockActions, BlockActionsProvider } from '../hooks/useBlockActions'
import { useBlockCollapse } from '../hooks/useBlockCollapse'
import { useBlockDatePicker } from '../hooks/useBlockDatePicker'
import { useBlockDnD } from '../hooks/useBlockDnD'
import { useBlockKeyboardHandlers } from '../hooks/useBlockKeyboardHandlers'
import { useBlockLinkResolve } from '../hooks/useBlockLinkResolve'
import { useBlockMultiSelect } from '../hooks/useBlockMultiSelect'
import { useBlockNavigateToLink } from '../hooks/useBlockNavigateToLink'
import { useBlockProperties } from '../hooks/useBlockProperties'
import { useBlockPropertiesBatch } from '../hooks/useBlockPropertiesBatch'
import { useBlockResolve } from '../hooks/useBlockResolve'
import { type BlockResolvers, BlockResolversProvider } from '../hooks/useBlockResolvers'
import {
  searchPropertyKeys,
  searchSlashCommands,
  useBlockSlashCommands,
} from '../hooks/useBlockSlashCommands'
import { useBlockTreeEventListeners } from '../hooks/useBlockTreeEventListeners'
import { useBlockTreeKeyboardShortcuts } from '../hooks/useBlockTreeKeyboardShortcuts'
import { useBlockZoom } from '../hooks/useBlockZoom'
import { useTagClickHandler } from '../hooks/useRichContentCallbacks'
import { useViewportObserver } from '../hooks/useViewportObserver'
import type { NavigateToPageFn } from '../lib/block-events'
import { processCheckboxSyntax } from '../lib/block-utils'
import {
  createBlock,
  deleteDraft,
  setProperty,
  setTodoState as setTodoStateCmd,
} from '../lib/tauri'
import { getDragDescendants } from '../lib/tree-utils'
import { useBlockStore } from '../stores/blocks'
import { usePageBlockStore, usePageBlockStoreApi } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'
import { BlockHistorySheet } from './BlockHistorySheet'
import { BlockListRenderer } from './BlockListRenderer'
import { BlockPropertyDrawerSheet } from './BlockPropertyDrawerSheet'
import { BlockZoomBar } from './BlockZoomBar'
import { BlockBatchActionMenu } from './block-tree/BlockBatchActionMenu'
import { BlockDatePicker } from './block-tree/BlockDatePicker'
import { BlockDndOverlay } from './block-tree/BlockDndOverlay'
import { TemplatePicker } from './block-tree/TemplatePicker'
import { Skeleton } from './ui/skeleton'

export { processCheckboxSyntax } from '../lib/block-utils'

export { guessMimeType } from '../lib/file-utils'

/** Stable DnD measuring config — module-level to avoid re-creation per render. */
const DND_MEASURING = {
  droppable: { strategy: MeasuringStrategy.Always },
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
  const { blocks, rootParentId, loading } = usePageBlockStore(
    useShallow((s) => ({ blocks: s.blocks, rootParentId: s.rootParentId, loading: s.loading })),
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
    moveUp,
    moveDown,
    createBelow,
  } = pageStore.getState()
  // Global focus/selection actions
  const { setFocused, toggleSelected, clearSelected } = useBlockStore.getState()
  const { rangeSelect: rawRangeSelect, selectAll: rawSelectAll } = useBlockStore.getState()

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
  })

  // ── Zoom hook (state + breadcrumb + zoomed view) ───────────────────
  const {
    zoomedBlockId,
    zoomIn: handleZoomIn,
    zoomToRoot,
    breadcrumbs: zoomBreadcrumb,
    zoomedVisible,
  } = useBlockZoom(blocks, collapsedVisible)

  // ── Enter-creates-block refs ───────────────────────────────────────
  const justCreatedBlockIds = useRef(new Set<string>())
  const prevFocusedRef = useRef<string | null>(null)

  // ── History sheet state ────────────────────────────────────────────
  const [historyBlockId, setHistoryBlockId] = useState<string | null>(null)

  // ── Property drawer state ──────────────────────────────────────────
  const [propertyDrawerBlockId, setPropertyDrawerBlockId] = useState<string | null>(null)

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
  const editorPlaceholder = useMemo(() => {
    if (!focusedBlockId || blocks.length === 0) return undefined
    const focused = blocks.find((b) => b.id === focusedBlockId)
    if (!focused) return undefined
    const isFirstChild = blocks[0]?.id === focusedBlockId
    const isEmpty = !focused.content || focused.content.trim() === ''
    if (isFirstChild && isEmpty) {
      return t('editor.templatePlaceholder')
    }
    return undefined
  }, [focusedBlockId, blocks, t])

  const rovingEditor = useRovingEditor({
    resolveBlockTitle: resolve.resolveBlockTitle,
    resolveTagName: resolve.resolveTagName,
    onNavigate: (id: string) => handleNavigateRef.current(id),
    onTagClick,
    resolveBlockStatus: resolve.resolveBlockStatus,
    resolveTagStatus: resolve.resolveTagStatus,
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
    ...(editorPlaceholder ? { placeholder: editorPlaceholder } : {}),
  })

  rovingEditorRef.current = rovingEditor

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: parentId triggers reload when page changes
  useEffect(() => {
    load()
    zoomToRoot()
  }, [load, parentId])

  // ── H-9: Auto-create first block on empty pages ─────────────────────
  // When a page loads with no child blocks, auto-create an empty content
  // block so the user can immediately start typing.  Uses a ref to prevent
  // double-creation on the same page.
  const autoCreatedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!autoCreateFirstBlock) return
    if (loading || blocks.length > 0 || !rootParentId) return
    if (autoCreatedForRef.current === rootParentId) return
    autoCreatedForRef.current = rootParentId

    createBlock({ blockType: 'content', content: '', parentId: rootParentId })
      .then((result) => {
        // Only apply if we're still on the same page
        if (pageStore.getState().rootParentId !== rootParentId) return
        // Defensive guard: a malformed result (missing id) must never reach the
        // store, because downstream renderers key by block.id and would emit
        // "Each child in a list should have a unique key" warnings for the
        // transient render before the next refetch. In production this guard
        // never fires; it catches test-mock leaks and any future regression.
        if (!result?.id) {
          logger.warn('BlockTree', 'auto-create returned result without id; skipping store write', {
            rootParentId: rootParentId ?? '',
          })
          return
        }
        pageStore.setState({
          blocks: [
            {
              ...result,
              depth: 0,
            },
          ],
        })
        useBlockStore.setState({ focusedBlockId: result.id })
      })
      .catch((err: unknown) => {
        logger.error(
          'BlockTree',
          'Failed to auto-create first block',
          {
            rootParentId: rootParentId ?? '',
          },
          err,
        )
        toast.error(t('blockTree.createFirstBlockFailed'))
      })
  }, [autoCreateFirstBlock, loading, blocks.length, rootParentId, t, pageStore])

  // Scan loaded blocks for [[ULID]] tokens not yet in the resolve cache
  // and batch-fetch them. See `useBlockLinkResolve` for the cache-scope
  // and FEAT-3p7 rationale.
  useBlockLinkResolve(blocks)

  // Per-block "extra" properties (everything except the four built-in
  // todo/priority/due/scheduled fields) for the row-rendering UI.
  const blockProperties = useBlockPropertiesBatch(blocks)

  // Keyboard callbacks
  const handleFlush = useCallback((): string | null => {
    const handle = rovingEditorRef.current
    if (!handle?.activeBlockId) return null
    const blockId = handle.activeBlockId // capture BEFORE unmount nullifies it
    const changed = handle.unmount()
    if (changed !== null) {
      // Use the parser to detect multi-block content (headings, code blocks, etc.)
      // A single code block or heading with newlines should NOT split.
      const doc = parse(changed)
      const blockCount = doc.content?.length ?? 0
      if (blockCount > 1) {
        splitBlock(blockId, changed)
      } else {
        // Check for checkbox markdown syntax before saving
        const { cleanContent, todoState } = processCheckboxSyntax(changed)
        if (todoState) {
          // Set todo state via thin command and save cleaned content
          setTodoStateCmd(blockId, todoState)
            .then(() => {
              if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
            })
            .catch((err: unknown) => {
              logger.error(
                'BlockTree',
                'Failed to set task state from checkbox syntax',
                {
                  blockId,
                },
                err,
              )
              toast.error(t('blockTree.setTaskStateFailed'))
            })
          pageStore.setState((s) => ({
            blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, todo_state: todoState } : b)),
          }))
          edit(blockId, cleanContent)
        } else {
          edit(blockId, changed)
        }
      }
    }
    return changed
  }, [edit, splitBlock, rootParentId, t, pageStore])

  // Sync the flush ref so `useBlockNavigateToLink` (created above) can
  // call into the latest `handleFlush` lazily.
  handleFlushRef.current = handleFlush

  // ── Scroll container ref (for auto-scroll during drag) ──────────────
  const scrollContainerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    scrollContainerRef.current = document.getElementById('main-content')
  }, [])

  // ── DnD hook (needs handleFlush + collapsedVisible) ────────────────
  const dnd = useBlockDnD({
    blocks,
    collapsedVisible: zoomedVisible,
    rootParentId,
    rovingEditor,
    handleFlush,
    setFocused,
    reorder,
    moveToParent,
    scrollContainerRef,
  })

  // ── Wire up the onBeforeCollapse ref now that handleFlush is available ──
  handleBeforeCollapseRef.current = (blockId: string) => {
    if (focusedBlockId) {
      const descendants = getDragDescendants(blocks, blockId)
      if (descendants.has(focusedBlockId)) {
        handleFlush()
        setFocused(null)
      }
    }
  }

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

  // ── Sync slash-command + checkbox refs with latest handlers ────────
  // (`handleNavigateRef` is owned by `useBlockNavigateToLink` above.)
  handleSlashCommandRef.current = handleSlashCommand
  handleCheckboxRef.current = handleCheckboxSyntax

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
          toast.error(t('blockTree.setPropertyFailed'))
        },
      )
    },
    [focusedBlockId, t],
  )

  handlePropertySelectRef.current = handlePropertySelect

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
        rawRangeSelect(
          blockId,
          blocks.map((b) => b.id),
        )
      }
    },
    [toggleSelected, rawRangeSelect, blocks],
  )

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
    onToggleTodo: () => focusedBlockId && handleToggleTodo(focusedBlockId),
    onToggleCollapse: () => focusedBlockId && toggleCollapse(focusedBlockId),
    onShowProperties: () => focusedBlockId && handleShowProperties(focusedBlockId),
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
      const block = pageStore.getState().blocks.find((b) => b.id === prevId)
      if (block && (!block.content || block.content.trim() === '')) {
        remove(prevId)
      }
    }
  }, [focusedBlockId, remove, pageStore])

  // ── Extracted keyboard shortcuts (document-level keydown listeners) ─
  useBlockTreeKeyboardShortcuts({
    focusedBlockId,
    selectedBlockIds,
    hasChildrenSet,
    blocks,
    toggleCollapse,
    rawSelectAll,
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
  const activeBlock = dnd.activeId ? (blocks.find((b) => b.id === dnd.activeId) ?? null) : null

  // ── Action / resolver bags published via context (MAINT-118) ────────
  // Memoised so descendants only re-render when callbacks change.
  const blockActions = useMemo<BlockActions>(
    () => ({
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
    }),
    [
      handleNavigate,
      remove,
      indent,
      dedent,
      handleMoveUpById,
      handleMoveDownById,
      handleMergeById,
      handleToggleTodo,
      handleTogglePriority,
      toggleCollapse,
      handleShowHistory,
      handleShowProperties,
      handleZoomIn,
      handleSelect,
    ],
  )
  const blockResolvers = useMemo<BlockResolvers>(
    () => ({
      resolveBlockTitle: resolve.resolveBlockTitle,
      resolveTagName: resolve.resolveTagName,
      resolveBlockStatus: resolve.resolveBlockStatus,
      resolveTagStatus: resolve.resolveTagStatus,
    }),
    [
      resolve.resolveBlockTitle,
      resolve.resolveTagName,
      resolve.resolveBlockStatus,
      resolve.resolveTagStatus,
    ],
  )

  if (loading) {
    return (
      <div
        className="block-tree-loading space-y-3 p-2"
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
    <>
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
    </>
  )
}
