/**
 * BlockTree — renders the block list with the roving editor (ADR-01).
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

import { closestCenter, DndContext, DragOverlay, MeasuringStrategy } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronRight, Home } from 'lucide-react'
import type React from 'react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { parse, serialize } from '../editor/markdown-serializer'
import type { PickerItem } from '../editor/SuggestionList'
import type { DocNode } from '../editor/types'
import { pmEndOfFirstBlock } from '../editor/types'
import { useBlockKeyboard } from '../editor/use-block-keyboard'
import { useRovingEditor } from '../editor/use-roving-editor'
import { useBlockDnD } from '../hooks/useBlockDnD'
import { useBlockProperties } from '../hooks/useBlockProperties'
import { useBlockResolve } from '../hooks/useBlockResolve'
import { useViewportObserver } from '../hooks/useViewportObserver'
import { announce } from '../lib/announcer'
import { parseDate } from '../lib/parse-date'
import {
  batchResolve,
  createBlock,
  editBlock,
  getBlock,
  listBlocks,
  setDueDate as setDueDateCmd,
  setPriority as setPriorityCmd,
  setProperty,
  setScheduledDate as setScheduledDateCmd,
  setTodoState as setTodoStateCmd,
} from '../lib/tauri'
import { getDragDescendants } from '../lib/tree-utils'
import { cn } from '../lib/utils'
import { useBlockStore } from '../stores/blocks'
import { useResolveStore } from '../stores/resolve'
import { EmptyState } from './EmptyState'
import { HistorySheet } from './HistorySheet'
import { SortableBlock } from './SortableBlock'
import { Calendar } from './ui/calendar'
import { Skeleton } from './ui/skeleton'

// ── Floating date picker with Escape + viewport centering ─────────────

function DatePickerOverlay({
  onSelect,
  onClose,
}: {
  onSelect: (day: Date | undefined) => void
  onClose: () => void
}): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [dateTextInput, setDateTextInput] = useState('')
  const [dateTextPreview, setDateTextPreview] = useState<string | null>(null)

  /** Convert a parsed YYYY-MM-DD string to a Date and call onSelect. */
  const handleDateSelected = useCallback(
    (dateStr: string) => {
      const [y, m, d] = dateStr.split('-').map(Number)
      const date = new Date(y, m - 1, d)
      onSelect(date)
    },
    [onSelect],
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      // Focus trap: keep Tab within the dialog
      if (e.key === 'Tab') {
        const dialog = dialogRef.current
        if (!dialog) return
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Auto-focus the text input on mount
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const input = dialog.querySelector<HTMLElement>('input')
    input?.focus()
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
        aria-label="Date picker"
        className="date-picker-popup fixed z-50 rounded-md border bg-popover p-2 shadow-lg left-1/2 top-1/3 -translate-x-1/2 max-[479px]:left-2 max-[479px]:right-2 max-[479px]:translate-x-0 max-[479px]:max-h-[70vh] max-[479px]:overflow-y-auto"
      >
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="flex-1 rounded border px-2 py-1 text-sm"
              placeholder="Type a date... (today, +3d, Apr 15)"
              value={dateTextInput}
              onChange={(e) => {
                setDateTextInput(e.target.value)
                const parsed = parseDate(e.target.value)
                setDateTextPreview(parsed)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dateTextPreview) {
                  e.preventDefault()
                  handleDateSelected(dateTextPreview)
                  setDateTextInput('')
                  setDateTextPreview(null)
                }
              }}
              aria-label="Type a date"
            />
          </div>
          {dateTextInput && (
            <p className="mt-1 text-xs text-muted-foreground">
              {dateTextPreview ? (
                <>
                  Parsed: <strong>{dateTextPreview}</strong> (press Enter to apply)
                </>
              ) : (
                <span className="text-destructive">Could not parse date</span>
              )}
            </p>
          )}
        </div>
        <Calendar mode="single" weekStartsOn={1} showOutsideDays onSelect={onSelect} />
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

interface BlockTreeProps {
  /** Optional parent block ID — when set, loads children of this block. */
  parentId?: string
  /** Navigate to a page in the page editor (cross-page navigation).
   *  Optional blockId scrolls to a specific block within the target page. */
  onNavigateToPage?: (pageId: string, title: string, blockId?: string) => void
}

export function BlockTree({ parentId, onNavigateToPage }: BlockTreeProps = {}): React.ReactElement {
  const { t } = useTranslation()
  const blocks = useBlockStore((s) => s.blocks)
  const rootParentId = useBlockStore((s) => s.rootParentId)
  const focusedBlockId = useBlockStore((s) => s.focusedBlockId)
  const loading = useBlockStore((s) => s.loading)
  const load = useBlockStore((s) => s.load)
  const setFocused = useBlockStore((s) => s.setFocused)
  const remove = useBlockStore((s) => s.remove)
  const edit = useBlockStore((s) => s.edit)
  const splitBlock = useBlockStore((s) => s.splitBlock)
  const indent = useBlockStore((s) => s.indent)
  const dedent = useBlockStore((s) => s.dedent)
  const reorder = useBlockStore((s) => s.reorder)
  const moveToParent = useBlockStore((s) => s.moveToParent)
  const moveUp = useBlockStore((s) => s.moveUp)
  const moveDown = useBlockStore((s) => s.moveDown)
  const createBelow = useBlockStore((s) => s.createBelow)

  // ── Collapse state ─────────────────────────────────────────────────
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  // ── Zoom state ─────────────────────────────────────────────────────
  const [zoomedBlockId, setZoomedBlockId] = useState<string | null>(null)

  // ── Date picker for /DATE and /DUE commands ────────────────────────
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [datePickerMode, setDatePickerMode] = useState<'date' | 'due' | 'schedule'>('date')
  const datePickerCursorPos = useRef<number | undefined>(undefined)

  // ── Enter-creates-block refs ───────────────────────────────────────
  const justCreatedBlockIds = useRef(new Set<string>())
  const prevFocusedRef = useRef<string | null>(null)

  // ── History sheet state ────────────────────────────────────────────
  const [historyBlockId, setHistoryBlockId] = useState<string | null>(null)

  const handleShowHistory = useCallback((blockId: string) => {
    setHistoryBlockId(blockId)
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
      if (blocks[i + 1].depth > blocks[i].depth) {
        set.add(blocks[i].id)
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
        block.depth <= skipUntilDepth[skipUntilDepth.length - 1]
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

  // ── Slash command definitions ──────────────────────────────────────
  const SLASH_COMMANDS: PickerItem[] = useMemo(
    () => [
      { id: 'todo', label: 'TODO — Mark as to-do' },
      { id: 'doing', label: 'DOING — Mark as in progress' },
      { id: 'done', label: 'DONE — Mark as complete' },
      { id: 'date', label: 'DATE — Link to a date page' },
      { id: 'due', label: 'DUE — Set due date on block' },
      { id: 'schedule', label: 'SCHEDULED — Set scheduled date on block' },
      { id: 'link', label: 'LINK — Insert page link' },
      { id: 'tag', label: 'TAG — Insert tag reference' },
      { id: 'code', label: 'CODE — Insert code block' },
      { id: 'effort', label: 'EFFORT — Set effort estimate (15m/30m/1h/2h/4h/1d)' },
      { id: 'assignee', label: 'ASSIGNEE — Set assignee' },
      { id: 'location', label: 'LOCATION — Set location' },
      { id: 'repeat', label: 'REPEAT — Set recurrence (daily/weekly/monthly/+Nd)' },
    ],
    [],
  )

  /** Priority commands — shown only when query matches (progressive disclosure). */
  const PRIORITY_COMMANDS: PickerItem[] = useMemo(
    () => [
      { id: 'priority-high', label: 'PRIORITY 1 — Set high priority' },
      { id: 'priority-medium', label: 'PRIORITY 2 — Set medium priority' },
      { id: 'priority-low', label: 'PRIORITY 3 — Set low priority' },
    ],
    [],
  )

  /** Heading commands — shown only when query matches (progressive disclosure). */
  const HEADING_COMMANDS: PickerItem[] = useMemo(
    () => [
      { id: 'h1', label: 'Heading 1 — Large heading' },
      { id: 'h2', label: 'Heading 2 — Medium heading' },
      { id: 'h3', label: 'Heading 3 — Small heading' },
      { id: 'h4', label: 'Heading 4' },
      { id: 'h5', label: 'Heading 5' },
      { id: 'h6', label: 'Heading 6' },
    ],
    [],
  )

  /** Repeat commands — shown only when query matches (progressive disclosure). */
  const REPEAT_COMMANDS: PickerItem[] = useMemo(
    () => [
      { id: 'repeat-daily', label: 'REPEAT DAILY — Every day' },
      { id: 'repeat-weekly', label: 'REPEAT WEEKLY — Every week' },
      { id: 'repeat-monthly', label: 'REPEAT MONTHLY — Every month' },
      { id: 'repeat-yearly', label: 'REPEAT YEARLY — Every year' },
    ],
    [],
  )

  const searchSlashCommands = useCallback(
    async (query: string): Promise<PickerItem[]> => {
      const q = query.toLowerCase()
      const baseResults = SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
      if (!q) return baseResults
      const priorityResults = PRIORITY_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
      const headingResults = HEADING_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
      const repeatResults = REPEAT_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
      return [...baseResults, ...priorityResults, ...headingResults, ...repeatResults]
    },
    [SLASH_COMMANDS, PRIORITY_COMMANDS, HEADING_COMMANDS, REPEAT_COMMANDS],
  )

  // ── Roving editor ──────────────────────────────────────────────────
  // handleNavigate and handleSlashCommand are defined below but referenced
  // via ref to avoid circular dependency with rovingEditor.
  const handleNavigateRef = useRef<(id: string) => void>(() => {})
  const handleSlashCommandRef = useRef<(item: PickerItem) => void>(() => {})
  const handleCheckboxRef = useRef<(state: 'TODO' | 'DONE') => void>(() => {})

  const rovingEditor = useRovingEditor({
    resolveBlockTitle: resolve.resolveBlockTitle,
    resolveTagName: resolve.resolveTagName,
    onNavigate: (id: string) => handleNavigateRef.current(id),
    resolveBlockStatus: resolve.resolveBlockStatus,
    resolveTagStatus: resolve.resolveTagStatus,
    searchTags: resolve.searchTags,
    searchPages: resolve.searchPages,
    onCreatePage: resolve.onCreatePage,
    onCreateTag: resolve.onCreateTag,
    searchSlashCommands,
    onSlashCommand: (item: PickerItem) => handleSlashCommandRef.current(item),
    onCheckbox: (state: 'TODO' | 'DONE') => handleCheckboxRef.current(state),
  })

  const viewport = useViewportObserver()

  useEffect(() => {
    load(parentId)
    setZoomedBlockId(null)
  }, [load, parentId])

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
            if (!currentCache.has(m[1])) uncached.add(m[1])
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
          setTodoStateCmd(blockId, todoState).catch(() => toast.error('Failed to set task state'))
          useBlockStore.setState((s) => ({
            blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, todo_state: todoState } : b)),
          }))
          edit(blockId, cleanContent)
        } else {
          edit(blockId, changed)
        }
      }
    }
    return changed
  }, [rovingEditor, edit, splitBlock])

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
    [collapsedIds, blocks, focusedBlockId, handleFlush, setFocused],
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
        await load(targetBlock.parent_id ?? undefined)
        setFocused(targetId)
        rovingEditor.mount(targetId, targetBlock.content ?? '')
      } catch {
        toast.error('Link target not found')
      }
    },
    [handleFlush, load, setFocused, rovingEditor, rootParentId, onNavigateToPage],
  )

  // Keep the ref in sync with the latest handleNavigate
  handleNavigateRef.current = handleNavigate

  // ── Slash command handler ──────────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor position read at call time, not a reactive dependency
  const handleSlashCommand = useCallback(
    async (item: PickerItem) => {
      if (!focusedBlockId) return

      if (item.id === 'todo' || item.id === 'doing' || item.id === 'done') {
        const state = item.id.toUpperCase()
        try {
          await setTodoStateCmd(focusedBlockId, state)
          useBlockStore.setState((s) => ({
            blocks: s.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, todo_state: state } : b,
            ),
          }))
        } catch {
          toast.error('Failed to set task state')
        }
      }

      if (item.id === 'date') {
        // Save cursor position before opening the date picker — the editor
        // will lose focus when the user clicks the calendar.
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
        setDatePickerMode('date')
        setDatePickerOpen(true)
      }

      if (item.id === 'due') {
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
        setDatePickerMode('due')
        setDatePickerOpen(true)
      }

      if (item.id === 'schedule') {
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
        setDatePickerMode('schedule')
        setDatePickerOpen(true)
        return
      }

      if (item.id === 'link') {
        rovingEditor.editor?.chain().focus().insertContent('[[').run()
        return
      }

      if (item.id === 'tag') {
        rovingEditor.editor?.chain().focus().insertContent('@').run()
        return
      }

      if (item.id === 'code') {
        rovingEditor.editor?.chain().focus().toggleCodeBlock().run()
        return
      }

      if (
        item.id === 'priority-high' ||
        item.id === 'priority-medium' ||
        item.id === 'priority-low'
      ) {
        const priority =
          item.id === 'priority-high' ? '1' : item.id === 'priority-medium' ? '2' : '3'
        try {
          await setPriorityCmd(focusedBlockId, priority)
          useBlockStore.setState((s) => ({
            blocks: s.blocks.map((b) => (b.id === focusedBlockId ? { ...b, priority } : b)),
          }))
        } catch {
          toast.error('Failed to set priority')
        }
      }

      const headingMatch = item.id.match(/^h([1-6])$/)
      if (headingMatch) {
        const level = Number(headingMatch[1])
        // Read current content from the editor (which has the slash text already removed)
        let currentContent = ''
        if (rovingEditor.editor) {
          const json = rovingEditor.editor.getJSON() as DocNode
          currentContent = serialize(json)
        } else {
          const block = useBlockStore.getState().blocks.find((b) => b.id === focusedBlockId)
          currentContent = block?.content ?? ''
        }
        // Strip existing heading prefix (if any)
        const headingRegex = /^#{1,6}\s/
        const stripped = currentContent.replace(headingRegex, '')
        const newContent = `${'#'.repeat(level)} ${stripped}`
        try {
          await editBlock(focusedBlockId, newContent)
          // Reload the block in the store
          useBlockStore.setState((state) => ({
            blocks: state.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, content: newContent } : b,
            ),
          }))
          // Re-mount editor so the heading renders immediately
          rovingEditor.mount(focusedBlockId, newContent)
        } catch {
          toast.error('Failed to set heading')
        }
      }

      if (item.id === 'effort' || item.id === 'assignee' || item.id === 'location') {
        if (!focusedBlockId) return
        try {
          await setProperty({ blockId: focusedBlockId, key: item.id, valueText: '' })
          toast.success(`Added ${item.label.split(' — ')[0].toLowerCase()} property`)
        } catch {
          toast.error('Failed to add property')
        }
        return
      }

      if (item.id.startsWith('repeat-')) {
        if (!focusedBlockId) return
        const value = item.id.replace('repeat-', '')
        try {
          await setProperty({ blockId: focusedBlockId, key: 'repeat', valueText: value })
          toast.success(t('slash.repeatSet', { value }))
        } catch {
          toast.error(t('slash.repeatFailed'))
        }
        return
      }
    },
    [focusedBlockId],
  )

  /** Handle date selection from the /DATE picker. Finds or creates the date page and inserts a block link. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolve.pagesListRef is a stable ref, not a reactive dependency
  const handleDatePick = useCallback(
    async (d: Date) => {
      setDatePickerOpen(false)
      const dd = String(d.getDate()).padStart(2, '0')
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const yyyy = d.getFullYear()
      const dateStr = `${yyyy}-${mm}-${dd}`

      if (datePickerMode === 'due') {
        // /DUE mode — set due_date on the focused block
        if (!focusedBlockId) return
        try {
          await setDueDateCmd(focusedBlockId, dateStr)
          useBlockStore.setState((s) => ({
            blocks: s.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, due_date: dateStr } : b,
            ),
          }))
        } catch {
          toast.error('Failed to set due date')
        }
        return
      }

      if (datePickerMode === 'schedule') {
        // /SCHEDULE mode — set scheduled_date on the focused block
        if (!focusedBlockId) return
        try {
          await setScheduledDateCmd(focusedBlockId, dateStr)
          useBlockStore.setState((s) => ({
            blocks: s.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, scheduled_date: dateStr } : b,
            ),
          }))
        } catch {
          toast.error('Failed to set scheduled date')
        }
        return
      }

      // /DATE mode — insert block link to a date page
      // Also check for the legacy DD/MM/YYYY format to avoid duplicates
      const legacyStr = `${dd}/${mm}/${yyyy}`

      // Find existing date page (check both formats) or create
      const resp = await listBlocks({ blockType: 'page', limit: 500 })
      let datePageId = resp.items.find((b) => b.content === dateStr || b.content === legacyStr)?.id
      if (!datePageId) {
        const newPage = await createBlock({ blockType: 'page', content: dateStr })
        datePageId = newPage.id
        // Update resolve cache so the link chip shows the date immediately
        useResolveStore.getState().set(newPage.id, dateStr, false)
        resolve.pagesListRef.current = [
          ...resolve.pagesListRef.current,
          { id: newPage.id, title: dateStr },
        ]
      }

      // Restore focus and insert the block link at cursor position
      if (rovingEditor.editor && datePageId) {
        const editor = rovingEditor.editor
        const id = datePageId
        // Re-focus the editor — the blur guard kept it mounted
        editor.commands.focus()
        // Insert on next frame to ensure focus is settled
        requestAnimationFrame(() => {
          editor.chain().focus().insertBlockLink(id).run()
        })
      }
    },
    [rovingEditor, datePickerMode, focusedBlockId],
  )

  // Keep the slash command ref in sync
  handleSlashCommandRef.current = handleSlashCommand

  const handleCheckboxSyntax = useCallback(
    (state: 'TODO' | 'DONE') => {
      if (!focusedBlockId) return
      setTodoStateCmd(focusedBlockId, state).catch(() => toast.error('Failed to set task state'))
      useBlockStore.setState((s) => ({
        blocks: s.blocks.map((b) => (b.id === focusedBlockId ? { ...b, todo_state: state } : b)),
      }))
    },
    [focusedBlockId],
  )

  handleCheckboxRef.current = handleCheckboxSyntax

  const handleFocusPrev = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
      const preview = prevBlock.content?.slice(0, 50) ?? ''
      announce(`Editing block: ${preview || 'empty block'}`)
    }
  }, [collapsedVisible, focusedBlockId, setFocused, rovingEditor])

  const handleFocusNext = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx >= 0 && idx < collapsedVisible.length - 1) {
      const nextBlock = collapsedVisible[idx + 1]
      setFocused(nextBlock.id)
      rovingEditor.mount(nextBlock.id, nextBlock.content ?? '')
      const preview = nextBlock.content?.slice(0, 50) ?? ''
      announce(`Editing block: ${preview || 'empty block'}`)
    }
  }, [collapsedVisible, focusedBlockId, setFocused, rovingEditor])

  const handleDeleteBlock = useCallback(() => {
    if (!focusedBlockId) return
    if (collapsedVisible.length <= 1) {
      toast.error('Cannot delete the last block on a page')
      return
    }
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    rovingEditor.unmount()
    remove(focusedBlockId)
    announce('Block deleted')
    // Focus previous block, or next visible at same level, or nothing
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
    } else if (idx + 1 < collapsedVisible.length) {
      const nextBlock = collapsedVisible[idx + 1]
      setFocused(nextBlock.id)
      rovingEditor.mount(nextBlock.id, nextBlock.content ?? '')
    } else {
      setFocused(null)
    }
  }, [focusedBlockId, collapsedVisible, rovingEditor, remove, setFocused])

  const handleIndent = useCallback(() => {
    if (!focusedBlockId) return
    // Flush editor content before structural move
    handleFlush()
    indent(focusedBlockId)
    announce('Block indented')
  }, [focusedBlockId, handleFlush, indent])

  const handleDedent = useCallback(() => {
    if (!focusedBlockId) return
    // Flush editor content before structural move
    handleFlush()
    dedent(focusedBlockId)
    announce('Block outdented')
  }, [focusedBlockId, handleFlush, dedent])

  // ── Move block up/down (Ctrl+Shift+Arrow) ─────────────────────────
  const handleMoveUp = useCallback(() => {
    if (!focusedBlockId) return
    handleFlush()
    moveUp(focusedBlockId)
    announce('Block moved up')
  }, [focusedBlockId, handleFlush, moveUp])

  const handleMoveDown = useCallback(() => {
    if (!focusedBlockId) return
    handleFlush()
    moveDown(focusedBlockId)
    announce('Block moved down')
  }, [focusedBlockId, handleFlush, moveDown])

  // ── Merge with previous block (p2-t11) ────────────────────────────
  const handleMergeWithPrev = useCallback(async () => {
    if (!focusedBlockId) return
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx <= 0) return // First block — nothing to merge with

    const prevBlock = collapsedVisible[idx - 1]

    // Get current block content from the editor
    const currentContent = rovingEditor.unmount() ?? collapsedVisible[idx].content ?? ''
    const prevContent = prevBlock.content ?? ''

    // Merge: concatenate previous content + current content
    const mergedContent = prevContent + currentContent
    const prevDoc = parse(prevContent)
    const joinPoint = pmEndOfFirstBlock(prevDoc)

    // Update previous block with merged content, then remove current block.
    // Await edit before remove to prevent data loss if edit fails.
    try {
      await edit(prevBlock.id, mergedContent)
      await remove(focusedBlockId)
    } catch {
      // Re-mount the editor on the current block so the user can retry
      rovingEditor.mount(focusedBlockId, currentContent)
      toast.error('Failed to merge blocks')
      return
    }

    // Focus previous block at the join point
    setFocused(prevBlock.id)
    rovingEditor.mount(prevBlock.id, mergedContent)

    // Position cursor at the join point (after the previous content)
    // Use setTimeout to let the editor mount complete
    setTimeout(() => {
      if (rovingEditor.editor) {
        // pmEndOfFirstBlock returns the PM position at the end of the
        // first block's inline content (already includes the paragraph
        // open-tag offset), so no extra +1 is needed.
        const pmPos = Math.min(joinPoint, rovingEditor.editor.state.doc.content.size - 1)
        rovingEditor.editor.commands.setTextSelection(pmPos)
      }
    }, 0)
  }, [focusedBlockId, collapsedVisible, rovingEditor, edit, remove, setFocused])

  // ── Merge by block ID (context menu) ─────────────────────────────
  const handleMergeById = useCallback(
    async (blockId: string) => {
      const idx = collapsedVisible.findIndex((b) => b.id === blockId)
      if (idx <= 0) return // First block — nothing to merge with

      const prevBlock = collapsedVisible[idx - 1]

      // If the editor is mounted on this block, unmount to capture latest content
      const editorContent = focusedBlockId === blockId ? rovingEditor.unmount() : null
      const currentContent = editorContent ?? collapsedVisible[idx].content ?? ''
      const prevContent = prevBlock.content ?? ''

      const mergedContent = prevContent + currentContent

      try {
        await edit(prevBlock.id, mergedContent)
        await remove(blockId)
      } catch {
        // Re-mount editor if it was unmounted
        if (editorContent !== null) {
          rovingEditor.mount(blockId, currentContent)
        }
        toast.error('Failed to merge blocks')
        return
      }

      setFocused(prevBlock.id)
    },
    [collapsedVisible, focusedBlockId, rovingEditor, edit, remove, setFocused],
  )

  // ── Enter: save content + create new sibling below ───────────────────
  const handleEnterSave = useCallback(async () => {
    if (!focusedBlockId) return
    handleFlush()
    const newBlockId = await createBelow(focusedBlockId)
    if (newBlockId) {
      justCreatedBlockIds.current.add(newBlockId)
      setFocused(newBlockId)
    }
  }, [focusedBlockId, handleFlush, createBelow, setFocused])

  // ── Escape: discard changes, unfocus ───────────────────────────────
  const handleEscapeCancel = useCallback(() => {
    if (!focusedBlockId) return
    // Unmount but discard the result — don't save changes
    const changed = rovingEditor.unmount()
    if (changed !== null) {
      toast('Changes discarded', { duration: 2000 })
    }
    setFocused(null)
  }, [focusedBlockId, rovingEditor, setFocused])

  useBlockKeyboard(rovingEditor.editor, {
    onFocusPrev: handleFocusPrev,
    onFocusNext: handleFocusNext,
    onDeleteBlock: handleDeleteBlock,
    onIndent: handleIndent,
    onDedent: handleDedent,
    onMoveUp: handleMoveUp,
    onMoveDown: handleMoveDown,
    onFlush: handleFlush,
    onMergeWithPrev: handleMergeWithPrev,
    onEnterSave: handleEnterSave,
    onEscapeCancel: handleEscapeCancel,
    onToggleTodo: () => focusedBlockId && handleToggleTodo(focusedBlockId),
    onToggleCollapse: () => focusedBlockId && toggleCollapse(focusedBlockId),
  })

  // ── Discard button custom event (from FormattingToolbar) ───────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) {
        handleEscapeCancel()
      }
    }
    document.addEventListener('discard-block-edit', handler)
    return () => document.removeEventListener('discard-block-edit', handler)
  }, [focusedBlockId, handleEscapeCancel])

  // ── Empty-block cleanup: delete just-created blocks left empty ─────
  useEffect(() => {
    const prevId = prevFocusedRef.current
    prevFocusedRef.current = focusedBlockId

    if (prevId && prevId !== focusedBlockId && justCreatedBlockIds.current.has(prevId)) {
      justCreatedBlockIds.current.delete(prevId)
      const block = useBlockStore.getState().blocks.find((b) => b.id === prevId)
      if (block && (!block.content || block.content.trim() === '')) {
        remove(prevId)
      }
    }
  }, [focusedBlockId, remove])

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

  // ── Priority keyboard shortcut event listeners (Mod+Shift+1/2/3) ───
  useEffect(() => {
    const handlePriorityEvent = async (e: Event) => {
      if (!focusedBlockId) return
      const eventType = e.type
      const priority =
        eventType === 'set-priority-1' ? '1' : eventType === 'set-priority-2' ? '2' : '3'
      try {
        await setPriorityCmd(focusedBlockId, priority)
        useBlockStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === focusedBlockId ? { ...b, priority } : b)),
        }))
      } catch {
        toast.error('Failed to set priority')
      }
    }
    document.addEventListener('set-priority-1', handlePriorityEvent)
    document.addEventListener('set-priority-2', handlePriorityEvent)
    document.addEventListener('set-priority-3', handlePriorityEvent)
    return () => {
      document.removeEventListener('set-priority-1', handlePriorityEvent)
      document.removeEventListener('set-priority-2', handlePriorityEvent)
      document.removeEventListener('set-priority-3', handlePriorityEvent)
    }
  }, [focusedBlockId])

  // ── Listen for toolbar date picker event ────────────────────────────
  useEffect(() => {
    const handleDateEvent = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
      setDatePickerMode('date')
      setDatePickerOpen(true)
    }
    document.addEventListener('open-date-picker', handleDateEvent)
    return () => document.removeEventListener('open-date-picker', handleDateEvent)
  }, [focusedBlockId, rovingEditor.editor])

  // ── Listen for toolbar due-date picker event ─────────────────────────
  useEffect(() => {
    const handler = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos ?? undefined
      setDatePickerMode('due')
      setDatePickerOpen(true)
    }
    document.addEventListener('open-due-date-picker', handler)
    return () => document.removeEventListener('open-due-date-picker', handler)
  }, [focusedBlockId, rovingEditor])

  // ── Listen for toolbar scheduled-date picker event ──────────────────
  useEffect(() => {
    const handler = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos ?? undefined
      setDatePickerMode('schedule')
      setDatePickerOpen(true)
    }
    document.addEventListener('open-scheduled-date-picker', handler)
    return () => document.removeEventListener('open-scheduled-date-picker', handler)
  }, [focusedBlockId, rovingEditor])

  // ── Listen for toolbar toggle-todo-state event ──────────────────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) handleToggleTodo(focusedBlockId)
    }
    document.addEventListener('toggle-todo-state', handler)
    return () => document.removeEventListener('toggle-todo-state', handler)
  }, [focusedBlockId, handleToggleTodo])

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
  }, [focusedBlockId, rovingEditor.editor])

  // ── Keyboard shortcut: Ctrl+1‑6 → toggle heading level ─────────────
  useEffect(() => {
    const handleHeadingShortcut = async (e: KeyboardEvent) => {
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

  // ── Active item for DragOverlay ────────────────────────────────────
  const activeBlock = dnd.activeId ? blocks.find((b) => b.id === dnd.activeId) : null

  if (loading) {
    return (
      <div
        className="block-tree-loading space-y-3 p-2"
        role="status"
        aria-busy="true"
        aria-label="Loading blocks"
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
          <div className="block-tree space-y-0.5 [@media(pointer:coarse)]:space-y-1.5">
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
                    onDelete={(id) => remove(id)}
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
                    onIndent={(id) => indent(id)}
                    onDedent={(id) => dedent(id)}
                    onMoveUp={(id) => {
                      handleFlush()
                      moveUp(id)
                    }}
                    onMoveDown={(id) => {
                      handleFlush()
                      moveDown(id)
                    }}
                    onMerge={handleMergeById}
                    onShowHistory={handleShowHistory}
                    onZoomIn={hasChildrenSet.has(block.id) ? handleZoomIn : undefined}
                  />
                </div>
              )
            })}
            {blocks.length === 0 && (
              <EmptyState message="No blocks yet. Click + Add block below to start writing." />
            )}
          </div>
        </SortableContext>
        {/* SR announcement for DnD projected drop position */}
        {dnd.activeId && dnd.projected && (
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {`Moving to depth ${dnd.projected.depth}`}
          </div>
        )}
        {/* Drag overlay: floating preview of the dragged block */}
        <DragOverlay dropAnimation={null}>
          {activeBlock ? (
            <div
              className="sortable-block-overlay rounded border bg-background/90 px-3 py-1.5 shadow-lg text-sm opacity-80"
              style={{ maxWidth: 320 }}
            >
              {(activeBlock.content ?? '').slice(0, 80) || 'Empty block'}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Floating date picker for /DATE slash command */}
      {datePickerOpen && (
        <DatePickerOverlay
          onSelect={(day) => day && handleDatePick(day)}
          onClose={() => setDatePickerOpen(false)}
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
    </>
  )
}
