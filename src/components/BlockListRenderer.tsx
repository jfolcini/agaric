/**
 * BlockListRenderer — presentational component for the sorted block list.
 *
 * Renders the SortableContext wrapper, viewport-aware placeholders, drop
 * indicators, and SortableBlock components. Extracted from BlockTree.tsx
 * (M-1 subtask 5) for file organization — no state of its own.
 */

import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import type { ViewportObserver } from '../hooks/useViewportObserver'
import type { FlatBlock, Projection } from '../lib/tree-utils'
import { EmptyState } from './EmptyState'
import { SortableBlock } from './SortableBlock'

export interface BlockListRendererProps {
  /** Blocks visible during drag (descendants of active item excluded). */
  visibleItems: FlatBlock[]
  /** Full block list (used for empty-state check). */
  blocks: FlatBlock[]
  /** Whether the block list is loading. */
  loading: boolean
  /** Root parent ID (for empty-state message). */
  rootParentId: string | null
  /** Currently focused block ID. */
  focusedBlockId: string | null
  /** Currently selected block IDs. */
  selectedBlockIds: string[]

  // ── DnD state ──────────────────────────────────────────────────────
  projected: Projection | null
  activeId: string | null
  overId: string | null

  // ── Viewport observer ──────────────────────────────────────────────
  viewport: ViewportObserver

  // ── Roving editor ──────────────────────────────────────────────────
  rovingEditor: RovingEditorHandle

  // ── Block callbacks ────────────────────────────────────────────────
  onNavigate: (id: string) => void
  onDelete: (blockId: string) => void
  onIndent: (blockId: string) => void
  onDedent: (blockId: string) => void
  onMoveUp: (blockId: string) => void
  onMoveDown: (blockId: string) => void
  onMerge: (blockId: string) => void
  onToggleTodo: (blockId: string) => void
  onTogglePriority: (blockId: string) => void
  onToggleCollapse: (blockId: string) => void
  onShowHistory: (blockId: string) => void
  onShowProperties: (blockId: string) => void
  onZoomIn: (blockId: string) => void
  onSelect: (blockId: string, mode: 'toggle' | 'range') => void
  onContainerMouseDown: (e: React.MouseEvent) => void

  // ── Resolve callbacks ──────────────────────────────────────────────
  resolveBlockTitle: (id: string) => string
  resolveTagName: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagStatus: (id: string) => 'active' | 'deleted'

  // ── Collapse / tree state ──────────────────────────────────────────
  hasChildrenSet: Set<string>
  collapsedIds: Set<string>
  blockProperties: Record<string, Array<{ key: string; value: string }>>
}

export function BlockListRenderer({
  visibleItems,
  blocks,
  loading,
  rootParentId,
  focusedBlockId,
  selectedBlockIds,
  projected,
  activeId,
  overId,
  viewport,
  rovingEditor,
  onNavigate,
  onDelete,
  onIndent,
  onDedent,
  onMoveUp,
  onMoveDown,
  onMerge,
  onToggleTodo,
  onTogglePriority,
  onToggleCollapse,
  onShowHistory,
  onShowProperties,
  onZoomIn,
  onSelect,
  onContainerMouseDown,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
  hasChildrenSet,
  collapsedIds,
  blockProperties,
}: BlockListRendererProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <SortableContext items={visibleItems.map((b) => b.id)} strategy={verticalListSortingStrategy}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: whitespace click to dismiss editor */}
      <div
        className="block-tree space-y-0.5 [@media(pointer:coarse)]:space-y-1.5"
        onMouseDown={onContainerMouseDown}
      >
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
                  className="drop-indicator h-[3px] bg-primary rounded-full ring-2 ring-primary/20"
                  style={{ marginLeft: `calc(var(--indent-width) * ${projected.depth})` }}
                />
              )}
              <SortableBlock
                blockId={block.id}
                content={block.content ?? ''}
                isFocused={isFocused}
                depth={block.id === activeId ? projectedDepth : block.depth}
                rovingEditor={rovingEditor}
                onNavigate={onNavigate}
                onDelete={onDelete}
                resolveBlockTitle={resolveBlockTitle}
                resolveTagName={resolveTagName}
                resolveBlockStatus={resolveBlockStatus}
                resolveTagStatus={resolveTagStatus}
                hasChildren={hasChildrenSet.has(block.id)}
                isCollapsed={collapsedIds.has(block.id)}
                onToggleCollapse={onToggleCollapse}
                todoState={block.todo_state ?? null}
                onToggleTodo={onToggleTodo}
                priority={block.priority ?? null}
                onTogglePriority={onTogglePriority}
                dueDate={block.due_date ?? null}
                scheduledDate={block.scheduled_date ?? null}
                properties={blockProperties[block.id]}
                onIndent={onIndent}
                onDedent={onDedent}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
                onMerge={onMerge}
                onShowHistory={onShowHistory}
                onShowProperties={onShowProperties}
                onZoomIn={hasChildrenSet.has(block.id) ? onZoomIn : undefined}
                isSelected={selectedBlockIds.includes(block.id)}
                onSelect={onSelect}
              />
            </div>
          )
        })}
        {blocks.length === 0 && !loading && (
          <EmptyState message={rootParentId ? t('blockTree.emptyPage') : t('blockTree.noBlocks')} />
        )}
      </div>
    </SortableContext>
  )
}
