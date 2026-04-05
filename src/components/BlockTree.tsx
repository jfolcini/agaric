/**
 * BlockTree — renders the block list with the roving editor.
 *
 * Each block is either a StaticBlock (div) or the active TipTap editor.
 * Enter creates a new block below. Backspace on empty deletes.
 * Off-screen blocks are replaced by height-preserving placeholders
 * via IntersectionObserver (p15-t13).
 *
 * Tree-aware drag-and-drop: blocks render with depth-based indentation.
 * Horizontal drag offset during DnD determines the projected indent level,
 * enabling drag-to-reparent. A drop indicator shows the target position
 * and depth.
 */

import { closestCenter, DndContext, MeasuringStrategy } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronRight, Home } from 'lucide-react'
import type React from 'react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { parse } from '../editor/markdown-serializer'
import type { PickerItem } from '../editor/SuggestionList'
import { useBlockKeyboard } from '../editor/use-block-keyboard'
import { useRovingEditor } from '../editor/use-roving-editor'
import { useBlockDatePicker } from '../hooks/useBlockDatePicker'
import { useBlockDnD } from '../hooks/useBlockDnD'
import { useBlockKeyboardHandlers } from '../hooks/useBlockKeyboardHandlers'
import { useBlockMultiSelect } from '../hooks/useBlockMultiSelect'
import { useBlockProperties } from '../hooks/useBlockProperties'
import { useBlockResolve } from '../hooks/useBlockResolve'
import {
  searchPropertyKeys,
  searchSlashCommands,
  useBlockSlashCommands,
} from '../hooks/useBlockSlashCommands'
import { useViewportObserver } from '../hooks/useViewportObserver'
import type { NavigateToPageFn } from '../lib/block-events'
import { BLOCK_EVENTS, onBlockEvent } from '../lib/block-events'
import {
  batchResolve,
  createBlock,
  getBatchProperties,
  getBlock,
  setPriority as setPriorityCmd,
  setProperty,
  setTodoState as setTodoStateCmd,
} from '../lib/tauri'
import { getDragDescendants } from '../lib/tree-utils'
import { cn } from '../lib/utils'
import { useBlockStore } from '../stores/blocks'
import { usePageBlockStore, usePageBlockStoreApi } from '../stores/page-blocks'
import { useResolveStore } from '../stores/resolve'
import { useUndoStore } from '../stores/undo'
import { BlockPropertyDrawer } from './BlockPropertyDrawer'
import { BlockContextMenu } from './block-tree/BlockContextMenu'
import { BlockDatePicker } from './block-tree/BlockDatePicker'
import { BlockDndOverlay } from './block-tree/BlockDndOverlay'
import { EmptyState } from './EmptyState'
import { HistorySheet } from './HistorySheet'
import { SortableBlock } from './SortableBlock'
import { Skeleton } from './ui/skeleton'

function TemplatePicker({
  templatePages,
  onSelect,
  onClose,
}: {
  templatePages: Array<{ id: string; content: string; preview: string | null }>
  onSelect: (templatePageId: string) => void
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const dialog = dialogRef.current
        if (!dialog) return
        const buttons = dialog.querySelectorAll<HTMLElement>('button')
        if (buttons.length === 0) return
        const current = document.activeElement as HTMLElement
        const idx = Array.from(buttons).indexOf(current)
        const next =
          e.key === 'ArrowDown'
            ? (idx + 1) % buttons.length
            : (idx - 1 + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    const btn = dialogRef.current?.querySelector<HTMLElement>('button')
    btn?.focus()
  }, [])

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('slash.templatePicker')}
        className="fixed z-50 rounded-md border bg-popover p-2 shadow-lg left-1/2 top-1/3 -translate-x-1/2 min-w-[200px] max-w-[calc(100vw-2rem)] sm:max-w-[300px] max-h-[60vh] overflow-y-auto max-sm:left-2 max-sm:right-2 max-sm:translate-x-0"
      >
        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
          {t('slash.selectTemplate')}
        </p>
        {templatePages.map((tp) => (
          <button
            key={tp.id}
            type="button"
            className="w-full text-left rounded px-2 py-1.5 text-sm hover:bg-accent transition-colors"
            onClick={() => onSelect(tp.id)}
          >
            <span className="font-medium">{tp.content || t('block.untitled')}</span>
            {tp.preview && (
              <span className="block text-xs text-muted-foreground truncate">{tp.preview}</span>
            )}
          </button>
        ))}
      </div>
    </>
  )
}

/**
 * Detect markdown checkbox syntax at the start of content.
 * `- [ ] ` → TODO, `- [x] ` / `- [X] ` → DONE.
 * Returns the cleaned content and the detected todo state, or null if no match.
 */
export function processCheckboxSyntax(content: string): {
  cleanContent: string
  todoState: string | null
} {
  if (content.startsWith('- [ ] ')) {
    return { cleanContent: content.slice(6), todoState: 'TODO' }
  }
  if (content.startsWith('- [x] ') || content.startsWith('- [X] ')) {
    return { cleanContent: content.slice(6), todoState: 'DONE' }
  }
  return { cleanContent: content, todoState: null }
}

/** Simple extension-based MIME type guesser for attachment uploads. */
export function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    zip: 'application/zip',
    tar: 'application/x-tar',
  }
  return mimeMap[ext] || 'application/octet-stream'
}

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

  // ── Collapse state (persisted in localStorage) ────────────────────
  const [collapsedIds, setCollapsedIdsRaw] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('collapsed_ids')
      if (stored) return new Set(JSON.parse(stored) as string[])
    } catch {
      // localStorage unavailable
    }
    return new Set()
  })
  const setCollapsedIds = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    setCollapsedIdsRaw((prev) => {
      const next = updater(prev)
      try {
        localStorage.setItem('collapsed_ids', JSON.stringify([...next]))
      } catch {
        // localStorage unavailable
      }
      return next
    })
  }, [])

  // ── Zoom state ─────────────────────────────────────────────────────
  const [zoomedBlockId, setZoomedBlockId] = useState<string | null>(null)

  // ── Enter-creates-block refs ───────────────────────────────────────
  const justCreatedBlockIds = useRef(new Set<string>())
  const prevFocusedRef = useRef<string | null>(null)

  // ── History sheet state ────────────────────────────────────────────
  const [historyBlockId, setHistoryBlockId] = useState<string | null>(null)

  // ── Property drawer state ──────────────────────────────────────────
  const [propertyDrawerBlockId, setPropertyDrawerBlockId] = useState<string | null>(null)

  const [blockProperties, setBlockProperties] = useState<
    Record<string, Array<{ key: string; value: string }>>
  >({})

  const handleShowHistory = useCallback((blockId: string) => {
    setHistoryBlockId(blockId)
  }, [])

  const handleShowProperties = useCallback((blockId: string) => {
    setPropertyDrawerBlockId(blockId)
  }, [])

  const handleZoomIn = useCallback((blockId: string) => {
    setZoomedBlockId(blockId)
  }, [])

  // ── Extracted hooks ────────────────────────────────────────────────
  const resolve = useBlockResolve()
  const properties = useBlockProperties()
  const { handleToggleTodo, handleTogglePriority } = properties

  /** Set of block IDs that have children (next block in flat tree has greater depth). */
  const hasChildrenSet = useMemo(() => {
    const set = new Set<string>()
    for (let i = 0; i < blocks.length - 1; i++) {
      const curr = blocks[i] as (typeof blocks)[number]
      const next = blocks[i + 1] as (typeof blocks)[number]
      if (next.depth > curr.depth) {
        set.add(curr.id)
      }
    }
    return set
  }, [blocks])

  /** Blocks visible after collapse filtering (before DnD filtering). */
  const collapsedVisible = useMemo(() => {
    if (collapsedIds.size === 0) return blocks
    const result: typeof blocks = []
    const skipUntilDepth: number[] = []

    for (const block of blocks) {
      while (
        skipUntilDepth.length > 0 &&
        block.depth <= (skipUntilDepth[skipUntilDepth.length - 1] as number)
      ) {
        skipUntilDepth.pop()
      }

      if (skipUntilDepth.length > 0) continue

      result.push(block)

      if (collapsedIds.has(block.id)) {
        skipUntilDepth.push(block.depth)
      }
    }
    return result
  }, [blocks, collapsedIds])

  const zoomedVisible = useMemo(() => {
    if (!zoomedBlockId) return collapsedVisible
    const zoomedBlock = blocks.find((b) => b.id === zoomedBlockId)
    if (!zoomedBlock) return collapsedVisible
    const depthOffset = zoomedBlock.depth + 1
    const descendants = getDragDescendants(blocks, zoomedBlockId)
    return collapsedVisible
      .filter((b) => descendants.has(b.id))
      .map((b) => ({ ...b, depth: b.depth - depthOffset }))
  }, [zoomedBlockId, blocks, collapsedVisible])

  const zoomBreadcrumb = useMemo(() => {
    if (!zoomedBlockId) return []
    const trail: Array<{ id: string; content: string }> = []
    let currentId: string | null = zoomedBlockId
    while (currentId) {
      const block = blocks.find((b) => b.id === currentId)
      if (!block) break
      trail.unshift({ id: block.id, content: block.content ?? '' })
      currentId = block.parent_id
    }
    return trail
  }, [zoomedBlockId, blocks])

  // ── Roving editor ──────────────────────────────────────────────────
  // handleNavigate and handleSlashCommand are defined below but referenced
  // via ref to avoid circular dependency with rovingEditor.
  const handleNavigateRef = useRef<(id: string) => void>(() => {})
  const handleSlashCommandRef = useRef<(item: PickerItem) => void>(() => {})
  const handleCheckboxRef = useRef<(state: 'TODO' | 'DONE') => void>(() => {})
  const handlePropertySelectRef = useRef<(item: PickerItem) => void>(() => {})

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
    setZoomedBlockId(null)
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
      .catch(() => {
        toast.error(t('blockTree.createFirstBlockFailed'))
      })
  }, [autoCreateFirstBlock, loading, blocks.length, rootParentId, t, pageStore])

  // Scan loaded blocks for [[ULID]] tokens not yet in the resolve cache
  // and batch-fetch them.  Pages + tags are already preloaded by App.tsx
  // via useResolveStore.preload(); this effect only handles block-link
  // references that may not be in the cache (e.g. links to content blocks).
  useEffect(() => {
    let cancelled = false
    async function resolveUncachedLinks() {
      try {
        const ULID_LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
        const uncached = new Set<string>()
        const currentCache = useResolveStore.getState().cache
        for (const b of blocks) {
          if (!b.content) continue
          for (const m of b.content.matchAll(ULID_LINK_RE)) {
            if (!currentCache.has(m[1] as string)) uncached.add(m[1] as string)
          }
        }

        if (uncached.size > 0) {
          try {
            const resolved = await batchResolve([...uncached])
            if (!cancelled) {
              const store = useResolveStore.getState()
              for (const r of resolved) {
                store.set(r.id, r.title?.slice(0, 60) || `[[${r.id.slice(0, 8)}...]]`, r.deleted)
              }
            }
          } catch {
            // Batch resolve failed — fallback entries stay as truncated ULIDs
          }
        }
      } catch {
        // Scan failed — resolve callbacks will use fallbacks
      }
    }
    resolveUncachedLinks()
    return () => {
      cancelled = true
    }
  }, [blocks])

  useEffect(() => {
    if (blocks.length === 0) return
    const visibleIds = blocks.map((b) => b.id)
    getBatchProperties(visibleIds)
      .then((result) => {
        const mapped: Record<string, Array<{ key: string; value: string }>> = {}
        for (const [blockId, props] of Object.entries(result)) {
          mapped[blockId] = props
            .filter(
              (p) => !['todo_state', 'priority', 'due_date', 'scheduled_date'].includes(p.key),
            )
            .map((p) => ({
              key: p.key,
              value:
                p.value_text ??
                p.value_date ??
                (p.value_num != null ? String(p.value_num) : '') ??
                '',
            }))
            .filter((p) => p.value !== '')
        }
        setBlockProperties(mapped)
      })
      .catch(() => {
        // Best-effort — properties are display-only
      })
  }, [blocks])

  // Keyboard callbacks
  const handleFlush = useCallback((): string | null => {
    if (!rovingEditor.activeBlockId) return null
    const blockId = rovingEditor.activeBlockId // capture BEFORE unmount nullifies it
    const changed = rovingEditor.unmount()
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
            .catch(() => toast.error(t('blockTree.setTaskStateFailed')))
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
  }, [rovingEditor, edit, splitBlock, rootParentId, t, pageStore])

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
  })

  const toggleCollapse = useCallback(
    (blockId: string) => {
      // If collapsing and the focused block is a descendant, rescue focus
      const wasCollapsed = collapsedIds.has(blockId)
      if (!wasCollapsed && focusedBlockId) {
        const descendants = getDragDescendants(blocks, blockId)
        if (descendants.has(focusedBlockId)) {
          handleFlush()
          setFocused(null)
        }
      }

      setCollapsedIds((prev) => {
        const next = new Set(prev)
        if (next.has(blockId)) next.delete(blockId)
        else next.add(blockId)
        return next
      })
    },
    [collapsedIds, blocks, focusedBlockId, handleFlush, setFocused, setCollapsedIds],
  )

  // ── Navigate to a block link target ────────────────────────────────
  const handleNavigate = useCallback(
    async (targetId: string) => {
      // Flush current editor state before navigating
      handleFlush()
      try {
        const targetBlock = await getBlock(targetId)
        // Populate cache with the fetched block info
        useResolveStore
          .getState()
          .set(
            targetId,
            targetBlock.content?.slice(0, 60) || `[[${targetId.slice(0, 8)}...]]`,
            targetBlock.deleted_at !== null,
          )

        // If target is a page, navigate to it in the page editor
        if (targetBlock.block_type === 'page') {
          onNavigateToPage?.(targetId, targetBlock.content ?? 'Untitled')
          return
        }

        // If target's parent differs from our tree's parent, navigate to the parent page
        if (targetBlock.parent_id && targetBlock.parent_id !== rootParentId) {
          // Fetch the parent to get the actual page title (not the target block's content)
          try {
            const parentBlock = await getBlock(targetBlock.parent_id)
            onNavigateToPage?.(targetBlock.parent_id, parentBlock.content ?? 'Untitled', targetId)
          } catch {
            onNavigateToPage?.(targetBlock.parent_id, 'Untitled', targetId)
          }
          return
        }

        // Same tree — navigate locally
        await load()
        setFocused(targetId)
        rovingEditor.mount(targetId, targetBlock.content ?? '')
      } catch {
        toast.error(t('blockTree.linkTargetNotFound'))
      }
    },
    [handleFlush, load, setFocused, rovingEditor, rootParentId, onNavigateToPage, t],
  )

  // Keep the ref in sync with the latest handleNavigate
  handleNavigateRef.current = handleNavigate

  // Keep the slash command ref in sync
  handleSlashCommandRef.current = handleSlashCommand

  handleCheckboxRef.current = handleCheckboxSyntax

  const handlePropertySelect = useCallback(
    (item: PickerItem) => {
      if (!focusedBlockId) return
      setProperty({ blockId: focusedBlockId, key: item.label, valueText: '' }).catch(() =>
        toast.error(t('blockTree.setPropertyFailed')),
      )
    },
    [focusedBlockId, t],
  )

  handlePropertySelectRef.current = handlePropertySelect

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

  // ── Discard button custom event (from FormattingToolbar) ───────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) {
        handleEscapeCancel()
      }
    }
    return onBlockEvent(document, 'DISCARD_BLOCK_EDIT', handler)
  }, [focusedBlockId, handleEscapeCancel])

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

  // ── Keyboard shortcut for collapse toggle (Mod+.) ──────────────────
  useEffect(() => {
    const handleCollapseKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        if (focusedBlockId && hasChildrenSet.has(focusedBlockId)) {
          toggleCollapse(focusedBlockId)
        }
      }
    }
    document.addEventListener('keydown', handleCollapseKey)
    return () => document.removeEventListener('keydown', handleCollapseKey)
  }, [focusedBlockId, hasChildrenSet, toggleCollapse])

  // ── Keyboard shortcuts for multi-selection (Ctrl+A, Escape) ─────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+A / Cmd+A — select all blocks (only when not editing)
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !focusedBlockId) {
        e.preventDefault()
        rawSelectAll(blocks.map((b) => b.id))
      }
      // Escape — clear selection (when not editing and there's an active selection)
      if (
        e.key === 'Escape' &&
        !e.defaultPrevented &&
        !focusedBlockId &&
        selectedBlockIds.length > 0
      ) {
        e.preventDefault()
        clearSelected()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [focusedBlockId, selectedBlockIds.length, rawSelectAll, blocks, clearSelected])

  // ── Keyboard shortcut: Escape closes unfocused editor (UX-M8) ──────
  // The TipTap-level Escape handler (use-block-keyboard.ts) only fires when
  // the editor DOM has focus.  This document-level handler covers the case
  // where the user clicked elsewhere on the page and presses Escape — the
  // editor is still mounted but not focused.
  useEffect(() => {
    const handleUnfocusedEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const { focusedBlockId: fid, selectedBlockIds: sel } = useBlockStore.getState()
      if (!fid) return
      // Don't interfere when there's an active multi-selection (handled above)
      if (sel.length > 0) return
      // Only act when the TipTap editor is NOT the active element
      const proseMirror = document.querySelector('.ProseMirror')
      if (proseMirror?.contains(document.activeElement)) return
      e.preventDefault()
      rovingEditor.unmount()
      setFocused(null)
    }
    document.addEventListener('keydown', handleUnfocusedEscape)
    return () => document.removeEventListener('keydown', handleUnfocusedEscape)
  }, [rovingEditor, setFocused])

  // ── Keyboard shortcut for task cycling (Ctrl+Enter / Cmd+Enter) ────
  useEffect(() => {
    const handleTaskKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (focusedBlockId) {
          handleToggleTodo(focusedBlockId)
        }
      }
    }
    document.addEventListener('keydown', handleTaskKey)
    return () => document.removeEventListener('keydown', handleTaskKey)
  }, [focusedBlockId, handleToggleTodo])

  // ── Priority cycling event listener (from FormattingToolbar) ─────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) handleTogglePriority(focusedBlockId)
    }
    return onBlockEvent(document, 'CYCLE_PRIORITY', handler)
  }, [focusedBlockId, handleTogglePriority])

  // ── Direct priority set from keyboard shortcuts (Ctrl+Shift+1/2/3) ──
  useEffect(() => {
    const handleSetPriority = async (e: Event) => {
      if (!focusedBlockId) return
      const priority =
        e.type === BLOCK_EVENTS.SET_PRIORITY_1
          ? '1'
          : e.type === BLOCK_EVENTS.SET_PRIORITY_2
            ? '2'
            : '3'
      try {
        await setPriorityCmd(focusedBlockId, priority)
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === focusedBlockId ? { ...b, priority } : b)),
        }))
      } catch {
        toast.error(t('blockTree.setPriorityFailed'))
      }
    }
    const cleanup1 = onBlockEvent(document, 'SET_PRIORITY_1', handleSetPriority)
    const cleanup2 = onBlockEvent(document, 'SET_PRIORITY_2', handleSetPriority)
    const cleanup3 = onBlockEvent(document, 'SET_PRIORITY_3', handleSetPriority)
    return () => {
      cleanup1()
      cleanup2()
      cleanup3()
    }
  }, [focusedBlockId, rootParentId, t, pageStore])

  // ── Listen for toolbar date picker event ────────────────────────────
  useEffect(() => {
    const handleDateEvent = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
      setDatePickerMode('date')
      setDatePickerOpen(true)
    }
    return onBlockEvent(document, 'OPEN_DATE_PICKER', handleDateEvent)
  }, [
    focusedBlockId,
    rovingEditor.editor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
  ])

  // ── Listen for toolbar due-date picker event ─────────────────────────
  useEffect(() => {
    const handler = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos ?? undefined
      setDatePickerMode('due')
      setDatePickerOpen(true)
    }
    return onBlockEvent(document, 'OPEN_DUE_DATE_PICKER', handler)
  }, [focusedBlockId, rovingEditor, datePickerCursorPos, setDatePickerMode, setDatePickerOpen])

  // ── Listen for toolbar scheduled-date picker event ──────────────────
  useEffect(() => {
    const handler = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos ?? undefined
      setDatePickerMode('schedule')
      setDatePickerOpen(true)
    }
    return onBlockEvent(document, 'OPEN_SCHEDULED_DATE_PICKER', handler)
  }, [focusedBlockId, rovingEditor, datePickerCursorPos, setDatePickerMode, setDatePickerOpen])

  // ── Listen for toolbar toggle-todo-state event ──────────────────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) handleToggleTodo(focusedBlockId)
    }
    return onBlockEvent(document, 'TOGGLE_TODO_STATE', handler)
  }, [focusedBlockId, handleToggleTodo])

  // ── Listen for toolbar open-block-properties event ──────────────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) handleShowProperties(focusedBlockId)
    }
    return onBlockEvent(document, 'OPEN_BLOCK_PROPERTIES', handler)
  }, [focusedBlockId, handleShowProperties])

  // ── Keyboard shortcut: Ctrl+Shift+D → open date picker ─────────────
  useEffect(() => {
    const handleDateShortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        if (!focusedBlockId) return
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos ?? undefined
        setDatePickerMode('date')
        setDatePickerOpen(true)
      }
    }
    document.addEventListener('keydown', handleDateShortcut)
    return () => document.removeEventListener('keydown', handleDateShortcut)
  }, [
    focusedBlockId,
    rovingEditor.editor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
  ])

  // ── Keyboard shortcut: Ctrl+1‑6 → toggle heading level ─────────────
  useEffect(() => {
    const handleHeadingShortcut = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key < '1' || e.key > '6') return
      if (!focusedBlockId) return
      e.preventDefault()
      const level = Number.parseInt(e.key, 10)
      handleSlashCommand({ id: `h${level}`, label: `Heading ${level}` })
    }
    document.addEventListener('keydown', handleHeadingShortcut)
    return () => document.removeEventListener('keydown', handleHeadingShortcut)
  }, [focusedBlockId, handleSlashCommand])

  // ── Click on whitespace within block tree closes editor (UX-M9) ──
  const handleContainerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== e.currentTarget) return
      const { focusedBlockId: fid } = useBlockStore.getState()
      if (!fid) return
      // If the editor DOM still has focus, blur it so EditableBlock's
      // handleBlur fires the normal save-and-close path.
      const proseMirror = document.querySelector('.ProseMirror')
      if (proseMirror?.contains(document.activeElement)) {
        ;(document.activeElement as HTMLElement)?.blur()
      } else {
        // Editor is mounted but already unfocused — force close
        rovingEditor.unmount()
        setFocused(null)
      }
    },
    [rovingEditor, setFocused],
  )

  // ── Active item for DragOverlay ────────────────────────────────────
  const activeBlock = dnd.activeId ? (blocks.find((b) => b.id === dnd.activeId) ?? null) : null

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
  const measuring = {
    droppable: { strategy: MeasuringStrategy.Always },
  }

  return (
    <>
      {zoomBreadcrumb.length > 0 && (
        <nav
          aria-label={t('block.breadcrumb')}
          className="flex items-center gap-1 px-2 py-1.5 text-sm text-muted-foreground border-b border-border/40 overflow-x-auto"
        >
          <button
            type="button"
            className="flex-shrink-0 hover:text-foreground transition-colors"
            onClick={() => setZoomedBlockId(null)}
          >
            <Home size={14} />
          </button>
          {zoomBreadcrumb.map((item, i) => (
            <Fragment key={item.id}>
              <ChevronRight size={12} className="flex-shrink-0 text-muted-foreground/50" />
              <button
                type="button"
                className={cn(
                  'truncate max-w-[200px] hover:text-foreground transition-colors',
                  i === zoomBreadcrumb.length - 1 && 'text-foreground font-medium',
                )}
                onClick={() =>
                  i === zoomBreadcrumb.length - 1 ? undefined : setZoomedBlockId(item.id)
                }
              >
                {item.content || t('block.untitled')}
              </button>
            </Fragment>
          ))}
        </nav>
      )}
      <BlockContextMenu
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
        <SortableContext
          items={dnd.visibleItems.map((b) => b.id)}
          strategy={verticalListSortingStrategy}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: whitespace click to dismiss editor */}
          <div
            className="block-tree space-y-0.5 [@media(pointer:coarse)]:space-y-1.5"
            onMouseDown={handleContainerMouseDown}
          >
            {dnd.visibleItems.map((block) => {
              const isFocused = focusedBlockId === block.id
              // Show projected depth during drag for the active item's over target
              const projectedDepth =
                dnd.projected && dnd.activeId && dnd.overId === block.id
                  ? dnd.projected.depth
                  : block.depth

              // Focused block is never virtualized — always render fully
              if (!isFocused && viewport.isOffscreen(block.id)) {
                return (
                  <div
                    key={block.id}
                    ref={viewport.observeRef}
                    data-block-id={block.id}
                    className="block-placeholder"
                    style={{ minHeight: viewport.getHeight(block.id) }}
                  />
                )
              }
              return (
                <div key={block.id} ref={viewport.observeRef} data-block-id={block.id}>
                  {/* Drop indicator: shows where the dragged block will land */}
                  {dnd.projected && dnd.overId === block.id && dnd.activeId !== block.id && (
                    <div
                      className="drop-indicator h-[3px] bg-primary rounded-full ring-2 ring-primary/20"
                      style={{ marginLeft: `calc(var(--indent-width) * ${dnd.projected.depth})` }}
                    />
                  )}
                  <SortableBlock
                    blockId={block.id}
                    content={block.content ?? ''}
                    isFocused={isFocused}
                    depth={block.id === dnd.activeId ? projectedDepth : block.depth}
                    rovingEditor={rovingEditor}
                    onNavigate={handleNavigate}
                    onDelete={remove}
                    resolveBlockTitle={resolve.resolveBlockTitle}
                    resolveTagName={resolve.resolveTagName}
                    resolveBlockStatus={resolve.resolveBlockStatus}
                    resolveTagStatus={resolve.resolveTagStatus}
                    hasChildren={hasChildrenSet.has(block.id)}
                    isCollapsed={collapsedIds.has(block.id)}
                    onToggleCollapse={toggleCollapse}
                    todoState={block.todo_state ?? null}
                    onToggleTodo={handleToggleTodo}
                    priority={block.priority ?? null}
                    onTogglePriority={handleTogglePriority}
                    dueDate={block.due_date ?? null}
                    scheduledDate={block.scheduled_date ?? null}
                    properties={blockProperties[block.id]}
                    onIndent={indent}
                    onDedent={dedent}
                    onMoveUp={handleMoveUpById}
                    onMoveDown={handleMoveDownById}
                    onMerge={handleMergeById}
                    onShowHistory={handleShowHistory}
                    onShowProperties={handleShowProperties}
                    onZoomIn={hasChildrenSet.has(block.id) ? handleZoomIn : undefined}
                    isSelected={selectedBlockIds.includes(block.id)}
                    onSelect={handleSelect}
                  />
                </div>
              )
            })}
            {blocks.length === 0 && !loading && (
              <EmptyState
                message={rootParentId ? t('blockTree.emptyPage') : t('blockTree.noBlocks')}
              />
            )}
          </div>
        </SortableContext>
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
      <HistorySheet
        blockId={historyBlockId}
        open={!!historyBlockId}
        onOpenChange={(open) => {
          if (!open) setHistoryBlockId(null)
        }}
      />

      {/* Property drawer for per-block properties */}
      <BlockPropertyDrawer
        blockId={propertyDrawerBlockId}
        open={!!propertyDrawerBlockId}
        onOpenChange={(open) => {
          if (!open) setPropertyDrawerBlockId(null)
        }}
      />
    </>
  )
}
