/**
 * MermaidDiagram — renders a Mermaid diagram from source code.
 *
 * Lazy-loaded by StaticBlock when a code block has language === 'mermaid'.
 * Uses mermaid.render() to produce SVG, shown via dangerouslySetInnerHTML.
 * Falls back to raw code + error message when parsing fails.
 */

import mermaid from 'mermaid'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DiagramViewer } from '@/components/rendering/DiagramViewer'
import { mermaidThemeVariables, readDiagramColors } from '@/components/rendering/mermaid-theme'
import { SCROLL_ONLY_WHEN_WIDER, ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useTheme } from '@/hooks/useTheme'
import { logger } from '@/lib/logger'

/**
 * (Re)configure mermaid for the current app theme before each render, so a
 * theme switch re-renders with the new colours (#758 item 1, #2259). The
 * colours come from the design tokens (#5638); when they cannot be resolved
 * the stock light or dark theme is the fallback.
 */
function initializeMermaid(isDark: boolean): void {
  const colors = readDiagramColors()
  if (!colors) logger.warn('MermaidDiagram', 'theme tokens unresolved, using the stock theme')
  mermaid.initialize({
    startOnLoad: false,
    // SECURITY: pin the sanitizing render mode explicitly. `'strict'` is mermaid's
    // default (it DOMPurify-sanitizes the rendered SVG — stripping scripts and
    // event handlers), but the diagram source is user-authored block content, so
    // make the XSS protection a hard, visible invariant rather than an implicit
    // default that a future config tweak could silently regress.
    securityLevel: 'strict',
    // Without this, every failed render APPENDS a full-width "Syntax error"
    // SVG div to document.body and throws before cleaning it up — one leaked,
    // visible artifact per failure (per keystroke while editing, since each
    // remount gets a fresh renderId). This component renders its own inline
    // error state, so mermaid's error diagram must be suppressed entirely.
    suppressErrorRendering: true,
    ...(colors
      ? {
          theme: 'base',
          themeVariables: mermaidThemeVariables(
            colors,
            isDark,
            getComputedStyle(document.body).fontFamily,
          ),
        }
      : { theme: isDark ? 'dark' : 'default' }),
  })
}

/** Smallest on-screen label size, in CSS px, an inline diagram may shrink to. */
const LEGIBLE_LABEL_PX = 11

/**
 * Mermaid sizes its SVG `width: 100%; max-width: <natural width>`, so it only
 * ever shrinks to fit the column. Stop the shrink where the smallest label
 * would drop below the floor; past that the ScrollArea scrolls instead.
 */
function keepLabelsLegible(svg: SVGSVGElement): void {
  const naturalWidth = svg.viewBox.baseVal?.width
  if (!naturalWidth) return
  const smallest = Math.min(
    ...[...svg.querySelectorAll('text, foreignObject *')]
      .filter((el) => el.textContent?.trim())
      .map((el) => Number.parseFloat(getComputedStyle(el).fontSize))
      .filter((px) => px > 0),
  )
  if (!Number.isFinite(smallest)) return
  svg.style.minWidth = `${naturalWidth * Math.min(1, LEGIBLE_LABEL_PX / smallest)}px`
}

/**
 * The diagram for the viewer and for Download SVG: at its natural size, with
 * its ids renamed so they do not collide with the inline copy's, serialized as
 * XML so the file stands alone.
 */
function viewerSvg(markup: string, renderId: string): string {
  const template = document.createElement('template')
  template.innerHTML = markup.replaceAll(renderId, `${renderId}-viewer`)
  const svgEl = template.content.querySelector('svg')
  if (!svgEl) return markup
  const [, , width, height] = (svgEl.getAttribute('viewBox') ?? '').split(/[\s,]+/)
  if (width && height) {
    svgEl.setAttribute('width', width)
    svgEl.setAttribute('height', height)
  }
  svgEl.style.removeProperty('max-width')
  return new XMLSerializer().serializeToString(svgEl)
}

export interface MermaidDiagramProps {
  code: string
}

export function MermaidDiagram({ code }: MermaidDiagramProps): React.ReactElement {
  const { t } = useTranslation()
  // Subscribe to the app's canonical theme source so any theme change re-runs
  // the render effect below (#2259, #5638). `useTheme`'s own effect applies the
  // documentElement theme classes first, so the tokens read at render time are
  // the new theme's. `isDark` also distinguishes the two sides of 'auto'.
  const { theme, isDark } = useTheme()
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const uniqueId = useId()
  const renderId = `mermaid-${uniqueId.replace(/:/g, '-')}`
  const cancelledRef = useRef(false)
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const diagramRef = useRef<HTMLDivElement>(null)
  const expandedSvg = useMemo(() => (svg ? viewerSvg(svg, renderId) : ''), [svg, renderId])
  // A diagram taller than the inline cap shows its top part under a fade.
  const [clipped, setClipped] = useState(false)

  useLayoutEffect(() => {
    const diagram = diagramRef.current
    const svgEl = diagram?.querySelector('svg')
    if (!diagram || !svgEl) return
    keepLabelsLegible(svgEl)
    setClipped(diagram.offsetHeight > (scrollRootRef.current?.clientHeight ?? Infinity))
  }, [svg])

  useEffect(() => {
    cancelledRef.current = false
    // oxlint-disable-next-line react/set-state-in-effect -- starts an async `mermaid.render` for the current code and theme; `loading` tracks that promise, cleared by its resolve/reject handlers; see #4407
    setLoading(true)
    setSvg(null)
    setError(null)

    // Mermaid bakes the theme in at render time, so re-apply it before each render.
    initializeMermaid(isDark)

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
  }, [code, renderId, theme, isDark])

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
    <div className="group/diagram relative">
      <ScrollArea
        ref={scrollRootRef}
        orientation="horizontal"
        className="max-h-[70vh] rounded-md border border-border bg-background"
        viewportProps={SCROLL_ONLY_WHEN_WIDER}
      >
        <div
          ref={diagramRef}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- container for a rendered SVG injected via dangerouslySetInnerHTML, not a real <img> source; role="img"+aria-label exposes it as a single graphic
          role="img"
          aria-label={t('mermaid.label')}
          className="p-3"
          data-testid="mermaid-diagram"
          dangerouslySetInnerHTML={{ __html: svg ?? '' }}
        />
      </ScrollArea>
      {clipped && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-px bottom-px h-16 rounded-b-md bg-linear-to-t from-background"
          data-testid="mermaid-fade"
        />
      )}
      <DiagramViewer
        title={t('mermaid.label')}
        source={code}
        copyLabel={t('diagramViewer.copySource')}
        svg={expandedSvg}
      >
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- container for a rendered SVG injected via dangerouslySetInnerHTML; role="img"+aria-label exposes it as a single graphic
          role="img"
          aria-label={t('mermaid.label')}
          className="p-4"
          dangerouslySetInnerHTML={{ __html: expandedSvg }}
        />
      </DiagramViewer>
    </div>
  )
}
