/**
 * HistoryListView — presentational list of history entries with the
 * load-more button and a polite announcement region for newly-loaded
 * pages. Receives all selection / focus / diff state as props from the
 * orchestrating `HistoryView`.
 *
 * Extracted from `HistoryView` (MAINT-128).
 */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { entryKey, NON_REVERSIBLE_OPS } from '../hooks/useHistorySelection'
import type { DiffSpan, HistoryEntry } from '../lib/tauri'
import { HistoryListItem } from './HistoryListItem'
import { LoadMoreButton } from './LoadMoreButton'

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

  return (
    <>
      {entries.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern for history list — no semantic HTML equivalent for non-tabular interactive grid
        <div
          ref={listRef}
          tabIndex={-1}
          className="history-list space-y-2 p-0 m-0 focus:outline-none"
          role="grid"
          aria-label={t('history.entriesLabel')}
          aria-multiselectable="true"
        >
          {entries.map((entry, index) => {
            const key = entryKey(entry)
            return (
              <HistoryListItem
                key={key}
                entry={entry}
                index={index}
                isSelected={selectedIds.has(key)}
                isFocused={focusedIndex === index}
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
