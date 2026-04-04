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
import type { LucideIcon } from 'lucide-react'
import {
  Calendar,
  CalendarDays,
  Check,
  ChevronRight,
  Clock,
  GripVertical,
  Paperclip,
  Repeat,
  Trash2,
} from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { priorityColor } from '../lib/priority-color'
import { formatRepeatLabel } from '../lib/repeat-utils'
import type { BlockRow } from '../lib/tauri'
import { listAttachments, listBlocks, listPropertyDefs, setProperty } from '../lib/tauri'
import { cn } from '../lib/utils'
import { AttachmentList } from './AttachmentList'
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

interface DateChipProps {
  date: string
  icon: LucideIcon
  colorClass: string
  eventName: string
  i18nKey: string
  chipClass: string
}

function DateChip({ date, icon: Icon, colorClass, eventName, i18nKey, chipClass }: DateChipProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className={cn(
        `${chipClass} flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none cursor-pointer`,
        colorClass,
      )}
      title={t(i18nKey, { date: formatCompactDate(date) })}
      aria-label={t(i18nKey, { date: formatCompactDate(date) })}
      onClick={() => {
        document.dispatchEvent(new CustomEvent(eventName))
      }}
    >
      <Icon size={14} className="flex-shrink-0" />
      {formatCompactDate(date)}
    </button>
  )
}

interface SortableBlockProps {
  blockId: string
  content: string
  isFocused: boolean
  /** Depth in the block tree (0 = root level). */
  depth?: number | undefined
  rovingEditor: RovingEditorHandle
  onNavigate?: ((id: string) => void) | undefined
  onDelete?: ((blockId: string) => void) | undefined
  /** Indent: make block a child of its previous sibling. */
  onIndent?: ((blockId: string) => void) | undefined
  /** Dedent: move block up one level to grandparent. */
  onDedent?: ((blockId: string) => void) | undefined
  resolveBlockTitle?: ((id: string) => string) | undefined
  resolveTagName?: ((id: string) => string) | undefined
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Whether this block has children in the tree. */
  hasChildren?: boolean | undefined
  /** Whether this block is currently collapsed. */
  isCollapsed?: boolean | undefined
  /** Callback to toggle collapse state. */
  onToggleCollapse?: ((blockId: string) => void) | undefined
  /** Current task state: 'TODO', 'DOING', 'DONE', or null/undefined for no task. */
  todoState?: (string | null) | undefined
  /** Callback to cycle task state. */
  onToggleTodo?: ((blockId: string) => void) | undefined
  /** Priority level: '1' (high), '2' (medium), '3' (low), or null/undefined. */
  priority?: (string | null) | undefined
  /** Callback to cycle priority: none → 1 → 2 → 3 → none. */
  onTogglePriority?: ((blockId: string) => void) | undefined
  /** Due date in YYYY-MM-DD format, or null/undefined if not set. */
  dueDate?: (string | null) | undefined
  /** Scheduled date in YYYY-MM-DD format, or null/undefined if not set. */
  scheduledDate?: (string | null) | undefined
  /** Custom properties to display as inline chips. */
  properties?: Array<{ key: string; value: string }> | undefined
  /** Move block up among siblings. */
  onMoveUp?: ((blockId: string) => void) | undefined
  /** Move block down among siblings. */
  onMoveDown?: ((blockId: string) => void) | undefined
  /** Merge block with its previous sibling. */
  onMerge?: ((blockId: string) => void) | undefined
  /** Show block history sheet */
  onShowHistory?: ((blockId: string) => void) | undefined
  /** Show block properties drawer */
  onShowProperties?: ((blockId: string) => void) | undefined
  /** Zoom in to show only this block's children */
  onZoomIn?: ((blockId: string) => void) | undefined
  /** Whether this block is part of a multi-selection. */
  isSelected?: boolean | undefined
  /** Ctrl+Click / Shift+Click selection callback. */
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
}

interface CheckboxStyle {
  className: string
  testId?: string
  icon?: React.ReactNode
}

const EMPTY_STYLE: CheckboxStyle = {
  className: 'task-checkbox-empty border-muted-foreground/40 transition-colors',
  testId: 'task-checkbox-empty',
}

/** Style config for the task checkbox per state. */
const TASK_CHECKBOX_STYLES: Record<string, CheckboxStyle> = {
  DONE: {
    className: 'task-checkbox-done border-green-600 bg-green-600 flex items-center justify-center',
    testId: 'task-checkbox-done',
    icon: <Check size={12} className="text-white" />,
  },
  DOING: {
    className:
      'task-checkbox-doing border-blue-500 bg-blue-500/20 flex items-center justify-center',
    testId: 'task-checkbox-doing',
    icon: <div className="h-1.5 w-1.5 rounded-sm bg-blue-500" />,
  },
  TODO: {
    className: 'task-checkbox-todo border-muted-foreground',
    testId: 'task-checkbox-todo',
  },
  _custom: {
    className:
      'task-checkbox-custom border-orange-500 bg-orange-500/20 flex items-center justify-center',
    icon: <div className="h-1.5 w-1.5 rounded-full bg-orange-500" />,
  },
  _empty: EMPTY_STYLE,
}

function TaskCheckbox({ state }: { state: string | null | undefined }) {
  const key = !state ? '_empty' : TASK_CHECKBOX_STYLES[state] ? state : '_custom'
  const style = TASK_CHECKBOX_STYLES[key] ?? EMPTY_STYLE
  return (
    <div
      className={`task-checkbox h-4 w-4 rounded border-2 ${style.className}`}
      data-testid={style.testId}
    >
      {style.icon}
    </div>
  )
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
  isSelected,
  onSelect,
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
  const [isRefProp, setIsRefProp] = useState(false)
  const [refPages, setRefPages] = useState<BlockRow[]>([])
  const [refSearch, setRefSearch] = useState('')
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchStartPos = useRef<{ x: number; y: number } | null>(null)
  const blockRef = useRef<HTMLDivElement>(null)

  // ── Attachment state ─────────────────────────────────────────────
  const [attachmentCount, setAttachmentCount] = useState(0)
  const [showAttachments, setShowAttachments] = useState(false)

  useEffect(() => {
    let stale = false
    listAttachments(blockId)
      .then((rows) => {
        if (!stale) setAttachmentCount(rows.length)
      })
      .catch(() => {
        /* ignore — non-critical */
      })
    return () => {
      stale = true
    }
  }, [blockId])

  // ── Heading level detection for gutter/inline alignment ───────
  const headingLevel = useMemo(() => {
    const m = content.match(/^(#{1,6})\s/)
    return m ? (m[1] as string).length : 0
  }, [content])

  /** Dynamic top-padding so gutter & inline-controls align with heading text. */
  const gutterPt = headingLevel === 1 ? 'pt-2' : headingLevel === 2 ? 'pt-1.5' : 'pt-1'

  const filteredProperties = useMemo(
    () =>
      (properties ?? []).filter(
        (p) =>
          !['repeat', 'created_at', 'completed_at', 'repeat-seq', 'repeat-origin'].includes(p.key),
      ),
    [properties],
  )

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

  // ── Load property definitions for select-type / ref-type detection ──
  useEffect(() => {
    if (!editingProp) {
      setSelectOptions(null)
      setIsRefProp(false)
      setRefPages([])
      setRefSearch('')
      return
    }
    let stale = false
    listPropertyDefs()
      .then((defs) => {
        if (stale) return
        const def = defs.find((d) => d.key === editingProp.key)
        if (def?.value_type === 'select' && def.options) {
          try {
            setSelectOptions(JSON.parse(def.options) as string[])
          } catch {
            setSelectOptions(null)
          }
          setIsRefProp(false)
        } else if (def?.value_type === 'ref') {
          setIsRefProp(true)
          setSelectOptions(null)
          listBlocks({ blockType: 'page' })
            .then((res) => {
              if (!stale) setRefPages(res.items)
            })
            .catch(() => {
              if (!stale) setRefPages([])
            })
        } else {
          setSelectOptions(null)
          setIsRefProp(false)
        }
      })
      .catch(() => {
        if (stale) return
        setSelectOptions(null)
        setIsRefProp(false)
      })
    return () => {
      stale = true
    }
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
      if (!touch) return
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
      if (!touch) return
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
        data-testid="sortable-block"
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
        <div className={cn(GUTTER_WIDTH, 'flex-shrink-0 flex items-start gap-1', gutterPt)}>
          {/* Drag handle — far left */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="drag-handle flex-shrink-0 cursor-grab p-0.5 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 group-focus-within:opacity-100 [.block-active_&]:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 touch-target [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                data-testid="drag-handle"
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
              className="flex-shrink-0 p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 group-focus-within:opacity-100 [.block-active_&]:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 touch-target [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
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
                  className="delete-handle flex-shrink-0 p-0.5 text-muted-foreground hover:text-destructive rounded-sm hover:bg-destructive/10 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 group-focus-within:opacity-100 [.block-active_&]:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 touch-target [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                  aria-label={t('block.delete')}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    onDelete(blockId)
                  }}
                  onClick={(e) => {
                    // Fallback for keyboard activation (Enter/Space fires click, not pointerDown)
                    e.stopPropagation()
                    onDelete(blockId)
                  }}
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
        <div className={cn('inline-controls flex items-start flex-shrink-0 gap-1', gutterPt)}>
          {/* Chevron — only when hasChildren, always visible */}
          {hasChildren ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="collapse-toggle flex-shrink-0 p-0.5 text-muted-foreground hover:text-foreground transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 touch-target [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                  data-testid="collapse-toggle"
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
                className="task-marker flex-shrink-0 p-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 touch-target [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                data-testid="task-marker"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleTodo?.(blockId)
                }}
                aria-label={
                  todoState ? t('block.taskCycle', { state: todoState }) : t('block.setTodo')
                }
              >
                <TaskCheckbox state={todoState} />
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
                  className="priority-badge flex-shrink-0 p-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-95 touch-target [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                  data-testid="priority-badge"
                  aria-label={t('block.priorityCycle', { level: PRIORITY_DISPLAY[priority] })}
                  onClick={(e) => {
                    e.stopPropagation()
                    onTogglePriority?.(blockId)
                  }}
                >
                  <span
                    className={cn(
                      'inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1',
                      priorityColor(priority),
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
            <DateChip
              date={dueDate}
              icon={CalendarDays}
              colorClass={dueDateColor(dueDate)}
              eventName="open-due-date-picker"
              i18nKey="block.dueDate"
              chipClass="due-date-chip"
            />
          )}

          {/* Scheduled date chip — clickable to open date picker */}
          {scheduledDate && (
            <DateChip
              date={scheduledDate}
              icon={Calendar}
              colorClass="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
              eventName="open-scheduled-date-picker"
              i18nKey="block.scheduledDate"
              chipClass="scheduled-chip"
            />
          )}

          {/* Repeat indicator — special-case for repeat property */}
          {properties?.some((p) => p.key === 'repeat') && (
            <button
              type="button"
              className="repeat-indicator flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1"
              aria-label={t('block.repeats', {
                value: properties.find((p) => p.key === 'repeat')?.value ?? '',
              })}
            >
              <Repeat size={12} className="flex-shrink-0" />
              {formatRepeatLabel(properties.find((p) => p.key === 'repeat')?.value ?? '')}
            </button>
          )}

          {/* Custom property chips — up to 3 shown (excluding repeat) */}
          {filteredProperties.length > 0 && (
            <>
              {filteredProperties.slice(0, 3).map((p) => {
                const displayValue = resolveBlockTitle
                  ? resolveBlockTitle(p.value) || p.value
                  : p.value
                return (
                  <PropertyChip
                    key={p.key}
                    propKey={p.key}
                    value={displayValue}
                    onClick={() => setEditingProp({ key: p.key, value: p.value })}
                    onKeyClick={() => setEditingKey({ oldKey: p.key, value: p.value })}
                  />
                )
              })}
              {filteredProperties.length > 3 && (
                <span className="text-xs text-muted-foreground select-none">
                  +{filteredProperties.length - 3}
                </span>
              )}
            </>
          )}

          {/* Attachment count badge */}
          {attachmentCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="attachment-badge flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none cursor-pointer bg-muted text-muted-foreground hover:bg-accent [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1 touch-target"
                  aria-label={t('block.attachments', { count: attachmentCount })}
                  aria-expanded={showAttachments}
                  onClick={() => setShowAttachments((prev) => !prev)}
                >
                  <Paperclip size={12} className="flex-shrink-0" />
                  {attachmentCount}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {t('block.attachmentsTip', { count: attachmentCount })}
              </TooltipContent>
            </Tooltip>
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
            ) : isRefProp ? (
              <fieldset
                className="flex flex-col gap-0.5 w-56 border-none p-0 m-0"
                data-testid="ref-picker"
                aria-label={t('block.refPickerLabel')}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingProp(null)
                }}
              >
                <input
                  ref={(el) => el?.focus()}
                  type="text"
                  className="rounded border px-2 py-1 text-sm w-full"
                  placeholder={t('block.searchPages')}
                  data-testid="ref-search-input"
                  value={refSearch}
                  onChange={(e) => setRefSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditingProp(null)
                  }}
                />
                <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
                  {(() => {
                    const filtered = refPages.filter((page) => {
                      if (!refSearch) return true
                      const title = page.content || ''
                      return title.toLowerCase().includes(refSearch.toLowerCase())
                    })
                    if (filtered.length === 0) {
                      return (
                        <div
                          className="px-2 py-1 text-sm text-muted-foreground"
                          data-testid="ref-no-results"
                        >
                          {t('block.noPagesFound')}
                        </div>
                      )
                    }
                    return filtered.map((page) => (
                      <button
                        key={page.id}
                        type="button"
                        className={cn(
                          'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors truncate',
                          page.id === editingProp.value && 'bg-accent font-medium',
                        )}
                        onClick={async () => {
                          try {
                            await setProperty({ blockId, key: editingProp.key, valueRef: page.id })
                          } catch {
                            toast.error(t('property.saveFailed'))
                          }
                          setEditingProp(null)
                        }}
                      >
                        {page.content || t('block.untitled')}
                      </button>
                    ))
                  })()}
                </div>
              </fieldset>
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
        <div
          className={cn(
            'flex-1 min-w-0',
            todoState === 'DONE' && !isFocused && 'line-through opacity-50',
          )}
        >
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
            isSelected={isSelected}
            onSelect={onSelect}
          />
        </div>

        {/* ── Collapsible attachment list ────────────────────────────── */}
        {showAttachments && attachmentCount > 0 && (
          <div className="mt-1 ml-5 border-l-2 border-border/30 pl-3">
            <AttachmentList blockId={blockId} />
          </div>
        )}

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
