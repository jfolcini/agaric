/**
 * StreamView — continuous infinite-scroll journal stream (#1415).
 *
 * A single chronological column of daily date pages, today pinned at the
 * top, older days appended below as the user scrolls toward the bottom
 * (Logseq-style). An alternative surface alongside the daily/weekly/monthly
 * /agenda modes — it never replaces them.
 *
 * Loading: `useStreamDates` owns the windowed date list (today → oldest)
 * and the `dateStr → pageId` map for that window. A sentinel element at the
 * bottom of the column is watched by an IntersectionObserver; when it nears
 * the viewport we call `loadOlder()`, which extends the window one batch
 * further into the past and refetches the page map for the wider span.
 *
 * Virtualization: every day renders through `DaySection` with `lazyMount`
 * enabled, so a day's heavy `BlockTree` (one TipTap editor + ~10
 * document-level keydown listeners, see `useBlockTreeKeyboardShortcuts`) is
 * only mounted once it enters the viewport — the same IntersectionObserver
 * mechanism the weekly view relies on (perf-review Tier 2 item 7). Unlike
 * the weekly view (fixed at 7 days), the stream's day count is bounded only
 * by `MIN_JOURNAL_DATE` — the entire journal history — so without a further
 * bound, a long backward-scrolling session would accumulate an unbounded
 * number of live editors and listeners (#2670).
 *
 * Mount window (#2670): `useDayMountWindow` caps the mounted-day set at
 * `STREAM_MOUNT_WINDOW` (the ~10 days nearest the current scroll position)
 * via an LRU. Visiting a new day beyond the cap evicts the least-recently-
 * visible day back to the same height-preserving placeholder `DaySection`
 * already uses pre-entry, releasing its `BlockTree` (and that tree's
 * document listeners, via normal effect cleanup) — instead of the old
 * one-shot-forever gate. A day with focus inside it is protected from
 * eviction (`canEvictDay` below) so scrolling away mid-edit doesn't silently
 * drop the cursor; scrolling back to an evicted day remounts it.
 *
 * Empty days: a date with no journal page yet renders its date heading plus
 * the shared `DaySection` empty state (an "Add first block" CTA that creates
 * the page on demand) — identical to how the daily/weekly surfaces present a
 * fresh day.
 */

import type React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { DaySection } from '@/components/journal/DaySection'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { useDayMountWindow } from '@/hooks/useDayMountWindow'
import { useJournalBlockCreation } from '@/hooks/useJournalBlockCreation'
import { useJournalDateFormat } from '@/hooks/useJournalDateFormat'
import { STREAM_BATCH_DAYS, useStreamDates } from '@/hooks/useStreamDates'
import type { DayEntry } from '@/lib/date-utils'
import { formatDate, formatJournalTitle } from '@/lib/date-utils'

interface StreamViewProps {
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
}

/**
 * Protects a day from eviction (#2670) when it currently has DOM focus
 * inside it — unmounting a day mid-edit would silently drop the cursor.
 * Reuses `DaySection`'s existing `id={`journal-${dateStr}`}` on the day's
 * `<section>` (no new element/id introduced). Guarded for non-DOM
 * environments (SSR) even though StreamView is client-only today.
 */
function canEvictDay(dateStr: string): boolean {
  if (typeof document === 'undefined') return true
  const el = document.getElementById(`journal-${dateStr}`)
  return !(el && document.activeElement && el.contains(document.activeElement))
}

export function StreamView({ onNavigateToPage }: StreamViewProps): React.ReactElement {
  const { t } = useTranslation()
  const { journalDateFormat } = useJournalDateFormat()
  const { dates, pageMap, loading, loadingOlder, reachedEnd, loadOlder, addPage } = useStreamDates()

  const { createdPages, handleAddBlock } = useJournalBlockCreation({
    pageMap,
    onPageCreated: addPage,
  })

  // Bounds the mounted-day set to STREAM_MOUNT_WINDOW nearest the current
  // scroll position (#2670) — see the file header and useDayMountWindow's
  // doc comment for the full rationale.
  const mountWindow = useDayMountWindow({ canEvict: canEvictDay })

  const makeDayEntry = useCallback(
    (d: Date): DayEntry => {
      // `dateStr` is the canonical ISO identity/lookup key (see JournalPage):
      // it MUST stay ISO regardless of the display-format preference, which
      // only governs the rendered `displayDate`.
      const dateStr = formatDate(d)
      return {
        date: d,
        dateStr,
        displayDate: formatJournalTitle(dateStr, journalDateFormat),
        pageId: createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null,
      }
    },
    [pageMap, createdPages, journalDateFormat],
  )

  const entries = useMemo(() => dates.map(makeDayEntry), [dates, makeDayEntry])
  const todayStr = formatDate(new Date())

  // ── Infinite-scroll sentinel ──────────────────────────────────────
  // A zero-height marker just below the last rendered day. When it enters
  // (or nears, via rootMargin) the viewport, reveal another batch. The
  // observer is re-created when the load callback or terminal state flips;
  // it self-disables once we reach MIN_JOURNAL_DATE.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // Latest loadOlder in a ref so the observer callback never goes stale
  // without forcing the observer to tear down on every page-map change.
  const loadOlderRef = useRef(loadOlder)
  loadOlderRef.current = loadOlder
  const loadingOlderRef = useRef(loadingOlder)
  loadingOlderRef.current = loadingOlder

  useEffect(() => {
    if (loading || reachedEnd) return
    const el = sentinelRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (obsEntries) => {
        for (const e of obsEntries) {
          if (e.isIntersecting && !loadingOlderRef.current) {
            loadOlderRef.current()
            return
          }
        }
      },
      // Pre-fetch one viewport's worth ahead so the spinner rarely shows.
      { rootMargin: '600px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loading, reachedEnd])

  if (loading) {
    return (
      <div data-testid="stream-loading">
        <LoadingSkeleton count={3} height="h-10" loading data-testid="loading-skeleton" />
      </div>
    )
  }

  return (
    <div className="space-y-1" data-testid="journal-stream" aria-label={t('journal.streamView')}>
      {entries.map((entry, i) => {
        const isToday = entry.dateStr === todayStr
        return (
          <div key={entry.dateStr}>
            {i > 0 && <div className="border-t border-border my-4" />}
            <DaySection
              entry={entry}
              headingLevel={isToday ? 'h2' : 'h3'}
              compact
              mode="stream"
              onNavigateToPage={onNavigateToPage}
              onAddBlock={handleAddBlock}
              lazyMount
              mountWindow={mountWindow}
            />
          </div>
        )
      })}

      {/* Sentinel — drives the next older batch. Kept in the tree (not
          gated on `reachedEnd`) so layout stays stable; the observer
          simply stops observing once the horizon is reached. */}
      {!reachedEnd && (
        <div
          ref={sentinelRef}
          data-testid="stream-sentinel"
          aria-hidden="true"
          style={{ height: 1 }}
        />
      )}

      {loadingOlder && (
        <div data-testid="stream-loading-older" className="py-2">
          <LoadingSkeleton count={STREAM_BATCH_DAYS > 6 ? 3 : 2} height="h-8" loading />
        </div>
      )}

      {reachedEnd && (
        <p className="py-4 text-center text-xs text-muted-foreground" data-testid="stream-end">
          {t('journal.streamReachedStart')}
        </p>
      )}
    </div>
  )
}
