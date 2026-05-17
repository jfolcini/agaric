/**
 * CollapsibleGroupList -- shared grouped list component with collapsible headers.
 *
 * Used by LinkedReferences and UnlinkedReferences to render groups of blocks
 * with a chevron toggle, title, and count. Block rendering is delegated to
 * a render prop so each consumer can provide its own block UI.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { PageLink } from './PageLink'

export interface GroupItem {
  page_id: string
  page_title: string | null
  blocks: { id: string }[]
}

export interface CollapsibleGroupListProps<G extends GroupItem> {
  /** The groups to render */
  groups: G[]
  /** Which groups are expanded (keyed by page_id) */
  expandedGroups: Record<string, boolean>
  /** Toggle callback */
  onToggleGroup: (pageId: string) => void
  /** Label for untitled groups (null page_title) */
  untitledLabel: string
  /** Render each block in a group — must return a <li> with a key */
  renderBlock: (block: G['blocks'][number], group: G) => React.ReactNode
  /** Fallback expand state when a group is not in expandedGroups (default: false) */
  defaultExpanded?: boolean
  /** CSS class for the group container div */
  groupClassName?: string
  /** CSS class for the header button */
  headerClassName?: string
  /** CSS class for the block list <ul> */
  listClassName?: string
  /** Accessible label for the block list (receives the resolved group title) */
  listAriaLabel?: (title: string) => string
  /** When provided, clicking the page title navigates instead of toggling */
  onPageTitleClick?: (pageId: string, title: string) => void
  /**
   * PEND-50 Phase 1 — optional `role` for the inner `<ul>`. Defaults to
   * the implicit `list` (no attribute) so existing consumers
   * (LinkedReferences / UnlinkedReferences) are unaffected. Search-result
   * grouping passes `"listbox"` so each group becomes its own
   * `aria-activedescendant`-driven listbox per the PEND-50 a11y model.
   */
  listRole?: 'listbox' | undefined
  /**
   * PEND-50 Phase 1 — `aria-activedescendant` for the inner `<ul>`,
   * resolved per-group by the caller. Threaded only when `listRole` is
   * `"listbox"`.
   */
  listAriaActiveDescendant?: (group: G) => string | undefined
  /**
   * PEND-50 Phase 1 — `tabIndex` for the inner `<ul>` (default `undefined`).
   * Search uses `0` on the focused group's listbox so keyboard nav lands
   * on the right element when the user Tabs into the results.
   */
  listTabIndex?: (group: G) => number | undefined
  /**
   * PEND-50 Phase 1 — `onKeyDown` for the inner `<ul>`. Search wires the
   * roving-focus hook here so ArrowUp/Down traverse the flattened result
   * set across groups.
   */
  listOnKeyDown?: (e: React.KeyboardEvent<HTMLUListElement>, group: G) => void
  /** PEND-50 Phase 1 — `data-testid` for the inner `<ul>`, for test selectors. */
  listDataTestId?: (group: G) => string | undefined
  /**
   * PEND-50 Phase 1 — override the per-group count label rendered next
   * to the title. Defaults to `(N)`. Search uses this to surface page-
   * name-only hits as "1 match (in name)" so the user understands why
   * a content-less group is in the result set.
   */
  formatCount?: (group: G) => string
}

export function CollapsibleGroupList<G extends GroupItem>({
  groups,
  expandedGroups,
  onToggleGroup,
  untitledLabel,
  renderBlock,
  defaultExpanded = false,
  groupClassName,
  headerClassName,
  listClassName,
  listAriaLabel,
  onPageTitleClick,
  listRole,
  listAriaActiveDescendant,
  listTabIndex,
  listOnKeyDown,
  listDataTestId,
  formatCount,
}: CollapsibleGroupListProps<G>): React.ReactElement {
  const { t } = useTranslation()
  return (
    <>
      {groups.map((group) => {
        const isExpanded = expandedGroups[group.page_id] ?? defaultExpanded
        const title = group.page_title ?? untitledLabel
        const countLabel = formatCount ? formatCount(group) : `(${group.blocks.length})`
        return (
          <div key={group.page_id} className={groupClassName}>
            {onPageTitleClick ? (
              <div
                className={
                  headerClassName ??
                  'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent/50 active:bg-accent/70 transition-colors'
                }
              >
                <button
                  type="button"
                  onClick={() => onToggleGroup(group.page_id)}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? t('group.collapseGroup') : t('group.expandGroup')}
                >
                  <ChevronToggle isExpanded={isExpanded} size="md" />
                </button>
                <PageLink
                  pageId={group.page_id}
                  title={title}
                  className="flex-1 truncate text-left"
                />
                <span>{countLabel}</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onToggleGroup(group.page_id)}
                className={
                  headerClassName ??
                  'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent/50 active:bg-accent/70 transition-colors'
                }
                aria-expanded={isExpanded}
              >
                <ChevronToggle isExpanded={isExpanded} size="md" />
                {title} {countLabel}
              </button>
            )}
            {isExpanded && (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: `aria-activedescendant` is gated on `listRole === 'listbox'` at runtime; biome can't see the conditional. PEND-50 sets `listRole="listbox"` on search-result lists; other consumers leave `listRole` unset and never receive the attribute.
              <ul
                className={listClassName ?? 'ml-4 mt-1 space-y-1'}
                aria-label={listAriaLabel?.(title)}
                role={listRole}
                aria-activedescendant={
                  listRole === 'listbox' ? listAriaActiveDescendant?.(group) : undefined
                }
                tabIndex={listTabIndex?.(group)}
                data-testid={listDataTestId?.(group)}
                onKeyDown={listOnKeyDown ? (e) => listOnKeyDown(e, group) : undefined}
              >
                {group.blocks.map((block) => renderBlock(block, group))}
              </ul>
            )}
          </div>
        )
      })}
    </>
  )
}
