/**
 * BacklinkGroupRenderer -- renders grouped backlink blocks with collapsible headers.
 *
 * Each group shows a page title header with expand/collapse toggle and a list of
 * block items with badges, rich content, and truncated IDs.
 *
 * ## Sort asymmetry (deliberate)
 *
 * The `groups` prop arrives pre-ordered by the backend
 * (`eval_backlink_query_grouped`): groups are **always** sorted
 * alphabetically by `page_title`, regardless of the user-supplied
 * `BacklinkSort`. The user's sort applies only to block ordering
 * **within** each group. This mirrors the backend contract — see
 * `src-tauri/src/backlink/grouped.rs` and REVIEW-LATER `I-Search-12`
 * (option (a), reshuffling groups by the user's sort key, was rejected
 * for UX reasons: stable alphabetical group order preserves muscle
 * memory). This component therefore renders groups in the order it
 * receives them and must not re-sort them client-side.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { useTagClickHandler } from '../hooks/useRichContentCallbacks'
import type { NavigateToPageFn } from '../lib/block-events'
import type { BacklinkGroup, BlockRow } from '../lib/tauri'
import { CollapsibleGroupList } from './CollapsibleGroupList'
import { renderRichContent } from './StaticBlock'

export interface BacklinkGroupRendererProps {
  groups: BacklinkGroup[]
  expandedGroups: Record<string, boolean>
  onToggleGroup: (pageId: string) => void
  onNavigateToPage?: NavigateToPageFn | undefined
  handleBlockClick: (block: BlockRow) => void
  handleBlockKeyDown: (e: React.KeyboardEvent, block: BlockRow) => void
  resolveBlockTitle: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagName: (id: string) => string
  /**
   * UX-271: Marks the section as showing "Linked" (`[[ref]]`) or "Unlinked"
   * (mention without link) backlinks. When provided, a small badge is
   * rendered above the group list so users can tell the two sections apart
   * at a glance. Optional to keep this component reusable.
   */
  linkType?: 'linked' | 'unlinked'
}

export function BacklinkGroupRenderer({
  groups,
  expandedGroups,
  onToggleGroup,
  onNavigateToPage,
  handleBlockClick,
  handleBlockKeyDown,
  resolveBlockTitle,
  resolveBlockStatus,
  resolveTagName,
  linkType,
}: BacklinkGroupRendererProps): React.ReactElement {
  const { t } = useTranslation()
  const onTagClick = useTagClickHandler()

  return (
    <>
      {linkType && (
        <div className="flex justify-end px-2 pb-1">
          <Badge
            variant="outline"
            className="linked-references-link-type-badge text-[10px] font-normal text-muted-foreground"
          >
            {linkType === 'linked' ? t('references.linkedBadge') : t('references.unlinkedBadge')}
          </Badge>
        </div>
      )}
      <CollapsibleGroupList
        groups={groups}
        expandedGroups={expandedGroups}
        onToggleGroup={onToggleGroup}
        untitledLabel={t('references.untitled')}
        groupClassName="linked-references-group"
        headerClassName="linked-references-group-header flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent/50 active:bg-accent/70 transition-colors"
        listClassName="linked-references-blocks ml-4 mt-1 space-y-1"
        listAriaLabel={(title) => t('references.backlinksFrom', { title })}
        {...(onNavigateToPage && {
          onPageTitleClick: (pageId: string, title: string) => onNavigateToPage(pageId, title),
        })}
        renderBlock={(block, _group) => (
          <li
            key={block.id}
            className="linked-reference-item flex flex-wrap items-center gap-3 border-b py-1.5 px-2 last:border-b-0 cursor-pointer hover:bg-muted/50"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
            tabIndex={0}
            onClick={() => handleBlockClick(block)}
            onKeyDown={(e) => handleBlockKeyDown(e, block)}
          >
            <Badge variant="secondary" className="linked-reference-item-type shrink-0">
              {block.block_type}
            </Badge>
            <span className="linked-reference-item-text text-sm flex-1 truncate">
              {block.content
                ? renderRichContent(block.content, {
                    interactive: true,
                    onTagClick,
                    resolveBlockTitle,
                    resolveTagName,
                    resolveBlockStatus,
                  })
                : t('references.empty')}
            </span>
            <span className="linked-reference-item-id text-xs text-muted-foreground font-mono">
              {block.id.slice(0, 8)}...
            </span>
          </li>
        )}
      />
    </>
  )
}
