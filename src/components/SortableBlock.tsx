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
import { useBatchAttachmentCounts } from '../hooks/useBatchAttachmentCounts'
import { type BlockActions, useBlockActions } from '../hooks/useBlockActions'
import { useBlockContextMenu } from '../hooks/useBlockContextMenu'
import { type BlockResolvers, useBlockResolvers } from '../hooks/useBlockResolvers'
import { useBlockSwipeActions } from '../hooks/useBlockSwipeActions'
import { useBlockTouchLongPress } from '../hooks/useBlockTouchLongPress'
import { usePropertyDefForEdit } from '../hooks/usePropertyDefForEdit'
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
  /** Whether any block in the tree has children (for caret placeholder alignment). */
  anyBlockHasChildren?: boolean | undefined
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

/**
 * Merge per-block action callbacks from explicit props and context.
 *
 * Explicit props (when provided by tests that mount SortableBlock
 * standalone) win over context values; production code lets every
 * entry come from `BlockActionsProvider` (MAINT-118).
 *
 * Lifted out of `SortableBlockInner` to keep its cognitive-complexity
 * score under Biome's threshold — the 14 `??` short-circuits would
 * otherwise dominate the inner function.
 */
function mergeActions(propActions: Partial<BlockActions>, ctx: BlockActions): BlockActions {
  return {
    onNavigate: propActions.onNavigate ?? ctx.onNavigate,
    onDelete: propActions.onDelete ?? ctx.onDelete,
    onIndent: propActions.onIndent ?? ctx.onIndent,
    onDedent: propActions.onDedent ?? ctx.onDedent,
    onToggleCollapse: propActions.onToggleCollapse ?? ctx.onToggleCollapse,
    onToggleTodo: propActions.onToggleTodo ?? ctx.onToggleTodo,
    onTogglePriority: propActions.onTogglePriority ?? ctx.onTogglePriority,
    onMoveUp: propActions.onMoveUp ?? ctx.onMoveUp,
    onMoveDown: propActions.onMoveDown ?? ctx.onMoveDown,
    onMerge: propActions.onMerge ?? ctx.onMerge,
    onShowHistory: propActions.onShowHistory ?? ctx.onShowHistory,
    onShowProperties: propActions.onShowProperties ?? ctx.onShowProperties,
    onZoomIn: propActions.onZoomIn ?? ctx.onZoomIn,
    onSelect: propActions.onSelect ?? ctx.onSelect,
  }
}

/**
 * Same prop-vs-context merge for the four block / tag display
 * resolvers. The prop bag is typed with explicit `| undefined` per key
 * to satisfy `exactOptionalPropertyTypes` when callers spread props
 * that may not be wired.
 */
type ResolverPropBag = { [K in keyof BlockResolvers]?: BlockResolvers[K] | undefined }

function mergeResolvers(
  propResolvers: ResolverPropBag,
  ctx: BlockResolvers | null,
): ResolverPropBag {
  return {
    resolveBlockTitle: propResolvers.resolveBlockTitle ?? ctx?.resolveBlockTitle,
    resolveTagName: propResolvers.resolveTagName ?? ctx?.resolveTagName,
    resolveBlockStatus: propResolvers.resolveBlockStatus ?? ctx?.resolveBlockStatus,
    resolveTagStatus: propResolvers.resolveTagStatus ?? ctx?.resolveTagStatus,
  }
}

function SortableBlockInner({
  blockId,
  content,
  isFocused,
  depth = 0,
  rovingEditor,
  onNavigate: onNavigateProp,
  onDelete: onDeleteProp,
  onIndent: onIndentProp,
  onDedent: onDedentProp,
  resolveBlockTitle: resolveBlockTitleProp,
  resolveTagName: resolveTagNameProp,
  resolveBlockStatus: resolveBlockStatusProp,
  resolveTagStatus: resolveTagStatusProp,
  hasChildren = false,
  anyBlockHasChildren = false,
  isCollapsed = false,
  onToggleCollapse: onToggleCollapseProp,
  todoState,
  onToggleTodo: onToggleTodoProp,
  priority,
  onTogglePriority: onTogglePriorityProp,
  dueDate,
  scheduledDate,
  properties,
  onMoveUp: onMoveUpProp,
  onMoveDown: onMoveDownProp,
  onMerge: onMergeProp,
  onShowHistory: onShowHistoryProp,
  onShowProperties: onShowPropertiesProp,
  onZoomIn: onZoomInProp,
  isSelected,
  onSelect: onSelectProp,
}: SortableBlockProps): React.ReactElement {
  const { t } = useTranslation()

  // ── Action / resolver resolution (MAINT-118) ─────────────────────
  // Production wires callbacks via BlockActionsProvider /
  // BlockResolversProvider at the BlockTree boundary; the wrapper
  // chain (BlockListRenderer → SortableBlockWrapper) no longer drills
  // them as props. Tests that mount SortableBlock standalone may pass
  // props directly — explicit props win over context lookups.
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
  } = mergeActions(
    {
      onNavigate: onNavigateProp,
      onDelete: onDeleteProp,
      onIndent: onIndentProp,
      onDedent: onDedentProp,
      onToggleCollapse: onToggleCollapseProp,
      onToggleTodo: onToggleTodoProp,
      onTogglePriority: onTogglePriorityProp,
      onMoveUp: onMoveUpProp,
      onMoveDown: onMoveDownProp,
      onMerge: onMergeProp,
      onShowHistory: onShowHistoryProp,
      onShowProperties: onShowPropertiesProp,
      onZoomIn: onZoomInProp,
      onSelect: onSelectProp,
    },
    useBlockActions(),
  )
  // Context menu zoom is gated by hasChildren (was previously gated in
  // SortableBlockWrapper before the props chain was collapsed).
  const onZoomIn = hasChildren ? onZoomInResolved : undefined
  const { resolveBlockTitle, resolveTagName, resolveBlockStatus, resolveTagStatus } =
    mergeResolvers(
      {
        resolveBlockTitle: resolveBlockTitleProp,
        resolveTagName: resolveTagNameProp,
        resolveBlockStatus: resolveBlockStatusProp,
        resolveTagStatus: resolveTagStatusProp,
      },
      useBlockResolvers(),
    )
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
  // MAINT-131: read from BatchAttachmentCountsProvider (one IPC per page
  // mount). Outside a provider the hook returns null and the count
  // defaults to 0 — matches the previous "no rows yet" rendering.
  const batchCounts = useBatchAttachmentCounts()
  const attachmentCount = batchCounts?.get(blockId) ?? 0
  const [showAttachments, setShowAttachments] = useState(false)

  const handleToggleAttachments = useCallback(() => setShowAttachments((prev) => !prev), [])
  const handleEditKey = useCallback(
    (keyInfo: { oldKey: string; value: string }) => setEditingKey(keyInfo),
    [setEditingKey],
  )

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
          ;(blockRef as React.RefObject<HTMLDivElement | null>).current = node
        }}
        style={style}
        data-block-id={blockId}
        data-testid="sortable-block"
        className={cn(
          'sortable-block group relative flex items-center gap-1 max-sm:items-start min-w-0',
          // BUG-37: suppress the iOS/Android long-press text-selection
          // magnifier / callout that otherwise competes with the 400ms
          // long-press context menu. Only applied on coarse pointers so
          // desktop text-selection within static blocks still works.
          '[@media(pointer:coarse)]:[-webkit-touch-callout:none]',
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
              {/* Larger icon for swipe gesture affordance */}
              <Trash2 className="h-5 w-5" />
            </button>
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
