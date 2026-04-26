/**
 * BlockZoomBar — breadcrumb navigation bar for zoomed block view.
 *
 * Renders a clickable breadcrumb trail: Home › Ancestor › … › Current.
 * Thin data adapter over the `Breadcrumb` design-system primitive
 * (`src/components/ui/breadcrumb.tsx`).
 *
 * Per UX-257, breadcrumb crumbs render plain stripped-text labels — never
 * inline `[[ULID]]` chips or rich content. Markdown markers are stripped and
 * `[[id]]` / `((id))` references are resolved via `useRichContentCallbacks`
 * (with a truncated-id fallback when the resolve cache is cold).
 *
 * Keyboard navigation (UX-215) and overflow handling live in the primitive.
 */

import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Breadcrumb, type BreadcrumbCrumb } from '@/components/ui/breadcrumb'
import type { BreadcrumbItem } from '../hooks/useBlockZoom'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'

export interface BlockZoomBarProps {
  breadcrumbs: BreadcrumbItem[]
  /** Called when the user clicks a breadcrumb item to navigate to it. */
  onNavigate: (blockId: string) => void
  /** Called when the user clicks the Home button to zoom out to root. */
  onZoomToRoot: () => void
}

/**
 * Strip lightweight markdown markup from a block's raw content for display
 * inside a breadcrumb. Resolves `[[id]]` / `((id))` references via
 * `resolveBlockTitle` (cache hit) or falls back to a truncated-id
 * placeholder. Strips `#`, `**`, `__`, `~~`, `==`, leading `>` markers so
 * crumbs read as plain navigation chrome rather than rich content.
 */
function stripBreadcrumbMarkup(
  raw: string,
  resolveBlockTitle: (id: string) => string | undefined,
): string {
  let s = raw
  // [[ULID]] block-link tokens
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_match, id: string) => {
    const trimmed = id.trim()
    const resolved = resolveBlockTitle(trimmed)
    if (resolved) return resolved
    return trimmed.length > 8 ? `${trimmed.slice(0, 8)}...` : trimmed
  })
  // ((ULID)) block-ref tokens
  s = s.replace(/\(\(([^)]+)\)\)/g, (_match, id: string) => {
    const trimmed = id.trim()
    const resolved = resolveBlockTitle(trimmed)
    if (resolved) return resolved
    return trimmed.length > 8 ? `${trimmed.slice(0, 8)}...` : trimmed
  })
  // Leading blockquote / heading markers
  s = s.replace(/^[\s>#]+/, '')
  // Pair-wrapped marks: **bold**, __underline__, ~~strike~~, ==highlight==
  s = s.replace(/(\*\*|__|~~|==)([\s\S]*?)\1/g, '$2')
  return s.trim()
}

export function BlockZoomBar({
  breadcrumbs,
  onNavigate,
  onZoomToRoot,
}: BlockZoomBarProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { resolveBlockTitle } = useRichContentCallbacks()

  const items = useMemo<BreadcrumbCrumb[]>(() => {
    return breadcrumbs.map((item, i) => {
      const isLast = i === breadcrumbs.length - 1
      const stripped = stripBreadcrumbMarkup(item.content, resolveBlockTitle)
      const label = stripped.length > 0 ? stripped : t('block.untitled')
      return {
        id: item.id,
        label,
        ...(isLast ? {} : { onSelect: () => onNavigate(item.id) }),
        testId: item.id,
        // UX-215 callers historically targeted `data-zoom-crumb` for keyboard
        // and a11y assertions; preserve it alongside the primitive's generic
        // `data-breadcrumb-crumb` to avoid breaking those selectors.
        dataAttributes: { 'data-zoom-crumb': item.id },
      }
    })
  }, [breadcrumbs, resolveBlockTitle, t, onNavigate])

  if (breadcrumbs.length === 0) return null

  return (
    <Breadcrumb
      items={items}
      ariaLabel={t('blockZoom.breadcrumbs')}
      home={{
        onClick: onZoomToRoot,
        ariaLabel: t('block.zoomToRoot'),
        testId: 'home',
        dataAttributes: { 'data-zoom-crumb': 'home' },
      }}
      className="border-b border-border/40"
    />
  )
}
