/**
 * BlockListRenderer — presentational component for the sorted block list.
 *
 * Renders the SortableContext wrapper, viewport-aware placeholders, drop
 * indicators, and SortableBlock components. Extracted from BlockTree.tsx
 * (M-1 subtask 5) for file organization — no state of its own.
 */

import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type React from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import type { ViewportObserver } from '../hooks/useViewportObserver'
import type { FlatBlock, Projection } from '../lib/tree-utils'
import { cn } from '../lib/utils'
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
  onContainerPointerDown: (e: React.PointerEvent) => void

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
  onContainerPointerDown,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
  hasChildrenSet,
  collapsedIds,
  blockProperties,
}: BlockListRendererProps): React.ReactElement {
  const { t } = useTranslation()

  // ── Expand animation (UX-79) ──────────────────────────────────────
  // Track previous collapsedIds to detect which parents were just expanded.
  // Children of those parents get a CSS enter animation.
  const prevCollapsedRef = useRef(collapsedIds)
  const animatingBlockIds = useMemo(() => {
    const prev = prevCollapsedRef.current
    if (prev === collapsedIds) return new Set<string>()

    // IDs that were collapsed before but are no longer collapsed → just expanded
    const justExpanded = new Set<string>()
    for (const id of prev) {
      if (!collapsedIds.has(id)) justExpanded.add(id)
    }
    if (justExpanded.size === 0) return new Set<string>()

    // Collect descendants of each just-expanded parent in the flat list
    const animated = new Set<string>()
    for (let i = 0; i < visibleItems.length; i++) {
      const block = visibleItems[i]
      if (!block || !justExpanded.has(block.id)) continue
      const parentDepth = block.depth
      for (let j = i + 1; j < visibleItems.length; j++) {
        const child = visibleItems[j]
        if (!child || child.depth <= parentDepth) break
        animated.add(child.id)
      }
    }
    return animated
  }, [collapsedIds, visibleItems])

  useEffect(() => {
    prevCollapsedRef.current = collapsedIds
  }, [collapsedIds])

  // ── Sibling aria props (UX-48) ─────────────────────────────────────
  // Compute aria-setsize / aria-posinset for each block by grouping
  // siblings that share the same parent in the flat list.
  const siblingAriaProps = useMemo(() => {
    const result = new Map<string, { setsize: number; posinset: number }>()
    const groups = new Map<number, number[]>()

    for (let i = 0; i < visibleItems.length; i++) {
      const block = visibleItems[i]
      let parentIdx = -1
      if (block && block.depth > 0) {
        for (let j = i - 1; j >= 0; j--) {
          if (visibleItems[j]?.depth === block.depth - 1) {
            parentIdx = j
            break
          }
        }
      }
      if (!groups.has(parentIdx)) groups.set(parentIdx, [])
      groups.get(parentIdx)?.push(i)
    }

    for (const [, indices] of groups) {
      for (let j = 0; j < indices.length; j++) {
        const idx = indices[j]
        const block = idx != null ? visibleItems[idx] : undefined
        if (block) {
          result.set(block.id, { setsize: indices.length, posinset: j + 1 })
        }
      }
    }

    return result
  }, [visibleItems])

  return (
    <SortableContext items={visibleItems.map((b) => b.id)} strategy={verticalListSortingStrategy}>
      {blocks.length === 0 && !loading ? (
        <EmptyState message={rootParentId ? t('blockTree.emptyPage') : t('blockTree.noBlocks')} />
      ) : (
        <ul
          className="block-tree list-none m-0 p-0 space-y-0.5 [@media(pointer:coarse)]:space-y-1.5"
          aria-label={t('blockTree.treeLabel')}
          onPointerDown={onContainerPointerDown}
        >
          {visibleItems.map((block) => {
            const isFocused = focusedBlockId === block.id
            // Show projected depth during drag for the active item's over target
            const projectedDepth =
              projected && activeId && overId === block.id ? projected.depth : block.depth
            const aria = siblingAriaProps.get(block.id)
            const hasChildren = hasChildrenSet.has(block.id)
            const isCollapsed = collapsedIds.has(block.id)

            // Focused block is never virtualized — always render fully
            if (!isFocused && viewport.isOffscreen(block.id)) {
              return (
                // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-level is valid on listitem per WAI-ARIA spec
                <li
                  key={block.id}
                  ref={viewport.observeRef}
                  data-block-id={block.id}
                  aria-level={block.depth + 1}
                  aria-setsize={aria?.setsize}
                  aria-posinset={aria?.posinset}
                  aria-expanded={hasChildren ? !isCollapsed : undefined}
                  className="block-placeholder list-none m-0 p-0"
                  style={{ minHeight: viewport.getHeight(block.id) }}
                />
              )
            }
            return (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-level is valid on listitem per WAI-ARIA spec
              <li
                key={block.id}
                ref={viewport.observeRef}
                data-block-id={block.id}
                aria-level={block.depth + 1}
                aria-setsize={aria?.setsize}
                aria-posinset={aria?.posinset}
                aria-expanded={hasChildren ? !isCollapsed : undefined}
                className={cn(
                  'list-none m-0 p-0',
                  animatingBlockIds.has(block.id) && 'block-children-enter',
                )}
              >
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
                  hasChildren={hasChildren}
                  isCollapsed={isCollapsed}
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
                  onZoomIn={hasChildren ? onZoomIn : undefined}
                  isSelected={selectedBlockIds.includes(block.id)}
                  onSelect={onSelect}
                />
              </li>
            )
          })}
        </ul>
      )}
    </SortableContext>
  )
}
