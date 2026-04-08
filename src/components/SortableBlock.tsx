/**
 * SortableBlock — drag-and-drop wrapper for blocks using @dnd-kit (p2-t9).
 *
 * Wraps EditableBlock with sortable behavior. Two-zone layout:
 * - Narrow gutter (68px): grip handle + history + delete button (hover-gated, right-justified)
 * - Inline controls: chevron (when hasChildren), checkbox, priority badge (when set)
 *
 * Left-to-right order:
 *   Gutter: [grip] [history] [delete]  |  Inline: [chevron?] [checkbox] [priority?] [content]
 *
 * Mobile / right-click context menu (long-press or right-click) provides
 * touch-friendly access to block actions: delete, indent, dedent, TODO, priority.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Clock, GripVertical, Trash2 } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { useBlockSwipeActions } from '../hooks/useBlockSwipeActions'
import { useBlockTouchLongPress } from '../hooks/useBlockTouchLongPress'
import type { BlockRow } from '../lib/tauri'
import { listAttachments, listBlocks, listPropertyDefs } from '../lib/tauri'
import { cn } from '../lib/utils'
import { AttachmentList } from './AttachmentList'
import { BlockContextMenu } from './BlockContextMenu'
import { BlockInlineControls } from './BlockInlineControls'
import { BlockPropertyEditor } from './BlockPropertyEditor'
import { EditableBlock } from './EditableBlock'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

/** Pixels of left padding per depth level. */
export const INDENT_WIDTH = 24

/** Fixed width for the gutter so positions never shift. */
const GUTTER_WIDTH = 'w-[68px]'

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

  const filteredProperties = useMemo(
    () =>
      (properties ?? []).filter(
        (p) =>
          !['repeat', 'created_at', 'completed_at', 'repeat-seq', 'repeat-origin'].includes(p.key),
      ),
    [properties],
  )

  // Keep a ref in sync with isDragging so the long-press setTimeout closure
  // can read the current value without capturing a stale boolean.
  const isDraggingRef = useRef(false)

  const openContextMenu = useCallback((x: number, y: number) => {
    setContextMenu({ x, y })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const { handleTouchStart, handleTouchEnd, handleTouchMove, handleContextMenu, clearLongPress } =
    useBlockTouchLongPress({ openContextMenu, isDraggingRef })

  // ── Swipe-to-delete (mobile only) ─────────────────────────────
  const handleSwipeDelete = useCallback(() => {
    onDelete?.(blockId)
  }, [onDelete, blockId])

  const {
    translateX: swipeTranslateX,
    isRevealed: swipeRevealed,
    handlers: swipeHandlers,
    reset: swipeReset,
  } = useBlockSwipeActions(handleSwipeDelete)

  const isTouchDevice =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

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
          'sortable-block group relative flex items-center gap-1 [@media(pointer:coarse)]:items-start [@media(pointer:coarse)]:overflow-hidden',
          isFocused && 'block-active',
        )}
        onTouchStart={(e) => {
          handleTouchStart(e)
          swipeHandlers.onTouchStart(e)
        }}
        onTouchEnd={() => {
          handleTouchEnd()
          swipeHandlers.onTouchEnd()
        }}
        onTouchMove={(e) => {
          handleTouchMove(e)
          swipeHandlers.onTouchMove(e)
        }}
        onContextMenu={handleContextMenu}
      >
        {/* ── Swipe-to-delete backdrop (mobile only) ──────────────── */}
        {isTouchDevice && onDelete && (swipeRevealed || swipeTranslateX < 0) && (
          <div
            className="absolute right-0 top-0 bottom-0 flex items-center justify-center bg-destructive text-destructive-foreground"
            style={{ width: 80 }}
            data-testid="swipe-delete-action"
          >
            <button
              type="button"
              aria-label={t('block.delete')}
              className="flex items-center justify-center w-full h-full"
              onClick={() => {
                onDelete(blockId)
                swipeReset()
              }}
            >
              <Trash2 className="h-5 w-5" />
            </button>
          </div>
        )}

        {/* ── Sliding content wrapper (swipe-to-delete) ───────────── */}
        <div
          className="flex items-center gap-1 w-full [@media(pointer:coarse)]:items-start"
          data-testid="swipe-content"
          style={{
            transform:
              isTouchDevice && swipeTranslateX !== 0
                ? `translateX(${swipeTranslateX}px)`
                : undefined,
            transition: isTouchDevice && swipeTranslateX !== 0 ? 'transform 0.2s ease' : undefined,
          }}
        >
          {/* Indent guide line for nested blocks */}
          {depth > 0 && (
            <div
              className="absolute left-0 top-0 bottom-0 border-l border-border/20"
              style={{ left: `calc(var(--indent-width) * ${depth - 1} + var(--indent-width) / 2)` }}
            />
          )}

          {/* ── Narrow gutter — grip + delete only ─────────────────── */}
          <div
            className={cn(
              GUTTER_WIDTH,
              'relative z-10 flex-shrink-0 flex items-center gap-1 justify-end [@media(pointer:coarse)]:w-0 [@media(pointer:coarse)]:overflow-hidden',
            )}
          >
            {/* Drag handle — far left */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="drag-handle flex-shrink-0 cursor-grab p-0.5 text-muted-foreground hover:text-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity focus-ring active:scale-95 touch-target"
                  data-testid="drag-handle"
                  aria-label={t('block.reorder')}
                  {...attributes}
                  {...listeners}
                >
                  <GripVertical className="h-4 w-4" />
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
                className="flex-shrink-0 p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity focus-ring active:scale-95 touch-target"
                onClick={() => onShowHistory(blockId)}
              >
                <Clock className="h-4 w-4" />
              </button>
            )}

            {/* Delete — next to grip */}
            {onDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="delete-handle flex-shrink-0 p-0.5 text-muted-foreground hover:text-destructive rounded-sm hover:bg-destructive/10 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity focus-ring active:scale-95 touch-target"
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
                    <Trash2 className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {t('block.delete')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* ── Inline controls — chevron, checkbox, priority ─────── */}
          <BlockInlineControls
            blockId={blockId}
            hasChildren={hasChildren}
            isCollapsed={isCollapsed}
            onToggleCollapse={onToggleCollapse}
            todoState={todoState}
            onToggleTodo={onToggleTodo}
            priority={priority}
            onTogglePriority={onTogglePriority}
            dueDate={dueDate}
            scheduledDate={scheduledDate}
            properties={properties}
            filteredProperties={filteredProperties}
            resolveBlockTitle={resolveBlockTitle}
            attachmentCount={attachmentCount}
            showAttachments={showAttachments}
            onToggleAttachments={() => setShowAttachments((prev) => !prev)}
            onEditProp={setEditingProp}
            onEditKey={(keyInfo) => setEditingKey(keyInfo)}
          />

          {/* ── Property edit popover / key rename ────────────────── */}
          <BlockPropertyEditor
            blockId={blockId}
            editingProp={editingProp}
            setEditingProp={setEditingProp}
            editingKey={editingKey}
            setEditingKey={setEditingKey}
            selectOptions={selectOptions}
            isRefProp={isRefProp}
            refPages={refPages}
            refSearch={refSearch}
            setRefSearch={setRefSearch}
          />

          {/* ── Block content ─────────────────────────────────────────── */}
          <div
            className={cn(
              'flex-1 min-w-0 transition-[text-decoration-color,opacity] duration-200',
              todoState === 'DONE' && !isFocused
                ? 'line-through opacity-50'
                : 'no-underline opacity-100',
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
