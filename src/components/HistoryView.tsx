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
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { useHistoryDiffToggle } from '../hooks/useHistoryDiffToggle'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { useListMultiSelect } from '../hooks/useListMultiSelect'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import { announce } from '../lib/announcer'
import { formatTimestamp } from '../lib/format'
import { matchesShortcutBinding } from '../lib/keyboard-config'
import { logger } from '../lib/logger'
import type { HistoryEntry } from '../lib/tauri'
import { listPageHistory, restorePageToOp, revertOps } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { CompactionCard } from './CompactionCard'
import { EmptyState } from './EmptyState'
import { HistoryFilterBar } from './HistoryFilterBar'
import { HistoryListItem } from './HistoryListItem'
import { HistorySelectionToolbar } from './HistorySelectionToolbar'
import { LoadMoreButton } from './LoadMoreButton'
import { ViewHeader } from './ViewHeader'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Op types that cannot be reversed. */
const NON_REVERSIBLE_OPS = new Set(['purge_block', 'delete_attachment'])

/** Unique key for a history entry. */
function entryKey(entry: HistoryEntry): string {
  return `${entry.device_id}:${entry.seq}`
}

/**
 * UX-275 sub-fix 7: classify a load failure into a user-meaningful bucket
 * so the error banner can show actionable context instead of a generic
 * message. The detection is best-effort and falls back to `unknown`.
 *
 *  - `network` — fetch / connectivity / timeout / offline
 *  - `server`  — backend error (HTTP 5xx, sqlx, IPC reject)
 *  - `unknown` — anything else
 */
type HistoryErrorCategory = 'network' | 'server' | 'unknown'

function categorizeHistoryError(err: unknown): HistoryErrorCategory {
  if (err == null) return 'unknown'
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  // Inspect HTTP-shaped errors first ({ status: 5xx } or { code: '5xx...' })
  if (typeof err === 'object' && err != null) {
    const obj = err as { status?: number; code?: string | number }
    if (typeof obj.status === 'number' && obj.status >= 500 && obj.status < 600) {
      return 'server'
    }
    if (typeof obj.code === 'string' && /^5\d\d/.test(obj.code)) {
      return 'server'
    }
  }
  if (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('offline') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout')
  ) {
    return 'network'
  }
  if (
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('internal server') ||
    msg.includes('database') ||
    msg.includes('sqlx')
  ) {
    return 'server'
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryView(): React.ReactElement {
  const { t } = useTranslation()
  const [reverting, setReverting] = useState(false)
  const [opTypeFilter, setOpTypeFilter] = useState<string | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<HistoryEntry | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  // FEAT-3 Phase 8 — current-space scoping. Default `false` ⇒ pass the
  // current space id so only ops on pages in this space are returned.
  // Toggling on drops the filter (cross-space "All spaces" mode). State
  // is intentionally NOT persisted: every History session must restart
  // current-space-only — the privacy-preserving default.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [showAllSpaces, setShowAllSpaces] = useState(false)
  const { expandedKeys, diffCache, loadingDiffs, handleToggleDiff } = useHistoryDiffToggle<string>(
    (entry) => entryKey(entry),
  )

  const listRef = useRef<HTMLDivElement>(null)
  // Register the list container as the primary focus target so switching to
  // History via sidebar lands focus on the entries list (not #main-content),
  // letting the user immediately arrow-navigate (UX-220).
  useRegisterPrimaryFocus(listRef)

  // ── Data loading ─────────────────────────────────────────────────
  // UX-275 sub-fix 7: track the categorised failure so the error banner can
  // show network/server/unknown-specific copy alongside the generic title.
  const [errorCategory, setErrorCategory] = useState<HistoryErrorCategory | null>(null)
  // FEAT-3 Phase 8 — when "All spaces" is off, narrow the IPC to the
  // current space. When on (or when no current space exists yet), pass
  // `undefined` so the backend returns ops from every space.
  const effectiveSpaceId = showAllSpaces ? undefined : (currentSpaceId ?? undefined)
  const queryFn = useCallback(
    async (cursor?: string) => {
      try {
        const result = await listPageHistory({
          pageId: '__all__',
          ...(opTypeFilter != null && { opTypeFilter }),
          ...(effectiveSpaceId != null && { spaceId: effectiveSpaceId }),
          ...(cursor != null && { cursor }),
          limit: 50,
        })
        setErrorCategory(null)
        return result
      } catch (err) {
        const category = categorizeHistoryError(err)
        setErrorCategory(category)
        logger.error(
          'HistoryView',
          'Failed to load history page',
          {
            category,
            opTypeFilter: opTypeFilter ?? null,
            spaceId: effectiveSpaceId ?? null,
            cursor: cursor ?? null,
          },
          err,
        )
        throw err
      }
    },
    [opTypeFilter, effectiveSpaceId],
  )
  const {
    items: entries,
    loading,
    hasMore,
    error,
    loadMore,
    reload,
    setItems: setEntries,
  } = usePaginatedQuery(queryFn, { onError: t('history.loadFailed') })

  // Track load-more announcements for screen readers
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

  // ── List keyboard navigation (ArrowUp/Down, j/k) ────────────────
  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: entries.length,
    wrap: false,
    vim: true,
    homeEnd: true,
    pageUpDown: true,
  })

  // ── Multi-select (shared hook) ────────────────────────────────────
  const {
    selected,
    toggleSelection: hookToggle,
    selectAll,
    clearSelection,
    handleRowClick: hookHandleRowClick,
  } = useListMultiSelect({
    items: entries,
    getItemId: entryKey,
    filterPredicate: (entry: HistoryEntry) => !NON_REVERSIBLE_OPS.has(entry.op_type),
  })

  // Wrapper: HistoryListItem passes index, hook expects ID
  const handleToggleSelection = useCallback(
    (index: number) => {
      const entry = entries[index]
      if (entry) hookToggle(entryKey(entry))
    },
    [entries, hookToggle],
  )

  // Reset selection when filter changes (entries are replaced by the hook).
  // FEAT-3 Phase 8 — also resets when the space scope flips so a stale
  // selection from the previous scope doesn't leak into the new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset UI state when filter changes
  useEffect(() => {
    clearSelection()
    setFocusedIndex(0)
  }, [opTypeFilter, effectiveSpaceId, setFocusedIndex, clearSelection])

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
      announce(t('announce.opsReverted', { count: ops.length }))
      clearSelection()
      // Reload after revert
      setEntries([])
      await reload()
    } catch {
      toast.error(t('history.revertFailed'))
      announce(t('announce.revertFailed'))
    }
    setReverting(false)
    setConfirmRevert(false)
  }, [selected, entries, reload, setEntries, clearSelection, t])

  const handleRestoreToHere = useCallback((entry: HistoryEntry) => {
    setRestoreTarget(entry)
    setConfirmRestore(true)
  }, [])

  const handleConfirmRestore = useCallback(async () => {
    if (!restoreTarget) return
    setRestoring(true)
    try {
      const result = await restorePageToOp({
        pageId: '__all__',
        targetDeviceId: restoreTarget.device_id,
        targetSeq: restoreTarget.seq,
      })
      toast.success(t('history.restoreSuccess', { count: result.ops_reverted }))
      announce(t('announce.restoreToHereSucceeded', { count: result.ops_reverted }))
      if (result.non_reversible_skipped > 0) {
        toast.warning(t('history.restoreSkipped', { count: result.non_reversible_skipped }))
      }
      setEntries([])
      await reload()
    } catch {
      toast.error(t('history.restoreFailed'))
      announce(t('announce.restoreToHereFailed'))
    }
    setRestoring(false)
    setConfirmRestore(false)
    setRestoreTarget(null)
  }, [restoreTarget, reload, setEntries, t])

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
      if (matchesShortcutBinding(e, 'listToggleSelection') && focusedIndex >= 0) {
        e.preventDefault()
        handleToggleSelection(focusedIndex)
        return
      }

      // Ctrl/Cmd+A — select all
      if (matchesShortcutBinding(e, 'listSelectAll')) {
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
      if (matchesShortcutBinding(e, 'listClearSelection')) {
        e.preventDefault()
        clearSelection()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [
    navHandleKeyDown,
    focusedIndex,
    handleToggleSelection,
    selectAll,
    selected.size,
    clearSelection,
  ])

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
      const entry = entries[index]
      if (entry) hookHandleRowClick(entryKey(entry), e)
      setFocusedIndex(index)
    },
    [entries, hookHandleRowClick, setFocusedIndex],
  )

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="history-view space-y-4">
      {/* Op log compaction card */}
      <CompactionCard />

      <ViewHeader>
        <div className="history-view-header space-y-2">
          {/* Filter bar */}
          <HistoryFilterBar
            opTypeFilter={opTypeFilter}
            onFilterChange={setOpTypeFilter}
            showAllSpaces={showAllSpaces}
            onShowAllSpacesChange={setShowAllSpaces}
          />

          {/* Selection toolbar — only render when items are selected so that
              batch actions (revert, clear) disappear after completion. Matches
              the ConflictList pattern and keeps the "N selected" text out of
              the DOM when nothing is selected. */}
          {selected.size > 0 && (
            <HistorySelectionToolbar
              selectedCount={selected.size}
              reverting={reverting}
              onRevertClick={() => setConfirmRevert(true)}
              onClearSelection={clearSelection}
            />
          )}
        </div>
      </ViewHeader>

      {/* Loading skeletons */}
      {loading && entries.length === 0 && (
        <LoadingSkeleton count={3} height="h-16" className="history-view-loading" />
      )}

      {/* Error banner.
          UX-275 sub-fix 7: keep the existing `history.loadFailed` heading
          (so screen-readers and existing tests still see it) and append a
          category-specific detail line so users get actionable context. */}
      {error && (
        <div
          className="history-error flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
          role="alert"
          data-error-category={errorCategory ?? 'unknown'}
        >
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-destructive">{error}</p>
            <p className="text-xs text-muted-foreground" data-testid="history-error-detail">
              {errorCategory === 'network'
                ? t('history.errorNetwork')
                : errorCategory === 'server'
                  ? t('history.errorServer')
                  : t('history.errorUnknown')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => reload()}>
            {t('history.retryButton')}
          </Button>
        </div>
      )}

      {/* Empty state.
          FEAT-3 Phase 8 — when scoped to the current space, surface the
          "Toggle 'All spaces' to see history from other spaces." hint
          so users understand why the list is empty and how to expand
          the scope. The cross-space ("All spaces" on) empty state keeps
          the existing generic copy. */}
      {!loading && entries.length === 0 && (
        <EmptyState
          icon={Clock}
          message={
            !showAllSpaces && currentSpaceId !== null
              ? t('history.emptyCurrentSpace')
              : t('history.noEntriesFound')
          }
        />
      )}

      {/* History list */}
      {entries.length > 0 && (
        <div
          ref={listRef}
          tabIndex={-1}
          className="history-list space-y-2 p-0 m-0 focus:outline-none"
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
                onToggleSelection={handleToggleSelection}
                onToggleDiff={handleToggleDiff}
                onRestoreToHere={handleRestoreToHere}
              />
            )
          })}
        </div>
      )}

      {/* Load more */}
      <LoadMoreButton
        hasMore={hasMore}
        loading={loading}
        onLoadMore={loadMore}
        className="history-load-more"
      />

      <output className="sr-only" aria-live="polite">
        {loadMoreAnnouncement}
      </output>

      {/* Revert confirmation dialog */}
      <ConfirmDialog
        open={confirmRevert}
        onOpenChange={setConfirmRevert}
        title={t('history.revertTitle', { count: selected.size })}
        description={t('history.revertDescription', { count: selected.size })}
        cancelLabel={t('history.cancelButton')}
        actionLabel={t('history.revertButton')}
        actionVariant="destructive"
        onAction={handleRevert}
        loading={reverting}
      />

      {/* Restore-to-here confirmation dialog */}
      <ConfirmDialog
        open={confirmRestore}
        onOpenChange={(open) => {
          setConfirmRestore(open)
          if (!open) setRestoreTarget(null)
        }}
        title={t('history.restoreToTitle', {
          timestamp: restoreTarget ? formatTimestamp(restoreTarget.created_at, 'full') : '',
        })}
        description={t('history.restoreToDescription')}
        cancelLabel={t('history.cancelButton')}
        actionLabel={t('history.restoreButton')}
        actionVariant="destructive"
        onAction={handleConfirmRestore}
        loading={restoring}
      />
    </div>
  )
}
