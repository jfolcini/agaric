/**
 * HistoryPanel — shows the edit history of a block from the op log (p2-t6, p2-t7, p2-t8).
 *
 * Per-block panel: receives a blockId prop and displays paginated history entries.
 * Supports restoring a block to a previous state via the op log payload.
 */

import { Clock } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { logger } from '@/lib/logger'
import { useHistoryDiffToggle } from '../hooks/useHistoryDiffToggle'
import { formatTimestamp } from '../lib/format'
import type { HistoryEntry } from '../lib/tauri'
import { editBlock, getBlock, getBlockHistory } from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { HistoryFilterBar } from './HistoryFilterBar'
import { BlockHistoryItem } from './HistoryListItem'
import { ListViewState } from './ListViewState'
import { LoadMoreButton } from './LoadMoreButton'

interface HistoryPanelProps {
  /** The block to show history for. */
  blockId: string | null
}

export function HistoryPanel({ blockId }: HistoryPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [confirmEntry, setConfirmEntry] = useState<HistoryEntry | null>(null)
  const [opTypeFilter, setOpTypeFilter] = useState<string | null>(null)
  const { expandedKeys, diffCache, loadingDiffs, handleToggleDiff } = useHistoryDiffToggle<number>(
    (entry) => entry.seq,
  )

  const loadHistory = useCallback(
    async (cursor?: string) => {
      if (!blockId) return
      setLoading(true)
      try {
        const resp = await getBlockHistory({
          blockId,
          ...(cursor != null && { cursor }),
          limit: 50,
        })
        if (cursor) {
          setEntries((prev) => [...prev, ...resp.items])
        } else {
          setEntries(resp.items)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
      } catch (err) {
        logger.error('HistoryPanel', 'Failed to load block history', { blockId }, err)
        toast.error(t('history.loadFailed'))
      }
      setLoading(false)
    },
    [blockId, t],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset and reload when blockId changes
  useEffect(() => {
    setEntries([])
    setNextCursor(null)
    setHasMore(false)
    loadHistory()
  }, [blockId, loadHistory])

  const loadMore = useCallback(() => {
    if (nextCursor) loadHistory(nextCursor)
  }, [nextCursor, loadHistory])

  const filteredEntries = opTypeFilter ? entries.filter((e) => e.op_type === opTypeFilter) : entries

  // UX-275 sub-fix 4: restore is reversible — capture the current block
  // content BEFORE applying the historical version so the success toast can
  // offer a one-click "Undo" that re-applies the captured snapshot.
  const handleUndoRestore = useCallback(
    async (targetBlockId: string, previousContent: string) => {
      try {
        await editBlock(targetBlockId, previousContent)
        toast.success(t('history.restoreUndone'))
      } catch (err) {
        logger.error('HistoryPanel', 'Failed to undo restore', { blockId: targetBlockId }, err)
        toast.error(t('history.restoreUndoFailed'))
      }
    },
    [t],
  )

  const handleRestore = useCallback(
    async (entry: HistoryEntry) => {
      if (!blockId) return
      try {
        const parsed = JSON.parse(entry.payload) as { to_text?: string }
        if (parsed.to_text == null) return

        // Snapshot the current block content for the toast's Undo action.
        // We tolerate a missing snapshot (e.g. fresh block, transient IPC
        // glitch) — the restore still proceeds, just without an Undo offer.
        let previousContent: string | null = null
        try {
          const current = await getBlock(blockId)
          previousContent = current.content ?? ''
        } catch (snapshotErr) {
          logger.warn(
            'HistoryPanel',
            'Could not snapshot block before restore — Undo will be unavailable',
            { blockId, opId: entry.seq },
            snapshotErr,
          )
        }

        await editBlock(blockId, parsed.to_text)

        if (previousContent != null) {
          const captured = previousContent
          toast.success(t('history.revertedSuccessfully'), {
            action: {
              label: t('action.undo'),
              onClick: () => {
                handleUndoRestore(blockId, captured)
              },
            },
          })
        } else {
          toast.success(t('history.revertedSuccessfully'))
        }
      } catch (err) {
        logger.error(
          'HistoryPanel',
          'Failed to restore from history',
          { blockId, opId: entry.seq },
          err,
        )
        toast.error(t('history.revertPanelFailed'))
      }
    },
    [blockId, t, handleUndoRestore],
  )

  if (!blockId) {
    return <EmptyState message={t('history.selectBlockEmpty')} compact />
  }

  return (
    <div className="history-panel space-y-4">
      <HistoryFilterBar opTypeFilter={opTypeFilter} onFilterChange={setOpTypeFilter} />

      <ListViewState
        loading={loading}
        items={filteredEntries}
        skeleton={<LoadingSkeleton count={2} height="h-14" className="history-panel-loading" />}
        empty={<EmptyState icon={Clock} message={t('history.noHistoryEmpty')} />}
      >
        {(items) => (
          <ul className="history-list space-y-0 list-none p-0 m-0">
            {items.map((entry, i) => (
              <BlockHistoryItem
                key={entry.seq}
                entry={entry}
                index={i}
                isExpanded={expandedKeys.has(entry.seq)}
                isLoadingDiff={loadingDiffs.has(entry.seq)}
                diffSpans={diffCache.get(entry.seq)}
                onToggleDiff={handleToggleDiff}
                onRestore={(e) => setConfirmEntry(e)}
              />
            ))}
          </ul>
        )}
      </ListViewState>

      <LoadMoreButton
        hasMore={hasMore}
        loading={loading}
        onLoadMore={loadMore}
        className="history-load-more"
      />

      <ConfirmDialog
        open={confirmEntry !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmEntry(null)
        }}
        title={t('history.restoreConfirmTitle')}
        description={t('history.restoreConfirmDescription', {
          timestamp: confirmEntry ? formatTimestamp(confirmEntry.created_at) : '',
        })}
        cancelLabel={t('dialog.cancel')}
        actionLabel={t('history.restoreConfirmAction')}
        onAction={() => {
          if (confirmEntry) handleRestore(confirmEntry)
          setConfirmEntry(null)
        }}
      />
    </div>
  )
}
