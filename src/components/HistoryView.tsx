/**
 * HistoryView --- global operation log with multi-select for batch revert.
 *
 * Shows all history entries (op log) with filtering by op type,
 * keyboard navigation, multi-select (including shift-click range select),
 * and batch revert with confirmation dialog.
 */

import { Clock } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useHistoryDiffToggle } from '../hooks/useHistoryDiffToggle'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import type { HistoryEntry } from '../lib/tauri'
import { listPageHistory, revertOps } from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { HistoryFilterBar } from './HistoryFilterBar'
import { HistoryListItem } from './HistoryListItem'
import { HistorySelectionToolbar } from './HistorySelectionToolbar'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Op types that cannot be reversed. */
const NON_REVERSIBLE_OPS = new Set(['purge_block', 'delete_attachment'])

/** Unique key for a history entry. */
function entryKey(entry: HistoryEntry): string {
  return `${entry.device_id}:${entry.seq}`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryView(): React.ReactElement {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClickedIndex, setLastClickedIndex] = useState(-1)
  const [reverting, setReverting] = useState(false)
  const [opTypeFilter, setOpTypeFilter] = useState<string | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  const { expandedKeys, diffCache, loadingDiffs, handleToggleDiff } = useHistoryDiffToggle<string>(
    (entry) => entryKey(entry),
  )

  const listRef = useRef<HTMLDivElement>(null)

  // ── Data loading ─────────────────────────────────────────────────
  const queryFn = useCallback(
    (cursor?: string) =>
      listPageHistory({
        pageId: '__all__',
        ...(opTypeFilter != null && { opTypeFilter }),
        ...(cursor != null && { cursor }),
        limit: 50,
      }),
    [opTypeFilter],
  )
  const {
    items: entries,
    loading,
    hasMore,
    error,
    loadMore,
    reload,
    setItems: setEntries,
  } = usePaginatedQuery(queryFn, { onError: 'Failed to load history' })

  // Track load-more announcements for screen readers
  const prevLengthRef = useRef(0)
  useEffect(() => {
    if (entries.length > prevLengthRef.current && prevLengthRef.current > 0) {
      setLoadMoreAnnouncement(`Loaded ${entries.length - prevLengthRef.current} more entries`)
    } else if (entries.length < prevLengthRef.current) {
      setLoadMoreAnnouncement('')
    }
    prevLengthRef.current = entries.length
  }, [entries.length])

  // ── List keyboard navigation (ArrowUp/Down, j/k) ────────────────
  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: entries.length,
    wrap: false,
    vim: true,
  })

  // Reset selection when filter changes (entries are replaced by the hook)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset UI state when filter changes
  useEffect(() => {
    setSelected(new Set())
    setFocusedIndex(0)
    setLastClickedIndex(-1)
  }, [opTypeFilter, setFocusedIndex])

  // ── Selection helpers ────────────────────────────────────────────

  const toggleSelection = useCallback(
    (index: number) => {
      const entry = entries[index]
      if (!entry || NON_REVERSIBLE_OPS.has(entry.op_type)) return
      const key = entryKey(entry)
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(key)) {
          next.delete(key)
        } else {
          next.add(key)
        }
        return next
      })
      setLastClickedIndex(index)
    },
    [entries],
  )

  const rangeSelect = useCallback(
    (toIndex: number) => {
      const fromIndex = lastClickedIndex >= 0 ? lastClickedIndex : 0
      const start = Math.min(fromIndex, toIndex)
      const end = Math.max(fromIndex, toIndex)
      setSelected((prev) => {
        const next = new Set(prev)
        for (let i = start; i <= end; i++) {
          const entry = entries[i]
          if (entry && !NON_REVERSIBLE_OPS.has(entry.op_type)) {
            next.add(entryKey(entry))
          }
        }
        return next
      })
      setLastClickedIndex(toIndex)
    },
    [entries, lastClickedIndex],
  )

  const selectAll = useCallback(() => {
    const next = new Set<string>()
    for (const entry of entries) {
      if (!NON_REVERSIBLE_OPS.has(entry.op_type)) {
        next.add(entryKey(entry))
      }
    }
    setSelected(next)
  }, [entries])

  const clearSelection = useCallback(() => {
    setSelected(new Set())
  }, [])

  // ── Revert ───────────────────────────────────────────────────────

  const handleRevert = useCallback(async () => {
    if (selected.size === 0) return
    setReverting(true)
    try {
      // Collect selected entries and sort by created_at descending (newest first)
      const selectedEntries = entries
        .filter((e) => selected.has(entryKey(e)))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

      const ops = selectedEntries.map((e) => ({
        device_id: e.device_id,
        seq: e.seq,
      }))

      await revertOps({ ops })
      setSelected(new Set())
      // Reload after revert
      setEntries([])
      await reload()
    } catch {
      toast.error(t('history.revertFailed'))
    }
    setReverting(false)
    setConfirmRevert(false)
  }, [selected, entries, reload, setEntries, t])

  // ── Keyboard navigation ──────────────────────────────────────────

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return

      // Delegate arrow/j/k navigation to the shared hook
      if (navHandleKeyDown(e)) {
        e.preventDefault()
        return
      }

      // Space — toggle checkbox on focused item
      if (e.key === ' ' && focusedIndex >= 0) {
        e.preventDefault()
        toggleSelection(focusedIndex)
        return
      }

      // Ctrl/Cmd+A — select all
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault()
        selectAll()
        return
      }

      // Enter — confirm revert
      if (e.key === 'Enter' && selected.size > 0) {
        e.preventDefault()
        setConfirmRevert(true)
        return
      }

      // Escape — clear selection
      if (e.key === 'Escape') {
        e.preventDefault()
        clearSelection()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navHandleKeyDown, focusedIndex, toggleSelection, selectAll, selected.size, clearSelection])

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0 || !listRef.current) return
    const items = listRef.current.querySelectorAll('[data-history-item]')
    const el = items[focusedIndex] as HTMLElement | undefined
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedIndex])

  // ── Row click handler ────────────────────────────────────────────

  const handleRowClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      if (e.shiftKey) {
        rangeSelect(index)
      } else {
        toggleSelection(index)
      }
      setFocusedIndex(index)
    },
    [rangeSelect, toggleSelection, setFocusedIndex],
  )

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="history-view space-y-4">
      <div className="sticky top-0 z-10 bg-background -mx-4 px-4 md:-mx-6 md:px-6 pb-4 border-b border-border/40 space-y-4">
        {/* Filter bar */}
        <HistoryFilterBar opTypeFilter={opTypeFilter} onFilterChange={setOpTypeFilter} />

        {/* Selection toolbar */}
        {selected.size > 0 && (
          <HistorySelectionToolbar
            selectedCount={selected.size}
            reverting={reverting}
            onRevertClick={() => setConfirmRevert(true)}
            onClearSelection={clearSelection}
          />
        )}
      </div>

      {/* Loading skeletons */}
      {loading && entries.length === 0 && (
        <div className="history-view-loading space-y-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          className="history-error flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/5 p-4"
          role="alert"
        >
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={() => reload()}>
            {t('history.retryButton')}
          </Button>
        </div>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && (
        <EmptyState icon={Clock} message={t('history.noEntriesFound')} />
      )}

      {/* History list */}
      {entries.length > 0 && (
        <div
          ref={listRef}
          className="history-list space-y-2 p-0 m-0"
          role="listbox"
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
                isSelected={selected.has(key)}
                isFocused={focusedIndex === index}
                isNonReversible={NON_REVERSIBLE_OPS.has(entry.op_type)}
                isExpanded={expandedKeys.has(key)}
                isLoadingDiff={loadingDiffs.has(key)}
                diffSpans={diffCache.get(key)}
                onRowClick={handleRowClick}
                onToggleSelection={toggleSelection}
                onToggleDiff={handleToggleDiff}
              />
            )
          })}
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="history-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load more'}
        </Button>
      )}

      <output className="sr-only" aria-live="polite">
        {loadMoreAnnouncement}
      </output>

      {/* Revert confirmation dialog */}
      <ConfirmDialog
        open={confirmRevert}
        onOpenChange={setConfirmRevert}
        title={`Revert ${selected.size} operations?`}
        description={`This will create ${selected.size} new operations that reverse the selected changes. The original operations remain in history.`}
        cancelLabel="Cancel"
        actionLabel="Revert"
        onAction={handleRevert}
        loading={reverting}
      />
    </div>
  )
}
