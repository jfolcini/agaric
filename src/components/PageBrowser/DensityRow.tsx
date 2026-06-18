/**
 * PEND-56 — `DensityRow`.
 *
 * Pages-view leaf row that renders one page at one of three densities:
 *
 *  - `compact`  (32 px) — title + relative-modified-time only; other
 *                         metadata reachable via the row's `title` tooltip.
 *  - `regular`  (44 px) — title + ↗ inbound link count + ⊟ child-block
 *                         count + relative time + first property-flag
 *                         badge (if any). Matches today's row height so
 *                         the virtualizer does not re-measure on first
 *                         flag flip. Default.
 *  - `expanded` (~68 px) — title on line 1; full metadata row on line 2;
 *                         *all* property-flag badges rendered.
 *
 * Inputs are typed primitive props (no objects with reference identity
 * that change across renders) so `React.memo`'s shallow compare can hit
 * across parent re-renders. Mirrors the pattern in `BlockListItem`.
 *
 * The wrapping `<div role="row">` carries `data-density={density}` so
 * integration tests can assert which mode is active without reading the
 * computed style.
 */

import { FileText, Star, Trash2 } from 'lucide-react'
import type React from 'react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'

import { HighlightMatch } from '@/components/common/HighlightMatch'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { DensityMode } from '@/hooks/usePageBrowserDensity'
import { cn } from '@/lib/utils'

export interface DensityRowProps {
  // ── Page identity ───────────────────────────────────────────────────
  /** Stable page id — drives `id="page-row-…"` and the focused-row aria
   * activedescendant link. */
  pageId: string
  /** Raw title — `null` falls back to the localised "Untitled" string. */
  title: string | null
  /** Trimmed filter text for the `HighlightMatch` mark. Pass `''` when
   * not filtering. */
  filterText: string

  // ── Density + virtualizer chrome ───────────────────────────────────
  /** Active density mode. Drives `data-density` and metadata layout. */
  density: DensityMode
  /** Virtualizer row index (data-index for the virtualizer's
   * `measureElement` ref). */
  virtualRowIndex: number
  /** Pixel offset of the virtual row — applied as a `translateY`. */
  virtualRowStart: number
  /** Ref callback passed straight to `useVirtualizer().measureElement`. */
  measureElement: ((node: Element | null) => void) | undefined

  // ── State + flags ──────────────────────────────────────────────────
  /** Flat-list index — drives `aria-selected` against `focusedIndex`. */
  pageIndex: number
  /** Index of the focused row in the parent grid; compared to
   * `pageIndex` for focus styling. */
  focusedIndex: number
  /** Whether this page is starred. Drives the star button affordance
   * and the `data-starred` attribute. */
  starred: boolean
  /** When `true`, renders the `(alias)` muted-text marker after the
   * title — used by the alias-resolver path when the filter matches via
   * a redirect, not the visible title. */
  showAliasBadge: boolean
  /** When `true`, disables the delete button (parent is mid-delete). */
  deleting: boolean

  // ── Typed metadata primitives (PEND-56 Phase 1 IPC columns) ────────
  /** Epoch-ms from `last_modified_at` (#109 Phase 2). `null` renders "never". */
  lastModifiedAt: number | null
  /** Inbound link count. Zero suppresses the ↗ badge in `regular` /
   * `expanded`. */
  inboundLinkCount: number
  /** Descendant non-deleted block count. Zero suppresses the ⊟ badge in
   * `regular` / `expanded`. */
  childBlockCount: number
  /** Page itself carries `block_tags`. */
  hasTags: boolean
  /** Some descendant has a non-null `todo_state`. */
  hasTodo: boolean
  /** Some descendant has a non-null `scheduled_date`. */
  hasScheduled: boolean
  /** Some descendant has a non-null `due_date`. */
  hasDue: boolean

  // ── Multi-select (#81 / PEND-57) ───────────────────────────────────
  /** Whether this row is in the batch selection. Drives the leading
   * checkbox's checked state and the `data-selected` attribute. */
  multiSelected: boolean
  /** Toggle this row's batch selection (additive to the single-row
   * star/delete flow). Receives the click event so the parent's
   * `useListMultiSelect.handleRowClick` can honour Shift (range) and
   * Cmd/Ctrl (toggle) modifiers. */
  onToggleMultiSelect: (pageId: string, e: React.MouseEvent) => void

  // ── Handlers ───────────────────────────────────────────────────────
  /** Called when the page row is activated (click). */
  onSelect: (pageId: string, title: string) => void
  /** Called when the leading star button is clicked. */
  onToggleStar: (pageId: string) => void
  /** Called when the trailing delete button is clicked. `null` clears
   * the parent's dialog target (kept for API parity with the legacy
   * `PageRow` callback). */
  onDeleteRequest: (target: { id: string; name: string } | null) => void
}

// ── Relative-time helper ────────────────────────────────────────────
//
// Sticks to pure JS so the helper is tree-shake-friendly and has zero
// locale state. The format intentionally matches the design mock-up:
// `now`, `2m`, `3h`, `5d`, `2w`, `4mo`, `2y`. Inputs are ISO strings
// straight off the IPC; `null` collapses to the localised `never`
// string at render time (handled by the caller).
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

/**
 * Compact relative-time formatter. Pure — only reads `Date.now()`. Not
 * locale-aware (the design mock uses ASCII shorthand) so this stays
 * outside the i18n catalog.
 *
 * Exported for the test file's deterministic assertions; callers should
 * not import it elsewhere.
 */
export function formatRelativeShort(
  // #109 Phase 2: `lastModifiedAt` is INTEGER epoch-ms; still accept ISO
  // strings for any other caller.
  value: string | number | null,
  now: number = Date.now(),
): string {
  if (!value) return ''
  const t = typeof value === 'number' ? value : Date.parse(value)
  if (Number.isNaN(t)) return ''
  const diff = Math.max(0, now - t)
  if (diff < MINUTE_MS) return 'now'
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`
  if (diff < WEEK_MS) return `${Math.floor(diff / DAY_MS)}d`
  if (diff < MONTH_MS) return `${Math.floor(diff / WEEK_MS)}w`
  if (diff < YEAR_MS) return `${Math.floor(diff / MONTH_MS)}mo`
  return `${Math.floor(diff / YEAR_MS)}y`
}

const rowStyle = (start: number): React.CSSProperties => ({
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  transform: `translateY(${start}px)`,
})

interface PropertyFlagBadgeProps {
  /** Stable, locale-independent token — used as `data-page-flag` so
   * integration tests and CSS hooks key off the same string regardless
   * of the active locale. */
  token: 'tags' | 'todos' | 'scheduled' | 'due'
  /** Rendered text — already passed through i18n. */
  label: string
}

function PropertyFlagBadge({ token, label }: PropertyFlagBadgeProps): React.ReactElement {
  return (
    <span
      data-page-flag={token}
      className="inline-flex shrink-0 items-center rounded-md border border-border/60 px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
    >
      #{label}
    </span>
  )
}

/** Build the ordered list of flag tokens this row should render. Pure
 * — exported only so the test file can assert against the same
 * allowlist without depending on render output. */
export function collectFlagTokens(props: {
  hasTags: boolean
  hasTodo: boolean
  hasScheduled: boolean
  hasDue: boolean
}): Array<'tags' | 'todos' | 'scheduled' | 'due'> {
  const out: Array<'tags' | 'todos' | 'scheduled' | 'due'> = []
  if (props.hasTags) out.push('tags')
  if (props.hasTodo) out.push('todos')
  if (props.hasScheduled) out.push('scheduled')
  if (props.hasDue) out.push('due')
  return out
}

function DensityRowInner(props: DensityRowProps): React.ReactElement {
  const { t } = useTranslation()
  const {
    pageId,
    title: rawTitle,
    filterText,
    density,
    virtualRowIndex,
    virtualRowStart,
    measureElement,
    pageIndex,
    focusedIndex,
    starred,
    showAliasBadge,
    deleting,
    lastModifiedAt,
    inboundLinkCount,
    childBlockCount,
    hasTags,
    hasTodo,
    hasScheduled,
    hasDue,
    multiSelected,
    onToggleMultiSelect,
    onSelect,
    onToggleStar,
    onDeleteRequest,
  } = props

  const title = rawTitle ?? t('pageBrowser.untitled')
  const trimmedFilter = filterText.trim()
  const focused = focusedIndex === pageIndex

  // Metadata pieces, computed once so the compact-tooltip path and the
  // regular/expanded rendering reuse the same strings.
  const relative = formatRelativeShort(lastModifiedAt)
  const relativeLabel = relative === '' ? t('pageBrowser.metadata.never') : relative
  const inboundText = t('pageBrowser.metadata.inbound', { count: inboundLinkCount })
  const childrenText = t('pageBrowser.metadata.children', { count: childBlockCount })
  const flagTokens = collectFlagTokens({ hasTags, hasTodo, hasScheduled, hasDue })

  // Compact density folds the full metadata into the row's `title`
  // tooltip so users keep access to ↗ / ⊟ / flags without the extra
  // chrome. Regular / expanded use the visible badge cluster, so the
  // tooltip stays the bare title (matching today's `PageRow`).
  // PEND-56 edge case: suppress `↗ 0` / `⊟ 0` in the tooltip the same
  // way the visible badges do — assemble the tail conditionally so
  // an empty page doesn't read "0 inbound links, 0 child blocks".
  const tooltipText = (() => {
    if (density !== 'compact') return title
    const tail: string[] = []
    if (inboundLinkCount > 0) tail.push(inboundText)
    if (childBlockCount > 0) tail.push(childrenText)
    tail.push(t('pageBrowser.metadata.lastModified', { relative: relativeLabel }))
    return `${title} — ${tail.join(', ')}`
  })()

  const showInbound = inboundLinkCount > 0 && density !== 'compact'
  const showChildren = childBlockCount > 0 && density !== 'compact'
  const visibleFlags =
    density === 'compact' ? [] : density === 'regular' ? flagTokens.slice(0, 1) : flagTokens

  return (
    <div
      // UX-331 — stable id so the grid container's `aria-activedescendant`
      // can point at this row when keyboard nav lands on it.
      id={`page-row-${pageId}`}
      data-index={virtualRowIndex}
      ref={measureElement}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- CSS-grid row inside role="grid"; a real <tr> needs a <table> and breaks the flex layout
      role="row"
      aria-selected={focused}
      data-page-item
      data-density={density}
      data-starred={starred}
      data-selected={multiSelected}
      tabIndex={-1}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors hover:bg-accent/50',
        density === 'compact' && 'py-1',
        density === 'regular' && 'py-2',
        density === 'expanded' && 'py-2.5',
        // Row-highlight (background) only — the inner button paints its own
        // `focus-ring-visible` ring for the actual focus affordance.
        focused && 'bg-accent/30',
      )}
      style={rowStyle(virtualRowStart)}
    >
      {/* #81 / PEND-57 — batch-selection checkbox. Always present (it is
          the entry point into selection mode); visible on hover / focus /
          when checked, mirroring the star + delete affordances. */}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell focus is delegated to the inner checkbox; CSS-grid cell would break as a <td> without a <table> */}
      <div role="gridcell" className="shrink-0">
        <Checkbox
          checked={multiSelected}
          onClick={(e) => {
            e.stopPropagation()
            onToggleMultiSelect(pageId, e)
          }}
          aria-label={t('pageBrowser.select.toggle')}
          data-testid={`page-select-${pageId}`}
          className={cn(
            'shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity',
            multiSelected && 'opacity-100',
          )}
        />
      </div>
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell focus is delegated to inner controls; CSS-grid cell would break as a <td> without a <table> */}
      <div role="gridcell" className="flex flex-1 items-center gap-3 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          aria-label={starred ? t('pageBrowser.unstarPage') : t('pageBrowser.starPage')}
          className="star-toggle shrink-0 h-6 w-6 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 focus-visible:opacity-100 focus-visible:ring-inset transition-opacity text-muted-foreground hover:text-star data-[starred=true]:opacity-100 data-[starred=true]:text-star"
          data-starred={starred}
          onClick={(e) => {
            e.stopPropagation()
            onToggleStar(pageId)
          }}
        >
          <Star className="h-3.5 w-3.5" fill={starred ? 'currentColor' : 'none'} />
        </Button>
        <button
          type="button"
          className={cn(
            'page-browser-item flex flex-1 min-w-0 border-none bg-transparent p-0 text-left text-sm cursor-pointer focus-ring-visible focus-visible:ring-inset',
            density === 'expanded' ? 'flex-col items-start gap-1' : 'items-center gap-3',
          )}
          onClick={() => onSelect(pageId, title)}
        >
          <span
            className={cn('flex items-center gap-3 min-w-0', density === 'expanded' && 'w-full')}
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="page-browser-item-title truncate" title={tooltipText}>
              <HighlightMatch text={title} filterText={trimmedFilter} />
              {showAliasBadge && (
                <span className="alias-badge text-xs text-muted-foreground">(alias)</span>
              )}
            </span>
          </span>
          {/* Metadata row.
           *   - Regular: inline (same line as title) on the right.
           *   - Expanded: a second line under the title.
           *   - Compact: hidden — tooltip-only access.
           */}
          {density !== 'compact' && (
            <span
              data-page-metadata
              className={cn(
                'flex shrink-0 items-center gap-2 text-xs text-muted-foreground',
                density === 'regular' && 'ml-auto pl-2',
                density === 'expanded' && 'pl-7 w-full',
              )}
            >
              {showInbound && (
                <span data-metadata-inbound>
                  <span aria-hidden="true">{`${inboundLinkCount} ↗`}</span>
                  <span className="sr-only">{inboundText}</span>
                </span>
              )}
              {showChildren && (
                <span data-metadata-children>
                  <span aria-hidden="true">{`${childBlockCount} ⊟`}</span>
                  <span className="sr-only">{childrenText}</span>
                </span>
              )}
              <span data-metadata-relative>
                <span aria-hidden="true">{relativeLabel}</span>
                <span className="sr-only">
                  {t('pageBrowser.metadata.lastModified', { relative: relativeLabel })}
                </span>
              </span>
              {visibleFlags.map((flag) => (
                <PropertyFlagBadge key={flag} token={flag} label={t(FLAG_LABEL_KEY[flag])} />
              ))}
            </span>
          )}
        </button>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell focus is delegated to inner action buttons; CSS-grid cell would break as a <td> without a <table> */}
      <div role="gridcell" className="shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('pageBrowser.deleteButton')}
          className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target focus-visible:opacity-100 focus-visible:ring-inset transition-opacity text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
          disabled={deleting}
          onClick={(e) => {
            e.stopPropagation()
            onDeleteRequest({ id: pageId, name: title })
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

/**
 * Statically-known i18n keys for each flag token. Keeping the lookup
 * table inline (vs. computing `propertyTag${Capitalised}` at render
 * time) means i18next's missing-key dev warning fires correctly if
 * someone removes a key from the catalog, and the bundle's static
 * key-extraction step (when we add one) can see them.
 */
const FLAG_LABEL_KEY: Record<'tags' | 'todos' | 'scheduled' | 'due', string> = {
  tags: 'pageBrowser.metadata.propertyTag',
  todos: 'pageBrowser.metadata.propertyTodo',
  scheduled: 'pageBrowser.metadata.propertyScheduled',
  due: 'pageBrowser.metadata.propertyDue',
}

/**
 * Memoised `DensityRow`. All props are primitives (or stable
 * callbacks/refs from the parent) so the default shallow compare hits
 * across parent re-renders.
 */
export const DensityRow = memo(DensityRowInner)
DensityRow.displayName = 'DensityRow'
