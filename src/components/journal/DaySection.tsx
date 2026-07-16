/**
 * DaySection — renders a single day within the journal.
 *
 * Shared by DailyView, WeeklyView, and MonthlyView.
 */

import { Calendar as CalendarIcon, ExternalLink, Plus } from 'lucide-react'
import type React from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DonePanel } from '@/components/agenda/DonePanel'
import { DuePanel } from '@/components/agenda/DuePanel'
import { LinkedReferences } from '@/components/backlinks/LinkedReferences'
import { EmptyState } from '@/components/common/EmptyState'
import { AddBlockButton } from '@/components/editor/AddBlockButton'
import { BlockTree } from '@/components/editor/BlockTree'
import { PageQuickActions } from '@/components/pages/PageQuickActions'
import { Button } from '@/components/ui/button'
import type { DayMountWindow } from '@/hooks/useDayMountWindow'
import { usePageDeleteAction } from '@/hooks/usePageDeleteAction'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { getSourceColor, getSourceLabel } from '@/lib/date-property-colors'
import type { DayEntry } from '@/lib/date-utils'
import { formatDate } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import type { JournalMode } from '@/stores/journal'
import { useJournalStore } from '@/stores/journal'
import { PageBlockStoreProvider } from '@/stores/page-blocks'

/** Stable empty-map defaults so optional count props don't re-create `{}` each render. */
const EMPTY_COUNTS: Record<string, number> = {}
const EMPTY_COUNTS_BY_SOURCE: Record<string, Record<string, number>> = {}

interface DaySectionProps {
  entry: DayEntry
  headingLevel?: ('h2' | 'h3') | undefined
  hideHeading?: boolean | undefined
  compact?: boolean | undefined
  mode: JournalMode
  agendaCountsBySource?: Record<string, Record<string, number>> | undefined
  backlinkCounts?: Record<string, number> | undefined
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
  onAddBlock: (dateStr: string) => void
  /**
   * When `true`, defer mounting the heavy `BlockTree` (and its
   * `PageBlockStoreProvider`) until the section enters the viewport.
   * Used by `WeeklyView` to avoid mounting 7 BlockTrees up-front when
   * only 2-3 are visible (perf-review Tier 2 item 7). Once mounted, the
   * tree stays mounted to avoid re-spawn churn on quick scroll. Honours
   * `prefers-reduced-motion: reduce` by eagerly mounting (avoids the
   * one-frame placeholder swap for motion-sensitive users). Defaults to
   * `false` — `DailyView` (single day) and tests render eagerly.
   */
  lazyMount?: boolean | undefined
  /**
   * External LRU mount-window controller (`useDayMountWindow`, #2670). When
   * provided, this REPLACES the self-managed one-shot `hasEntered` state
   * below: mount state comes from `mountWindow.isMounted(entry.dateStr)`,
   * and the section reports EVERY viewport entry (not just the first) via
   * `mountWindow.markVisible` so the caller's LRU can track recency and
   * evict the farthest days back to this same placeholder — bounding the
   * TipTap-editor + document-listener count an unbounded infinite scroll
   * would otherwise accumulate. Used by `StreamView`; `WeeklyView` and
   * `MonthlyView` leave this `undefined` and keep the original
   * mount-forever-once-entered behavior (their day count is already fixed,
   * see file header). Only meaningful when `lazyMount` is also `true`.
   */
  mountWindow?: DayMountWindow | undefined
}

/** Placeholder min-height while a lazy day waits to enter the viewport. */
const LAZY_PLACEHOLDER_MIN_HEIGHT = 200

/**
 * One-shot intersection observer: returns `true` once the element has
 * been intersected, then stays `true` (no flip-back) so a brief scroll
 * away from a mounted day doesn't tear down the tree. Disabled when
 * `enabled === false` (eager-mount path).
 */
function useEnteredViewport(
  enabled: boolean,
  rootMargin = '200px 0px',
): [boolean, React.RefObject<HTMLDivElement | null>] {
  const [entered, setEntered] = useState(!enabled)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!enabled || entered) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // Defensive: jsdom/older runtimes — eagerly mark as entered.
      setEntered(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setEntered(true)
            observer.disconnect()
            return
          }
        }
      },
      { rootMargin },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [enabled, entered, rootMargin])

  return [entered, ref]
}

/**
 * Same one-shot-while-not-entered observer shape as `useEnteredViewport`
 * above, but reports every transition into view via `onEnter` instead of
 * owning local state (#2670). Used by the `mountWindow`-controlled path,
 * where "entered" comes from the caller's LRU (`mountWindow.isMounted`), not
 * local state — so a day that scrolls back into view AFTER being evicted can
 * re-trigger a remount. Only observes while `!hasEntered` (mirrors the
 * self-managed hook: no need to keep watching an already-mounted day — a day
 * can only be evicted after `windowSize` OTHER distinct days have been
 * visited, which requires it to already be well outside the viewport, so a
 * single "entered" report per unmounted phase is enough — see
 * `useDayMountWindow`'s doc comment). Re-arms (creates a fresh observer)
 * whenever `hasEntered` flips back to `false`, i.e. right after eviction.
 */
function useControlledViewportEntry(
  enabled: boolean,
  hasEntered: boolean,
  onEnter: () => void,
  rootMargin = '200px 0px',
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  const onEnterRef = useRef(onEnter)
  onEnterRef.current = onEnter

  useEffect(() => {
    if (!enabled || hasEntered) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // Defensive: jsdom/older runtimes — report entered immediately.
      onEnterRef.current()
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onEnterRef.current()
            return
          }
        }
      },
      { rootMargin },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [enabled, hasEntered, rootMargin])

  return ref
}

// oxlint-disable-next-line eslint/complexity -- cognitive complexity 26 (max 25). DaySection already orchestrates many props (lazy mount, navigation, focus restoration, agenda counts); refactoring out would require pulling several inter-dependent useEffects apart for one point over.
function DaySectionInner({
  entry,
  headingLevel = 'h3',
  hideHeading = false,
  compact = false,
  mode,
  agendaCountsBySource = EMPTY_COUNTS_BY_SOURCE,
  backlinkCounts = EMPTY_COUNTS,
  onNavigateToPage,
  onAddBlock,
  lazyMount = false,
  mountWindow,
}: DaySectionProps): React.ReactElement {
  const { t } = useTranslation()
  const navigateToDate = useJournalStore((s) => s.navigateToDate)
  const goToDateAndPanel = useJournalStore((s) => s.goToDateAndPanel)
  const todayStr = formatDate(new Date())
  const isToday = entry.dateStr === todayStr
  const Heading = headingLevel === 'h2' ? 'h2' : 'h3'
  const isClickable = mode !== 'daily'

  // Part A — page-delete flow (confirm dialog → IPC → success
  // toast with Undo). The journal uses higher-stakes copy
  // ("Delete the note for {{date}}?") because a daily note is a
  // distinguished entry, not just another page.
  const { requestDelete, deletingId, confirmDialog: deleteConfirmDialog } = usePageDeleteAction()
  const dayPageId = entry.pageId
  const isDeletingThisDay = dayPageId != null && deletingId === dayPageId

  const handleRequestDayDelete = useCallback(
    (pageId: string) => {
      requestDelete(pageId, entry.displayDate, {
        confirmCopy: {
          titleKey: 'journal.deleteDayTitle',
          descriptionKey: 'journal.deleteDayDescription',
          values: { date: entry.displayDate },
        },
      })
    },
    [entry.displayDate, requestDelete],
  )

  // Lazy-mount the BlockTree only when (a) the caller opted in via
  // `lazyMount` and (b) reduced-motion is NOT requested. Reduced-motion
  // users get eager mount to avoid the one-frame placeholder→tree swap
  // that would otherwise be visible during scroll. `usePrefersReducedMotion`
  // reads matchMedia once on mount and subscribes to changes, so the value
  // is not re-evaluated in this render body on every WeeklyView re-render.
  const prefersReducedMotion = usePrefersReducedMotion()
  const shouldLazyMount = lazyMount && !prefersReducedMotion
  const isWindowControlled = shouldLazyMount && mountWindow != null

  // Self-managed one-shot path (WeeklyView/MonthlyView, no `mountWindow`) —
  // unchanged from before #2670.
  const [selfEntered, selfLazyRef] = useEnteredViewport(shouldLazyMount && !isWindowControlled)

  // Externally-controlled LRU path (StreamView, #2670): mount state comes
  // from the caller's window, and every entry (not just the first) reports
  // back so a day evicted by the LRU can remount when scrolled back to.
  const controlledEntered = isWindowControlled
    ? (mountWindow?.isMounted(entry.dateStr) ?? false)
    : false
  const handleControlledEnter = useCallback(() => {
    mountWindow?.markVisible(entry.dateStr)
  }, [mountWindow, entry.dateStr])
  const controlledRef = useControlledViewportEntry(
    isWindowControlled,
    controlledEntered,
    handleControlledEnter,
  )

  const hasEntered = isWindowControlled ? controlledEntered : selfEntered
  const lazyRef = isWindowControlled ? controlledRef : selfLazyRef

  // Last-measured rendered height of the mounted BlockTree content, kept in
  // a ref (not state — no re-render needed) so that when the mount-window
  // LRU evicts this day back to the placeholder, the placeholder reuses the
  // day's REAL height instead of the generic `LAZY_PLACEHOLDER_MIN_HEIGHT`
  // (#2670 follow-up: the fixed-height placeholder was correct for the
  // pre-entry state — nothing has been rendered yet, so there's no real
  // height to preserve — but reusing it verbatim for a day that WAS already
  // rendered, possibly far taller than 200px, shrinks the document above
  // the viewport and shifts scroll position; `useStreamDates`'s file header
  // explicitly notes the stream's append-only design was chosen so it would
  // never need "scroll-anchoring math" — eviction reintroduces exactly that
  // need, so we preserve height here instead of relying on browser
  // scroll-anchoring heuristics). Only tracked on the window-controlled path
  // — the self-managed path never unmounts once entered, so there is
  // nothing to preserve there.
  const measuredHeightRef = useRef<number | undefined>(undefined)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isWindowControlled || !hasEntered) return
    const el = contentRef.current
    if (!el) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) measuredHeightRef.current = box.height
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [isWindowControlled, hasEntered])

  return (
    <section
      id={`journal-${entry.dateStr}`}
      aria-label={t('journal.dayAriaLabel', { date: entry.displayDate })}
      // NO bare `group` here. Tailwind's `group-hover:` matches ANY ancestor
      // carrying the literal `group` class, not just the nearest one. Each
      // block row is itself `.sortable-block.group` and reveals its gutter
      // controls on `group-hover`; a `group` on this section (an ancestor of
      // every row) made hovering anywhere in the day reveal EVERY row's gutter
      // controls at once (#1243). The section-level group is also unnecessary:
      // `PageQuickActions variant="journal"` is `hoverReveal: false` (always
      // visible), so nothing depended on it.
      className={cn(isToday && 'bg-accent/[0.08] px-3 py-2 -mx-3')}
    >
      {/* Day heading — hidden in daily mode since header shows the date */}
      {!hideHeading && (
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Heading
            className={cn(
              headingLevel === 'h2'
                ? 'text-base font-medium'
                : 'text-sm font-medium text-muted-foreground',
              isToday && headingLevel === 'h3' && 'text-foreground',
            )}
          >
            {isClickable ? (
              <button
                type="button"
                className="hover:text-primary hover:underline underline-offset-2 cursor-pointer transition-colors"
                onClick={() => navigateToDate(entry.date, 'daily')}
                aria-label={t('journal.goToDailyView', { date: entry.displayDate })}
              >
                {entry.displayDate}
              </button>
            ) : (
              entry.displayDate
            )}
            {isToday && (
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                ({t('journal.today')})
              </span>
            )}
          </Heading>
          {/* Count badges for weekly/monthly modes */}
          {mode !== 'daily' && mode !== 'agenda' && (
            <>
              {Object.entries(agendaCountsBySource[entry.dateStr] ?? {}).map(([source, count]) => {
                const color = getSourceColor(source)
                const label = getSourceLabel(source)
                const displayCount = count > 99 ? '99+' : count
                return (
                  <button
                    key={source}
                    type="button"
                    className={cn(
                      'inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium',
                      color.light,
                      color.dark,
                      'hover:opacity-80',
                    )}
                    onClick={() => goToDateAndPanel(entry.date, 'due')}
                    aria-label={t('journal.agendaCountBadge', { count, label })}
                  >
                    {displayCount} {label}
                  </button>
                )
              })}
              {entry.pageId && (backlinkCounts[entry.pageId] ?? 0) > 0 && (
                <button
                  type="button"
                  className="inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 active:bg-primary/30"
                  onClick={() => goToDateAndPanel(entry.date, 'references')}
                  aria-label={t('journal.backlinkCountBadge', {
                    count: backlinkCounts[entry.pageId],
                  })}
                >
                  {(backlinkCounts[entry.pageId] ?? 0) > 99 ? '99+' : backlinkCounts[entry.pageId]}{' '}
                  {t('journal.refsBadge')}
                </button>
              )}
            </>
          )}
          {entry.pageId && onNavigateToPage && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('journal.openInEditorLabel', { date: entry.dateStr })}
              onClick={() => onNavigateToPage(entry.pageId as string, entry.dateStr)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          {/*  Part A — star + delete affordance next to the
              "open in editor" button. Guarded on `entry.pageId` so the
              auto-create placeholder day (no note yet) doesn't show
              destructive controls. Hover-reveal on desktop, always-
              visible on touch (handled inside PageQuickActions). */}
          {entry.pageId && (
            <PageQuickActions
              pageId={entry.pageId}
              title={entry.displayDate}
              variant="journal"
              deleting={isDeletingThisDay}
              onDeleteRequest={handleRequestDayDelete}
            />
          )}
        </div>
      )}
      {/* In daily mode (heading hidden), still show the "open in editor" link */}
      {hideHeading && entry.pageId && onNavigateToPage && (
        <div className="flex items-center gap-2 mb-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            aria-label={`Open ${entry.dateStr} in editor`}
            onClick={() => onNavigateToPage(entry.pageId as string, entry.dateStr)}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1" />
            {t('journal.openInEditor')}
          </Button>
          {/*  Part A — same affordance for daily mode (hideHeading). */}
          <PageQuickActions
            pageId={entry.pageId}
            title={entry.displayDate}
            variant="journal"
            deleting={isDeletingThisDay}
            onDeleteRequest={handleRequestDayDelete}
          />
        </div>
      )}
      {/* Single delete-confirm dialog (Part A) — both header
          branches above route through `usePageDeleteAction.requestDelete`. */}
      {deleteConfirmDialog}

      {entry.pageId &&
        (shouldLazyMount && !hasEntered ? (
          <div
            ref={lazyRef}
            data-testid="day-section-lazy-placeholder"
            data-date={entry.dateStr}
            style={{ minHeight: measuredHeightRef.current ?? LAZY_PLACEHOLDER_MIN_HEIGHT }}
            aria-hidden="true"
          />
        ) : (
          <div ref={contentRef}>
            <PageBlockStoreProvider pageId={entry.pageId}>
              <BlockTree
                parentId={entry.pageId}
                onNavigateToPage={onNavigateToPage}
                autoCreateFirstBlock={mode === 'daily'}
              />
            </PageBlockStoreProvider>
          </div>
        ))}

      {/* DuePanel + DonePanel are date-keyed agenda queries — they
          render in daily mode for any day regardless of whether a
          journal page exists for that day (follow-up: the
          journal page is no longer auto-created for past navigation,
          so gating these on `entry.pageId` would silently hide overdue
          tasks for past days).

          LinkedReferences is page-keyed (backlinks into this page) so
          stays gated on `entry.pageId` — there are no backlinks to a
          page that doesn't exist. */}
      {mode === 'daily' && (
        <>
          <div id="journal-due-panel">
            <DuePanel
              date={entry.dateStr}
              onNavigateToPage={onNavigateToPage}
              excludePageId={entry.pageId ?? undefined}
            />
          </div>
          {entry.pageId && (
            <div id="journal-references-panel">
              <LinkedReferences pageId={entry.pageId} onNavigateToPage={onNavigateToPage} />
            </div>
          )}
          <div id="journal-done-panel">
            <DonePanel
              date={entry.dateStr}
              onNavigateToPage={onNavigateToPage}
              excludePageId={entry.pageId ?? undefined}
            />
          </div>
        </>
      )}

      {/* Empty state: compact for multi-day views, full for daily */}
      {!entry.pageId &&
        (compact ? (
          <EmptyState
            compact
            message={t('agenda.day.empty', { date: entry.displayDate })}
            action={
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 mx-auto flex items-center gap-1"
                onClick={() => onAddBlock(entry.dateStr)}
              >
                <Plus className="h-4 w-4" />
                {t('agenda.day.addBlock')}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={CalendarIcon}
            message={t('journal.noBlocks', { date: entry.displayDate })}
            compact
            action={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3 mx-auto flex items-center gap-1"
                  onClick={() => onAddBlock(entry.dateStr)}
                >
                  <Plus className="h-4 w-4" />
                  {t('journal.addFirstBlock')}
                </Button>
                <p className="text-xs text-muted-foreground mt-2">{t('journal.emptyHint')}</p>
              </>
            }
          />
        ))}

      {/* "Add block" button — only shown when there IS content (otherwise the empty state has the CTA) */}
      {entry.pageId && (
        <div className="mt-1">
          <AddBlockButton onClick={() => onAddBlock(entry.dateStr)} />
        </div>
      )}
    </section>
  )
}

export const DaySection = memo(DaySectionInner)
DaySection.displayName = 'DaySection'
