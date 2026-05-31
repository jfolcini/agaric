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
import { Trash2 } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { useBatchAttachments } from '../hooks/useBatchAttachments'
import { useBlockActions } from '../hooks/useBlockActions'
import { useBlockContextMenu } from '../hooks/useBlockContextMenu'
import { useBlockResolvers } from '../hooks/useBlockResolvers'
import { useBlockSwipeActions } from '../hooks/useBlockSwipeActions'
import { useBlockTouchLongPress } from '../hooks/useBlockTouchLongPress'
import { usePropertyDefForEdit } from '../hooks/usePropertyDefForEdit'
import { INTERNAL_PROPERTY_KEYS } from '../lib/block-utils'
import { cn } from '../lib/utils'
import { AttachmentList } from './AttachmentList'
import { BlockContextMenu } from './BlockContextMenu'
import { BlockGutterControls } from './BlockGutterControls'
import { BlockInlineControls } from './BlockInlineControls'
import { BlockPropertyEditor } from './BlockPropertyEditor'
import { EditableBlock } from './EditableBlock'
import { TooltipProvider } from './ui/tooltip'

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
  /** Whether this block has children in the tree. */
  hasChildren?: boolean | undefined
  /** Whether any block in the tree has children (for caret placeholder alignment). */
  anyBlockHasChildren?: boolean | undefined
  /** Whether this block is currently collapsed. */
  isCollapsed?: boolean | undefined
  /** Current task state: 'TODO', 'DOING', 'DONE', or null/undefined for no task. */
  todoState?: (string | null) | undefined
  /** Priority level: '1' (high), '2' (medium), '3' (low), or null/undefined. */
  priority?: (string | null) | undefined
  /** Due date in YYYY-MM-DD format, or null/undefined if not set. */
  dueDate?: (string | null) | undefined
  /** Scheduled date in YYYY-MM-DD format, or null/undefined if not set. */
  scheduledDate?: (string | null) | undefined
  /** Custom properties to display as inline chips. */
  properties?: Array<{ key: string; value: string }> | undefined
  /** Whether this block is part of a multi-selection. */
  isSelected?: boolean | undefined
}

function SortableBlockInner({
  blockId,
  content,
  isFocused,
  depth = 0,
  rovingEditor,
  hasChildren = false,
  anyBlockHasChildren = false,
  isCollapsed = false,
  todoState,
  priority,
  dueDate,
  scheduledDate,
  properties,
  isSelected,
}: SortableBlockProps): React.ReactElement {
  const { t } = useTranslation()

  // ── Action / resolver resolution (MAINT-118 + PEND-30 D-1) ───────
  // Production and tests both wire callbacks via BlockActionsProvider /
  // BlockResolversProvider — production at the BlockTree boundary,
  // tests via the `<TestBlockActionsOverride>` wrapper. SortableBlock
  // no longer accepts these as props (D-1 dropped 14 action + 4
  // resolver props from the interface).
  const {
    onNavigate,
    onDelete,
    onIndent,
    onDedent,
    onToggleCollapse,
    onToggleTodo,
    onTogglePriority,
    onMoveUp,
    onMoveDown,
    onMerge,
    onShowHistory,
    onShowProperties,
    onZoomIn: onZoomInResolved,
    onSelect,
  } = useBlockActions()
  // Context menu zoom is gated by hasChildren (was previously gated in
  // SortableBlockWrapper before the props chain was collapsed).
  const onZoomIn = hasChildren ? onZoomInResolved : undefined
  const resolvers = useBlockResolvers()
  const resolveBlockTitle = resolvers?.resolveBlockTitle
  const resolveTagName = resolvers?.resolveTagName
  const resolveBlockStatus = resolvers?.resolveBlockStatus
  const resolveTagStatus = resolvers?.resolveTagStatus
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: blockId,
  })

  // ── Context menu + property-edit state ───────────────────────────
  const {
    contextMenu,
    openContextMenu,
    closeContextMenu,
    editingProp,
    setEditingProp,
    editingKey,
    setEditingKey,
  } = useBlockContextMenu()
  const { selectOptions, isRefProp, refPages, refSearch, setRefSearch } =
    usePropertyDefForEdit(editingProp)
  const blockRef = useRef<HTMLDivElement>(null)

  // ── Attachment state ─────────────────────────────────────────────
  // MAINT-131 / PEND-35 Tier 2.7a: read counts from the BatchAttachments
  // provider (single source — one IPC per page mount, count derived as
  // `rows.length`). Outside a provider the hook returns null and the
  // count defaults to 0 — matches the previous "no rows yet" rendering.
  const batchAttachments = useBatchAttachments()
  const attachmentCount = batchAttachments?.getCount(blockId) ?? 0
  const [showAttachments, setShowAttachments] = useState(false)

  const handleToggleAttachments = useCallback(() => setShowAttachments((prev) => !prev), [])
  const handleEditKey = useCallback(
    (keyInfo: { oldKey: string; value: string }) => setEditingKey(keyInfo),
    [setEditingKey],
  )

  const filteredProperties = useMemo(
    () => (properties ?? []).filter((p) => !INTERNAL_PROPERTY_KEYS.has(p.key)),
    [properties],
  )

  // Keep a ref in sync with isDragging so the long-press setTimeout closure
  // can read the current value without capturing a stale boolean.
  const isDraggingRef = useRef(false)

  const { handleTouchStart, handleTouchEnd, handleTouchMove, handleContextMenu, clearLongPress } =
    useBlockTouchLongPress({ openContextMenu, isDraggingRef })

  // ── Swipe-to-delete (mobile only) ─────────────────────────────
  const handleSwipeDelete = useCallback(() => {
    onDelete?.(blockId)
  }, [onDelete, blockId])

  const {
    translateX: swipeTranslateX,
    isRevealed: swipeRevealed,
    thresholdCrossed: swipeThresholdCrossed,
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

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Fade the source row hard during drag so it reads as a "lifted"
    // placeholder rather than competing with the new position.
    opacity: isDragging ? 0.35 : 1,
    paddingLeft: depth > 0 ? `calc(var(--indent-width) * ${depth})` : undefined,
  }

  return (
    <TooltipProvider delayDuration={500}>
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- touch handlers for long-press context menu */}
      <div
        ref={(node) => {
          setNodeRef(node)
          ;(blockRef as React.RefObject<HTMLDivElement | null>).current = node
        }}
        style={style}
        data-block-id={blockId}
        data-testid="sortable-block"
        // B (#216): describe the swipe-to-delete gesture for assistive tech.
        // The swipe handlers only do anything on coarse pointers and only
        // when a delete handler is wired up, so scope the description the same way.
        {...(isTouchDevice && onDelete
          ? { 'aria-description': t('block.swipeRowDescription') }
          : {})}
        className={cn(
          'sortable-block group relative flex items-center gap-1 max-sm:items-start min-w-0',
          // BUG-37: suppress the iOS/Android long-press text-selection
          // magnifier / callout that otherwise competes with the 400ms
          // long-press context menu. Only applied on coarse pointers so
          // desktop text-selection within static blocks still works.
          '[@media(pointer:coarse)]:[-webkit-touch-callout:none]',
          isFocused && 'block-active',
          // Lifted-placeholder affordance: dashed outline marks the
          // source row's origin while the overlay floats elsewhere.
          isDragging && 'outline-dashed outline-1 outline-border rounded-sm',
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
        {/* UX-304: progressive cue — the backdrop is a muted destructive
            tint while the gesture only reveals the action, then flips to
            the solid destructive variant + t('block.swipe.releaseToDelete') label
            once the auto-delete threshold is crossed mid-drag. */}
        {isTouchDevice && onDelete && (swipeRevealed || swipeTranslateX < 0) && (
          <div
            className={cn(
              'absolute right-0 top-0 bottom-0 flex items-center justify-center gap-2 px-3',
              'transition-colors duration-150',
              swipeThresholdCrossed
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-destructive/10 text-destructive',
            )}
            style={{ width: swipeThresholdCrossed ? '100%' : 80 }}
            data-testid="swipe-delete-action"
            data-threshold-crossed={swipeThresholdCrossed ? 'true' : 'false'}
          >
            <button
              type="button"
              aria-label={t('block.delete')}
              className="flex items-center justify-center h-full"
              onClick={() => {
                onDelete(blockId)
                swipeReset()
              }}
            >
              {/* Larger icon for swipe gesture affordance */}
              <Trash2 className="h-5 w-5" />
            </button>
            {swipeThresholdCrossed && (
              <span
                className="hidden text-sm font-medium [@media(pointer:coarse)]:inline"
                data-testid="swipe-release-hint"
              >
                {t('block.swipe.releaseToDelete')}
              </span>
            )}
          </div>
        )}

        {/* ── Sliding content wrapper (swipe-to-delete) ───────────── */}
        <div
          className="flex items-stretch gap-1 w-full max-sm:items-start max-sm:flex-wrap max-sm:gap-x-1 max-sm:gap-y-1.5 min-w-0"
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

          {/* ── Narrow gutter — grip + history + delete ────────────── */}
          <div
            className={cn(
              GUTTER_WIDTH,
              'relative z-10 flex-shrink-0 flex items-center gap-1 justify-end max-md:w-0 max-md:overflow-hidden',
            )}
          >
            <BlockGutterControls
              blockId={blockId}
              onDelete={onDelete}
              onShowHistory={onShowHistory}
              dragAttributes={attributes}
              dragListeners={listeners}
            />
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
            anyBlockHasChildren={anyBlockHasChildren}
            attachmentCount={attachmentCount}
            showAttachments={showAttachments}
            onToggleAttachments={handleToggleAttachments}
            onEditProp={setEditingProp}
            onEditKey={handleEditKey}
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
              // Strikethrough + fade for DONE and CANCELLED (both are "closed" states).
              (todoState === 'DONE' || todoState === 'CANCELLED') && !isFocused
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
            linkUrl={contextMenu.linkUrl}
          />
        )}
      </div>
    </TooltipProvider>
  )
}

export const SortableBlock = React.memo(SortableBlockInner)
SortableBlock.displayName = 'SortableBlock'
