import { ChevronDown, ChevronUp } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import type { DiffSpan } from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { renderRichContent } from './StaticBlock'

interface DiffDisplayProps {
  spans: DiffSpan[]
}

/** Threshold above which the diff is collapsed by default. */
const LARGE_DIFF_THRESHOLD = 500
/** Number of spans shown when the diff is collapsed. */
const COLLAPSED_SPAN_COUNT = 100

/**
 * Renders a word-level diff as inline colored spans.
 * Deletions are red with strikethrough, insertions green.
 * ULID tokens inside spans are resolved via renderRichContent().
 *
 * UX-265 sub-fix 5: when the diff has more than {@link LARGE_DIFF_THRESHOLD}
 * spans, the first {@link COLLAPSED_SPAN_COUNT} are shown by default and a
 * "Show full diff (N hidden)" button reveals the rest. Click the same button
 * (now "Collapse diff") to re-collapse.
 *
 * UX-275 sub-fix 1: the diff is wrapped in a labelled region and exposes
 * prev/next "hunk" navigation. A *hunk* is a maximal run of consecutive spans
 * whose `tag !== 'Equal'` — i.e. a contiguous patch of changes flanked by
 * unchanged context. Buttons step through hunks and `scrollIntoView` the
 * first span of the active hunk so large diffs are no longer one
 * impenetrable paragraph for keyboard / SR users.
 */
export function DiffDisplay({ spans }: DiffDisplayProps): React.ReactElement {
  const { t } = useTranslation()
  const richCallbacks = useRichContentCallbacks()
  const isLarge = spans.length > LARGE_DIFF_THRESHOLD
  const [expanded, setExpanded] = useState(false)
  const [currentHunk, setCurrentHunk] = useState(0)
  const spanRefs = useRef<Map<number, HTMLElement | null>>(new Map())

  const visibleSpans = isLarge && !expanded ? spans.slice(0, COLLAPSED_SPAN_COUNT) : spans
  const hiddenCount = spans.length - visibleSpans.length

  // Group consecutive non-Equal spans into hunks. Each hunk is the index of
  // its first span in `visibleSpans`. Recomputed when the visible slice
  // changes (collapse / expand toggles can shift hunk membership).
  const hunkStarts = useMemo(() => {
    const starts: number[] = []
    let inHunk = false
    for (let i = 0; i < visibleSpans.length; i++) {
      const span = visibleSpans[i]
      const isChange = span?.tag === 'Insert' || span?.tag === 'Delete'
      if (isChange && !inHunk) {
        starts.push(i)
        inHunk = true
      } else if (!isChange) {
        inHunk = false
      }
    }
    return starts
  }, [visibleSpans])

  const hasHunks = hunkStarts.length > 0
  const atFirstHunk = currentHunk <= 0
  const atLastHunk = currentHunk >= hunkStarts.length - 1

  const goToHunk = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(hunkStarts.length - 1, index))
      setCurrentHunk(clamped)
      const spanIndex = hunkStarts[clamped]
      if (spanIndex == null) return
      const el = spanRefs.current.get(spanIndex)
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    },
    [hunkStarts],
  )

  const handlePrevHunk = useCallback(() => {
    goToHunk(currentHunk - 1)
  }, [currentHunk, goToHunk])

  const handleNextHunk = useCallback(() => {
    goToHunk(currentHunk + 1)
  }, [currentHunk, goToHunk])

  if (spans.length === 0) {
    return <EmptyState compact message={t('history.diff.empty')} />
  }

  return (
    <div className="diff-display-wrapper">
      {/* biome-ignore lint/a11y/useSemanticElements: aria-label on a <div> region is intentional — diff content is a labelled landmark */}
      <div role="region" aria-label={t('diff.regionLabel')}>
        <p className="diff-display text-sm leading-relaxed whitespace-pre-wrap break-words m-0">
          {visibleSpans.map((span, i) => {
            const key = `${i}-${span.tag}`
            const content =
              renderRichContent(span.value, {
                interactive: false,
                ...richCallbacks,
              }) ?? span.value
            const isHunkStart = hunkStarts.includes(i)
            const refCallback = (el: HTMLElement | null) => {
              if (el) spanRefs.current.set(i, el)
              else spanRefs.current.delete(i)
            }
            switch (span.tag) {
              case 'Delete':
                return (
                  <del
                    key={key}
                    ref={refCallback}
                    data-hunk-start={isHunkStart || undefined}
                    className="bg-destructive/15 text-destructive no-underline line-through"
                  >
                    {content}
                  </del>
                )
              case 'Insert':
                return (
                  <ins
                    key={key}
                    ref={refCallback}
                    data-hunk-start={isHunkStart || undefined}
                    className="bg-status-done text-status-done-foreground no-underline"
                  >
                    {content}
                  </ins>
                )
              default:
                return (
                  <span key={key} ref={refCallback}>
                    {content}
                  </span>
                )
            }
          })}
        </p>
      </div>
      {hasHunks && (
        <div className="diff-hunk-nav mt-2 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="diff-hunk-prev px-2 text-xs"
            data-testid="diff-prev-hunk-btn"
            onClick={handlePrevHunk}
            disabled={atFirstHunk}
            aria-label={t('diff.prevHunk')}
          >
            <ChevronUp className="h-3.5 w-3.5" />
            {t('diff.prevHunk')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="diff-hunk-next px-2 text-xs"
            data-testid="diff-next-hunk-btn"
            onClick={handleNextHunk}
            disabled={atLastHunk}
            aria-label={t('diff.nextHunk')}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            {t('diff.nextHunk')}
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="diff-hunk-counter">
            {t('diff.hunkCounter', {
              current: currentHunk + 1,
              total: hunkStarts.length,
            })}
          </span>
        </div>
      )}
      {isLarge && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="diff-toggle-btn mt-1 text-xs"
          data-testid="diff-toggle-btn"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? t('conflict.diffCollapse')
            : t('conflict.diffShowMore', { count: hiddenCount })}
        </Button>
      )}
    </div>
  )
}
