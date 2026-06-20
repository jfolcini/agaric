/**
 * FeaturePageHeader — shared title/breadcrumb/actions chrome for top-level
 * views (PEND / design-system-ux-review-2026-05-09.md Tier 1 item 5).
 *
 * Standardises the "feature page" landmark: every top-level view now
 * carries a real `<header>` + `<h1>` so screen readers can land on the
 * view title via heading navigation and assistive-tech users get a
 * consistent visual anchor across Journal / Trash / Settings / Status /
 * Graph / Templates (the six views that previously rolled their own ad-
 * hoc header markup or none at all). Existing `ViewHeader`-portaled
 * views (PageBrowser, HistoryView, SearchPanel, AgendaView, PageHeader)
 * remain unchanged — the portal mechanic is orthogonal to this visual
 * chrome.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ breadcrumb? (optional, full-width row)                      │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ <h1>title</h1>           actions?        kebab?             │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Slots:
 *  - `title`            (required) — rendered as `<h1>`. The view's
 *                       accessible page title. Truncates on overflow.
 *  - `breadcrumb`       (optional) — full node, typically a `<nav>` with
 *                       aria-label. Sits above the title row.
 *  - `actions`          (optional) — right-aligned action buttons /
 *                       toolbar content. Renders before `kebab`.
 *  - `kebab`            (optional) — overflow menu trigger pinned to the
 *                       far right.
 *  - `className`        — merged onto the outer `<header>` for layout
 *                       overrides (margin, sticky positioning, …).
 *
 * Why a fresh primitive rather than extending `ViewHeader`?
 *  - `ViewHeader` is a *portal* wrapper that lifts content above the
 *    main `<ScrollArea>` so filter bars stick during scroll. Its
 *    children are freeform.
 *  - `FeaturePageHeader` is a *styled* primitive with a fixed slot
 *    contract. Views can compose the two (portal the styled header into
 *    the outlet) or render the styled header inline.
 *  - Folding the two into one component would either lose the portal
 *    behaviour or force every consumer to thread title/actions through
 *    the outlet layer.
 */

import type * as React from 'react'

import { cn } from '@/lib/utils'

export interface FeaturePageHeaderProps {
  /** Accessible page title rendered as `<h1>`. */
  title: string
  /**
   * Optional content rendered above the title row. Typically a
   * `<nav aria-label="…">` breadcrumb naming the active sub-view.
   */
  breadcrumb?: React.ReactNode
  /**
   * Optional right-aligned action group (buttons, toolbar items). The
   * `actions` slot stays left of the `kebab` slot when both are
   * provided.
   */
  actions?: React.ReactNode
  /**
   * Optional overflow / kebab menu trigger pinned to the far right.
   * Conceptually distinct from `actions` so the kebab can be styled /
   * positioned independently (e.g. mobile-only collapse).
   */
  kebab?: React.ReactNode
  /** Forwarded to the outer `<header>` for layout overrides. */
  className?: string
  /** Forwarded ref. */
  ref?: React.Ref<HTMLElement>
}

const FeaturePageHeader = ({
  ref,
  title,
  breadcrumb,
  actions,
  kebab,
  className,
}: FeaturePageHeaderProps) => (
  <header
    ref={ref}
    data-slot="feature-page-header"
    className={cn('feature-page-header flex flex-col gap-2', className)}
  >
    {breadcrumb != null && <div data-slot="feature-page-header-breadcrumb">{breadcrumb}</div>}
    <div className="flex items-center gap-2">
      <h1 data-slot="feature-page-header-title" className="flex-1 truncate text-lg font-semibold">
        {title}
      </h1>
      {actions != null && (
        <div data-slot="feature-page-header-actions" className="flex items-center gap-1">
          {actions}
        </div>
      )}
      {kebab != null && (
        <div data-slot="feature-page-header-kebab" className="flex items-center">
          {kebab}
        </div>
      )}
    </div>
  </header>
)

FeaturePageHeader.displayName = 'FeaturePageHeader'

export { FeaturePageHeader }
