/**
 * PageSourceChanges — what the *Edit as Markdown* buffer changed in the page's
 * markdown, a line at a time (#5160): each hunk's removed lines, then its
 * added ones, with the words that changed in a removed line and the added line
 * paired with it marked, between up to `CONTEXT` unchanged lines either side.
 * A `−` or `+` gutter and a screen-reader label carry what the colour does.
 * The words are diffed here, so only while the view is open.
 */

import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { diffWords, type LineDiff, type Segment } from '@/lib/line-diff'
import { cn } from '@/lib/utils'

const CONTEXT = 3

type Row =
  | { kind: 'same'; text: string }
  | { kind: 'skipped'; count: number }
  | { kind: 'removed' | 'added'; segments: Segment[] }

const whole = (text: string): Segment[] => [{ text, changed: false }]

/** The unchanged lines `[from, to)` of `lines`, the middle of a long run folded. */
function contextRows(lines: string[], from: number, to: number, first: boolean, last: boolean) {
  const keepHead = first ? 0 : CONTEXT
  const keepTail = last ? 0 : CONTEXT
  const rows: Row[] = []
  if (to - from <= keepHead + keepTail + 1) {
    for (let i = from; i < to; i += 1) rows.push({ kind: 'same', text: lines[i] as string })
    return rows
  }
  for (let i = from; i < from + keepHead; i += 1)
    rows.push({ kind: 'same', text: lines[i] as string })
  rows.push({ kind: 'skipped', count: to - from - keepHead - keepTail })
  for (let i = to - keepTail; i < to; i += 1) rows.push({ kind: 'same', text: lines[i] as string })
  return rows
}

export function changeRows({ after, hunks }: LineDiff): Row[] {
  const rows: Row[] = []
  let at = 0
  hunks.forEach((hunk, h) => {
    rows.push(...contextRows(after, at, hunk.afterStart, h === 0, false))
    const removed: Row[] = hunk.removed.map((text) => ({ kind: 'removed', segments: whole(text) }))
    const added: Row[] = hunk.added.map((text) => ({ kind: 'added', segments: whole(text) }))
    for (let i = 0; i < Math.min(removed.length, added.length); i += 1) {
      const [before, now] = diffWords(hunk.removed[i] as string, hunk.added[i] as string)
      removed[i] = { kind: 'removed', segments: before }
      added[i] = { kind: 'added', segments: now }
    }
    rows.push(...removed, ...added)
    at = hunk.afterStart + hunk.added.length
  })
  rows.push(...contextRows(after, at, after.length, hunks.length === 0, true))
  return rows
}

const GUTTER = { same: ' ', removed: '−', added: '+' } as const

export function PageSourceChanges({ diff }: { diff: LineDiff }): React.ReactElement {
  const { t } = useTranslation()
  const rows = useMemo(() => changeRows(diff), [diff])

  if (diff.hunks.length === 0) {
    return <EmptyState compact headingLevel="p" message={t('pageSource.noChanges')} />
  }

  return (
    <section
      aria-label={t('pageSource.changes')}
      data-testid="page-source-changes"
      className="min-h-[50vh] overflow-hidden rounded-md border border-input py-1 font-mono text-sm"
    >
      {rows.map((row, i) => {
        const key = i
        if (row.kind === 'skipped') {
          return (
            <div key={key} className="bg-muted px-3 py-0.5 text-xs text-muted-foreground">
              {t('pageSource.unchangedLines', { count: row.count })}
            </div>
          )
        }
        const segments = row.kind === 'same' ? whole(row.text) : row.segments
        return (
          <div
            key={key}
            data-change={row.kind === 'same' ? undefined : row.kind}
            className={cn(
              'flex min-h-6 leading-6',
              row.kind === 'removed' && 'bg-destructive/10',
              row.kind === 'added' && 'bg-status-done/60',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'w-6 shrink-0 text-center select-none',
                row.kind === 'removed' && 'text-destructive',
                row.kind === 'added' && 'text-status-done-foreground',
              )}
            >
              {GUTTER[row.kind]}
            </span>
            <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap">
              {row.kind !== 'same' && (
                <span className="sr-only">
                  {`${t(row.kind === 'added' ? 'pageSource.changeAdded' : 'pageSource.changeRemoved')} `}
                </span>
              )}
              {segments.map((segment, j) =>
                segment.changed ? (
                  <mark
                    // oxlint-disable-next-line react/no-array-index-key -- a line's segments are rebuilt with it
                    key={j}
                    className={cn(
                      'rounded-sm text-inherit',
                      row.kind === 'removed'
                        ? 'bg-destructive/25 line-through'
                        : 'bg-status-done-foreground/20 underline decoration-2 underline-offset-2',
                    )}
                  >
                    {segment.text}
                  </mark>
                ) : (
                  // oxlint-disable-next-line react/no-array-index-key -- a line's segments are rebuilt with it
                  <span key={j}>{segment.text}</span>
                ),
              )}
            </span>
          </div>
        )
      })}
    </section>
  )
}
