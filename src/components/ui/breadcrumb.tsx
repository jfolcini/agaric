/**
 * Breadcrumb — design-system primitive for hierarchical wayfinding.
 *
 * Single source of truth for breadcrumb UI across the app. Used by
 * `BlockZoomBar` (zoomed block trail) and `PageHeader`'s namespace breadcrumb
 * for `/`-separated page titles. See REVIEW-LATER.md UX-257 / FEAT-13 for the
 * design direction this primitive consolidates.
 *
 * Structure:
 * - `<nav role="navigation" aria-label>` wrapping `<div role="toolbar">`.
 *   (`<ol role="toolbar">` would re-open the axe `listitem` violation —
 *   overriding `<ol>`'s implicit `list` role strips the listitem context
 *   from `<li>` children.)
 * - `aria-current="page"` on the final crumb (rendered as a non-clickable
 *   span — the user is already there). `"page"` is the conventional ARIA
 *   value for breadcrumb final segments.
 * - Per-crumb truncation: intermediate crumbs `max-w-[160px]`, final
 *   `max-w-[280px]` (the page title above the bar is the focal point).
 * - Overflow: when more than `OVERFLOW_THRESHOLD` (5) crumbs exist, middle
 *   crumbs collapse into a `…` Radix `Popover` (per AGENTS.md — never custom
 *   dropdowns).
 * - 44 px touch hit-area on the toolbar via
 *   `[@media(pointer:coarse)]:min-h-11` + `[@media(pointer:coarse)]:py-2`,
 *   not by stretching every crumb. The desktop `min-h-6` (24 px) on its own
 *   would only reach 40 px under the touch padding (24 + 2×8); bumping
 *   `min-h` to `11` (44 px) on touch-coarse hits the AGENTS.md mandate
 *   exactly. Matches the density of the tab bar / filter-pill row.
 *
 * Keyboard navigation (UX-215):
 * - ArrowLeft / ArrowRight move focus across breadcrumb buttons.
 * - Home / End jump to the first / last button.
 * - The container has `role="toolbar"` so AT announces the grouping.
 *
 * Tokens: only `--muted-foreground` / `--foreground` from `index.css`. No
 * hardcoded Tailwind colour classes (AGENTS.md anti-pattern).
 *
 * ── Principled deviation from AGENTS.md "Mandatory patterns" ──────────────
 *
 * AGENTS.md instructs: "Focus management: use `focus-visible:ring-[3px]
 * focus-visible:ring-ring/50` consistently". This file deliberately deviates
 * for the breadcrumb crumb buttons — they render with `focus-visible:underline`
 * + `focus-visible:outline-hidden` instead of the form-control ring. The ring
 * rule applies to interactive form controls (Button, Input, Select); breadcrumb
 * crumbs are wayfinding text-links and the conventional focus indicator for a
 * text-link is an underline, not a 3 px ring. Pairing this with the underline
 * hover treatment makes the trail read as a path of links rather than a button
 * bar — see FEAT-13 in REVIEW-LATER.md. The overflow popover trigger and home
 * icon follow the same convention for visual consistency. The popover's
 * interior menu items keep the standard form-control ring (they are inside a
 * menu surface, not on the trail).
 */

import { ChevronRight, Home, MoreHorizontal } from 'lucide-react'
import type * as React from 'react'
import { Fragment, useCallback, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** Items above this count collapse middle crumbs into the overflow popover. */
const OVERFLOW_THRESHOLD = 5

export interface BreadcrumbCrumb {
  /** Stable react key — typically a block / page id. */
  id: string
  /** Plain-text label. Caller is responsible for stripping markdown markup. */
  label: string
  /** Click handler. Omit (or `undefined`) to render a non-clickable crumb. */
  onSelect?: (() => void) | undefined
  /** Forwarded to `data-breadcrumb-crumb` for test selectors. Defaults to `id`. */
  testId?: string | undefined
  /** Additional `data-*` attributes forwarded onto the rendered element. */
  dataAttributes?: Record<string, string> | undefined
}

export interface BreadcrumbHomeConfig {
  onClick: () => void
  /** Accessible name for the icon-only home button (i18n). */
  ariaLabel: string
  /** Forwarded to `data-breadcrumb-crumb` on the home button. */
  testId?: string | undefined
  /** Additional `data-*` attributes forwarded onto the home button. */
  dataAttributes?: Record<string, string> | undefined
}

export interface BreadcrumbProps {
  /**
   * Items in left-to-right order. The final item is rendered as the active
   * step (`aria-current="page"`, non-clickable).
   */
  items: readonly BreadcrumbCrumb[]
  /** aria-label for the `<nav>` and `<div role="toolbar">` (i18n). */
  ariaLabel: string
  /** Optional Home icon rendered as the leading item. */
  home?: BreadcrumbHomeConfig | undefined
  /** Forwarded to the `<nav>` wrapper. */
  className?: string | undefined
  /** Accessible label for the overflow `…` popover trigger (i18n). */
  overflowAriaLabel?: string | undefined
}

// FEAT-13: text-link styling for non-active crumbs (no rounded pill, no
// hover-bg, no focus ring). See the file's top doc comment for the rationale
// behind the focus-style deviation from AGENTS.md.
const itemButtonClass = cn(
  'inline-flex max-w-[160px] items-center truncate text-muted-foreground transition-colors hover:underline focus-visible:underline focus-visible:outline-hidden',
)

const itemActiveClass = cn(
  'inline-flex max-w-[280px] items-center truncate font-medium text-foreground',
)

const homeButtonClass = cn(
  'inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:underline focus-visible:underline focus-visible:outline-hidden',
)

const overflowTriggerClass = cn(
  'inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:underline focus-visible:underline focus-visible:outline-hidden',
)

export function BreadcrumbSeparator({
  className,
}: {
  className?: string | undefined
}): React.ReactElement {
  return (
    <ChevronRight
      aria-hidden="true"
      data-slot="breadcrumb-separator"
      className={cn('h-3 w-3 shrink-0 text-muted-foreground/50', className)}
    />
  )
}
BreadcrumbSeparator.displayName = 'BreadcrumbSeparator'

export interface BreadcrumbHomeProps {
  onClick: () => void
  ariaLabel: string
  testId?: string | undefined
  className?: string | undefined
  dataAttributes?: Record<string, string> | undefined
}

export function BreadcrumbHome({
  onClick,
  ariaLabel,
  testId,
  className,
  dataAttributes,
}: BreadcrumbHomeProps): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center" data-slot="breadcrumb-home">
      <button
        type="button"
        data-breadcrumb-crumb={testId ?? 'home'}
        {...(dataAttributes ?? {})}
        className={cn(homeButtonClass, className)}
        onClick={onClick}
        aria-label={ariaLabel}
      >
        <Home className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
BreadcrumbHome.displayName = 'BreadcrumbHome'

export interface BreadcrumbItemProps {
  label: string
  /** When true, renders as a non-clickable span with `aria-current="page"`. */
  isActive: boolean
  onSelect?: (() => void) | undefined
  testId?: string | undefined
  className?: string | undefined
  dataAttributes?: Record<string, string> | undefined
}

export function BreadcrumbItem({
  label,
  isActive,
  onSelect,
  testId,
  className,
  dataAttributes,
}: BreadcrumbItemProps): React.ReactElement {
  if (isActive) {
    return (
      <div className="flex min-w-0 items-center" data-slot="breadcrumb-item">
        <span
          aria-current="page"
          {...(testId !== undefined ? { 'data-breadcrumb-crumb': testId } : {})}
          {...(dataAttributes ?? {})}
          className={cn(itemActiveClass, className)}
          title={label}
        >
          {label}
        </span>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 items-center" data-slot="breadcrumb-item">
      <button
        type="button"
        {...(testId !== undefined ? { 'data-breadcrumb-crumb': testId } : {})}
        {...(dataAttributes ?? {})}
        className={cn(itemButtonClass, className)}
        onClick={onSelect}
        title={label}
      >
        {label}
      </button>
    </div>
  )
}
BreadcrumbItem.displayName = 'BreadcrumbItem'

interface OverflowPopoverProps {
  items: readonly BreadcrumbCrumb[]
  ariaLabel: string
}

function OverflowPopover({ items, ariaLabel }: OverflowPopoverProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex shrink-0 items-center" data-slot="breadcrumb-overflow">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-breadcrumb-crumb="overflow"
            aria-label={ariaLabel}
            aria-expanded={open}
            className={overflowTriggerClass}
          >
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto min-w-[180px] max-w-[320px] p-1">
          <div data-slot="breadcrumb-overflow-list" className="flex flex-col gap-0.5" role="menu">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-breadcrumb-overflow-item={item.testId ?? item.id}
                className={cn(
                  'flex w-full items-center truncate rounded-sm px-2 py-1 text-left text-xs',
                  'text-muted-foreground transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  'outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
                )}
                onClick={() => {
                  item.onSelect?.()
                  setOpen(false)
                }}
                title={item.label}
              >
                {item.label}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function Breadcrumb({
  items,
  ariaLabel,
  home,
  className,
  overflowAriaLabel,
}: BreadcrumbProps): React.ReactElement | null {
  const toolbarRef = useRef<HTMLDivElement | null>(null)

  const focusIndex = useCallback((index: number) => {
    const root = toolbarRef.current
    if (!root) return
    const buttons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button[data-breadcrumb-crumb]'),
    )
    if (buttons.length === 0) return
    const clamped = Math.max(0, Math.min(buttons.length - 1, index))
    buttons[clamped]?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const root = toolbarRef.current
      if (!root) return
      const buttons = Array.from(
        root.querySelectorAll<HTMLButtonElement>('button[data-breadcrumb-crumb]'),
      )
      if (buttons.length === 0) return
      const active = document.activeElement as HTMLElement | null
      const currentIndex = active ? buttons.indexOf(active as HTMLButtonElement) : -1
      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault()
          const next = currentIndex < 0 ? 0 : Math.min(buttons.length - 1, currentIndex + 1)
          focusIndex(next)
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          const prev = currentIndex < 0 ? 0 : Math.max(0, currentIndex - 1)
          focusIndex(prev)
          break
        }
        case 'Home': {
          e.preventDefault()
          focusIndex(0)
          break
        }
        case 'End': {
          e.preventDefault()
          focusIndex(buttons.length - 1)
          break
        }
        default:
          break
      }
    },
    [focusIndex],
  )

  if (items.length === 0 && !home) return null

  // Overflow strategy: when the trail is longer than the threshold, keep the
  // first crumb + the final two crumbs visible and collapse everything in
  // between behind a `…` popover. The final crumb is the user's anchor and
  // therefore always visible.
  const shouldCollapse = items.length > OVERFLOW_THRESHOLD
  const headItem = shouldCollapse ? items[0] : null
  const middleItems = shouldCollapse ? items.slice(1, items.length - 2) : []
  const tailItems = shouldCollapse ? items.slice(items.length - 2) : items
  const tailStartIndex = shouldCollapse ? items.length - tailItems.length : 0

  return (
    <nav aria-label={ariaLabel} data-slot="breadcrumb" className={cn('w-full', className)}>
      <div
        ref={toolbarRef}
        data-slot="breadcrumb-list"
        role="toolbar"
        aria-orientation="horizontal"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex min-h-6 items-center gap-1 px-2 py-1 text-xs text-muted-foreground',
          '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-2',
        )}
      >
        {home ? (
          <BreadcrumbHome
            onClick={home.onClick}
            ariaLabel={home.ariaLabel}
            testId={home.testId}
            dataAttributes={home.dataAttributes}
          />
        ) : null}
        {shouldCollapse && headItem ? (
          <Fragment key={`head-${headItem.id}`}>
            {home ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem
              label={headItem.label}
              isActive={false}
              onSelect={headItem.onSelect}
              testId={headItem.testId ?? headItem.id}
              dataAttributes={headItem.dataAttributes}
            />
            <BreadcrumbSeparator />
            <OverflowPopover
              items={middleItems}
              ariaLabel={overflowAriaLabel ?? 'Show hidden breadcrumbs'}
            />
          </Fragment>
        ) : null}
        {tailItems.map((item, i) => {
          const indexInFullList = tailStartIndex + i
          const isLast = indexInFullList === items.length - 1
          // Insert a separator before every tail item *except* the very first
          // visible item when there's no home and we haven't collapsed.
          const needsLeadingSep = shouldCollapse || home != null || i > 0
          return (
            <Fragment key={item.id}>
              {needsLeadingSep ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem
                label={item.label}
                isActive={isLast}
                onSelect={item.onSelect}
                testId={item.testId ?? item.id}
                dataAttributes={item.dataAttributes}
              />
            </Fragment>
          )
        })}
      </div>
    </nav>
  )
}
Breadcrumb.displayName = 'Breadcrumb'
