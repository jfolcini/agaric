import { ChevronDown, ChevronUp } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import type { DiffSpan } from '../lib/tauri'
import { cn } from '../lib/utils'
import { EmptyState } from './EmptyState'
import { renderRichContent } from './RichContentRenderer'

interface DiffDisplayProps {
  spans: DiffSpan[]
}

/** Threshold above which the diff is collapsed by default. */
const LARGE_DIFF_THRESHOLD = 500
/** Number of spans shown when the diff is collapsed. */
const COLLAPSED_SPAN_COUNT = 100

/**
 * Walk up from `el`'s parent chain looking for the nearest scrollable
 * ancestor (overflow: auto | scroll | overlay on either axis). Returns
 * `null` if none is found. Used by the hunk-nav scroll-skip heuristic so
 * `scrollIntoView` is only called when the target is actually offscreen.
 */
function findScrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el?.parentElement ?? null
  while (cur) {
    const style = window.getComputedStyle(cur)
    const overflow = `${style.overflow} ${style.overflowY} ${style.overflowX}`
    if (/auto|scroll|overlay/.test(overflow)) {
      return cur
    }
    cur = cur.parentElement
  }
  return null
}

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
 *
 * PEND-17 Part A: the active hunk receives a visible ring so prev/next have
 * obvious feedback; `scrollIntoView` is skipped when the target is already
 * fully visible in its scrollable ancestor; the nav is hidden entirely for
 * single-hunk diffs (nothing to navigate); the counter sits to the left of
 * the buttons so it reads as a label rather than a trailing footnote.
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

  // Group consecutive non-Equal spans into hunks. `hunkStarts[i]` is the
  // index of the first span of hunk `i` in `visibleSpans`. `hunkOfSpan[j]`
  // is the hunk index a given span belongs to (`null` for Equal spans).
  // Tracking every span's hunk membership (not just the first span) is what
  // lets us highlight the contiguous run for the active hunk.
  const { hunkStarts, hunkOfSpan } = useMemo(() => {
    const starts: number[] = []
    const ofSpan: (number | null)[] = new Array(visibleSpans.length).fill(null)
    let inHunk = false
    let currentHunkIdx = -1
    for (let i = 0; i < visibleSpans.length; i++) {
      const span = visibleSpans[i]
      const isChange = span?.tag === 'Insert' || span?.tag === 'Delete'
      if (isChange) {
        if (!inHunk) {
          starts.push(i)
          currentHunkIdx++
          inHunk = true
        }
        ofSpan[i] = currentHunkIdx
      } else {
        inHunk = false
      }
    }
    return { hunkStarts: starts, hunkOfSpan: ofSpan }
  }, [visibleSpans])

  const hasNav = hunkStarts.length > 1
  const atFirstHunk = currentHunk <= 0
  const atLastHunk = currentHunk >= hunkStarts.length - 1

  const goToHunk = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(hunkStarts.length - 1, index))
      setCurrentHunk(clamped)
      const spanIndex = hunkStarts[clamped]
      if (spanIndex == null) return
      const el = spanRefs.current.get(spanIndex)
      if (!el || typeof el.scrollIntoView !== 'function') return
      // Skip the scroll if the target is already fully visible in its
      // nearest scrollable ancestor — avoids the "I clicked but nothing
      // moved" feedback gap on short diffs that already fit on screen.
      const ancestor = findScrollableAncestor(el)
      if (ancestor) {
        const t = el.getBoundingClientRect()
        const a = ancestor.getBoundingClientRect()
        if (t.top >= a.top && t.bottom <= a.bottom) return
      }
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
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
            const hunkIdx = hunkOfSpan[i]
            const isHunkStart = hunkIdx != null && hunkStarts[hunkIdx] === i
            const isActiveHunk = hunkIdx != null && hunkIdx === currentHunk && hasNav
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
                    data-hunk-active={isActiveHunk || undefined}
                    className={cn(
                      'bg-destructive/15 text-destructive no-underline line-through',
                      isActiveHunk && 'ring-2 ring-ring/60 rounded-sm',
                    )}
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
                    data-hunk-active={isActiveHunk || undefined}
                    className={cn(
                      'bg-status-done text-status-done-foreground no-underline',
                      isActiveHunk && 'ring-2 ring-ring/60 rounded-sm',
                    )}
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
      {hasNav && (
        <div className="diff-hunk-nav mt-2 flex flex-wrap items-center gap-2">
          <span
            className="text-xs text-muted-foreground"
            data-testid="diff-hunk-counter"
            aria-live="polite"
            aria-atomic="true"
          >
            {t('diff.hunkCounter', {
              current: currentHunk + 1,
              total: hunkStarts.length,
            })}
          </span>
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
