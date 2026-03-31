/**
 * SortableBlock — drag-and-drop wrapper for blocks using @dnd-kit (p2-t9).
 *
 * Wraps EditableBlock with sortable behavior. Two-zone layout:
 * - Narrow gutter (48px): grip handle + delete button (hover-gated)
 * - Inline controls: chevron (when hasChildren), checkbox, priority badge (when set)
 *
 * Left-to-right order:
 *   Gutter: [grip] [delete]  |  Inline: [chevron?] [checkbox] [priority?] [content]
 *
 * Mobile / right-click context menu (long-press or right-click) provides
 * touch-friendly access to block actions: delete, indent, dedent, TODO, priority.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, ChevronRight, GripVertical, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { cn } from '../lib/utils'
import { BlockContextMenu } from './BlockContextMenu'
import { EditableBlock } from './EditableBlock'

/** Pixels of left padding per depth level. */
export const INDENT_WIDTH = 24

/** Fixed width for the gutter so positions never shift. */
const GUTTER_WIDTH = 'w-[44px]'

/** Display labels for stored priority values. */
const PRIORITY_DISPLAY: Record<string, string> = { A: '1', B: '2', C: '3' }

/** Minimum touch hold duration (ms) to trigger the context menu. */
const LONG_PRESS_DELAY = 400

/** Max touch movement (px) before the long-press gesture is cancelled. */
const LONG_PRESS_MOVE_THRESHOLD = 10

interface SortableBlockProps {
  blockId: string
  content: string
  isFocused: boolean
  /** Depth in the block tree (0 = root level). */
  depth?: number
  rovingEditor: RovingEditorHandle
  onNavigate?: (id: string) => void
  onDelete?: (blockId: string) => void
  /** Indent: make block a child of its previous sibling. */
  onIndent?: (blockId: string) => void
  /** Dedent: move block up one level to grandparent. */
  onDedent?: (blockId: string) => void
  resolveBlockTitle?: (id: string) => string
  resolveTagName?: (id: string) => string
  resolveBlockStatus?: (id: string) => 'active' | 'deleted'
  resolveTagStatus?: (id: string) => 'active' | 'deleted'
  /** Whether this block has children in the tree. */
  hasChildren?: boolean
  /** Whether this block is currently collapsed. */
  isCollapsed?: boolean
  /** Callback to toggle collapse state. */
  onToggleCollapse?: (blockId: string) => void
  /** Current task state: 'TODO', 'DOING', 'DONE', or null/undefined for no task. */
  todoState?: string | null
  /** Callback to cycle task state. */
  onToggleTodo?: (blockId: string) => void
  /** Priority level: 'A' (high), 'B' (medium), 'C' (low), or null/undefined. */
  priority?: string | null
  /** Callback to cycle priority: none → A → B → C → none. */
  onTogglePriority?: (blockId: string) => void
  /** Move block up among siblings. */
  onMoveUp?: (blockId: string) => void
  /** Move block down among siblings. */
  onMoveDown?: (blockId: string) => void
}

export function SortableBlock({
  blockId,
  content,
  isFocused,
  depth = 0,
  rovingEditor,
  onNavigate,
  onDelete,
  onIndent,
  onDedent,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
  hasChildren = false,
  isCollapsed = false,
  onToggleCollapse,
  todoState,
  onToggleTodo,
  priority,
  onTogglePriority,
  onMoveUp,
  onMoveDown,
}: SortableBlockProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: blockId,
  })

  // ── Context menu state ───────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchStartPos = useRef<{ x: number; y: number } | null>(null)

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    touchStartPos.current = null
  }, [])

  const openContextMenu = useCallback((x: number, y: number) => {
    setContextMenu({ x, y })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // ── Touch handlers for long-press detection ──────────────────────
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      touchStartPos.current = { x: touch.clientX, y: touch.clientY }
      longPressTimer.current = setTimeout(() => {
        openContextMenu(touch.clientX, touch.clientY)
        longPressTimer.current = null
      }, LONG_PRESS_DELAY)
    },
    [openContextMenu],
  )

  const handleTouchEnd = useCallback(() => {
    clearLongPress()
  }, [clearLongPress])

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartPos.current) return
      const touch = e.touches[0]
      const dx = touch.clientX - touchStartPos.current.x
      const dy = touch.clientY - touchStartPos.current.y
      if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD) {
        clearLongPress()
      }
    },
    [clearLongPress],
  )

  // ── Right-click handler (desktop bonus) ──────────────────────────
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      openContextMenu(e.clientX, e.clientY)
    },
    [openContextMenu],
  )

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
    paddingLeft: depth > 0 ? depth * INDENT_WIDTH : undefined,
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: touch handlers for long-press context menu
    <div
      ref={setNodeRef}
      style={style}
      data-block-id={blockId}
      className={cn(
        'sortable-block group relative flex items-start gap-1',
        isFocused && 'block-active',
      )}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
      onContextMenu={handleContextMenu}
    >
      {/* Indent guide line for nested blocks */}
      {depth > 0 && (
        <div
          className="absolute left-0 top-0 bottom-0 border-l border-border/20"
          style={{ left: (depth - 1) * INDENT_WIDTH + INDENT_WIDTH / 2 }}
        />
      )}

      {/* ── Narrow gutter — grip + delete only ─────────────────── */}
      <div className={cn(GUTTER_WIDTH, 'flex-shrink-0 flex items-start gap-1')}>
        {/* Drag handle — far left */}
        <button
          type="button"
          className="drag-handle flex-shrink-0 cursor-grab p-0.5 mt-1.5 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 [.block-active_&]:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
          title="Drag to reorder"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={16} />
        </button>

        {/* Delete — next to grip */}
        {onDelete && (
          <button
            type="button"
            className="delete-handle flex-shrink-0 p-0.5 mt-1.5 text-muted-foreground hover:text-destructive rounded-sm hover:bg-destructive/10 opacity-0 group-hover:opacity-100 [.block-active_&]:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
            title="Delete block"
            aria-label="Delete block"
            onClick={() => onDelete(blockId)}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>

      {/* ── Inline controls — chevron, checkbox, priority ─────── */}
      <div className="inline-controls flex items-start flex-shrink-0 gap-1">
        {/* Chevron — only when hasChildren, always visible */}
        {hasChildren && (
          <button
            type="button"
            className="collapse-toggle flex-shrink-0 p-0.5 mt-1.5 text-muted-foreground hover:text-foreground transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
            onClick={() => onToggleCollapse?.(blockId)}
            title={isCollapsed ? 'Expand (Ctrl+.)' : 'Collapse (Ctrl+.)'}
            aria-label={isCollapsed ? 'Expand children' : 'Collapse children'}
            aria-expanded={!isCollapsed}
          >
            <ChevronRight
              size={14}
              className={cn('transition-transform', !isCollapsed && 'rotate-90')}
            />
          </button>
        )}

        {/* Checkbox — always rendered */}
        <button
          type="button"
          className="task-marker flex-shrink-0 p-0.5 mt-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
          title={
            todoState
              ? `${todoState} → Click or Ctrl+Enter to cycle (TODO → DOING → DONE → none)`
              : 'Click or Ctrl+Enter to set as TODO'
          }
          onClick={(e) => {
            e.stopPropagation()
            onToggleTodo?.(blockId)
          }}
          aria-label={todoState ? `Task: ${todoState}. Click to cycle.` : 'Set as TODO'}
        >
          {todoState === 'DONE' ? (
            <div className="task-checkbox task-checkbox-done h-4 w-4 rounded border-2 border-green-600 bg-green-600 flex items-center justify-center">
              <Check size={12} className="text-white" />
            </div>
          ) : todoState === 'DOING' ? (
            <div className="task-checkbox task-checkbox-doing h-4 w-4 rounded border-2 border-blue-500 bg-blue-500/20 flex items-center justify-center">
              <div className="h-1.5 w-1.5 rounded-sm bg-blue-500" />
            </div>
          ) : todoState === 'TODO' ? (
            <div className="task-checkbox task-checkbox-todo h-4 w-4 rounded border-2 border-muted-foreground" />
          ) : (
            <div className="task-checkbox task-checkbox-empty h-4 w-4 rounded border-2 border-muted-foreground/40 transition-colors" />
          )}
        </button>

        {/* Priority badge — only when set */}
        {priority && (
          <button
            type="button"
            className="priority-badge flex-shrink-0 p-0.5 mt-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
            title={`Priority ${PRIORITY_DISPLAY[priority]} — Click to cycle (1 → 2 → 3 → none)`}
            aria-label={`Priority ${PRIORITY_DISPLAY[priority]}. Click to cycle.`}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePriority?.(blockId)
            }}
          >
            <div
              className={cn(
                'w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold',
                priority === 'A' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
                priority === 'B' &&
                  'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
                priority === 'C' &&
                  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
              )}
            >
              {PRIORITY_DISPLAY[priority]}
            </div>
          </button>
        )}
      </div>

      {/* ── Block content ─────────────────────────────────────────── */}
      <div className={cn('flex-1 min-w-0', todoState === 'DONE' && 'line-through opacity-50')}>
        <EditableBlock
          blockId={blockId}
          content={content}
          isFocused={isFocused}
          rovingEditor={rovingEditor}
          onNavigate={onNavigate}
          resolveBlockTitle={resolveBlockTitle}
          resolveTagName={resolveTagName}
          resolveBlockStatus={resolveBlockStatus}
          resolveTagStatus={resolveTagStatus}
        />
      </div>

      {/* ── Context menu (long-press / right-click) ───────────────── */}
      {contextMenu && (
        <BlockContextMenu
          blockId={blockId}
          position={contextMenu}
          onClose={closeContextMenu}
          onDelete={onDelete}
          onIndent={onIndent}
          onDedent={onDedent}
          onToggleTodo={onToggleTodo}
          onTogglePriority={onTogglePriority}
          onToggleCollapse={onToggleCollapse}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          hasChildren={hasChildren}
          isCollapsed={isCollapsed}
          todoState={todoState}
          priority={priority}
        />
      )}
    </div>
  )
}
