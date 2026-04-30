/**
 * HistoryView --- global operation log with multi-select for batch revert.
 *
 * Top-level orchestrator: owns data loading, filter state, dialog open
 * states, and composes `HistoryFilterBar` + `HistorySelectionToolbar`
 * + `HistoryListView` + the revert / restore dialogs. Selection,
 * keyboard navigation, list rendering, and the dialog IPCs each live
 * in their own hook / sibling component (MAINT-128).
 */

import { Clock } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { useHistoryDiffToggle } from '../hooks/useHistoryDiffToggle'
import { useHistoryKeyboardNav } from '../hooks/useHistoryKeyboardNav'
import { entryKey, useHistorySelection } from '../hooks/useHistorySelection'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import { categorizeHistoryError, type HistoryErrorCategory } from '../lib/categorize-history-error'
import { logger } from '../lib/logger'
import type { HistoryEntry } from '../lib/tauri'
import { listPageHistory } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { CompactionCard } from './CompactionCard'
import { EmptyState } from './EmptyState'
import { HistoryFilterBar } from './HistoryFilterBar'
import { HistoryListView } from './HistoryListView'
import { HistoryRestoreDialog } from './HistoryRestoreDialog'
import { HistoryRevertDialog } from './HistoryRevertDialog'
import { HistorySelectionToolbar } from './HistorySelectionToolbar'
import { ViewHeader } from './ViewHeader'

export function HistoryView(): React.ReactElement {
  const { t } = useTranslation()
  const [opTypeFilter, setOpTypeFilter] = useState<string | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<HistoryEntry | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
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

  // ── Selection (multi-select with shift-range) ────────────────────
  const {
    selectedIds,
    toggleSelectedIndex,
    selectAll,
    clearSelection,
    handleRowClick: selectionHandleRowClick,
    getSelectedEntries,
  } = useHistorySelection(entries)

  // ── Keyboard navigation (Arrow / vim / Home / End / PageUp/Down) ─
  const { focusedIndex, setFocusedIndex } = useHistoryKeyboardNav({
    itemCount: entries.length,
    listRef,
    hasSelection: selectedIds.size > 0,
    onToggleSelection: toggleSelectedIndex,
    onSelectAll: selectAll,
    onConfirmRevert: () => setConfirmRevert(true),
    onClearSelection: clearSelection,
  })

  // Reset selection + focus when filter changes (entries are replaced
  // by the paginated query). FEAT-3 Phase 8 — also resets when the
  // space scope flips so a stale selection from the previous scope
  // doesn't leak into the new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset UI state when filter changes
  useEffect(() => {
    clearSelection()
    setFocusedIndex(0)
  }, [opTypeFilter, effectiveSpaceId, setFocusedIndex, clearSelection])

  // Glue selection+focus row click together for HistoryListView.
  const handleRowClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      selectionHandleRowClick(index, e)
      setFocusedIndex(index)
    },
    [selectionHandleRowClick, setFocusedIndex],
  )

  const handleRestoreToHere = useCallback((entry: HistoryEntry) => {
    setRestoreTarget(entry)
    setConfirmRestore(true)
  }, [])

  // Post-revert / post-restore reload — clears local pagination state
  // and re-issues the initial query.
  const reloadAfterMutation = useCallback(async () => {
    clearSelection()
    setEntries([])
    await reload()
  }, [clearSelection, reload, setEntries])

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
          {selectedIds.size > 0 && (
            <HistorySelectionToolbar
              selectedCount={selectedIds.size}
              reverting={false}
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

      <HistoryListView
        entries={entries}
        selectedIds={selectedIds}
        focusedIndex={focusedIndex}
        expandedKeys={expandedKeys}
        diffCache={diffCache}
        loadingDiffs={loadingDiffs}
        listRef={listRef}
        hasMore={hasMore}
        loading={loading}
        onLoadMore={loadMore}
        onRowClick={handleRowClick}
        onToggleSelection={toggleSelectedIndex}
        onToggleDiff={handleToggleDiff}
        onRestoreToHere={handleRestoreToHere}
      />

      {/* Revert confirmation dialog */}
      <HistoryRevertDialog
        open={confirmRevert}
        onOpenChange={setConfirmRevert}
        selectedEntries={getSelectedEntries()}
        onSuccess={reloadAfterMutation}
      />

      {/* Restore-to-here confirmation dialog */}
      <HistoryRestoreDialog
        open={confirmRestore}
        onOpenChange={(open) => {
          setConfirmRestore(open)
          if (!open) setRestoreTarget(null)
        }}
        restoreTarget={restoreTarget}
        onSuccess={reloadAfterMutation}
      />
    </div>
  )
}
