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
import { usePageDeleteAction } from '@/hooks/usePageDeleteAction'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { cn } from '@/lib/utils'

import { getSourceColor, getSourceLabel } from '../../lib/date-property-colors'
import type { DayEntry } from '../../lib/date-utils'
import { formatDate } from '../../lib/date-utils'
import type { JournalMode } from '../../stores/journal'
import { useJournalStore } from '../../stores/journal'
import { PageBlockStoreProvider } from '../../stores/page-blocks'

interface DaySectionProps {
  entry: DayEntry
  headingLevel?: ('h2' | 'h3') | undefined
  hideHeading?: boolean | undefined
  compact?: boolean | undefined
  mode: JournalMode
  agendaCounts?: Record<string, number> | undefined
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

// oxlint-disable-next-line eslint/complexity -- cognitive complexity 26 (max 25). DaySection already orchestrates many props (lazy mount, navigation, focus restoration, agenda counts); refactoring out would require pulling several inter-dependent useEffects apart for one point over.
function DaySectionInner({
  entry,
  headingLevel = 'h3',
  hideHeading = false,
  compact = false,
  mode,
  agendaCounts: _agendaCounts = {},
  agendaCountsBySource = {},
  backlinkCounts = {},
  onNavigateToPage,
  onAddBlock,
  lazyMount = false,
}: DaySectionProps): React.ReactElement {
  const { t } = useTranslation()
  const navigateToDate = useJournalStore((s) => s.navigateToDate)
  const goToDateAndPanel = useJournalStore((s) => s.goToDateAndPanel)
  const todayStr = formatDate(new Date())
  const isToday = entry.dateStr === todayStr
  const Heading = headingLevel === 'h2' ? 'h2' : 'h3'
  const isClickable = mode !== 'daily'

  // PEND-68 Part A — page-delete flow (confirm dialog → IPC → success
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
          title: t('journal.deleteDayTitle', { date: entry.displayDate }),
          description: t('journal.deleteDayDescription'),
        },
      })
    },
    [entry.displayDate, requestDelete, t],
  )

  // Lazy-mount the BlockTree only when (a) the caller opted in via
  // `lazyMount` and (b) reduced-motion is NOT requested. Reduced-motion
  // users get eager mount to avoid the one-frame placeholder→tree swap
  // that would otherwise be visible during scroll. `usePrefersReducedMotion`
  // reads matchMedia once on mount and subscribes to changes, so the value
  // is not re-evaluated in this render body on every WeeklyView re-render.
  const prefersReducedMotion = usePrefersReducedMotion()
  const shouldLazyMount = lazyMount && !prefersReducedMotion
  const [hasEntered, lazyRef] = useEnteredViewport(shouldLazyMount)

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
          {/* PEND-68 Part A — star + delete affordance next to the
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
          {/* PEND-68 Part A — same affordance for daily mode (hideHeading). */}
          <PageQuickActions
            pageId={entry.pageId}
            title={entry.displayDate}
            variant="journal"
            deleting={isDeletingThisDay}
            onDeleteRequest={handleRequestDayDelete}
          />
        </div>
      )}
      {/* Single delete-confirm dialog (PEND-68 Part A) — both header
          branches above route through `usePageDeleteAction.requestDelete`. */}
      {deleteConfirmDialog}

      {entry.pageId &&
        (shouldLazyMount && !hasEntered ? (
          <div
            ref={lazyRef}
            data-testid="day-section-lazy-placeholder"
            data-date={entry.dateStr}
            style={{ minHeight: LAZY_PLACEHOLDER_MIN_HEIGHT }}
            aria-hidden="true"
          />
        ) : (
          <PageBlockStoreProvider pageId={entry.pageId}>
            <BlockTree
              parentId={entry.pageId}
              onNavigateToPage={onNavigateToPage}
              autoCreateFirstBlock={mode === 'daily'}
            />
          </PageBlockStoreProvider>
        ))}

      {/* DuePanel + DonePanel are date-keyed agenda queries — they
          render in daily mode for any day regardless of whether a
          journal page exists for that day (BUG-48 follow-up: the
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
