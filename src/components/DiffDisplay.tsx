import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import type { DiffSpan } from '../lib/tauri'
import { renderRichContent } from './StaticBlock'

interface DiffDisplayProps {
  spans: DiffSpan[]
}

/**
 * Renders a word-level diff as inline colored spans.
 * Deletions are red with strikethrough, insertions green.
 * ULID tokens inside spans are resolved via renderRichContent().
 */
export function DiffDisplay({ spans }: DiffDisplayProps): React.ReactElement {
  const { t } = useTranslation()
  const richCallbacks = useRichContentCallbacks()

  if (spans.length === 0) {
    return <span className="text-xs text-muted-foreground italic">{t('diff.noChanges')}</span>
  }
  return (
    <p className="diff-display text-sm leading-relaxed whitespace-pre-wrap break-words m-0">
      {spans.map((span, i) => {
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
  )
}
