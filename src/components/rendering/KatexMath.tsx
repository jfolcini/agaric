/**
 * KatexMath — renders LaTeX math via KaTeX (#1437).
 *
 * Lazy-loaded (this whole module, KaTeX itself, and KaTeX's CSS are pulled in
 * only when a math node is shown) so the ~250 kB KaTeX library stays OUT of the
 * editor/index chunk and off the first-paint critical path (#750). Mirrors the
 * MermaidDiagram lazy pattern.
 *
 * `katex.renderToString` is called with `throwOnError: false`, so invalid
 * LaTeX never throws — KaTeX renders the offending source inline in its error
 * colour. We additionally guard the call in a try/catch so an unexpected throw
 * degrades to the raw source rather than crashing the editor.
 */

// Importing the CSS here (not in a top-level entry) keeps it in the lazy chunk's
// asset graph so it loads alongside KaTeX, never on first paint.
import 'katex/dist/katex.min.css'
import katex from 'katex'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { DiagramViewer } from '@/components/rendering/DiagramViewer'
import { SCROLL_ONLY_WHEN_WIDER, ScrollArea } from '@/components/ui/scroll-area'

export interface KatexMathProps {
  /** Raw LaTeX source. */
  latex: string
  /** Display (block) mode vs inline mode. */
  display?: boolean
  /**
   * Display mode only: add the Expand button and full-screen viewer (#5638).
   * Off where the equation already sits inside a button (the editor node view).
   */
  expandable?: boolean
}

export function KatexMath({
  latex,
  display = false,
  expandable = false,
}: KatexMathProps): React.ReactElement {
  const { t } = useTranslation()
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, {
        displayMode: display,
        // Never throw on invalid LaTeX — render the source in the error colour
        // so a typo shows an inline, readable error instead of crashing.
        throwOnError: false,
        // KaTeX writes this into an inline `style`, so a token reference follows the theme.
        errorColor: 'var(--alert-error-foreground)',
      })
    } catch {
      // Defensive: KaTeX should not throw with throwOnError:false, but if it
      // ever does, degrade to the raw source rather than letting the editor
      // node view crash.
      return null
    }
  }, [latex, display])

  if (html === null) {
    return (
      <code className="katex-error-fallback text-alert-error-foreground" data-testid="katex-error">
        {latex}
      </code>
    )
  }

  if (!display) {
    return (
      <span
        data-testid="katex-inline"
        className="katex-inline-wrapper"
        // katex.renderToString from LaTeX source (no HTML passthrough); it is the
        // library's own sanitized markup, mirroring MermaidDiagram's SVG injection.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  // KaTeX keeps a display equation on one line (`white-space: nowrap`), so a
  // wide one must scroll rather than be clipped by the column.
  const equation = (
    <ScrollArea
      orientation="horizontal"
      className="katex-display-wrapper"
      viewportProps={SCROLL_ONLY_WHEN_WIDER}
    >
      <div data-testid="katex-block" dangerouslySetInnerHTML={{ __html: html }} />
    </ScrollArea>
  )
  if (!expandable) return equation
  return (
    <div className="group/diagram relative">
      {equation}
      <DiagramViewer
        title={t('math.label')}
        source={latex}
        copyLabel={t('diagramViewer.copyLatex')}
      >
        <div className="px-4 text-3xl" dangerouslySetInnerHTML={{ __html: html }} />
      </DiagramViewer>
    </div>
  )
}
