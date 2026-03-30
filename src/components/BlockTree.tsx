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
import { createBlock, getBlock, listBlocks, listTagsByPrefix } from '../lib/tauri'
import { computePosition, getDragDescendants, getProjection } from '../lib/tree-utils'
import { useBlockStore } from '../stores/blocks'
import { INDENT_WIDTH, SortableBlock } from './SortableBlock'

/** Cached info about a block/tag for resolve callbacks. */
interface BlockInfo {
  title: string
  deleted: boolean
}

interface BlockTreeProps {
  /** Optional parent block ID — when set, loads children of this block. */
  parentId?: string
}

export function BlockTree({ parentId }: BlockTreeProps = {}): React.ReactElement {
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

  // Items visible during drag: exclude descendants of the active item
  const activeDescendants = useMemo(
    () => (activeId ? getDragDescendants(blocks, activeId) : new Set<string>()),
    [activeId, blocks],
  )

  const visibleItems = useMemo(
    () => (activeId ? blocks.filter((b) => !activeDescendants.has(b.id)) : blocks),
    [blocks, activeId, activeDescendants],
  )

  // Projection of where the dragged item would land
  const projected = useMemo(() => {
    if (!activeId || !overId) return null
    return getProjection(visibleItems, activeId, overId, offsetLeft, INDENT_WIDTH, rootParentId)
  }, [activeId, overId, offsetLeft, visibleItems, rootParentId])

  // ── Resolve cache ──────────────────────────────────────────────────
  // Simple in-memory cache of block/tag info for resolve callbacks.
  // Populated by handleNavigate and async lookups; avoids repeated IPC
  // calls during render.
  const blockInfoCache = useRef<Map<string, BlockInfo>>(new Map())

  const resolveBlockTitle = useCallback((id: string): string => {
    const cached = blockInfoCache.current.get(id)
    if (cached) return cached.title
    return `[[${id.slice(0, 8)}...]]`
  }, [])

  const resolveBlockStatus = useCallback((id: string): 'active' | 'deleted' => {
    const cached = blockInfoCache.current.get(id)
    if (cached) return cached.deleted ? 'deleted' : 'active'
    return 'active'
  }, [])

  const resolveTagName = useCallback((id: string): string => {
    const cached = blockInfoCache.current.get(id)
    if (cached) return cached.title
    return `#${id.slice(0, 8)}...`
  }, [])

  const resolveTagStatus = useCallback((id: string): 'active' | 'deleted' => {
    const cached = blockInfoCache.current.get(id)
    if (cached) return cached.deleted ? 'deleted' : 'active'
    return 'active'
  }, [])

  // ── Picker callbacks ────────────────────────────────────────────────
  const searchTags = useCallback(async (query: string): Promise<PickerItem[]> => {
    const tags = await listTagsByPrefix({ prefix: query })
    return tags.map((tag) => ({
      id: tag.tag_id,
      label: tag.name,
    }))
  }, [])

  const searchPages = useCallback(async (query: string): Promise<PickerItem[]> => {
    const resp = await listBlocks({ blockType: 'page', limit: 20 })
    const q = query.toLowerCase()
    const matches: PickerItem[] = resp.items
      .filter((p) => (p.content ?? '').toLowerCase().includes(q))
      .map((p) => ({
        id: p.id,
        label: p.content ?? 'Untitled',
      }))
    // Append a "Create new" option when the query doesn't exactly match an existing page
    if (q.trim().length > 0) {
      const exactMatch = resp.items.some((p) => (p.content ?? '').toLowerCase() === q)
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
    return block.id
  }, [])

  // ── Roving editor ──────────────────────────────────────────────────
  // handleNavigate is defined below but referenced via ref to avoid
  // circular dependency with rovingEditor.
  const handleNavigateRef = useRef<(id: string) => void>(() => {})

  const rovingEditor = useRovingEditor({
    resolveBlockTitle,
    resolveTagName,
    onNavigate: (id: string) => handleNavigateRef.current(id),
    resolveBlockStatus,
    resolveTagStatus,
    searchTags,
    searchPages,
    onCreatePage,
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

  // Keyboard callbacks
  const handleFlush = useCallback((): string | null => {
    if (!rovingEditor.activeBlockId) return null
    const blockId = rovingEditor.activeBlockId // capture BEFORE unmount nullifies it
    const changed = rovingEditor.unmount()
    if (changed !== null) {
      if (changed.includes('\n')) {
        splitBlock(blockId, changed)
      } else {
        edit(blockId, changed)
      }
    }
    return changed
  }, [rovingEditor, edit, splitBlock])

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
        // Load the parent's children so the target block is in the list
        await load(targetBlock.parent_id ?? undefined)
        setFocused(targetId)
        rovingEditor.mount(targetId, targetBlock.content ?? '')
      } catch {
        // Block not found (deleted/purged) — no-op, don't crash
      }
    },
    [handleFlush, load, setFocused, rovingEditor],
  )

  // Keep the ref in sync with the latest handleNavigate
  handleNavigateRef.current = handleNavigate

  const handleFocusPrev = useCallback(() => {
    const idx = blocks.findIndex((b) => b.id === focusedBlockId)
    if (idx > 0) {
      const prevBlock = blocks[idx - 1]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
    }
  }, [blocks, focusedBlockId, setFocused, rovingEditor])

  const handleFocusNext = useCallback(() => {
    const idx = blocks.findIndex((b) => b.id === focusedBlockId)
    if (idx >= 0 && idx < blocks.length - 1) {
      const nextBlock = blocks[idx + 1]
      setFocused(nextBlock.id)
      rovingEditor.mount(nextBlock.id, nextBlock.content ?? '')
    }
  }, [blocks, focusedBlockId, setFocused, rovingEditor])

  const handleDeleteBlock = useCallback(() => {
    if (!focusedBlockId) return
    const idx = blocks.findIndex((b) => b.id === focusedBlockId)
    rovingEditor.unmount()
    remove(focusedBlockId)
    // Focus previous block, or next, or nothing
    if (idx > 0) {
      const prevBlock = blocks[idx - 1]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
    } else if (blocks.length > 1) {
      const nextBlock = blocks[1]
      setFocused(nextBlock.id)
      rovingEditor.mount(nextBlock.id, nextBlock.content ?? '')
    } else {
      setFocused(null)
    }
  }, [focusedBlockId, blocks, rovingEditor, remove, setFocused])

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

      if (!over || active.id === over.id) return

      const blockId = active.id as string

      if (projected) {
        // Tree-aware move: use projection to determine new parent + position
        const newPosition = computePosition(
          visibleItems,
          projected.parentId,
          visibleItems.findIndex((b) => b.id === over.id),
          blockId,
        )
        moveToParent(blockId, projected.parentId, newPosition)
      } else {
        // Fallback: simple reorder at same level
        const overIndex = blocks.findIndex((b) => b.id === over.id)
        if (overIndex >= 0) {
          reorder(blockId, overIndex)
        }
      }
    },
    [blocks, projected, visibleItems, moveToParent, reorder],
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setOverId(null)
    setOffsetLeft(0)
  }, [])

  // ── Merge with previous block (p2-t11) ────────────────────────────
  const handleMergeWithPrev = useCallback(() => {
    if (!focusedBlockId) return
    const idx = blocks.findIndex((b) => b.id === focusedBlockId)
    if (idx <= 0) return // First block — nothing to merge with

    const prevBlock = blocks[idx - 1]

    // Get current block content from the editor
    const currentContent = rovingEditor.unmount() ?? blocks[idx].content ?? ''
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
  }, [focusedBlockId, blocks, rovingEditor, edit, remove, setFocused])

  useBlockKeyboard(rovingEditor.editor, {
    onFocusPrev: handleFocusPrev,
    onFocusNext: handleFocusNext,
    onDeleteBlock: handleDeleteBlock,
    onIndent: handleIndent,
    onDedent: handleDedent,
    onFlush: handleFlush,
    onMergeWithPrev: handleMergeWithPrev,
  })

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
      <SortableContext items={visibleItems.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <div className="block-tree space-y-0.5">
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
                    className="drop-indicator h-0.5 bg-primary rounded-full"
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
                />
              </div>
            )
          })}
          {blocks.length === 0 && (
            <div className="block-tree-empty rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              <p>No blocks yet. Start typing to create one.</p>
            </div>
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
  )
}
