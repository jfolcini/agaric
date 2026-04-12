/**
 * DaySection — renders a single day within the journal.
 *
 * Shared by DailyView, WeeklyView, and MonthlyView.
 */

import { Calendar as CalendarIcon, ExternalLink, Plus } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getSourceColor, getSourceLabel } from '../../lib/date-property-colors'
import type { DayEntry } from '../../lib/date-utils'
import { formatDate } from '../../lib/date-utils'
import type { JournalMode } from '../../stores/journal'
import { useJournalStore } from '../../stores/journal'
import { PageBlockStoreProvider } from '../../stores/page-blocks'
import { AddBlockButton } from '../AddBlockButton'
import { BlockTree } from '../BlockTree'
import { DonePanel } from '../DonePanel'
import { DuePanel } from '../DuePanel'
import { EmptyState } from '../EmptyState'
import { LinkedReferences } from '../LinkedReferences'

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
}

export function DaySection({
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
}: DaySectionProps): React.ReactElement {
  const { t } = useTranslation()
  const navigateToDate = useJournalStore((s) => s.navigateToDate)
  const goToDateAndPanel = useJournalStore((s) => s.goToDateAndPanel)
  const todayStr = formatDate(new Date())
  const isToday = entry.dateStr === todayStr
  const Heading = headingLevel === 'h2' ? 'h2' : 'h3'
  const isClickable = mode !== 'daily'

  return (
    <section
      id={`journal-${entry.dateStr}`}
      aria-label={t('journal.dayAriaLabel', { date: entry.displayDate })}
      className={cn(isToday && 'bg-accent/[0.08] border-l-2 border-accent px-3 py-2 -mx-3')}
    >
      {/* Day heading — hidden in daily mode since header shows the date */}
      {!hideHeading && (
        <div className="flex items-center gap-2 mb-2">
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
                aria-label={`Go to daily view for ${entry.displayDate}`}
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
                    aria-label={`${count} ${label} items, click to view`}
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
                  aria-label={`${backlinkCounts[entry.pageId]} references, click to view`}
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
              aria-label={`Open ${entry.dateStr} in editor`}
              onClick={() => onNavigateToPage(entry.pageId as string, entry.dateStr)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
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
        </div>
      )}

      {entry.pageId && (
        <PageBlockStoreProvider pageId={entry.pageId}>
          <BlockTree
            parentId={entry.pageId}
            onNavigateToPage={onNavigateToPage}
            autoCreateFirstBlock={mode === 'daily'}
          />
        </PageBlockStoreProvider>
      )}

      {/* DuePanel + LinkedReferences + DonePanel — only in daily mode */}
      {mode === 'daily' && entry.pageId && (
        <>
          <div id="journal-due-panel">
            <DuePanel date={entry.dateStr} onNavigateToPage={onNavigateToPage} />
          </div>
          <div id="journal-references-panel">
            <LinkedReferences pageId={entry.pageId} onNavigateToPage={onNavigateToPage} />
          </div>
          <div id="journal-done-panel">
            <DonePanel date={entry.dateStr} onNavigateToPage={onNavigateToPage} />
          </div>
        </>
      )}

      {/* Empty state: compact for multi-day views, full for daily */}
      {!entry.pageId &&
        (compact ? (
          <button
            type="button"
            className="w-full rounded-md border border-dashed px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent/50 active:bg-accent/70 transition-colors"
            onClick={() => onAddBlock(entry.dateStr)}
          >
            <Plus className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
            {t('action.addBlock')}
          </button>
        ) : (
          <EmptyState
            icon={CalendarIcon}
            message={t('journal.noBlocks', { date: entry.displayDate })}
            compact
            action={
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 mx-auto flex items-center gap-1"
                onClick={() => onAddBlock(entry.dateStr)}
              >
                <Plus className="h-4 w-4" />
                {t('journal.addFirstBlock')}
              </Button>
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
