/**
 * TrashListView — presentational shell for the trash listbox.
 *
 * Wraps ListViewState (loading skeleton + empty-state) plus the
 * filtered "no match" empty state, and renders one TrashRowItem per
 * filtered block. Extracted from TrashView.tsx for MAINT-128 so the
 * orchestrator only composes filter bar / toolbar / list / dialogs.
 */

import { Search, Trash2, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import type { RichContentCallbacks } from '../../hooks/useRichContentCallbacks'
import type { BlockRow } from '../../lib/tauri'
import { EmptyState } from '../EmptyState'
import { ListViewState } from '../ListViewState'
import { TrashRowItem } from './TrashRowItem'

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
          <div
            className="trash-view-list space-y-2"
            role="listbox"
            ref={ref}
            aria-label={t('trash.listLabel')}
            tabIndex={0}
            aria-activedescendant={
              focusedIndex >= 0 && filteredBlocks[focusedIndex]
                ? `trash-item-${filteredBlocks[focusedIndex].id}`
                : undefined
            }
          >
            {filteredBlocks.map((block, index) => (
              <TrashRowItem
                key={block.id}
                block={block}
                isSelected={selectedIds.has(block.id)}
                isFocused={index === focusedIndex}
                parentLabel={getParentLabel(block)}
                descendantCount={descendantCounts[block.id] ?? 0}
                callbacks={callbacks}
                onTagClick={onTagClick}
                onRowClick={onRowClick}
                onToggleSelection={onToggleSelection}
                onRestore={onRestore}
                onRequestPurge={onRequestPurge}
              />
            ))}
          </div>
        )
      }
    </ListViewState>
  )
}
