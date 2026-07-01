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
 * `src-tauri/src/backlink/grouped.rs` (I-Search-12: option (a),
 * reshuffling groups by the user's sort key, was rejected for UX reasons —
 * stable alphabetical group order preserves muscle memory). This component
 * therefore renders groups in the order it receives them and must not
 * re-sort them client-side.
 */

import type React from 'react'
import { memo, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { CollapsibleGroupList } from '@/components/common/CollapsibleGroupList'
import { renderRichContent } from '@/components/RichContentRenderer'
import { Badge } from '@/components/ui/badge'
import { useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import type { NavigateToPageFn } from '@/lib/block-events'
import type { BacklinkGroup, BlockRow } from '@/lib/tauri'
import { useResolveStore } from '@/stores/resolve'

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
   * Marks the section as showing `t('references.linkedBadge')`
   * (`[[ref]]`) or `t('references.unlinkedBadge')` (mention without link)
   * backlinks. When provided, a small badge is
   * rendered above the group list so users can tell the two sections apart
   * at a glance. Optional to keep this component reusable.
   */
  linkType?: 'linked' | 'unlinked'
}

interface BacklinkRowProps {
  block: BlockRow
  onBlockClick: (block: BlockRow) => void
  onBlockKeyDown: (e: React.KeyboardEvent, block: BlockRow) => void
  onTagClick: (id: string) => void
  resolveBlockTitle: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagName: (id: string) => string
  emptyLabel: string
}

/**
 * A single backlink list row. Memoized so that the parent
 * `LinkedReferences` re-rendering on every arrow-key / focus change does not
 * re-run `renderRichContent` → `parse(block.content)` for every visible
 * backlink (#2193).
 *
 * The rich-content parse is wrapped in a `useMemo` keyed on `block.content`
 * and the resolve-store `version`. All click / resolve callbacks are threaded
 * via refs read at call-time so a fresh parent closure (new callback identity
 * each render) does NOT bust the memo — staleness is benign because any
 * change to what the resolve callbacks return bumps the resolve `version`,
 * which is a memo dependency and forces a recompute.
 */
function BacklinkRowInner({
  block,
  onBlockClick,
  onBlockKeyDown,
  onTagClick,
  resolveBlockTitle,
  resolveBlockStatus,
  resolveTagName,
  emptyLabel,
}: BacklinkRowProps): React.ReactElement {
  const onBlockClickRef = useRef(onBlockClick)
  onBlockClickRef.current = onBlockClick
  const onBlockKeyDownRef = useRef(onBlockKeyDown)
  onBlockKeyDownRef.current = onBlockKeyDown
  const onTagClickRef = useRef(onTagClick)
  onTagClickRef.current = onTagClick
  const resolveBlockTitleRef = useRef(resolveBlockTitle)
  resolveBlockTitleRef.current = resolveBlockTitle
  const resolveBlockStatusRef = useRef(resolveBlockStatus)
  resolveBlockStatusRef.current = resolveBlockStatus
  const resolveTagNameRef = useRef(resolveTagName)
  resolveTagNameRef.current = resolveTagName

  const resolveVersion = useResolveStore((s) => s.version)
  const richContent = useMemo(
    () =>
      block.content
        ? renderRichContent(block.content, {
            interactive: true,
            onTagClick: (id) => onTagClickRef.current(id),
            resolveBlockTitle: (id) => resolveBlockTitleRef.current(id),
            resolveTagName: (id) => resolveTagNameRef.current(id),
            resolveBlockStatus: (id) => resolveBlockStatusRef.current(id),
          })
        : emptyLabel,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolve/onTagClick callbacks captured via refs (intentional perf optimization — see comment above); resolveVersion drives recomputation on cache updates
    [block.content, resolveVersion, emptyLabel],
  )

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- keyboard-navigable reference row; click/keydown drive roving focus and block activation, the row is the interactive unit
    <li
      className="linked-reference-item flex flex-wrap items-center gap-3 border-b py-1.5 px-2 last:border-b-0 cursor-pointer hover:bg-muted/50"
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- li needs tabIndex for keyboard navigation
      tabIndex={0}
      onClick={() => onBlockClickRef.current(block)}
      onKeyDown={(e) => onBlockKeyDownRef.current(e, block)}
    >
      <Badge tone="secondary" className="linked-reference-item-type shrink-0">
        {block.block_type}
      </Badge>
      <span className="linked-reference-item-text text-sm flex-1 truncate">{richContent}</span>
      <span className="linked-reference-item-id text-xs text-muted-foreground font-mono">
        {block.id.slice(0, 8)}...
      </span>
    </li>
  )
}

const BacklinkRow = memo(BacklinkRowInner)
BacklinkRow.displayName = 'BacklinkRow'

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
            tone="outline"
            className="linked-references-link-type-badge text-xs font-normal text-muted-foreground"
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
          <BacklinkRow
            key={block.id}
            block={block}
            onBlockClick={handleBlockClick}
            onBlockKeyDown={handleBlockKeyDown}
            onTagClick={onTagClick}
            resolveBlockTitle={resolveBlockTitle}
            resolveBlockStatus={resolveBlockStatus}
            resolveTagName={resolveTagName}
            emptyLabel={t('references.empty')}
          />
        )}
      />
    </>
  )
}
