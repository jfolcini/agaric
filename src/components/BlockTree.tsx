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
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parse, serialize } from '../editor/markdown-serializer'
import type { PickerItem } from '../editor/SuggestionList'
import type { DocNode } from '../editor/types'
import { useBlockKeyboard } from '../editor/use-block-keyboard'
import { useRovingEditor } from '../editor/use-roving-editor'
import { useBlockDnD } from '../hooks/useBlockDnD'
import { useBlockProperties } from '../hooks/useBlockProperties'
import { useBlockResolve } from '../hooks/useBlockResolve'
import { useViewportObserver } from '../hooks/useViewportObserver'
import type { PropertyRow } from '../lib/tauri'
import {
  batchResolve,
  createBlock,
  editBlock,
  getBlock,
  getProperties,
  listBlocks,
  listTagsByPrefix,
  setProperty,
} from '../lib/tauri'
import { getDragDescendants } from '../lib/tree-utils'
import { useBlockStore } from '../stores/blocks'
import { useResolveStore } from '../stores/resolve'
import { EmptyState } from './EmptyState'
import { INDENT_WIDTH, SortableBlock } from './SortableBlock'
import { Calendar } from './ui/calendar'

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
  const {
    blocks,
    rootParentId,
    focusedBlockId,
    loading,
    load,
    setFocused,
    remove,
    edit,
    splitBlock,
    indent,
    dedent,
    reorder,
    moveToParent,
    moveUp,
    moveDown,
  } = useBlockStore()

  // ── Collapse state ─────────────────────────────────────────────────
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  // ── Date picker for /DATE command ─────────────────────────────────
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const datePickerCursorPos = useRef<number | undefined>(undefined)

  // ── Extracted hooks ────────────────────────────────────────────────
  const resolve = useBlockResolve()
  const properties = useBlockProperties()
  const { getTodoState, handleToggleTodo, handleTogglePriority, setBlockProperties } = properties

  /** Get the priority value for a block from the properties cache. */
  const getPriority = useCallback(
    (blockId: string): string | null => {
      const props = properties.blockProperties.get(blockId)
      return props?.find((p) => p.key === 'priority')?.value_text ?? null
    },
    [properties.blockProperties],
  )

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

  // ── Slash command definitions ──────────────────────────────────────
  const SLASH_COMMANDS: PickerItem[] = useMemo(
    () => [
      { id: 'todo', label: 'TODO — Mark as to-do' },
      { id: 'doing', label: 'DOING — Mark as in progress' },
      { id: 'done', label: 'DONE — Mark as complete' },
      { id: 'date', label: 'DATE — Link to a date page' },
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

  const searchSlashCommands = useCallback(
    async (query: string): Promise<PickerItem[]> => {
      const q = query.toLowerCase()
      const baseResults = SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
      if (!q) return baseResults
      const priorityResults = PRIORITY_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
      const headingResults = HEADING_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
      return [...baseResults, ...priorityResults, ...headingResults]
    },
    [SLASH_COMMANDS, PRIORITY_COMMANDS, HEADING_COMMANDS],
  )

  // ── Roving editor ──────────────────────────────────────────────────
  // handleNavigate and handleSlashCommand are defined below but referenced
  // via ref to avoid circular dependency with rovingEditor.
  const handleNavigateRef = useRef<(id: string) => void>(() => {})
  const handleSlashCommandRef = useRef<(item: PickerItem) => void>(() => {})

  const rovingEditor = useRovingEditor({
    resolveBlockTitle: resolve.resolveBlockTitle,
    resolveTagName: resolve.resolveTagName,
    onNavigate: (id: string) => handleNavigateRef.current(id),
    resolveBlockStatus: resolve.resolveBlockStatus,
    resolveTagStatus: resolve.resolveTagStatus,
    searchTags: resolve.searchTags,
    searchPages: resolve.searchPages,
    onCreatePage: resolve.onCreatePage,
    searchSlashCommands,
    onSlashCommand: (item: PickerItem) => handleSlashCommandRef.current(item),
  })

  const viewport = useViewportObserver()

  useEffect(() => {
    load(parentId)
  }, [load, parentId])

  // Preload all pages + tags into the resolve cache so link chips show
  // resolved titles on first render instead of truncated ULIDs.
  // MUST be declared after the load effect so it fires second on mount.
  useEffect(() => {
    let cancelled = false
    async function preload() {
      try {
        const store = useResolveStore.getState()

        // Fetch all pages
        const pagesResp = await listBlocks({ blockType: 'page', limit: 1000 })
        if (cancelled) return
        const pagesList: Array<{ id: string; title: string }> = []
        for (const p of pagesResp.items) {
          const title = p.content ?? 'Untitled'
          store.set(p.id, title, p.deleted_at !== null)
          pagesList.push({ id: p.id, title })
        }
        resolve.pagesListRef.current = pagesList

        // Fetch all tags
        const tags = await listTagsByPrefix({ prefix: '' })
        if (cancelled) return
        for (const t of tags) {
          store.set(t.tag_id, t.name, false)
        }

        // Scan loaded blocks for [[ULID]] tokens not yet cached
        const ULID_LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
        const uncached = new Set<string>()
        const currentCache = useResolveStore.getState().cache
        for (const b of blocks) {
          if (!b.content) continue
          for (const m of b.content.matchAll(ULID_LINK_RE)) {
            if (!currentCache.has(m[1])) uncached.add(m[1])
          }
        }

        // Batch-fetch any uncached block references via single IPC call
        if (uncached.size > 0) {
          try {
            const resolved = await batchResolve([...uncached])
            if (!cancelled) {
              for (const r of resolved) {
                store.set(r.id, r.title?.slice(0, 60) || `[[${r.id.slice(0, 8)}...]]`, r.deleted)
              }
            }
          } catch {
            // Batch resolve failed — fallback entries stay as truncated ULIDs
          }
        }
      } catch {
        // Preload failed — resolve callbacks will use fallbacks
      }
    }
    preload()
    return () => {
      cancelled = true
    }
  }, [blocks, resolve.pagesListRef])

  // ── Fetch properties for all blocks (batch) ────────────────────────
  useEffect(() => {
    if (blocks.length === 0) return
    const fetchProps = async () => {
      const propsMap = new Map<string, PropertyRow[]>()
      await Promise.all(
        blocks.map(async (b) => {
          try {
            const props = await getProperties(b.id)
            if (props.length > 0) propsMap.set(b.id, props)
          } catch {
            /* ignore */
          }
        }),
      )
      setBlockProperties(propsMap)
    }
    fetchProps()
  }, [blocks, setBlockProperties])

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
          // Set the todo property and save cleaned content
          setProperty({ blockId, key: 'todo', valueText: todoState })
          edit(blockId, cleanContent)
          // Update local properties cache
          setBlockProperties((prev) => {
            const next = new Map(prev)
            const props = (next.get(blockId) ?? []).filter((p) => p.key !== 'todo')
            props.push({
              key: 'todo',
              value_text: todoState,
              value_num: null,
              value_date: null,
              value_ref: null,
            })
            next.set(blockId, props)
            return next
          })
        } else {
          edit(blockId, changed)
        }
      }
    }
    return changed
  }, [rovingEditor, edit, splitBlock, setBlockProperties])

  // ── DnD hook (needs handleFlush + collapsedVisible) ────────────────
  const dnd = useBlockDnD({
    blocks,
    collapsedVisible,
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
        // Block not found (deleted/purged) — no-op, don't crash
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
        await setProperty({ blockId: focusedBlockId, key: 'todo', valueText: state })
        // Update local properties cache
        setBlockProperties((prev) => {
          const next = new Map(prev)
          const props = (next.get(focusedBlockId) ?? []).filter((p) => p.key !== 'todo')
          props.push({
            key: 'todo',
            value_text: state,
            value_num: null,
            value_date: null,
            value_ref: null,
          })
          next.set(focusedBlockId, props)
          return next
        })
      }

      if (item.id === 'date') {
        // Save cursor position before opening the date picker — the editor
        // will lose focus when the user clicks the calendar.
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
        setDatePickerOpen(true)
      }

      if (
        item.id === 'priority-high' ||
        item.id === 'priority-medium' ||
        item.id === 'priority-low'
      ) {
        const priority =
          item.id === 'priority-high' ? 'A' : item.id === 'priority-medium' ? 'B' : 'C'
        await setProperty({ blockId: focusedBlockId, key: 'priority', valueText: priority })
        setBlockProperties((prev) => {
          const next = new Map(prev)
          const props = (next.get(focusedBlockId) ?? []).filter((p) => p.key !== 'priority')
          props.push({
            key: 'priority',
            value_text: priority,
            value_num: null,
            value_date: null,
            value_ref: null,
          })
          next.set(focusedBlockId, props)
          return next
        })
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
        await editBlock(focusedBlockId, newContent)
        // Reload the block in the store
        useBlockStore.setState((state) => ({
          blocks: state.blocks.map((b) =>
            b.id === focusedBlockId ? { ...b, content: newContent } : b,
          ),
        }))
        // Re-mount editor so the heading renders immediately
        rovingEditor.mount(focusedBlockId, newContent)
      }
    },
    [focusedBlockId, setBlockProperties],
  )

  /** Handle date selection from the /DATE picker. Finds or creates the date page and inserts a block link. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolve.pagesListRef is a stable ref, not a reactive dependency
  const handleDatePick = useCallback(
    async (d: Date) => {
      setDatePickerOpen(false)
      const dd = String(d.getDate()).padStart(2, '0')
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const yyyy = d.getFullYear()
      const dateStr = `${dd}/${mm}/${yyyy}`
      // Also check for the journal YYYY-MM-DD format to avoid duplicates
      const isoStr = `${yyyy}-${mm}-${dd}`

      // Find existing date page (check both formats) or create
      const resp = await listBlocks({ blockType: 'page', limit: 500 })
      let datePageId = resp.items.find((b) => b.content === dateStr || b.content === isoStr)?.id
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
    [rovingEditor],
  )

  // Keep the slash command ref in sync
  handleSlashCommandRef.current = handleSlashCommand

  const handleFocusPrev = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
    }
  }, [collapsedVisible, focusedBlockId, setFocused, rovingEditor])

  const handleFocusNext = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx >= 0 && idx < collapsedVisible.length - 1) {
      const nextBlock = collapsedVisible[idx + 1]
      setFocused(nextBlock.id)
      rovingEditor.mount(nextBlock.id, nextBlock.content ?? '')
    }
  }, [collapsedVisible, focusedBlockId, setFocused, rovingEditor])

  const handleDeleteBlock = useCallback(() => {
    if (!focusedBlockId) return
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    rovingEditor.unmount()
    remove(focusedBlockId)
    // Focus previous block, or next, or nothing
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
    } else if (collapsedVisible.length > 1) {
      const nextBlock = collapsedVisible[1]
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
  }, [focusedBlockId, handleFlush, indent])

  const handleDedent = useCallback(() => {
    if (!focusedBlockId) return
    // Flush editor content before structural move
    handleFlush()
    dedent(focusedBlockId)
  }, [focusedBlockId, handleFlush, dedent])

  // ── Move block up/down (Ctrl+Shift+Arrow) ─────────────────────────
  const handleMoveUp = useCallback(() => {
    if (!focusedBlockId) return
    handleFlush()
    moveUp(focusedBlockId)
  }, [focusedBlockId, handleFlush, moveUp])

  const handleMoveDown = useCallback(() => {
    if (!focusedBlockId) return
    handleFlush()
    moveDown(focusedBlockId)
  }, [focusedBlockId, handleFlush, moveDown])

  // ── Merge with previous block (p2-t11) ────────────────────────────
  const handleMergeWithPrev = useCallback(() => {
    if (!focusedBlockId) return
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx <= 0) return // First block — nothing to merge with

    const prevBlock = collapsedVisible[idx - 1]

    // Get current block content from the editor
    const currentContent = rovingEditor.unmount() ?? collapsedVisible[idx].content ?? ''
    const prevContent = prevBlock.content ?? ''

    // Merge: concatenate previous content + current content
    const mergedContent = prevContent + currentContent
    const joinPoint = prevContent.length

    // Update previous block with merged content and remove current block
    edit(prevBlock.id, mergedContent)
    remove(focusedBlockId)

    // Focus previous block at the join point
    setFocused(prevBlock.id)
    rovingEditor.mount(prevBlock.id, mergedContent)

    // Position cursor at the join point (after the previous content)
    // Use setTimeout to let the editor mount complete
    setTimeout(() => {
      if (rovingEditor.editor) {
        // In ProseMirror, position 0 is before the first paragraph,
        // position 1 is at the start of text. So join point in PM = joinPoint + 1.
        const pmPos = Math.min(joinPoint + 1, rovingEditor.editor.state.doc.content.size - 1)
        rovingEditor.editor.commands.setTextSelection(pmPos)
      }
    }, 0)
  }, [focusedBlockId, collapsedVisible, rovingEditor, edit, remove, setFocused])

  // ── Enter: save content + close editor ───────────────────────────────
  const handleEnterSave = useCallback(() => {
    if (!focusedBlockId) return
    handleFlush()
    setFocused(null)
  }, [focusedBlockId, handleFlush, setFocused])

  // ── Escape: discard changes, unfocus ───────────────────────────────
  const handleEscapeCancel = useCallback(() => {
    if (!focusedBlockId) return
    // Unmount but discard the result — don't save changes
    rovingEditor.unmount()
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
    const handlePriorityEvent = (e: Event) => {
      if (!focusedBlockId) return
      const eventType = e.type
      const priority =
        eventType === 'set-priority-1' ? 'A' : eventType === 'set-priority-2' ? 'B' : 'C'
      setProperty({ blockId: focusedBlockId, key: 'priority', valueText: priority })
      setBlockProperties((prev) => {
        const next = new Map(prev)
        const props = (next.get(focusedBlockId) ?? []).filter((p) => p.key !== 'priority')
        props.push({
          key: 'priority',
          value_text: priority,
          value_num: null,
          value_date: null,
          value_ref: null,
        })
        next.set(focusedBlockId, props)
        return next
      })
    }
    document.addEventListener('set-priority-1', handlePriorityEvent)
    document.addEventListener('set-priority-2', handlePriorityEvent)
    document.addEventListener('set-priority-3', handlePriorityEvent)
    return () => {
      document.removeEventListener('set-priority-1', handlePriorityEvent)
      document.removeEventListener('set-priority-2', handlePriorityEvent)
      document.removeEventListener('set-priority-3', handlePriorityEvent)
    }
  }, [focusedBlockId, setBlockProperties])

  // ── Listen for toolbar date picker event ────────────────────────────
  useEffect(() => {
    const handleDateEvent = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
      setDatePickerOpen(true)
    }
    document.addEventListener('open-date-picker', handleDateEvent)
    return () => document.removeEventListener('open-date-picker', handleDateEvent)
  }, [focusedBlockId, rovingEditor.editor])

  // ── Active item for DragOverlay ────────────────────────────────────
  const activeBlock = dnd.activeId ? blocks.find((b) => b.id === dnd.activeId) : null

  if (loading) {
    return (
      <div className="block-tree-loading flex items-center justify-center p-8 text-sm text-muted-foreground">
        Loading blocks...
      </div>
    )
  }

  // DnD measuring config: always measure during drag for correct collision detection
  const measuring = {
    droppable: { strategy: MeasuringStrategy.Always },
  }

  return (
    <>
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
          <div className="block-tree space-y-0.5">
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
                      style={{ marginLeft: dnd.projected.depth * INDENT_WIDTH }}
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
                    todoState={getTodoState(block.id)}
                    onToggleTodo={handleToggleTodo}
                    priority={getPriority(block.id)}
                    onTogglePriority={handleTogglePriority}
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
                  />
                </div>
              )
            })}
            {blocks.length === 0 && (
              <EmptyState message="No blocks yet. Click + Add block below to start writing." />
            )}
          </div>
        </SortableContext>
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
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
          <div className="fixed inset-0 z-40" onClick={() => setDatePickerOpen(false)} />
          <div className="date-picker-popup fixed left-1/2 top-1/3 z-50 -translate-x-1/2 rounded-md border bg-popover p-2 shadow-lg">
            <Calendar
              mode="single"
              weekStartsOn={1}
              showOutsideDays
              onSelect={(day) => day && handleDatePick(day)}
            />
          </div>
        </>
      )}
    </>
  )
}
