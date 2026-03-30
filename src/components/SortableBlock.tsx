/**
 * SortableBlock — drag-and-drop wrapper for blocks using @dnd-kit (p2-t9).
 *
 * Wraps EditableBlock with sortable behavior. Shows a drag handle (GripVertical)
 * on hover. Applies opacity during drag.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Trash2 } from 'lucide-react'
import type React from 'react'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
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
      className="sortable-block group flex items-start gap-1"
    >
      <button
        type="button"
        className="drag-handle flex-shrink-0 cursor-grab opacity-30 group-hover:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-foreground"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      {onDelete && (
        <button
          type="button"
          className="delete-handle flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-destructive rounded-sm hover:bg-destructive/10"
          aria-label="Delete block"
          onClick={() => onDelete(blockId)}
        >
          <Trash2 size={16} />
        </button>
      )}
      <div className="flex-1 min-w-0">
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
