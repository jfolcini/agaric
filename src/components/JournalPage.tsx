/**
 * JournalPage — daily journal view backed by BlockTree.
 *
 * Each date MAY have a backing page block (blockType='page', content=dateString).
 * The page is invisible to the user — they just see child blocks rendered
 * via BlockTree (with roving editor, DnD, keyboard shortcuts, markdown).
 * The "Add block" button auto-creates the daily page if needed.
 */

import { ChevronLeft, ChevronRight, ExternalLink, Plus } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { createBlock, listBlocks } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { BlockTree } from './BlockTree'

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
  /** Called to navigate to a page for editing. */
  onNavigateToPage?: (pageId: string, title?: string) => void
}

export function JournalPage({
  onBlockClick: _onBlockClick,
  onNavigateToPage,
}: JournalPageProps): React.ReactElement {
  const [date, setDate] = useState(() => new Date())
  const [dailyPageId, setDailyPageId] = useState<string | null>(null)
  const [pageLoading, setPageLoading] = useState(false)
  const { load } = useBlockStore()

  const dateStr = formatDate(date)

  /** Find the daily page for the current date (does NOT load children — BlockTree does that). */
  const findDailyPage = useCallback(async () => {
    setPageLoading(true)
    try {
      const resp = await listBlocks({ blockType: 'page', limit: 500 })
      const page = resp.items.find((b) => b.content === formatDate(date))
      setDailyPageId(page ? page.id : null)
    } catch {
      setDailyPageId(null)
    }
    setPageLoading(false)
  }, [date])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset and reload when date changes
  useEffect(() => {
    setDailyPageId(null)
    findDailyPage()
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

  /** Add a new block under the daily page, creating the page if needed. */
  async function handleAddBlock() {
    let pageId = dailyPageId
    // Auto-create daily page if it doesn't exist
    if (!pageId) {
      const page = await createBlock({ blockType: 'page', content: formatDate(date) })
      pageId = page.id
      setDailyPageId(pageId)
    }

    // Create an empty child block under the daily page
    await createBlock({
      blockType: 'text',
      content: '',
      parentId: pageId,
    })

    // Refresh BlockTree to pick up the new block
    await load(pageId)
  }

  // TODO: Auto-delete daily page when last block is deleted.
  // BlockTree handles deletion internally via useBlockStore.remove().
  // We could subscribe to block count changes and clean up the empty
  // daily page, but that requires cross-component coordination.
  // Deferred — will revisit when adding journal-specific lifecycle hooks.

  return (
    <div className="space-y-4">
      {/* Date navigation */}
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={goToPrevDay}>
          <ChevronLeft className="h-4 w-4" />
          Prev
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-base font-medium">{formatDateDisplay(date)}</span>
          {!isToday && (
            <Button variant="ghost" size="sm" onClick={goToToday}>
              Today
            </Button>
          )}
          {dailyPageId && onNavigateToPage && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Open in editor"
              onClick={() => onNavigateToPage(dailyPageId, dateStr)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <Button variant="outline" onClick={goToNextDay}>
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Loading indicator while finding the daily page */}
      {pageLoading && (
        <div className="space-y-1">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      )}

      {/* Block tree — delegates all block rendering to BlockTree */}
      {!pageLoading && dailyPageId && <BlockTree parentId={dailyPageId} />}

      {/* Empty state — no daily page for this date */}
      {!pageLoading && !dailyPageId && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No blocks for {formatDateDisplay(date)}. Add one below.
        </div>
      )}

      {/* Add block button */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={handleAddBlock}
        >
          <Plus className="h-4 w-4" />
          Add block
        </Button>
      </div>
    </div>
  )
}
