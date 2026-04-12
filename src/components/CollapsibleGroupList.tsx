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
}: CollapsibleGroupListProps<G>): React.ReactElement {
  const { t } = useTranslation()
  return (
    <>
      {groups.map((group) => {
        const isExpanded = expandedGroups[group.page_id] ?? defaultExpanded
        const title = group.page_title ?? untitledLabel
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
                <span>({group.blocks.length})</span>
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
                {title} ({group.blocks.length})
              </button>
            )}
            {isExpanded && (
              <ul
                className={listClassName ?? 'ml-4 mt-1 space-y-1'}
                aria-label={listAriaLabel?.(title)}
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
