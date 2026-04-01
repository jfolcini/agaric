/**
 * HistoryPanel — shows the edit history of a block from the op log (p2-t6, p2-t7, p2-t8).
 *
 * Per-block panel: receives a blockId prop and displays paginated history entries.
 * Supports restoring a block to a previous state via the op log payload.
 */

import { Clock, Loader2, RotateCcw } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTimestamp } from '../lib/format'
import type { HistoryEntry } from '../lib/tauri'
import { editBlock, getBlockHistory } from '../lib/tauri'
import { EmptyState } from './EmptyState'

interface HistoryPanelProps {
  /** The block to show history for. */
  blockId: string | null
}

export function HistoryPanel({ blockId }: HistoryPanelProps): React.ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [restoringSeq, setRestoringSeq] = useState<number | null>(null)

  const loadHistory = useCallback(
    async (cursor?: string) => {
      if (!blockId) return
      setLoading(true)
      try {
        const resp = await getBlockHistory({ blockId, cursor, limit: 50 })
        if (cursor) {
          setEntries((prev) => [...prev, ...resp.items])
        } else {
          setEntries(resp.items)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
      } catch {
        toast.error('Failed to load history')
      }
      setLoading(false)
    },
    [blockId],
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

  const handleRestore = useCallback(
    async (entry: HistoryEntry) => {
      if (!blockId) return
      setRestoringSeq(entry.seq)
      try {
        const parsed = JSON.parse(entry.payload) as { to_text?: string }
        if (parsed.to_text != null) {
          await editBlock(blockId, parsed.to_text)
        }
        toast.success('Reverted successfully')
      } catch {
        toast.error('Failed to revert')
      }
      setRestoringSeq(null)
    },
    [blockId],
  )

  /** Extract a preview from the payload for edit_block ops. */
  function getPayloadPreview(entry: HistoryEntry): string | null {
    try {
      const parsed = JSON.parse(entry.payload) as { to_text?: string }
      if (parsed.to_text != null) {
        const text = parsed.to_text
        return text.length > 100 ? `${text.slice(0, 100)}...` : text
      }
    } catch {
      // Invalid JSON — return null
    }
    return null
  }

  if (!blockId) {
    return <EmptyState message="Select a block to see history" compact />
  }

  return (
    <div className="history-panel space-y-4">
      {loading && entries.length === 0 && (
        <div className="history-panel-loading space-y-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      )}

      {!loading && entries.length === 0 && (
        <EmptyState icon={Clock} message="No history for this block" />
      )}

      <ul className="history-list space-y-2 list-none p-0 m-0">
        {entries.map((entry) => {
          const preview = getPayloadPreview(entry)
          const isEditBlock = entry.op_type === 'edit_block'
          return (
            <li
              key={entry.seq}
              className="history-item flex items-start justify-between gap-3 rounded-lg border bg-card p-4"
            >
              <div className="history-item-content flex flex-col gap-1 min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="history-item-type shrink-0">
                    {entry.op_type}
                  </Badge>
                  <span className="history-item-time text-xs text-muted-foreground">
                    {formatTimestamp(entry.created_at)}
                  </span>
                </div>
                {preview && (
                  <span className="history-item-preview text-sm text-muted-foreground truncate">
                    {preview}
                  </span>
                )}
              </div>
              {isEditBlock && preview && (
                <Button
                  variant="outline"
                  size="sm"
                  className="history-restore-btn shrink-0"
                  onClick={() => handleRestore(entry)}
                  disabled={restoringSeq === entry.seq}
                >
                  {restoringSeq === entry.seq ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  Restore
                </Button>
              )}
            </li>
          )
        })}
      </ul>

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
    </div>
  )
}
