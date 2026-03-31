/**
 * SortableBlock — drag-and-drop wrapper for blocks using @dnd-kit (p2-t9).
 *
 * Wraps EditableBlock with sortable behavior. Shows a drag handle (GripVertical)
 * on hover. Applies opacity during drag.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, ChevronRight, GripVertical, Trash2 } from 'lucide-react'
import type React from 'react'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { cn } from '../lib/utils'
import { EditableBlock } from './EditableBlock'

/** Pixels of left padding per depth level. */
export const INDENT_WIDTH = 24

interface SortableBlockProps {
  blockId: string
  content: string
  isFocused: boolean
  /** Depth in the block tree (0 = root level). */
  depth?: number
  rovingEditor: RovingEditorHandle
  onNavigate?: (id: string) => void
  onDelete?: (blockId: string) => void
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
}

export function SortableBlock({
  blockId,
  content,
  isFocused,
  depth = 0,
  rovingEditor,
  onNavigate,
  onDelete,
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
}: SortableBlockProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: blockId,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
    paddingLeft: depth > 0 ? depth * INDENT_WIDTH : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-block-id={blockId}
      className="sortable-block group relative flex items-start gap-1"
    >
      {/* Indent guide line for nested blocks */}
      {depth > 0 && (
        <div
          className="absolute left-0 top-0 bottom-0 border-l border-border/20"
          style={{ left: (depth - 1) * INDENT_WIDTH + INDENT_WIDTH / 2 }}
        />
      )}
      {hasChildren ? (
        <button
          type="button"
          className="collapse-toggle flex-shrink-0 p-0.5 mt-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => onToggleCollapse?.(blockId)}
          title={isCollapsed ? 'Expand (Ctrl+.)' : 'Collapse (Ctrl+.)'}
          aria-label={isCollapsed ? 'Expand children' : 'Collapse children'}
        >
          <ChevronRight
            size={14}
            className={cn('transition-transform', !isCollapsed && 'rotate-90')}
          />
        </button>
      ) : (
        <span className="collapse-spacer flex-shrink-0 w-[19px] mt-1.5" />
      )}
      <button
        type="button"
        className="task-marker flex-shrink-0 p-0.5 mt-1.5 transition-colors"
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
          <div className="task-checkbox task-checkbox-empty h-4 w-4 rounded border-2 border-transparent group-hover:border-muted-foreground/30 transition-colors" />
        )}
      </button>
      {priority && (
        <span
          className={cn(
            'priority-badge flex-shrink-0 text-[10px] font-bold mt-1.5 w-4 h-4 rounded-full flex items-center justify-center',
            priority === 'A' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
            priority === 'B' &&
              'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
            priority === 'C' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
          )}
        >
          {priority}
        </span>
      )}
      <button
        type="button"
        className="drag-handle flex-shrink-0 cursor-grab opacity-30 group-hover:opacity-100 transition-opacity p-0.5 mt-1.5 text-muted-foreground hover:text-foreground"
        title="Drag to reorder"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      {onDelete && (
        <button
          type="button"
          className="delete-handle flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 mt-1.5 text-muted-foreground hover:text-destructive rounded-sm hover:bg-destructive/10"
          title="Delete block"
          aria-label="Delete block"
          onClick={() => onDelete(blockId)}
        >
          <Trash2 size={16} />
        </button>
      )}
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
    </div>
  )
}
