import type React from 'react'
import { lazy, Suspense } from 'react'

import { i18n } from '../../../lib/i18n'
import { Spinner } from '../../ui/spinner'

// Lazy-load MermaidDiagram to avoid bundling mermaid on initial load
const LazyMermaidDiagram = lazy(() =>
  import('../../MermaidDiagram').then((m) => ({ default: m.MermaidDiagram })),
)

export function renderMermaidBlock(code: string, key: string): React.ReactElement {
  return (
    <Suspense
      key={key}
      fallback={
        /* oxlint-disable jsx-a11y/prefer-tag-over-role -- keep the literal role="status": RichContentRenderer/StaticBlock tests query container.querySelector('[role="status"]'), which an <output>'s implicit role does not satisfy */
        <div
          className="flex items-center gap-2 rounded-md bg-muted px-3 py-4 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner size="sm" />
          <span>{i18n.t('mermaid.loading')}</span>
        </div>
        /* oxlint-enable jsx-a11y/prefer-tag-over-role */
      }
    >
      <LazyMermaidDiagram code={code} />
    </Suspense>
  )
}
