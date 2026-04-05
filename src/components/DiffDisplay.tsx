import type React from 'react'
import type { DiffSpan } from '../lib/tauri'

interface DiffDisplayProps {
  spans: DiffSpan[]
}

/**
 * Renders a word-level diff as inline colored spans.
 * Deletions are red with strikethrough, insertions green.
 */
export function DiffDisplay({ spans }: DiffDisplayProps): React.ReactElement {
  if (spans.length === 0) {
    return <span className="text-xs text-muted-foreground italic">No changes</span>
  }
  return (
    <p className="diff-display text-sm leading-relaxed whitespace-pre-wrap break-words m-0">
      {spans.map((span, i) => {
        const key = `${i}-${span.tag}`
        switch (span.tag) {
          case 'Delete':
            return (
              <del
                key={key}
                className="bg-destructive/15 text-destructive no-underline line-through"
              >
                {span.value}
              </del>
            )
          case 'Insert':
            return (
              <ins key={key} className="bg-status-done text-status-done-foreground no-underline">
                {span.value}
              </ins>
            )
          default:
            return <span key={key}>{span.value}</span>
        }
      })}
    </p>
  )
}
