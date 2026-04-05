/**
 * HistoryView --- global operation log with multi-select for batch revert.
 *
 * Shows all history entries (op log) with filtering by op type,
 * keyboard navigation, multi-select (including shift-click range select),
 * and batch revert with confirmation dialog.
 */

import { ChevronDown, ChevronRight, Clock, Loader2, Lock, RotateCcw } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useHistoryDiffToggle } from '../hooks/useHistoryDiffToggle'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { formatTimestamp } from '../lib/format'
import { getPayloadPreview } from '../lib/history-utils'
import type { HistoryEntry } from '../lib/tauri'
import { listPageHistory, revertOps } from '../lib/tauri'
import { DiffDisplay } from './DiffDisplay'
import { EmptyState } from './EmptyState'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OP_TYPES = [
  'edit',
  'create',
  'delete',
  'move',
  'tag',
  'property',
  'attachment',
  'restore',
  'purge',
  'sync_merge',
  'sync_receive',
] as const

/** Op types that cannot be reversed. */
const NON_REVERSIBLE_OPS = new Set(['purge_block', 'delete_attachment'])

/** Unique key for a history entry. */
function entryKey(entry: HistoryEntry): string {
  return `${entry.device_id}:${entry.seq}`
}

// ---------------------------------------------------------------------------
// Badge colour mapping
// ---------------------------------------------------------------------------

function opBadgeClasses(opType: string): string {
  if (opType.startsWith('create') || opType.startsWith('restore')) {
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
  }
  if (opType.startsWith('edit')) {
    return 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
  }
  if (opType.startsWith('delete') || opType.startsWith('purge')) {
    return 'bg-destructive/10 text-destructive'
  }
  if (opType.startsWith('move')) {
    return 'bg-purple-500/10 text-purple-700 dark:text-purple-400'
  }
  if (
    opType.startsWith('tag') ||
    opType.startsWith('property') ||
    opType === 'set_property' ||
    opType === 'delete_property'
  ) {
    return 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
  }
  if (opType.startsWith('attachment') || opType === 'add_attachment') {
    return 'bg-muted text-muted-foreground'
  }
  return 'bg-secondary text-secondary-foreground'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryView(): React.ReactElement {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focusedIndex, setFocusedIndex] = useState(-1)
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

  // Reset selection when filter changes (entries are replaced by the hook)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset UI state when filter changes
  useEffect(() => {
    setSelected(new Set())
    setFocusedIndex(-1)
    setLastClickedIndex(-1)
  }, [opTypeFilter])

  // Set initial focus when entries load
  useEffect(() => {
    if (entries.length > 0 && focusedIndex === -1) {
      setFocusedIndex(0)
    }
  }, [entries.length, focusedIndex])

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
      toast.error('Failed to revert operations')
    }
    setReverting(false)
    setConfirmRevert(false)
  }, [selected, entries, reload, setEntries])

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

      // Arrow Up / k
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        setFocusedIndex((prev) => Math.max(0, prev - 1))
        return
      }

      // Arrow Down / j
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        setFocusedIndex((prev) => Math.min(entries.length - 1, prev + 1))
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
  }, [entries.length, focusedIndex, toggleSelection, selectAll, selected.size, clearSelection])

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
    [rangeSelect, toggleSelection],
  )

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="history-view space-y-4">
      {/* Filter bar */}
      <div className="history-filter-bar flex items-center gap-3">
        <label htmlFor="op-type-filter" className="text-sm font-medium text-muted-foreground">
          {t('history.filterLabel')}
        </label>
        <Select
          value={opTypeFilter ?? '__all__'}
          onValueChange={(val) => setOpTypeFilter(val === '__all__' ? null : val)}
        >
          <SelectTrigger
            id="op-type-filter"
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Filter by operation type"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('history.allTypesOption')}</SelectItem>
            {OP_TYPES.map((opType) => (
              <SelectItem key={opType} value={opType}>
                {opType}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Selection toolbar */}
      {selected.size > 0 && (
        <div className="history-selection-toolbar flex items-center gap-3 rounded-lg border bg-muted/50 p-3">
          <Badge variant="secondary">
            {selected.size} {t('history.selectedBadge')}
          </Badge>
          <Button
            variant="default"
            size="sm"
            onClick={() => setConfirmRevert(true)}
            disabled={reverting}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {reverting ? t('history.revertingButton') : t('history.revertSelectedButton')}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection} disabled={reverting}>
            {t('history.clearSelectionButton')}
          </Button>
          <span className="text-xs text-muted-foreground ml-auto hidden sm:inline">
            {t('history.keyboardHint')}
          </span>
        </div>
      )}

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
          aria-label="History entries"
          aria-multiselectable="true"
        >
          {entries.map((entry, index) => {
            const key = entryKey(entry)
            const isSelected = selected.has(key)
            const isFocused = focusedIndex === index
            const isNonReversible = NON_REVERSIBLE_OPS.has(entry.op_type)
            const preview = getPayloadPreview(entry)

            return (
              <div
                key={key}
                data-history-item
                data-testid={`history-item-${index}`}
                role="option"
                aria-selected={isSelected}
                className={`history-item flex flex-col gap-2 rounded-lg border p-4 cursor-pointer transition-colors ${
                  isSelected ? 'bg-accent/50 border-accent' : 'bg-card hover:bg-accent/30'
                } ${isFocused ? 'ring-2 ring-ring' : ''} ${isNonReversible ? 'opacity-50' : ''}`}
                onClick={(e) => handleRowClick(index, e)}
                onKeyDown={(e) => {
                  if (e.key === ' ') {
                    e.preventDefault()
                    toggleSelection(index)
                  }
                }}
                tabIndex={isFocused ? 0 : -1}
                aria-disabled={isNonReversible || undefined}
              >
                <div className="flex items-center gap-3 w-full">
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isNonReversible}
                    onChange={() => toggleSelection(index)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-4 w-4 shrink-0 rounded border-border [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6"
                    aria-label={t('history.selectOperationLabel', {
                      opType: entry.op_type,
                      seq: entry.seq,
                    })}
                  />

                  {/* Op type badge */}
                  <Badge
                    variant="outline"
                    className={`history-item-type shrink-0 border-transparent ${opBadgeClasses(entry.op_type)}`}
                    data-testid="history-type-badge"
                  >
                    {entry.op_type}
                  </Badge>

                  {/* Content preview + timestamp */}
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    {preview && (
                      <span className="history-item-preview text-sm truncate">{preview}</span>
                    )}
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="history-item-time text-xs text-muted-foreground w-fit">
                            {formatTimestamp(entry.created_at, 'relative')}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{formatTimestamp(entry.created_at, 'full')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <span className="text-xs text-muted-foreground/60"> · </span>
                    <span className="history-item-device text-xs text-muted-foreground/60">
                      dev:{entry.device_id.slice(0, 8)}
                    </span>
                  </div>

                  {/* Diff toggle for edit_block entries */}
                  {entry.op_type === 'edit_block' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="diff-toggle-btn shrink-0 px-2"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggleDiff(entry)
                      }}
                    >
                      {loadingDiffs.has(key) ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : expandedKeys.has(key) ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                      {t('history.diffButton')}
                    </Button>
                  )}

                  {/* Lock icon for non-reversible ops */}
                  {isNonReversible && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Lock
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            aria-label="Non-reversible"
                          />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t('history.nonReversibleTooltip')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
                {expandedKeys.has(key) && diffCache.has(key) && (
                  // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation prevents parent row selection when clicking diff
                  <div
                    className="diff-container mt-2 w-full"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <DiffDisplay spans={diffCache.get(key) ?? []} />
                  </div>
                )}
              </div>
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
