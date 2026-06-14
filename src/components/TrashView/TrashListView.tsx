/**
 * TrashListView — presentational shell for the trash listbox.
 *
 * Wraps ListViewState (loading skeleton + empty-state) plus the
 * filtered "no match" empty state, and renders one TrashRowItem per
 * filtered block. Extracted from TrashView.tsx for MAINT-128 so the
 * orchestrator only composes filter bar / toolbar / list / dialogs.
 *
 * Virtualized (#740): each `TrashRowItem` runs a heavy
 * `renderRichContent` parse plus two `TooltipProvider`s, so rendering
 * hundreds of trashed rows with a plain `.map()` janked — especially on
 * Android. The list now windows through `@tanstack/react-virtual`, the
 * SAME primitive AgendaResults / DuePanel / DonePanel / PageBrowser use
 * (mirrors DonePanel: `ScrollArea` viewport as the scroll element,
 * absolute-positioned rows inside a sized spacer, `measureElement` for
 * post-paint height correction, `overscan: 5`). Selection, actions,
 * keyboard-focus wiring (`aria-activedescendant` / `data-trash-item`)
 * and the empty / no-match states are preserved.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, Trash2, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

import type { RichContentCallbacks } from '../../hooks/useRichContentCallbacks'
import type { BlockRow } from '../../lib/tauri'
import { TrashRowItem } from './TrashRowItem'

// Estimated row height in CSS px. A trash row is a bordered card with
// content + relative-date + optional breadcrumb (`p-4` padding); ~96px is
// the common single-line case. Like DonePanel / PageBrowser, the
// absolutely-positioned virtual rows render flush (the card border keeps
// them visually distinct — `space-y-2` can't apply to absolute siblings
// and a margin would be excluded from `measureElement`'s `offsetHeight`,
// drifting the offsets). `measureElement` corrects this estimate to the
// actual height after first paint (wrapped content / breadcrumb grow it).
const ESTIMATED_ROW_HEIGHT = 96

interface TrashListViewProps {
  blocks: BlockRow[]
  filteredBlocks: BlockRow[]
  loading: boolean
  debouncedFilter: string
  focusedIndex: number
  selectedIds: Set<string>
  descendantCounts: Record<string, number>
  callbacks: RichContentCallbacks
  onTagClick: (tagId: string) => void
  onClearFilter: () => void
  onRowClick: (id: string, e: React.MouseEvent) => void
  onToggleSelection: (id: string) => void
  onRestore: (block: BlockRow) => void
  onRequestPurge: (id: string) => void
  getParentLabel: (block: BlockRow) => string | null
  /**
   * Ref to the scroll viewport (the element that actually scrolls). The
   * orchestrator (`TrashView`) reads `[data-trash-item]` rows under this
   * node to scroll the keyboard-focused row into view, so it must point at
   * the element that contains the virtualized rows.
   */
  ref?: React.Ref<HTMLDivElement>
}

export function TrashListView({
  blocks,
  filteredBlocks,
  loading,
  debouncedFilter,
  focusedIndex,
  selectedIds,
  descendantCounts,
  callbacks,
  onTagClick,
  onClearFilter,
  onRowClick,
  onToggleSelection,
  onRestore,
  onRequestPurge,
  getParentLabel,
  ref,
}: TrashListViewProps): React.ReactElement {
  const { t } = useTranslation()

  // Internal scroll-element ref for the virtualizer. The forwarded `ref`
  // is wired to the same viewport via `ScrollArea.viewportRef` so the
  // orchestrator keeps observing the scrolling node.
  const scrollParentRef = useRef<HTMLDivElement>(null)

  const estimateSize = useCallback(() => ESTIMATED_ROW_HEIGHT, [])

  const virtualizer = useVirtualizer({
    count: filteredBlocks.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize,
    overscan: 5,
    getItemKey: (index) => filteredBlocks[index]?.id ?? index,
  })

  // Keep the keyboard-focused row in view (mirrors DonePanel /
  // PageBrowser). With virtualization a programmatic focus jump (Home /
  // End / PageDown) can land on a row outside the current window, so the
  // orchestrator's old "querySelectorAll('[data-trash-item]')[focusedIndex]
  // .scrollIntoView()" — which indexes into the *windowed* DOM slice, not
  // the absolute list — can no longer find the target. `scrollToIndex`
  // walks the virtualizer to the absolute index and mounts the row.
  useEffect(() => {
    if (focusedIndex < 0 || focusedIndex >= filteredBlocks.length) return
    virtualizer.scrollToIndex(focusedIndex, { align: 'auto' })
  }, [focusedIndex, filteredBlocks.length, virtualizer])

  return (
    <ListViewState
      loading={loading}
      items={blocks}
      skeleton={<LoadingSkeleton count={2} height="h-14" className="trash-view-loading" />}
      empty={<EmptyState icon={Trash2} message={t('trash.emptyMessage')} />}
    >
      {() =>
        debouncedFilter && filteredBlocks.length === 0 ? (
          <EmptyState
            icon={Search}
            message={t('trash.noMatchMessage')}
            action={
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={onClearFilter}
                data-testid="trash-clear-filter-btn"
              >
                <X className="h-3 w-3" />
                {t('trash.clearFilter')}
              </Button>
            }
          />
        ) : (
          <ScrollArea
            viewportRef={(node: HTMLDivElement | null) => {
              scrollParentRef.current = node
              if (typeof ref === 'function') ref(node)
              else if (ref) (ref as React.RefObject<HTMLDivElement | null>).current = node
            }}
            viewportClassName="trash-view-scroll max-h-[calc(100dvh-260px)]"
            viewportProps={{
              className: 'trash-view-list',
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- aria grid over a flex/CSS-grid layout; a <table> would break the card layout
              role: 'grid',
              'aria-label': t('trash.listLabel'),
              tabIndex: 0,
              ...(focusedIndex >= 0 && filteredBlocks[focusedIndex]
                ? { 'aria-activedescendant': `trash-item-${filteredBlocks[focusedIndex].id}` }
                : {}),
            }}
          >
            {/* Sized spacer: total height of all rows so the scrollbar
                reflects the full list while only the windowed slice is
                mounted. Each `TrashRowItem` is itself absolutely
                positioned at its virtual offset (mirrors DonePanel /
                PageBrowser, where the `role="row"` element IS the
                positioned + measured node so it stays a direct grid child). */}
            <div
              className="trash-view-list-inner relative"
              style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%' }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const block = filteredBlocks[virtualRow.index]
                if (!block) return null
                return (
                  <TrashRowItem
                    key={virtualRow.key}
                    block={block}
                    isSelected={selectedIds.has(block.id)}
                    isFocused={virtualRow.index === focusedIndex}
                    parentLabel={getParentLabel(block)}
                    descendantCount={descendantCounts[block.id] ?? 0}
                    callbacks={callbacks}
                    onTagClick={onTagClick}
                    onRowClick={onRowClick}
                    onToggleSelection={onToggleSelection}
                    onRestore={onRestore}
                    onRequestPurge={onRequestPurge}
                    rowRef={virtualizer.measureElement}
                    dataIndex={virtualRow.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  />
                )
              })}
            </div>
          </ScrollArea>
        )
      }
    </ListViewState>
  )
}
