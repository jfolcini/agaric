/**
 * HistoryListView — presentational list of history entries with the
 * load-more button and a polite announcement region for newly-loaded
 * pages. Receives all selection / focus / diff state as props from the
 * orchestrating `HistoryView`.
 *
 * Extracted from `HistoryView` (MAINT-128).
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { HistoryListItem } from '@/components/HistoryListItem'
import { ScrollArea } from '@/components/ui/scroll-area'
import { entryKey, NON_REVERSIBLE_OPS } from '@/hooks/useHistorySelection'
import type { DiffSpan, HistoryEntry } from '@/lib/tauri'

export interface HistoryListViewProps {
  entries: HistoryEntry[]
  selectedIds: Set<string>
  focusedIndex: number
  expandedKeys: Set<string>
  diffCache: Map<string, DiffSpan[]>
  loadingDiffs: Set<string>
  listRef: React.RefObject<HTMLDivElement | null>
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  onRowClick: (index: number, e: React.MouseEvent) => void
  onToggleSelection: (index: number) => void
  onToggleDiff: (entry: HistoryEntry) => void
  onRestoreToHere: (entry: HistoryEntry) => void
}

export function HistoryListView({
  entries,
  selectedIds,
  focusedIndex,
  expandedKeys,
  diffCache,
  loadingDiffs,
  listRef,
  hasMore,
  loading,
  onLoadMore,
  onRowClick,
  onToggleSelection,
  onToggleDiff,
  onRestoreToHere,
}: HistoryListViewProps): React.ReactElement {
  const { t } = useTranslation()
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  const prevLengthRef = useRef(0)

  useEffect(() => {
    if (entries.length > prevLengthRef.current && prevLengthRef.current > 0) {
      setLoadMoreAnnouncement(
        t('history.loadedMoreEntries', { count: entries.length - prevLengthRef.current }),
      )
    } else if (entries.length < prevLengthRef.current) {
      setLoadMoreAnnouncement('')
    }
    prevLengthRef.current = entries.length
  }, [entries.length, t])

  // ── Virtualization (perf-review Tier 2 #6, 2026-05-14) ─────────────
  // The outer `listRef` (provided by the parent) doubles as the
  // virtualizer's scroll element so the existing keyboard-nav focus
  // scroll-into-view contract still works.
  // HistoryListItem renders an op-summary row plus an optional inline
  // diff section that swells the row height when expanded. Estimated
  // collapsed height (~80px = p-4 + 2 lines) is a starting point;
  // `measureElement` corrects to actual height after first paint, so
  // expanded rows do not push subsequent rows out of view.
  const estimateSize = useCallback(() => 80, [])
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => listRef.current,
    estimateSize,
    overscan: 5,
    getItemKey: (index) => {
      const entry = entries[index]
      return entry ? entryKey(entry) : index
    },
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <>
      {entries.length > 0 && (
        <ScrollArea
          viewportRef={listRef}
          viewportClassName="history-list p-0 m-0 focus:outline-none max-h-[calc(100dvh-220px)]"
          // ARIA grid pattern for history list — no semantic HTML
          // equivalent for a non-tabular interactive grid. Lives on the
          // scroll viewport (the focusable element keyboard nav drives).
          viewportProps={{
            tabIndex: -1,
            role: 'grid',
            'aria-label': t('history.entriesLabel'),
            'aria-multiselectable': 'true',
          }}
        >
          {/* Total-size spacer so the scrollbar reflects the full list
              even though only the windowed slice is mounted. */}
          <div style={{ height: `${totalSize}px`, width: '100%', position: 'relative' }}>
            {virtualItems.map((virtualRow) => {
              const entry = entries[virtualRow.index]
              if (!entry) return null
              const key = entryKey(entry)
              return (
                <HistoryListItem
                  key={virtualRow.key}
                  rowRef={virtualizer.measureElement}
                  dataIndex={virtualRow.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  entry={entry}
                  index={virtualRow.index}
                  isSelected={selectedIds.has(key)}
                  isFocused={focusedIndex === virtualRow.index}
                  isNonReversible={NON_REVERSIBLE_OPS.has(entry.op_type)}
                  isExpanded={expandedKeys.has(key)}
                  isLoadingDiff={loadingDiffs.has(key)}
                  diffSpans={diffCache.get(key)}
                  onRowClick={onRowClick}
                  onToggleSelection={onToggleSelection}
                  onToggleDiff={onToggleDiff}
                  onRestoreToHere={onRestoreToHere}
                />
              )
            })}
          </div>
        </ScrollArea>
      )}

      <LoadMoreButton
        hasMore={hasMore}
        loading={loading}
        onLoadMore={onLoadMore}
        className="history-load-more"
      />

      <output className="sr-only" aria-live="polite">
        {loadMoreAnnouncement}
      </output>
    </>
  )
}
