/**
 * JournalPage — today's blocks from agenda_cache (p15-t20, p15-t21).
 *
 * Shows blocks scheduled for a given date. Supports prev/next day
 * navigation. Uses listBlocks with agendaDate filter.
 * Paginated via cursor-based pagination (ADR requirement).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { BlockRow } from '../lib/tauri'
import { listBlocks } from '../lib/tauri'

/** Format a Date as YYYY-MM-DD. */
function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Format a Date as a readable string (e.g., "Mon, Jan 15 2025"). */
function formatDateDisplay(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

interface JournalPageProps {
  /** Called when a block is clicked — navigates to block editor. */
  onBlockClick?: (blockId: string) => void
}

export function JournalPage({ onBlockClick }: JournalPageProps): React.ReactElement {
  const [date, setDate] = useState(() => new Date())
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)

  const dateStr = formatDate(date)

  const loadBlocks = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        const resp = await listBlocks({ agendaDate: dateStr, cursor, limit: 50 })
        if (cursor) {
          setBlocks((prev) => [...prev, ...resp.items])
        } else {
          setBlocks(resp.items)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
      } catch {
        // Silently fail
      }
      setLoading(false)
    },
    [dateStr],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset and reload when date changes
  useEffect(() => {
    setBlocks([])
    setNextCursor(null)
    setHasMore(false)
    loadBlocks()
  }, [dateStr])

  const loadMore = useCallback(() => {
    if (nextCursor) loadBlocks(nextCursor)
  }, [nextCursor, loadBlocks])

  const goToPrevDay = useCallback(() => {
    setDate((prev) => {
      const d = new Date(prev)
      d.setDate(d.getDate() - 1)
      return d
    })
  }, [])

  const goToNextDay = useCallback(() => {
    setDate((prev) => {
      const d = new Date(prev)
      d.setDate(d.getDate() + 1)
      return d
    })
  }, [])

  const goToToday = useCallback(() => {
    setDate(new Date())
  }, [])

  const isToday = formatDate(new Date()) === dateStr

  return (
    <div className="journal-page">
      <div className="journal-nav">
        <button type="button" className="journal-nav-btn" onClick={goToPrevDay}>
          &larr; Prev
        </button>
        <div className="journal-date">
          <span className="journal-date-text">{formatDateDisplay(date)}</span>
          {!isToday && (
            <button type="button" className="journal-today-btn" onClick={goToToday}>
              Today
            </button>
          )}
        </div>
        <button type="button" className="journal-nav-btn" onClick={goToNextDay}>
          Next &rarr;
        </button>
      </div>

      {loading && blocks.length === 0 && <div className="journal-loading">Loading...</div>}

      {!loading && blocks.length === 0 && (
        <div className="journal-empty">No blocks scheduled for {formatDateDisplay(date)}</div>
      )}

      {blocks.length > 0 && (
        <div className="journal-blocks">
          {blocks.map((block) => (
            <button
              key={block.id}
              type="button"
              className="journal-block-item"
              onClick={() => onBlockClick?.(block.id)}
            >
              <span className="journal-block-type">{block.block_type}</span>
              <span className="journal-block-content">{block.content ?? '(empty)'}</span>
            </button>
          ))}
        </div>
      )}

      {hasMore && (
        <button type="button" className="journal-load-more" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  )
}
