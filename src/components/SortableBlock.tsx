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
import {
  Calendar,
  CalendarDays,
  Check,
  ChevronRight,
  Clock,
  GripVertical,
  Repeat,
  Trash2,
} from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { listPropertyDefs, setProperty } from '../lib/tauri'
import { cn } from '../lib/utils'
import { BlockContextMenu } from './BlockContextMenu'
import { EditableBlock } from './EditableBlock'
import { PropertyChip } from './PropertyChip'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

/** Pixels of left padding per depth level. */
export const INDENT_WIDTH = 24

/** Fixed width for the gutter so positions never shift. */
const GUTTER_WIDTH = 'w-[44px]'

/** Display labels for stored priority values. */
const PRIORITY_DISPLAY: Record<string, string> = { '1': 'P1', '2': 'P2', '3': 'P3' }

/** Minimum touch hold duration (ms) to trigger the context menu. */
const LONG_PRESS_DELAY = 400

/** Max touch movement (px) before the long-press gesture is cancelled. */
const LONG_PRESS_MOVE_THRESHOLD = 10

/** Short month names for compact date display. */
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Format a YYYY-MM-DD date string compactly. Same year → "Apr 15", different year → "Apr 15, 2025". */
function formatCompactDate(dateStr: string): string {
  const parts = dateStr.split('-')
  if (parts.length !== 3) return dateStr
  const [y, m, d] = parts.map(Number)
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return dateStr
  const month = MONTH_SHORT[(m ?? 1) - 1] ?? 'Jan'
  const day = d ?? 1
  const now = new Date()
  if (y === now.getFullYear()) return `${month} ${day}`
  return `${month} ${day}, ${y}`
}

/** Determine the color class for a due date chip based on whether it's overdue, today, or future. */
function dueDateColor(dateStr: string): string {
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (dateStr < todayStr) return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
  if (dateStr === todayStr)
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
  return 'bg-muted text-muted-foreground'
}

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
  /** Priority level: '1' (high), '2' (medium), '3' (low), or null/undefined. */
  priority?: string | null
  /** Callback to cycle priority: none → 1 → 2 → 3 → none. */
  onTogglePriority?: (blockId: string) => void
  /** Due date in YYYY-MM-DD format, or null/undefined if not set. */
  dueDate?: string | null
  /** Scheduled date in YYYY-MM-DD format, or null/undefined if not set. */
  scheduledDate?: string | null
  /** Custom properties to display as inline chips. */
  properties?: Array<{ key: string; value: string }>
  /** Move block up among siblings. */
  onMoveUp?: (blockId: string) => void
  /** Move block down among siblings. */
  onMoveDown?: (blockId: string) => void
  /** Merge block with its previous sibling. */
  onMerge?: (blockId: string) => void
  /** Show block history sheet */
  onShowHistory?: (blockId: string) => void
  /** Show block properties drawer */
  onShowProperties?: (blockId: string) => void
  /** Zoom in to show only this block's children */
  onZoomIn?: (blockId: string) => void
}

function SortableBlockInner({
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
  dueDate,
  scheduledDate,
  properties,
  onMoveUp,
  onMoveDown,
  onMerge,
  onShowHistory,
  onShowProperties,
  onZoomIn,
}: SortableBlockProps): React.ReactElement {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: blockId,
  })

  // ── Context menu state ───────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [editingProp, setEditingProp] = useState<{ key: string; value: string } | null>(null)
  const [editingKey, setEditingKey] = useState<{ oldKey: string; value: string } | null>(null)
  const [selectOptions, setSelectOptions] = useState<string[] | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchStartPos = useRef<{ x: number; y: number } | null>(null)
  const blockRef = useRef<HTMLDivElement>(null)

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    touchStartPos.current = null
  }, [])

  // Keep a ref in sync with isDragging so the long-press setTimeout closure
  // can read the current value without capturing a stale boolean.
  const isDraggingRef = useRef(false)
  useEffect(() => {
    isDraggingRef.current = isDragging
    if (isDragging) {
      clearLongPress()
    }
  }, [isDragging, clearLongPress])

  // ── Load property definitions for select-type detection ──────────
  useEffect(() => {
    if (!editingProp) {
      setSelectOptions(null)
      return
    }
    listPropertyDefs()
      .then((defs) => {
        const def = defs.find((d) => d.key === editingProp.key)
        if (def?.value_type === 'select' && def.options) {
          try {
            setSelectOptions(JSON.parse(def.options) as string[])
          } catch {
            setSelectOptions(null)
          }
        } else {
          setSelectOptions(null)
        }
      })
      .catch(() => setSelectOptions(null))
  }, [editingProp])

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
        if (!isDraggingRef.current) {
          openContextMenu(touch.clientX, touch.clientY)
        }
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
    paddingLeft: depth > 0 ? `calc(var(--indent-width) * ${depth})` : undefined,
  }

  return (
    <TooltipProvider delayDuration={500}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: touch handlers for long-press context menu */}
      <div
        ref={(node) => {
          setNodeRef(node)
          ;(blockRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        }}
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
            style={{ left: `calc(var(--indent-width) * ${depth - 1} + var(--indent-width) / 2)` }}
          />
        )}

        {/* ── Narrow gutter — grip + delete only ─────────────────── */}
        <div className={cn(GUTTER_WIDTH, 'flex-shrink-0 flex items-start pt-1 gap-1')}>
          {/* Drag handle — far left */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="drag-handle flex-shrink-0 cursor-grab p-0.5 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [.block-active_&]:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                aria-label={t('block.reorder')}
                {...attributes}
                {...listeners}
              >
                <GripVertical size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {t('block.reorderTip')}
            </TooltipContent>
          </Tooltip>

          {/* History — between grip and delete */}
          {onShowHistory && (
            <button
              type="button"
              aria-label={t('block.history')}
              className="flex-shrink-0 p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [.block-active_&]:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
              onClick={() => onShowHistory(blockId)}
            >
              <Clock size={16} />
            </button>
          )}

          {/* Delete — next to grip */}
          {onDelete && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="delete-handle flex-shrink-0 p-0.5 text-muted-foreground hover:text-destructive rounded-sm hover:bg-destructive/10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [.block-active_&]:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                  aria-label={t('block.delete')}
                  onClick={() => onDelete(blockId)}
                >
                  <Trash2 size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {t('block.delete')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* ── Inline controls — chevron, checkbox, priority ─────── */}
        <div className="inline-controls flex items-start flex-shrink-0 pt-1 gap-1">
          {/* Chevron — only when hasChildren, always visible */}
          {hasChildren ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="collapse-toggle flex-shrink-0 p-0.5 text-muted-foreground hover:text-foreground transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                  onClick={() => onToggleCollapse?.(blockId)}
                  aria-label={isCollapsed ? t('block.expandChildren') : t('block.collapseChildren')}
                  aria-expanded={!isCollapsed}
                >
                  <ChevronRight
                    size={16}
                    className={cn('transition-transform', !isCollapsed && 'rotate-90')}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {isCollapsed ? t('block.expandTip') : t('block.collapseTip')}
              </TooltipContent>
            </Tooltip>
          ) : (
            /* Spacer matching chevron width so leaf blocks align with parents */
            <div className="flex-shrink-0 w-5 [@media(pointer:coarse)]:w-[44px]" />
          )}

          {/* Checkbox — always rendered */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="task-marker flex-shrink-0 p-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleTodo?.(blockId)
                }}
                aria-label={
                  todoState ? t('block.taskCycle', { state: todoState }) : t('block.setTodo')
                }
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
                ) : todoState ? (
                  <div className="task-checkbox task-checkbox-custom h-4 w-4 rounded border-2 border-orange-500 bg-orange-500/20 flex items-center justify-center">
                    <div className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                  </div>
                ) : (
                  <div className="task-checkbox task-checkbox-empty h-4 w-4 rounded border-2 border-muted-foreground/40 transition-colors" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {todoState ? t('block.todoCycleTip', { state: todoState }) : t('block.setTodoTip')}
            </TooltipContent>
          </Tooltip>

          {/* Priority badge — only when set */}
          {priority && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="priority-badge flex-shrink-0 p-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                  aria-label={t('block.priorityCycle', { level: PRIORITY_DISPLAY[priority] })}
                  onClick={(e) => {
                    e.stopPropagation()
                    onTogglePriority?.(blockId)
                  }}
                >
                  <span
                    className={cn(
                      'inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold',
                      priority === '1' && 'bg-red-500 text-white',
                      priority === '2' && 'bg-yellow-500 text-white',
                      priority === '3' && 'bg-blue-500 text-white',
                    )}
                  >
                    {PRIORITY_DISPLAY[priority]}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {t('block.priorityTip', { level: PRIORITY_DISPLAY[priority] })}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Due date chip — clickable to open date picker */}
          {dueDate && (
            <span
              role="img"
              className={cn(
                'due-date-chip flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none select-none cursor-pointer',
                dueDateColor(dueDate),
              )}
              aria-label={t('block.dueDate', { date: formatCompactDate(dueDate) })}
              onClick={() => {
                document.dispatchEvent(new CustomEvent('open-due-date-picker'))
              }}
            >
              <CalendarDays size={14} className="flex-shrink-0" />
              {formatCompactDate(dueDate)}
            </span>
          )}

          {/* Scheduled date chip — clickable to open date picker */}
          {scheduledDate && (
            <span
              role="img"
              className={cn(
                'scheduled-chip flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none select-none cursor-pointer',
                'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
              )}
              aria-label={t('block.scheduledDate', { date: formatCompactDate(scheduledDate) })}
              onClick={() => {
                document.dispatchEvent(new CustomEvent('open-scheduled-date-picker'))
              }}
            >
              <Calendar size={14} className="flex-shrink-0" />
              {formatCompactDate(scheduledDate)}
            </span>
          )}

          {/* Repeat indicator — special-case for repeat property */}
          {properties?.some((p) => p.key === 'repeat') && (
            <span
              role="img"
              className="repeat-indicator flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none select-none bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400"
              aria-label={t('block.repeats', {
                value: properties.find((p) => p.key === 'repeat')?.value ?? '',
              })}
            >
              <Repeat size={12} className="flex-shrink-0" />
              {properties.find((p) => p.key === 'repeat')?.value}
            </span>
          )}

          {/* Custom property chips — up to 3 shown (excluding repeat) */}
          {properties && properties.filter((p) => p.key !== 'repeat').length > 0 && (
            <>
              {properties
                .filter((p) => p.key !== 'repeat')
                .slice(0, 3)
                .map((p) => (
                  <PropertyChip
                    key={p.key}
                    propKey={p.key}
                    value={p.value}
                    onClick={() => setEditingProp({ key: p.key, value: p.value })}
                    onKeyClick={() => setEditingKey({ oldKey: p.key, value: p.value })}
                  />
                ))}
              {properties.filter((p) => p.key !== 'repeat').length > 3 && (
                <span className="text-[10px] text-muted-foreground select-none">
                  +{properties.filter((p) => p.key !== 'repeat').length - 3}
                </span>
              )}
            </>
          )}
        </div>

        {/* ── Property edit popover ─────────────────────────────────── */}
        {editingProp && (
          <div className="absolute z-50 mt-1 rounded-md border bg-popover p-1 shadow-lg">
            {selectOptions ? (
              <div className="flex flex-col gap-0.5" data-testid="select-options-dropdown">
                {selectOptions.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={cn(
                      'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors',
                      opt === editingProp.value && 'bg-accent font-medium',
                    )}
                    onClick={async () => {
                      try {
                        await setProperty({ blockId, key: editingProp.key, valueText: opt })
                      } catch {
                        toast.error('Failed to save property')
                      }
                      setEditingProp(null)
                    }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            ) : (
              <input
                ref={(el) => el?.focus()}
                type="text"
                className="rounded border px-2 py-1 text-sm w-32"
                defaultValue={editingProp.value}
                onBlur={async (e) => {
                  const newValue = e.target.value.trim()
                  if (newValue !== editingProp.value) {
                    try {
                      await setProperty({
                        blockId,
                        key: editingProp.key,
                        valueText: newValue || null,
                      })
                    } catch {
                      toast.error('Failed to save property')
                    }
                  }
                  setEditingProp(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditingProp(null)
                }}
              />
            )}
          </div>
        )}

        {/* ── Property key rename popover ───────────────────────────── */}
        {editingKey && (
          <div className="property-key-editor absolute z-50 mt-1 rounded-md border bg-popover p-1 shadow-lg">
            <input
              ref={(el) => el?.focus()}
              type="text"
              className="rounded border px-2 py-1 text-sm w-32"
              defaultValue={editingKey.oldKey}
              onBlur={async (e) => {
                const newKey = e.target.value.trim()
                if (newKey && newKey !== editingKey.oldKey) {
                  try {
                    await setProperty({
                      blockId,
                      key: newKey,
                      valueText: editingKey.value,
                    })
                    await setProperty({
                      blockId,
                      key: editingKey.oldKey,
                      valueText: null,
                    })
                  } catch {
                    toast.error('Failed to rename property')
                  }
                }
                setEditingKey(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingKey(null)
              }}
            />
          </div>
        )}

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
            triggerRef={blockRef}
            onDelete={onDelete}
            onIndent={onIndent}
            onDedent={onDedent}
            onToggleTodo={onToggleTodo}
            onTogglePriority={onTogglePriority}
            onToggleCollapse={onToggleCollapse}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onMerge={onMerge}
            onShowHistory={onShowHistory}
            onShowProperties={onShowProperties}
            onZoomIn={onZoomIn}
            hasChildren={hasChildren}
            isCollapsed={isCollapsed}
            todoState={todoState}
            priority={priority}
            dueDate={dueDate}
          />
        )}
      </div>
    </TooltipProvider>
  )
}

export const SortableBlock = React.memo(SortableBlockInner)
SortableBlock.displayName = 'SortableBlock'
