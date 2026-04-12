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
import { cn } from '../lib/utils'
import { Spinner } from './ui/spinner'

// Initialize mermaid once globally
mermaid.initialize({
  startOnLoad: false,
  theme:
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'default',
})

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
        <pre className={cn('text-xs font-mono bg-muted rounded p-2 overflow-x-auto')}>
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  return (
    <div
      className="rounded-md bg-muted p-3 overflow-x-auto"
      role="img"
      aria-label={t('mermaid.label')}
      data-testid="mermaid-diagram"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid.render() output is safe
      dangerouslySetInnerHTML={{ __html: svg ?? '' }}
    />
  )
}
