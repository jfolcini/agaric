/**
 * JournalPage — scrollable multi-day journal view backed by BlockTree.
 *
 * Shows today + past days stacked vertically (like Logseq's journal).
 * Each date MAY have a backing page block (blockType='page', content=dateString).
 * The page is invisible to the user — they just see child blocks rendered
 * via BlockTree (with roving editor, DnD, keyboard shortcuts, markdown).
 * Each day section has its own "Add block" button that auto-creates the
 * daily page if needed.
 */

import { Calendar, ChevronDown, ExternalLink, Plus } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { createBlock, listBlocks } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { BlockTree } from './BlockTree'

const DAYS_PER_BATCH = 7

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

/** Build an array of Date objects from today going back `count` days, starting at `offset`. */
function buildDayRange(offset: number, count: number): Date[] {
  const days: Date[] = []
  const today = new Date()
  for (let i = offset; i < offset + count; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    days.push(d)
  }
  return days
}

interface DayEntry {
  date: Date
  dateStr: string
  displayDate: string
  pageId: string | null
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
  const [dayCount, setDayCount] = useState(DAYS_PER_BATCH)
  const [pageMap, setPageMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
  // Track per-day pageIds that were created by handleAddBlock so we can
  // immediately show BlockTree without waiting for a full refetch.
  const [createdPages, setCreatedPages] = useState<Map<string, string>>(new Map())
  const { load } = useBlockStore()

  /** Fetch all pages and build a dateStr→pageId lookup. */
  const fetchPages = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await listBlocks({ blockType: 'page', limit: 500 })
      const map = new Map<string, string>()
      for (const b of resp.items) {
        // Daily pages have content set to the YYYY-MM-DD date string
        if (b.content && /^\d{4}-\d{2}-\d{2}$/.test(b.content)) {
          map.set(b.content, b.id)
        }
      }
      setPageMap(map)
    } catch {
      setPageMap(new Map())
    }
    setLoading(false)
  }, [])

  // Fetch pages on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: only run on mount
  useEffect(() => {
    fetchPages()
  }, [])

  /** The list of dates to display. */
  const days: Date[] = useMemo(() => buildDayRange(0, dayCount), [dayCount])

  /** Build DayEntry array with page lookup. */
  const dayEntries: DayEntry[] = useMemo(() => {
    return days.map((d) => {
      const dateStr = formatDate(d)
      return {
        date: d,
        dateStr,
        displayDate: formatDateDisplay(d),
        pageId: createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null,
      }
    })
  }, [days, pageMap, createdPages])

  const todayStr = formatDate(new Date())

  /** Load 7 more past days. */
  function handleLoadMore() {
    setDayCount((prev) => prev + DAYS_PER_BATCH)
  }

  /** Add a new block under a specific day's page, creating the page if needed. */
  async function handleAddBlock(dateStr: string) {
    let pageId = createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null

    // Auto-create daily page if it doesn't exist
    if (!pageId) {
      const page = await createBlock({ blockType: 'page', content: dateStr })
      pageId = page.id
      setCreatedPages((prev) => new Map(prev).set(dateStr, pageId as string))
      setPageMap((prev) => new Map(prev).set(dateStr, pageId as string))
    }

    // Create an empty child block under the daily page
    await createBlock({
      blockType: 'content',
      content: '',
      parentId: pageId,
    })

    // Refresh BlockTree to pick up the new block
    await load(pageId)
  }

  return (
    <div className="space-y-6">
      {/* Loading indicator on initial fetch */}
      {loading && (
        <div className="space-y-1" data-testid="loading-skeleton">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-8 w-full rounded-lg" />
        </div>
      )}

      {/* Day sections */}
      {!loading &&
        dayEntries.map((entry) => {
          const isToday = entry.dateStr === todayStr
          return (
            <section key={entry.dateStr} aria-label={`Journal for ${entry.displayDate}`}>
              {/* Day header */}
              {isToday ? (
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-base font-medium">{entry.displayDate}</h2>
                  {entry.pageId && onNavigateToPage && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Open ${entry.dateStr} in editor`}
                      onClick={() => onNavigateToPage(entry.pageId as string, entry.dateStr)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-medium text-muted-foreground">{entry.displayDate}</h3>
                  {entry.pageId && onNavigateToPage && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Open ${entry.dateStr} in editor`}
                      onClick={() => onNavigateToPage(entry.pageId as string, entry.dateStr)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              )}

              {/* Block tree — delegates all block rendering to BlockTree */}
              {entry.pageId && <BlockTree parentId={entry.pageId} />}

              {/* Empty state — no daily page for this date */}
              {!entry.pageId && (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  <Calendar className="mx-auto mb-2 h-5 w-5" />
                  No blocks for {entry.dateStr}.
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-3 mx-auto flex items-center gap-1"
                    onClick={() => handleAddBlock(entry.dateStr)}
                  >
                    <Plus className="h-4 w-4" />
                    Add your first block
                  </Button>
                </div>
              )}

              {/* Add block button for this day */}
              <div className="mt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => handleAddBlock(entry.dateStr)}
                >
                  <Plus className="h-4 w-4" />
                  Add block
                </Button>
              </div>
            </section>
          )
        })}

      {/* Load more button */}
      {!loading && (
        <div className="flex justify-center pb-4">
          <Button variant="outline" size="sm" onClick={handleLoadMore}>
            <ChevronDown className="h-4 w-4 mr-1" />
            Load older days
          </Button>
        </div>
      )}
    </div>
  )
}
