import type React from 'react'
import { lazy, Suspense } from 'react'

import { Spinner } from '@/components/ui/spinner'
import { i18n } from '@/lib/i18n'

// Lazy-load MermaidDiagram to avoid bundling mermaid on initial load
const LazyMermaidDiagram = lazy(() =>
  import('@/components/rendering/MermaidDiagram').then((m) => ({ default: m.MermaidDiagram })),
)

export function renderMermaidBlock(code: string, key: string): React.ReactElement {
  return (
    <Suspense
      key={key}
      fallback={
        <output className="flex items-center gap-2 rounded-md bg-muted px-3 py-4 text-sm text-muted-foreground">
          <Spinner size="sm" />
          <span>{i18n.t('mermaid.loading')}</span>
        </output>
      }
    >
      <LazyMermaidDiagram code={code} />
    </Suspense>
  )
}
