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

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PickerItem } from '../editor/SuggestionList'
import { useBlockKeyboard } from '../editor/use-block-keyboard'
import { useRovingEditor } from '../editor/use-roving-editor'
import { useViewportObserver } from '../hooks/useViewportObserver'
import type { PropertyRow } from '../lib/tauri'
import {
  batchResolve,
  createBlock,
  deleteProperty,
  getBlock,
  getProperties,
  listBlocks,
  listTagsByPrefix,
  searchBlocks,
  setProperty,
} from '../lib/tauri'
import {
  computePosition,
  type FlatBlock,
  getDragDescendants,
  getProjection,
} from '../lib/tree-utils'
import { useBlockStore } from '../stores/blocks'
import { EmptyState } from './EmptyState'
import { INDENT_WIDTH, SortableBlock } from './SortableBlock'
import { Calendar } from './ui/calendar'

/** Cached info about a block/tag for resolve callbacks. */
interface BlockInfo {
  title: string
  deleted: boolean
}

/** Task state cycle: none → TODO → DOING → DONE → none. */
const TASK_CYCLE: readonly (string | null)[] = [null, 'TODO', 'DOING', 'DONE']

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
  } = useBlockStore()

  // ── DnD state ──────────────────────────────────────────────────────
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [offsetLeft, setOffsetLeft] = useState(0)

  // ── Collapse state ─────────────────────────────────────────────────
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  // ── Block properties (task state) ─────────────────────────────────
  const [blockProperties, setBlockProperties] = useState<Map<string, PropertyRow[]>>(new Map())

  // ── Date picker for /DATE command ─────────────────────────────────
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const datePickerCursorPos = useRef<number | undefined>(undefined)

  /** Get the current todo state for a block from the properties cache. */
  const getTodoState = useCallback(
    (blockId: string): string | null => {
      const props = blockProperties.get(blockId)
      const todoProp = props?.find((p) => p.key === 'todo')
      return todoProp?.value_text ?? null
    },
    [blockProperties],
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
    const result: FlatBlock[] = []
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

  // Items visible during drag: exclude descendants of the active item
  const activeDescendants = useMemo(
    () => (activeId ? getDragDescendants(collapsedVisible, activeId) : new Set<string>()),
    [activeId, collapsedVisible],
  )

  const visibleItems = useMemo(
    () =>
      activeId ? collapsedVisible.filter((b) => !activeDescendants.has(b.id)) : collapsedVisible,
    [collapsedVisible, activeId, activeDescendants],
  )

  // Projection of where the dragged item would land
  const projected = useMemo(() => {
    if (!activeId || !overId) return null
    return getProjection(visibleItems, activeId, overId, offsetLeft, INDENT_WIDTH, rootParentId)
  }, [activeId, overId, offsetLeft, visibleItems, rootParentId])

  // ── Resolve cache ──────────────────────────────────────────────────
  // Simple in-memory cache of block/tag info for resolve callbacks.
  // Populated by the preload effect below + handleNavigate.
  const blockInfoCache = useRef<Map<string, BlockInfo>>(new Map())
  const pagesListRef = useRef<Array<{ id: string; title: string }>>([])
  // Bumped after preload to trigger re-render with resolved titles.
  const [resolveVersion, setResolveVersion] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockTitle = useCallback(
    (id: string): string => {
      const cached = blockInfoCache.current.get(id)
      if (cached) return cached.title
      return `[[${id.slice(0, 8)}...]]`
    },
    [resolveVersion],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockStatus = useCallback(
    (id: string): 'active' | 'deleted' => {
      const cached = blockInfoCache.current.get(id)
      if (cached) return cached.deleted ? 'deleted' : 'active'
      return 'active'
    },
    [resolveVersion],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveTagName = useCallback(
    (id: string): string => {
      const cached = blockInfoCache.current.get(id)
      if (cached) return cached.title
      return `#${id.slice(0, 8)}...`
    },
    [resolveVersion],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveTagStatus = useCallback(
    (id: string): 'active' | 'deleted' => {
      const cached = blockInfoCache.current.get(id)
      if (cached) return cached.deleted ? 'deleted' : 'active'
      return 'active'
    },
    [resolveVersion],
  )

  // ── Picker callbacks ────────────────────────────────────────────────
  const searchTags = useCallback(async (query: string): Promise<PickerItem[]> => {
    const tags = await listTagsByPrefix({ prefix: query })
    return tags.map((tag) => ({
      id: tag.tag_id,
      label: tag.name,
    }))
  }, [])

  const searchPages = useCallback(async (query: string): Promise<PickerItem[]> => {
    const q = query.toLowerCase().trim()

    // For short/empty queries, use the preloaded pages cache for instant results.
    // For longer queries, use FTS5 server-side search for relevance-ranked results.
    let matches: PickerItem[]

    if (q.length <= 2) {
      // Short query — use cache (substring match)
      let source = pagesListRef.current
      if (source.length === 0) {
        const resp = await listBlocks({ blockType: 'page', limit: 500 })
        source = resp.items.map((p) => ({ id: p.id, title: p.content ?? 'Untitled' }))
        pagesListRef.current = source
      }
      matches = source
        .filter((p) => !q || p.title.toLowerCase().includes(q))
        .slice(0, 20)
        .map((p) => ({ id: p.id, label: p.title }))
    } else {
      // Longer query — use FTS5 search, filter to pages
      const resp = await searchBlocks({ query: q, limit: 20 })
      matches = resp.items
        .filter((b) => b.block_type === 'page')
        .map((b) => ({ id: b.id, label: b.content ?? 'Untitled' }))

      // If FTS returns few results, supplement from cache
      if (matches.length < 5 && pagesListRef.current.length > 0) {
        const ftsIds = new Set(matches.map((m) => m.id))
        const cacheMatches = pagesListRef.current
          .filter((p) => p.title.toLowerCase().includes(q) && !ftsIds.has(p.id))
          .slice(0, 10)
          .map((p) => ({ id: p.id, label: p.title }))
        matches = [...matches, ...cacheMatches].slice(0, 20)
      }
    }

    // Append a "Create new" option when the query doesn't exactly match an existing page
    if (q.length > 0) {
      const allSource = pagesListRef.current.length > 0 ? pagesListRef.current : matches
      const exactMatch = allSource.some(
        (p) => ('title' in p ? p.title : p.label).toLowerCase() === q,
      )
      if (!exactMatch) {
        matches.push({ id: '__create__', label: query.trim(), isCreate: true })
      }
    }
    return matches
  }, [])

  const onCreatePage = useCallback(async (label: string): Promise<string> => {
    const block = await createBlock({ blockType: 'page', content: label })
    // Populate resolve cache so the link chip shows the title immediately
    blockInfoCache.current.set(block.id, { title: label, deleted: false })
    pagesListRef.current = [...pagesListRef.current, { id: block.id, title: label }]
    setResolveVersion((v) => v + 1)
    return block.id
  }, [])

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

  const searchSlashCommands = useCallback(
    async (query: string): Promise<PickerItem[]> => {
      const q = query.toLowerCase()
      return SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
    },
    [SLASH_COMMANDS],
  )

  // ── Roving editor ──────────────────────────────────────────────────
  // handleNavigate and handleSlashCommand are defined below but referenced
  // via ref to avoid circular dependency with rovingEditor.
  const handleNavigateRef = useRef<(id: string) => void>(() => {})
  const handleSlashCommandRef = useRef<(item: PickerItem) => void>(() => {})

  const rovingEditor = useRovingEditor({
    resolveBlockTitle,
    resolveTagName,
    onNavigate: (id: string) => handleNavigateRef.current(id),
    resolveBlockStatus,
    resolveTagStatus,
    searchTags,
    searchPages,
    onCreatePage,
    searchSlashCommands,
    onSlashCommand: (item: PickerItem) => handleSlashCommandRef.current(item),
  })

  const viewport = useViewportObserver()

  // ── DnD sensors ────────────────────────────────────────────────────
  // PointerSensor with 8px activation distance so clicks still work.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

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
        // Fetch all pages
        const pagesResp = await listBlocks({ blockType: 'page', limit: 1000 })
        if (cancelled) return
        const pagesList: Array<{ id: string; title: string }> = []
        for (const p of pagesResp.items) {
          const title = p.content ?? 'Untitled'
          blockInfoCache.current.set(p.id, {
            title,
            deleted: p.deleted_at !== null,
          })
          pagesList.push({ id: p.id, title })
        }
        pagesListRef.current = pagesList

        // Fetch all tags
        const tags = await listTagsByPrefix({ prefix: '' })
        if (cancelled) return
        for (const t of tags) {
          blockInfoCache.current.set(t.tag_id, {
            title: t.name,
            deleted: false,
          })
        }

        // Scan loaded blocks for [[ULID]] tokens not yet cached
        const ULID_LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
        const uncached = new Set<string>()
        for (const b of blocks) {
          if (!b.content) continue
          for (const m of b.content.matchAll(ULID_LINK_RE)) {
            if (!blockInfoCache.current.has(m[1])) uncached.add(m[1])
          }
        }

        // Batch-fetch any uncached block references via single IPC call
        if (uncached.size > 0) {
          try {
            const resolved = await batchResolve([...uncached])
            if (!cancelled) {
              for (const r of resolved) {
                blockInfoCache.current.set(r.id, {
                  title: r.title?.slice(0, 60) || `[[${r.id.slice(0, 8)}...]]`,
                  deleted: r.deleted,
                })
              }
            }
          } catch {
            // Batch resolve failed — fallback entries stay as truncated ULIDs
          }
        }

        if (!cancelled) setResolveVersion((v) => v + 1)
      } catch {
        // Preload failed — resolve callbacks will use fallbacks
      }
    }
    preload()
    return () => {
      cancelled = true
    }
  }, [blocks])

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
  }, [blocks])

  // Keyboard callbacks
  const handleFlush = useCallback((): string | null => {
    if (!rovingEditor.activeBlockId) return null
    const blockId = rovingEditor.activeBlockId // capture BEFORE unmount nullifies it
    const changed = rovingEditor.unmount()
    if (changed !== null) {
      if (changed.includes('\n')) {
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
  }, [rovingEditor, edit, splitBlock])

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
        blockInfoCache.current.set(targetId, {
          title: targetBlock.content?.slice(0, 60) || `[[${targetId.slice(0, 8)}...]]`,
          deleted: targetBlock.deleted_at !== null,
        })

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
    },
    [focusedBlockId],
  )

  /** Handle date selection from the /DATE picker. Finds or creates the date page and inserts a block link. */
  const handleDatePick = useCallback(
    async (d: Date) => {
      setDatePickerOpen(false)
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

      // Find or create the date page
      const resp = await listBlocks({ blockType: 'page', limit: 500 })
      let datePageId = resp.items.find((b) => b.content === dateStr)?.id
      if (!datePageId) {
        const newPage = await createBlock({ blockType: 'page', content: dateStr })
        datePageId = newPage.id
      }

      // Restore focus + cursor position, then insert the block link
      if (rovingEditor.editor && datePageId) {
        const editor = rovingEditor.editor
        const id = datePageId
        editor.view.focus()
        requestAnimationFrame(() => {
          editor.chain().focus('end').insertBlockLink(id).run()
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

  // ── DnD handlers ───────────────────────────────────────────────────
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = event.active.id as string
      setActiveId(id)
      setOverId(id)
      setOffsetLeft(0)

      // Flush editor if active
      if (rovingEditor.activeBlockId) {
        handleFlush()
        setFocused(null)
      }
    },
    [rovingEditor, handleFlush, setFocused],
  )

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    setOffsetLeft(event.delta.x)
  }, [])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setOverId((event.over?.id as string) ?? null)
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event

      // Reset DnD state
      setActiveId(null)
      setOverId(null)
      setOffsetLeft(0)

      if (!over) return

      const blockId = active.id as string
      const activeBlock = blocks.find((b) => b.id === blockId)

      if (projected && activeBlock) {
        // Check if the projection indicates a depth/parent change
        const currentParentId = activeBlock.parent_id ?? rootParentId
        const depthChanged = projected.depth !== activeBlock.depth
        const parentChanged = projected.parentId !== currentParentId

        if (depthChanged || parentChanged || active.id !== over.id) {
          // Tree-aware move: use projection to determine new parent + position
          const newPosition = computePosition(
            visibleItems,
            projected.parentId,
            visibleItems.findIndex((b) => b.id === over.id),
            blockId,
          )
          moveToParent(blockId, projected.parentId, newPosition)
          return
        }
      }

      // Same-level reorder (no depth/parent change)
      if (active.id !== over.id) {
        const overIndex = blocks.findIndex((b) => b.id === over.id)
        if (overIndex >= 0) {
          reorder(blockId, overIndex)
        }
      }
    },
    [blocks, rootParentId, projected, visibleItems, moveToParent, reorder],
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setOverId(null)
    setOffsetLeft(0)
  }, [])

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

  // ── Task state cycling ─────────────────────────────────────────────
  const handleToggleTodo = useCallback(
    async (blockId: string) => {
      const current = getTodoState(blockId)
      const currentIdx = TASK_CYCLE.indexOf(current)
      const nextIdx = (currentIdx + 1) % TASK_CYCLE.length
      const nextState = TASK_CYCLE[nextIdx]

      if (nextState === null) {
        await deleteProperty(blockId, 'todo')
      } else {
        await setProperty({ blockId, key: 'todo', valueText: nextState })
      }

      // Update local cache
      setBlockProperties((prev) => {
        const next = new Map(prev)
        if (nextState === null) {
          const props = (next.get(blockId) ?? []).filter((p) => p.key !== 'todo')
          if (props.length === 0) next.delete(blockId)
          else next.set(blockId, props)
        } else {
          const props = (next.get(blockId) ?? []).filter((p) => p.key !== 'todo')
          props.push({
            key: 'todo',
            value_text: nextState,
            value_num: null,
            value_date: null,
            value_ref: null,
          })
          next.set(blockId, props)
        }
        return next
      })
    },
    [getTodoState],
  )

  useBlockKeyboard(rovingEditor.editor, {
    onFocusPrev: handleFocusPrev,
    onFocusNext: handleFocusNext,
    onDeleteBlock: handleDeleteBlock,
    onIndent: handleIndent,
    onDedent: handleDedent,
    onFlush: handleFlush,
    onMergeWithPrev: handleMergeWithPrev,
    onEnterSave: handleEnterSave,
    onEscapeCancel: handleEscapeCancel,
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

  // ── Active item for DragOverlay ────────────────────────────────────
  const activeBlock = activeId ? blocks.find((b) => b.id === activeId) : null

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
        sensors={sensors}
        collisionDetection={closestCenter}
        measuring={measuring}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={visibleItems.map((b) => b.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="block-tree space-y-1">
            {visibleItems.map((block) => {
              const isFocused = focusedBlockId === block.id
              // Show projected depth during drag for the active item's over target
              const projectedDepth =
                projected && activeId && overId === block.id ? projected.depth : block.depth

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
                  {projected && overId === block.id && activeId !== block.id && (
                    <div
                      className="drop-indicator h-1 bg-primary rounded-full"
                      style={{ marginLeft: projected.depth * INDENT_WIDTH }}
                    />
                  )}
                  <SortableBlock
                    blockId={block.id}
                    content={block.content ?? ''}
                    isFocused={isFocused}
                    depth={block.id === activeId ? projectedDepth : block.depth}
                    rovingEditor={rovingEditor}
                    onNavigate={handleNavigate}
                    onDelete={(id) => remove(id)}
                    resolveBlockTitle={resolveBlockTitle}
                    resolveTagName={resolveTagName}
                    resolveBlockStatus={resolveBlockStatus}
                    resolveTagStatus={resolveTagStatus}
                    hasChildren={hasChildrenSet.has(block.id)}
                    isCollapsed={collapsedIds.has(block.id)}
                    onToggleCollapse={toggleCollapse}
                    todoState={getTodoState(block.id)}
                    onToggleTodo={handleToggleTodo}
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
          <div className="fixed left-1/2 top-1/3 z-50 -translate-x-1/2 rounded-md border bg-popover p-2 shadow-lg">
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
