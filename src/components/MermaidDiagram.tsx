/**
 * MermaidDiagram — renders a Mermaid diagram from source code.
 *
 * Lazy-loaded by StaticBlock when a code block has language === 'mermaid'.
 * Uses mermaid.render() to produce SVG, shown via dangerouslySetInnerHTML.
 * Falls back to raw code + error message when parsing fails.
 */

import mermaid from 'mermaid'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ScrollArea } from './ui/scroll-area'
import { Spinner } from './ui/spinner'

/**
 * (Re)configure mermaid for the current app theme. Called inside the render
 * effect (not at module load) so theme switches take effect on the next
 * diagram render instead of staying frozen to whatever `.dark` was when the
 * module first loaded (#758 item 1).
 */
function initializeMermaid(): void {
  mermaid.initialize({
    startOnLoad: false,
    // SECURITY: pin the sanitizing render mode explicitly. `'strict'` is mermaid's
    // default (it DOMPurify-sanitizes the rendered SVG — stripping scripts and
    // event handlers), but the diagram source is user-authored block content, so
    // make the XSS protection a hard, visible invariant rather than an implicit
    // default that a future config tweak could silently regress.
    securityLevel: 'strict',
    theme:
      typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
        ? 'dark'
        : 'default',
  })
}

export interface MermaidDiagramProps {
  code: string
}

export function MermaidDiagram({ code }: MermaidDiagramProps): React.ReactElement {
  const { t } = useTranslation()
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const uniqueId = useId()
  const renderId = `mermaid-${uniqueId.replace(/:/g, '-')}`
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    setLoading(true)
    setSvg(null)
    setError(null)

    // Re-read the theme on every render so a light/dark toggle since the
    // last render is picked up (mermaid bakes the theme in at render time).
    initializeMermaid()

    mermaid
      .render(renderId, code)
      .then(({ svg: rendered }) => {
        if (!cancelledRef.current) {
          setSvg(rendered)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })

    return () => {
      cancelledRef.current = true
    }
  }, [code, renderId])

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 rounded-md bg-muted px-3 py-4 text-sm text-muted-foreground"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- kept as role="status" so the loading state is discoverable via the explicit role attribute relied on by callers/tests; <output> drops it
        role="status"
        data-testid="mermaid-loading"
      >
        <Spinner size="sm" />
        <span>{t('mermaid.loading')}</span>
      </div>
    )
  }

  if (error) {
    return (
      <div
        className="rounded-md border border-alert-error-border bg-alert-error p-3"
        role="alert"
        data-testid="mermaid-error"
      >
        <p className="text-sm font-semibold text-alert-error-foreground mb-2">
          {t('mermaid.error')}: {error}
        </p>
        <ScrollArea orientation="horizontal" className="rounded bg-muted">
          <pre className="text-xs font-mono p-2">
            <code>{code}</code>
          </pre>
        </ScrollArea>
      </div>
    )
  }

  return (
    <ScrollArea orientation="horizontal" className="rounded-md bg-muted">
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- container for a rendered SVG injected via dangerouslySetInnerHTML, not a real <img> source; role="img"+aria-label exposes it as a single graphic
        role="img"
        aria-label={t('mermaid.label')}
        className="p-3"
        data-testid="mermaid-diagram"
        // oxlint-disable-next-line react/no-danger -- mermaid renders with securityLevel 'strict' (DOMPurify-sanitized SVG) — see mermaid.initialize above
        dangerouslySetInnerHTML={{ __html: svg ?? '' }}
      />
    </ScrollArea>
  )
}
