/**
 * `PageRow`.
 *
 * Pages-view leaf row for one page: title + ↗ inbound link count + ⊟
 * child-block count + relative modified time + the first property-flag
 * badge (if any).
 *
 * Inputs are typed primitive props (no objects with reference identity
 * that change across renders) so `React.memo`'s shallow compare can hit
 * across parent re-renders. Mirrors the pattern in `BlockListItem`.
 */

import { Bookmark, FileText, Trash2 } from 'lucide-react'
import type React from 'react'
import { memo, useCallback, useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { DuplicateTitleCue } from '@/components/common/DuplicateTitleCue'
import { HighlightMatch } from '@/components/common/HighlightMatch'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { usePagePrefetchIntent } from '@/hooks/usePagePrefetchIntent'
import type { ViewportObserver } from '@/hooks/useViewportObserver'
import { cn } from '@/lib/utils'

export interface PageRowProps {
  // ── Page identity ───────────────────────────────────────────────────
  /** Stable page id — drives `id="page-row-…"` and the focused-row aria
   * activedescendant link. */
  pageId: string
  /** Raw title — `null` falls back to the localised "Untitled" string. */
  title: string | null
  /** Trimmed filter text for the `HighlightMatch` mark. Pass `''` when
   * not filtering. */
  filterText: string

  // ── Virtualizer chrome ─────────────────────────────────────────────
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
  /**
   * #4709 — another page in this view carries the identical title. Page
   * titles are not unique (pages are ULID-keyed), and the Pages tree now
   * renders every colliding page instead of dropping all but the last,
   * so two rows can read `Agaric`. Renders the page's creation date —
   * decoded from the ULID, the one property that reliably differs —
   * after the title so the rows can be told apart.
   */
  duplicateTitle: boolean

  // ── Typed metadata primitives (Phase 1 IPC columns) ────────
  /** Epoch-ms from `last_modified_at` (#109 Phase 2). `null` renders "never". */
  lastModifiedAt: number | null
  /** Inbound link count. Zero suppresses the ↗ badge. */
  inboundLinkCount: number
  /** Descendant non-deleted block count. Zero suppresses the ⊟ badge. */
  childBlockCount: number
  /** Page itself carries `block_tags`. */
  hasTags: boolean
  /** Some descendant has a non-null `todo_state`. */
  hasTodo: boolean
  /** Some descendant has a non-null `scheduled_date`. */
  hasScheduled: boolean
  /** Some descendant has a non-null `due_date`. */
  hasDue: boolean

  // ── Multi-select (#81) ───────────────────────────────────
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
   * the parent's dialog target. */
  onDeleteRequest: (target: { id: string; name: string } | null) => void

  // ── Prefetch (#2850) ─────────────────────────────────────────────────
  /**
   * Shared viewport-intersection observer instantiated once by the parent
   * list. Drives the mobile/no-hover prefetch fallback — this row schedules
   * a speculative prefetch as it scrolls within `rootMargin` of the
   * viewport, alongside the desktop hover/focus intent.
   */
  viewport: ViewportObserver
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
      // #1966 mobile: hide the property-flag badges on narrow rows so the page
      // title (which truncates) keeps usable width instead of collapsing to a
      // few characters. Counts + flags return at `sm`+; the short relative-time
      // stays.
      className="inline-flex shrink-0 items-center rounded-md border border-border/60 px-1.5 py-0 text-[10px] font-medium text-muted-foreground max-sm:hidden"
    >
      #{label}
    </span>
  )
}

/** Build the ordered list of flag tokens a page carries; the row renders
 * the first. Pure — exported only so the test file can assert against the
 * same allowlist without depending on render output. */
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

function PageRowInner(props: PageRowProps): React.ReactElement {
  const { t } = useTranslation()
  const {
    pageId,
    title: rawTitle,
    filterText,
    virtualRowIndex,
    virtualRowStart,
    measureElement,
    pageIndex,
    focusedIndex,
    starred,
    showAliasBadge,
    deleting,
    duplicateTitle,
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
    viewport,
  } = props

  const title = rawTitle ?? t('pageBrowser.untitled')
  const trimmedFilter = filterText.trim()
  const focused = focusedIndex === pageIndex

  // #2850 — hover/focus + viewport-approach prefetch intent, sharing one
  // dwell timer (both trigger sources debounce onto the same schedule/cancel
  // pair, so a hover AND a viewport-entry for the same row within the dwell
  // window still fire at most one prefetch).
  const prefetchIntent = usePagePrefetchIntent()

  // Mobile/no-hover fallback (#2850): mirrors the `SortableBlockWrapper`
  // per-id subscription pattern against the SAME shared `viewport` instance
  // (one IntersectionObserver for the whole list, not one per row). When
  // this row's page comes within `rootMargin` of the viewport, schedule the
  // dwell-debounced prefetch; leaving the margin cancels a still-pending one
  // (a fast scroll-past must not fire N prefetches for rows never lingered
  // on).
  const offscreen = useSyncExternalStore(
    useCallback((onChange) => viewport.subscribe(pageId, onChange), [viewport, pageId]),
    () => viewport.isOffscreen(pageId),
  )
  useEffect(() => {
    if (offscreen) {
      prefetchIntent.cancel()
    } else {
      prefetchIntent.schedule(pageId)
    }
    // `prefetchIntent` itself is NOT a dep — `schedule`/`cancel` are
    // identity-stable for the hook's lifetime (see `useDebouncedCallback`),
    // so this only needs to re-run when the offscreen membership or the
    // page id actually changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [offscreen, pageId])

  const observeRef = useCallback(
    (el: HTMLElement | null) => {
      viewport.createObserveRef(pageId)(el)
      measureElement?.(el)
    },
    [viewport, pageId, measureElement],
  )

  const relative = formatRelativeShort(lastModifiedAt)
  const relativeLabel = relative === '' ? t('pageBrowser.metadata.never') : relative
  const firstFlag = collectFlagTokens({ hasTags, hasTodo, hasScheduled, hasDue })[0]

  return (
    <div
      // Stable id so the grid container's `aria-activedescendant`
      // can point at this row when keyboard nav lands on it.
      id={`page-row-${pageId}`}
      data-index={virtualRowIndex}
      ref={observeRef}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- CSS-grid row inside role="grid"; a real <tr> needs a <table> and breaks the flex layout
      role="row"
      aria-selected={focused}
      data-page-item
      data-starred={starred}
      data-selected={multiSelected}
      tabIndex={-1}
      // #2850 — hover intent anywhere on the row; the inner title button
      // carries the matching onFocus/onBlur (it's the actual focusable
      // element for keyboard nav).
      onMouseEnter={() => prefetchIntent.schedule(pageId)}
      onMouseLeave={prefetchIntent.cancel}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
        focused && 'list-cursor',
      )}
      style={rowStyle(virtualRowStart)}
    >
      {/* #81 / batch-selection checkbox. Always present (it is
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
          size="icon-xs"
          aria-label={starred ? t('pageBrowser.removeBookmark') : t('pageBrowser.addBookmark')}
          className="star-toggle shrink-0 touch-target opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 focus-visible:opacity-100 focus-visible:ring-inset transition-opacity text-muted-foreground hover:text-star data-[starred=true]:opacity-100 data-[starred=true]:text-star"
          data-starred={starred}
          onClick={(e) => {
            e.stopPropagation()
            onToggleStar(pageId)
          }}
        >
          <Bookmark className="h-3.5 w-3.5" fill={starred ? 'currentColor' : 'none'} />
        </Button>
        <button
          type="button"
          className="page-browser-item flex flex-1 min-w-0 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer focus-ring-visible focus-visible:ring-inset"
          onClick={() => onSelect(pageId, title)}
          // #2850 — keyboard focus intent (mirrors the row's hover intent
          // above); this button is the row's actual focusable element.
          onFocus={() => prefetchIntent.schedule(pageId)}
          onBlur={prefetchIntent.cancel}
        >
          <span className="flex items-center gap-3 min-w-0">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="page-browser-item-title truncate" title={title}>
              <HighlightMatch text={title} filterText={trimmedFilter} />
              {showAliasBadge && (
                <span className="alias-badge text-xs text-muted-foreground">(alias)</span>
              )}
              {duplicateTitle && <DuplicateTitleCue pageId={pageId} className="ml-2" />}
            </span>
          </span>
          <span
            data-page-metadata
            className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-xs text-muted-foreground"
          >
            {inboundLinkCount > 0 && (
              <span data-metadata-inbound className="max-sm:hidden">
                <span aria-hidden="true">{`${inboundLinkCount} ↗`}</span>
                <span className="sr-only">
                  {t('pageBrowser.metadata.inbound', { count: inboundLinkCount })}
                </span>
              </span>
            )}
            {childBlockCount > 0 && (
              <span data-metadata-children className="max-sm:hidden">
                <span aria-hidden="true">{`${childBlockCount} ⊟`}</span>
                <span className="sr-only">
                  {t('pageBrowser.metadata.children', { count: childBlockCount })}
                </span>
              </span>
            )}
            <span data-metadata-relative>
              <span aria-hidden="true">{relativeLabel}</span>
              <span className="sr-only">
                {t('pageBrowser.metadata.lastModified', { relative: relativeLabel })}
              </span>
            </span>
            {firstFlag && (
              <PropertyFlagBadge token={firstFlag} label={t(FLAG_LABEL_KEY[firstFlag])} />
            )}
          </span>
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
 * Memoised `PageRow`. All props are primitives (or stable
 * callbacks/refs from the parent) so the default shallow compare hits
 * across parent re-renders.
 */
export const PageRow = memo(PageRowInner)
PageRow.displayName = 'PageRow'
