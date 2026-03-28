/**
 * JournalPage — today's blocks from agenda_cache (p15-t20, p15-t21).
 *
 * Shows blocks scheduled for a given date. Supports prev/next day
 * navigation. Uses listBlocks with agendaDate filter.
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

  const dateStr = formatDate(date)

  useEffect(() => {
    setLoading(true)
    listBlocks({ agendaDate: dateStr })
      .then((resp) => {
        setBlocks(resp.items)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [dateStr])

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

      {loading && <div className="journal-loading">Loading...</div>}

      {!loading && blocks.length === 0 && (
        <div className="journal-empty">No blocks scheduled for {formatDateDisplay(date)}</div>
      )}

      {!loading && blocks.length > 0 && (
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
    </div>
  )
}
