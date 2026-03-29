/**
 * BlockTree — renders the block list with the roving editor (ADR-01).
 *
 * Each block is either a StaticBlock (div) or the active TipTap editor.
 * Enter creates a new block below. Backspace on empty deletes.
 * Off-screen blocks are replaced by height-preserving placeholders
 * via IntersectionObserver (p15-t13).
 * Drag-and-drop reordering via @dnd-kit (p2-t9).
 */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
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
import { useCallback, useEffect, useRef } from 'react'
import { useBlockKeyboard } from '../editor/use-block-keyboard'
import { useRovingEditor } from '../editor/use-roving-editor'
import { useViewportObserver } from '../hooks/useViewportObserver'
import { getBlock } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { SortableBlock } from './SortableBlock'

/** Cached info about a block/tag for resolve callbacks. */
interface BlockInfo {
  title: string
  deleted: boolean
}

export function BlockTree(): React.ReactElement {
  const {
    blocks,
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
  } = useBlockStore()

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
  })

  const viewport = useViewportObserver()

  // ── DnD sensors ────────────────────────────────────────────────────
  // PointerSensor with 8px activation distance so clicks still work.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    load()
  }, [load])

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

  // ── DnD drag end ─────────────────────────────────────────────────
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return

      // Unfocus/unmount editor during drag completion
      // handleFlush() already calls unmount() internally, so no second unmount needed.
      if (rovingEditor.activeBlockId) {
        handleFlush()
        setFocused(null)
      }

      const overIndex = blocks.findIndex((b) => b.id === over.id)
      if (overIndex >= 0) {
        reorder(active.id as string, overIndex)
      }
    },
    [blocks, rovingEditor, handleFlush, setFocused, reorder],
  )

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

  if (loading) {
    return (
      <div className="block-tree-loading flex items-center justify-center p-8 text-sm text-muted-foreground">
        Loading blocks...
      </div>
    )
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <div className="block-tree space-y-0.5">
          {blocks.map((block) => {
            const isFocused = focusedBlockId === block.id
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
                <SortableBlock
                  blockId={block.id}
                  content={block.content ?? ''}
                  isFocused={isFocused}
                  rovingEditor={rovingEditor}
                  onNavigate={handleNavigate}
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
    </DndContext>
  )
}
