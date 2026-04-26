import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import type { DiffSpan } from '../lib/tauri'
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
 */
export function DiffDisplay({ spans }: DiffDisplayProps): React.ReactElement {
  const { t } = useTranslation()
  const richCallbacks = useRichContentCallbacks()
  const isLarge = spans.length > LARGE_DIFF_THRESHOLD
  const [expanded, setExpanded] = useState(false)

  if (spans.length === 0) {
    return <span className="text-xs text-muted-foreground italic">{t('diff.noChanges')}</span>
  }

  const visibleSpans = isLarge && !expanded ? spans.slice(0, COLLAPSED_SPAN_COUNT) : spans
  const hiddenCount = spans.length - visibleSpans.length

  return (
    <div className="diff-display-wrapper">
      <p className="diff-display text-sm leading-relaxed whitespace-pre-wrap break-words m-0">
        {visibleSpans.map((span, i) => {
          const key = `${i}-${span.tag}`
          const content =
            renderRichContent(span.value, {
              interactive: false,
              ...richCallbacks,
            }) ?? span.value
          switch (span.tag) {
            case 'Delete':
              return (
                <del
                  key={key}
                  className="bg-destructive/15 text-destructive no-underline line-through"
                >
                  {content}
                </del>
              )
            case 'Insert':
              return (
                <ins key={key} className="bg-status-done text-status-done-foreground no-underline">
                  {content}
                </ins>
              )
            default:
              return <span key={key}>{content}</span>
          }
        })}
      </p>
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
