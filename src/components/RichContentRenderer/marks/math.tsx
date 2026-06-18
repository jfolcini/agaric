import type React from 'react'
import { lazy, Suspense } from 'react'

import type { MathBlockNode, MathInlineNode } from '../../../editor/types'

// Lazy-load KatexMath so KaTeX (+ CSS) stays out of the initial bundle (#750).
const LazyKatexMath = lazy(() =>
  import('@/components/rendering/KatexMath').then((m) => ({ default: m.KatexMath })),
)

/** Static (read-only) render of an inline `$…$` math node (#1437). */
export function renderMathInline(node: MathInlineNode, key: string): React.ReactElement {
  return (
    <Suspense
      key={key}
      fallback={<span className="text-muted-foreground">{node.attrs.latex}</span>}
    >
      <LazyKatexMath latex={node.attrs.latex} />
    </Suspense>
  )
}

/** Static (read-only) render of a block `$$…$$` math node (#1437). */
export function renderMathBlock(node: MathBlockNode, key: string): React.ReactElement {
  return (
    <Suspense key={key} fallback={<div className="text-muted-foreground">{node.attrs.latex}</div>}>
      <LazyKatexMath latex={node.attrs.latex} display />
    </Suspense>
  )
}
