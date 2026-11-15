/**
 * OutgoingLinks — what a page's blocks link to (#6749), beside its linked and
 * unlinked references: grouped by the page each target lives on, the targets
 * that do not resolve (trashed, purged, another space) in a group of their
 * own, page links and block references told apart by the kind toggle the
 * linked references use. Each row names the linking block and jumps to it.
 *
 * Collapsed by default, and read only once opened, so a page open pays
 * nothing for it.
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import type React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { KindToggle } from '@/components/backlinks/LinkedReferences'
import { CollapsibleGroupList } from '@/components/common/CollapsibleGroupList'
import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { renderRichContent } from '@/components/RichContentRenderer'
import { useInvalidateOnGraphStructure } from '@/hooks/useInvalidateOnGraphStructure'
import { useRichContentCallbacks } from '@/hooks/useRichContentCallbacks'
import { unwrap } from '@/lib/app-error'
import type { LinkKind, OutgoingLinkRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { queryClient } from '@/lib/query-client'
import { requireActiveScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'

export interface OutgoingLinksProps {
  pageId: string
  pageTitle: string
  onNavigateToPage?: NavigateToPageFn | undefined
}

/** The group key of the unresolved targets; no page id is empty. */
const UNRESOLVED = ''

interface LinkGroup {
  page_id: string
  page_title: string | null
  blocks: (OutgoingLinkRow & { id: string })[]
}

/** The rows in their order, each run of one target page a group. */
function groupRows(rows: OutgoingLinkRow[], unresolvedTitle: string): LinkGroup[] {
  const groups = new Map<string, LinkGroup>()
  for (const row of rows) {
    const key = row.target_page_id ?? UNRESOLVED
    let group = groups.get(key)
    if (!group) {
      group = {
        page_id: key,
        page_title: key === UNRESOLVED ? unresolvedTitle : row.target_page_title,
        blocks: [],
      }
      groups.set(key, group)
    }
    group.blocks.push({ ...row, id: `${row.source_id}:${row.target_id}` })
  }
  return [...groups.values()]
}

export function OutgoingLinks({
  pageId,
  pageTitle,
  onNavigateToPage,
}: OutgoingLinksProps): React.ReactElement {
  const { t } = useTranslation()
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const [collapsed, setCollapsed] = useState(true)
  const [kind, setKind] = useState<LinkKind | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  // Another page opens collapsed, every kind, as a page opens (#4407's render-phase reset).
  const [panelForPage, setPanelForPage] = useState(pageId)
  if (panelForPage !== pageId) {
    setPanelForPage(pageId)
    setCollapsed(true)
    setKind(null)
    setExpandedGroups({})
  }
  const callbacks = useRichContentCallbacks()

  const prefix = useMemo(() => ['outgoingLinks', spaceId, pageId], [spaceId, pageId])
  useInvalidateOnGraphStructure(prefix)
  const { data, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(
      {
        queryKey: [...prefix, kind],
        queryFn: async ({ pageParam }) =>
          unwrap(
            await commands.listOutgoingLinks(
              pageId,
              kind,
              pageParam,
              PAGINATION_LIMIT,
              requireActiveScope(spaceId as string),
            ),
          ),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
        enabled: !collapsed && spaceId !== null,
      },
      queryClient,
    )

  const rows = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  const groups = useMemo(() => groupRows(rows, t('outgoingLinks.unresolved')), [rows, t])

  return (
    <section
      className="outgoing-links"
      data-testid="outgoing-links"
      aria-label={t('outgoingLinks.header')}
    >
      <CollapsiblePanelHeader isCollapsed={collapsed} onToggle={() => setCollapsed((c) => !c)}>
        {t('outgoingLinks.header')}
      </CollapsiblePanelHeader>
      {!collapsed && (
        <>
          <div className="mt-1 px-2">
            <KindToggle kind={kind} onKindChange={setKind} />
          </div>
          <ListViewState
            loading={isLoading}
            items={groups}
            empty={<EmptyState compact headingLevel="p" message={t('outgoingLinks.empty')} />}
            error={isError && t('outgoingLinks.loadFailed')}
            onRetry={() => void refetch()}
          >
            {() => (
              <div className="mt-1 space-y-2">
                <CollapsibleGroupList
                  groups={groups}
                  expandedGroups={expandedGroups}
                  onToggleGroup={(id) =>
                    setExpandedGroups((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))
                  }
                  defaultExpanded
                  untitledLabel={t('references.untitled')}
                  listClassName="ml-4 mt-1 space-y-1"
                  listAriaLabel={(title) => t('outgoingLinks.listLabel', { title })}
                  renderBlock={(link) => (
                    <li key={link.id}>
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted/50 focus-ring-visible [@media(pointer:coarse)]:min-h-11"
                        onClick={() => onNavigateToPage?.(pageId, pageTitle, link.source_id)}
                      >
                        <span className="truncate">
                          {link.source_content
                            ? renderRichContent(link.source_content, {
                                interactive: false,
                                inline: true,
                                anchorRefId: link.target_id,
                                ...callbacks,
                              })
                            : t('references.empty')}
                        </span>
                      </button>
                    </li>
                  )}
                />
                <LoadMoreButton
                  hasMore={hasNextPage}
                  loading={isFetchingNextPage}
                  onLoadMore={() => void fetchNextPage()}
                  label={t('references.loadMore')}
                  loadingLabel={t('references.loading')}
                />
              </div>
            )}
          </ListViewState>
        </>
      )}
    </section>
  )
}
