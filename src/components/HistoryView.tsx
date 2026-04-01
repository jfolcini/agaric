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
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTimestamp } from '../lib/format'
import type { DiffSpan, HistoryEntry } from '../lib/tauri'
import { computeEditDiff, listPageHistory, revertOps } from '../lib/tauri'
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
    return 'bg-emerald-500/10 text-emerald-700'
  }
  if (opType.startsWith('edit')) {
    return 'bg-blue-500/10 text-blue-700'
  }
  if (opType.startsWith('delete') || opType.startsWith('purge')) {
    return 'bg-destructive/10 text-destructive'
  }
  if (opType.startsWith('move')) {
    return 'bg-purple-500/10 text-purple-700'
  }
  if (
    opType.startsWith('tag') ||
    opType.startsWith('property') ||
    opType === 'set_property' ||
    opType === 'delete_property'
  ) {
    return 'bg-amber-500/10 text-amber-700'
  }
  if (opType.startsWith('attachment') || opType === 'add_attachment') {
    return 'bg-muted text-muted-foreground'
  }
  return 'bg-secondary text-secondary-foreground'
}

// ---------------------------------------------------------------------------
// Payload preview
// ---------------------------------------------------------------------------

function getPayloadPreview(entry: HistoryEntry): string | null {
  try {
    const parsed = JSON.parse(entry.payload) as Record<string, unknown>
    // edit_block payloads have to_text
    if (typeof parsed.to_text === 'string') {
      const text = parsed.to_text
      return text.length > 80 ? `${text.slice(0, 80)}...` : text
    }
    // create_block payloads have content
    if (typeof parsed.content === 'string') {
      const text = parsed.content
      return text.length > 80 ? `${text.slice(0, 80)}...` : text
    }
  } catch {
    // Invalid JSON
  }
  return null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryView(): React.ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [lastClickedIndex, setLastClickedIndex] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [opTypeFilter, setOpTypeFilter] = useState<string | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [diffCache, setDiffCache] = useState<Map<string, DiffSpan[]>>(new Map())
  const [loadingDiffs, setLoadingDiffs] = useState<Set<string>>(new Set())

  const listRef = useRef<HTMLDivElement>(null)

  // ── Data loading ─────────────────────────────────────────────────
  const loadHistory = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        setError(null)
        const resp = await listPageHistory({
          pageId: '__all__',
          opTypeFilter: opTypeFilter ?? undefined,
          cursor,
          limit: 50,
        })
        if (cursor) {
          setEntries((prev) => [...prev, ...resp.items])
          setLoadMoreAnnouncement(`Loaded ${resp.items.length} more entries`)
        } else {
          setEntries(resp.items)
          setLoadMoreAnnouncement('')
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
      } catch {
        setError('Failed to load history')
      }
      setLoading(false)
    },
    [opTypeFilter],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset and reload when filter changes
  useEffect(() => {
    setEntries([])
    setNextCursor(null)
    setHasMore(false)
    setSelected(new Set())
    setFocusedIndex(-1)
    setLastClickedIndex(-1)
    loadHistory()
  }, [opTypeFilter, loadHistory])

  // Set initial focus when entries load
  useEffect(() => {
    if (entries.length > 0 && focusedIndex === -1) {
      setFocusedIndex(0)
    }
  }, [entries.length, focusedIndex])

  const loadMore = useCallback(() => {
    if (nextCursor) loadHistory(nextCursor)
  }, [nextCursor, loadHistory])

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
      setNextCursor(null)
      setHasMore(false)
      await loadHistory()
    } catch {
      toast.error('Failed to revert operations')
    }
    setReverting(false)
    setConfirmRevert(false)
  }, [selected, entries, loadHistory])

  const handleToggleDiff = useCallback(
    async (entry: HistoryEntry) => {
      const key = entryKey(entry)
      if (expandedKeys.has(key)) {
        setExpandedKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        return
      }
      setExpandedKeys((prev) => new Set(prev).add(key))
      if (diffCache.has(key)) return
      setLoadingDiffs((prev) => new Set(prev).add(key))
      try {
        const diff = await computeEditDiff({ deviceId: entry.device_id, seq: entry.seq })
        if (diff) {
          setDiffCache((prev) => new Map(prev).set(key, diff))
        }
      } catch {
        toast.error('Failed to load diff')
      }
      setLoadingDiffs((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    },
    [expandedKeys, diffCache],
  )

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

  // ── Filter change ────────────────────────────────────────────────

  const handleFilterChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    setOpTypeFilter(value === '' ? null : value)
  }, [])

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="history-view space-y-4">
      {/* Filter bar */}
      <div className="history-filter-bar flex items-center gap-3">
        <label htmlFor="op-type-filter" className="text-sm font-medium text-muted-foreground">
          Filter:
        </label>
        <select
          id="op-type-filter"
          value={opTypeFilter ?? ''}
          onChange={handleFilterChange}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          aria-label="Filter by operation type"
        >
          <option value="">All types</option>
          {OP_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Selection toolbar */}
      {selected.size > 0 && (
        <div className="history-selection-toolbar flex items-center gap-3 rounded-lg border bg-muted/50 p-3">
          <Badge variant="secondary">{selected.size} selected</Badge>
          <Button
            variant="default"
            size="sm"
            onClick={() => setConfirmRevert(true)}
            disabled={reverting}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {reverting ? 'Reverting...' : 'Revert selected'}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection} disabled={reverting}>
            Clear selection
          </Button>
          <span className="text-xs text-muted-foreground ml-auto hidden sm:inline">
            Space to toggle, Enter to revert
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null)
              loadHistory()
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && (
        <EmptyState icon={Clock} message="No history entries found" />
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
                    className="h-4 w-4 shrink-0 rounded border-border"
                    aria-label={`Select operation ${entry.op_type} #${entry.seq}`}
                  />

                  {/* Op type badge */}
                  <Badge
                    variant="outline"
                    className={`history-item-type shrink-0 border-transparent ${opBadgeClasses(entry.op_type)}`}
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
                    <span className="text-[10px] text-muted-foreground/60"> · </span>
                    <span className="history-item-device text-[10px] text-muted-foreground/60">
                      dev:{entry.device_id.slice(0, 8)}
                    </span>
                  </div>

                  {/* Diff toggle for edit_block entries */}
                  {entry.op_type === 'edit_block' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="diff-toggle-btn shrink-0 h-7 px-2"
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
                      Diff
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
                          <p>This operation cannot be reversed</p>
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
      <AlertDialog open={confirmRevert} onOpenChange={setConfirmRevert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert {selected.size} operations?</AlertDialogTitle>
            <AlertDialogDescription>
              This will create {selected.size} new operations that reverse the selected changes. The
              original operations remain in history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevert} disabled={reverting}>
              {reverting ? 'Reverting...' : 'Revert'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
