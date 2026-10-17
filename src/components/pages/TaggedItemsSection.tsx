/**
 * TaggedItemsSection — the pages and the blocks a tag is on, shown on the
 * tag's own page, which every tag click (Tags view, tag chips) opens and which
 * holds no blocks of its own (#4725).
 *
 * Only direct tags count: the tag attached to the row itself or written in it
 * as `#tag` (`TagOrRef`, the union the Tags list counts). A block under a
 * tagged page or block only inherits the tag and is not listed. Each panel is
 * one cursor-paginated `run_advanced_query`, newest first; the blocks panel
 * groups the loaded rows by page and renders them the way Linked references
 * does, each row expandable to its children.
 *
 * "Search everything under #tag" opens Search on `under:#tag`, which also
 * matches the blocks that only inherit the tag.
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import { FileText, Search, Tag } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  BacklinkGroupRenderer,
  type BlockChildren,
} from '@/components/backlinks/BacklinkGroupRenderer'
import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { BlockListItem } from '@/components/editor/BlockListItem'
import { TaggedBlockChildren } from '@/components/pages/TaggedBlockChildren'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { useBacklinkResolution } from '@/hooks/useBacklinkResolution'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useFocusedRowEffect } from '@/hooks/useFocusedRowEffect'
import { useKeyboardNavigableList } from '@/hooks/useKeyboardNavigableList'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { unwrap } from '@/lib/app-error'
import type {
  AdvancedQueryResponse,
  BacklinkGroup,
  BlockRow,
  QueryResultRow,
  SortKey,
} from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { queryClient } from '@/lib/query-client'
import { tokenSource } from '@/lib/search-query'
import { useNavigationStore } from '@/stores/navigation'
import { resolveTitles } from '@/stores/resolve-titles'
import { useSpaceStore } from '@/stores/space'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

const QUERY_KEY = 'taggedItems'
const NEWEST_FIRST: SortKey[] = [{ source: { type: 'Column', name: 'created' }, desc: true }]
const NOTHING: AdvancedQueryResponse = {
  rows: [],
  nextCursor: null,
  hasMore: false,
  totalCount: null,
}
const FOCUS_CLASSES = ['list-cursor'] as const

type TaggedKind = 'page' | 'content'

function blockRowDomId(blockId: string): string {
  return `tagged-block-${blockId}`
}

export interface TaggedItemsSectionProps {
  tagId: string
  /** The tag's name, which the search link writes into the query. */
  tagName: string
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function TaggedItemsSection({
  tagId,
  tagName,
  onNavigateToPage,
}: TaggedItemsSectionProps): React.ReactElement {
  const { t } = useTranslation()
  // A sync or MCP write can tag or untag anything while this page is open.
  useEffect(
    () =>
      subscribeToNameChanges((change) => {
        if (change.kind === 'invalidated') {
          void queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
        }
      }),
    [],
  )

  return (
    <div className="space-y-6" data-testid="tagged-items">
      <Button variant="link" size="sm" className="px-0" onClick={() => searchUnder(tagName)}>
        <Search aria-hidden="true" />
        {t('taggedItems.searchUnder', { name: tagName })}
      </Button>
      <TaggedPages tagId={tagId} onNavigateToPage={onNavigateToPage} />
      <TaggedBlocks tagId={tagId} onNavigateToPage={onNavigateToPage} />
    </div>
  )
}

function searchUnder(tagName: string): void {
  useCommandPaletteStore
    .getState()
    .setPendingViewQuery(tokenSource({ kind: 'under', value: tagName, span: [0, 0] }))
  useNavigationStore.getState().setView('search')
}

function renderChildren(block: BlockRow): React.ReactNode {
  return block.page_id ? <TaggedBlockChildren blockId={block.id} pageId={block.page_id} /> : null
}

/** The rows of one block type that carry `tagId` directly, newest first. */
function useTaggedRows(tagId: string, kind: TaggedKind) {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const query = useInfiniteQuery(
    {
      queryKey: [QUERY_KEY, currentSpaceId, tagId, kind],
      queryFn: async ({ pageParam }): Promise<AdvancedQueryResponse> => {
        if (currentSpaceId == null) return NOTHING
        try {
          return unwrap(
            await commands.runAdvancedQuery({
              spaceId: currentSpaceId,
              filter: {
                type: 'And',
                children: [
                  { type: 'Leaf', primitive: { type: 'TagOrRef', tag: tagId } },
                  {
                    type: 'Leaf',
                    primitive: { type: 'BlockType', values: [kind], exclude: false },
                  },
                ],
              },
              sort: NEWEST_FIRST,
              cursor: pageParam ?? null,
              limit: PAGINATION_LIMIT,
            }),
          )
        } catch (err) {
          logger.error('TaggedItemsSection', 'failed to load tagged items', { tagId, kind }, err)
          throw err
        }
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
      // The client never goes stale on its own; tagging happens on other pages.
      refetchOnMount: 'always',
    },
    queryClient,
  )
  const rows = useMemo<QueryResultRow[]>(
    () => query.data?.pages.flatMap((p) => p.rows) ?? [],
    [query.data],
  )
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  return { ...query, rows, loadMore }
}

interface PanelProps {
  tagId: string
  onNavigateToPage: NavigateToPageFn | undefined
}

/** A titled panel with the list states every panel shares. */
function Panel({
  kind,
  heading,
  query,
  empty,
  children,
}: {
  kind: TaggedKind
  heading: string
  query: ReturnType<typeof useTaggedRows>
  empty: React.ReactNode
  children: (headingId: string) => React.ReactNode
}): React.ReactElement {
  const { t } = useTranslation()
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} data-testid={`tagged-${kind}`}>
      <h2 id={headingId} className="mb-2 text-sm font-semibold text-muted-foreground">
        {heading}
      </h2>
      <ListViewState
        loading={query.isFetching}
        items={query.rows}
        skeleton={<LoadingSkeleton count={2} height="h-10" />}
        error={query.isError && t('taggedItems.loadFailed')}
        onRetry={() => void query.refetch()}
        empty={empty}
      >
        {() => children(headingId)}
      </ListViewState>
      <LoadMoreButton
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onLoadMore={query.loadMore}
        className="mt-2"
      />
    </section>
  )
}

function TaggedPages({ tagId, onNavigateToPage }: PanelProps): React.ReactElement {
  const { t } = useTranslation()
  const query = useTaggedRows(tagId, 'page')
  const { rows } = query
  const untitled = t('common.untitled')
  const open = useCallback(
    (row: QueryResultRow) => onNavigateToPage?.(row.id, row.content || untitled),
    [onNavigateToPage, untitled],
  )
  const { focusedIndex, handleKeyDown, listRef } = useKeyboardNavigableList<HTMLUListElement>(
    rows.length,
    (index) => {
      const row = rows[index]
      if (row) open(row)
    },
    { homeEnd: true, pageUpDown: true, resetKey: tagId },
  )

  return (
    <Panel
      kind="page"
      heading={t('taggedItems.pages')}
      query={query}
      empty={
        <EmptyState compact icon={FileText} headingLevel="p" message={t('taggedItems.noPages')} />
      }
    >
      {(headingId) => (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys bubble here from the roving row, the list's single tab stop
        <ul
          ref={listRef}
          aria-labelledby={headingId}
          className="m-0 list-none p-0"
          onKeyDown={(e) => {
            if (handleKeyDown(e)) e.preventDefault()
          }}
        >
          {rows.map((row, index) => (
            <BlockListItem
              key={row.id}
              content={row.content}
              className="py-1.5 hover:bg-muted/50 active:bg-muted/70"
              contentClassName="truncate"
              onClick={() => open(row)}
              isFocused={focusedIndex === index}
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function TaggedBlocks({ tagId, onNavigateToPage }: PanelProps): React.ReactElement {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const query = useTaggedRows(tagId, 'content')
  const { rows } = query
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggleChildren = useCallback((blockId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(blockId)) next.add(blockId)
      return next
    })
  }, [])
  const blockChildren = useMemo<BlockChildren>(
    () => ({ expanded, onToggle: toggleChildren, render: renderChildren }),
    [expanded, toggleChildren],
  )

  useEffect(() => {
    if (currentSpaceId == null) return
    const pageIds = [...new Set(rows.flatMap((b) => (b.page_id ? [b.page_id] : [])))]
    if (pageIds.length === 0) return
    let cancelled = false
    resolveTitles(currentSpaceId, pageIds)
      .then((titles) => {
        if (!cancelled) setPageTitles((prev) => new Map([...prev, ...titles]))
      })
      .catch((err: unknown) => {
        logger.warn('TaggedItemsSection', 'failed to resolve page titles', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [rows, currentSpaceId])

  // Rows arrive newest first, so a page's group sits where its newest block does.
  const groups = useMemo<BacklinkGroup[]>(() => {
    const byPage = new Map<string, BacklinkGroup>()
    for (const row of rows) {
      const pageId = row.page_id ?? row.id
      let group = byPage.get(pageId)
      if (!group) {
        group = { page_id: pageId, page_title: pageTitles.get(pageId) ?? null, blocks: [] }
        byPage.set(pageId, group)
      }
      group.blocks.push(row)
    }
    return [...byPage.values()]
  }, [rows, pageTitles])
  const expandedGroups = useMemo(
    () => Object.fromEntries(groups.map((g) => [g.page_id, !collapsed[g.page_id]])),
    [groups, collapsed],
  )
  const toggleGroup = useCallback((pageId: string) => {
    setCollapsed((prev) => ({ ...prev, [pageId]: !prev[pageId] }))
  }, [])

  const { resolveBlockTitle, resolveBlockStatus, resolveTagName } = useBacklinkResolution(groups)
  const { handleBlockClick, handleBlockKeyDown } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: t('common.untitled'),
  })

  const visibleBlocks = useMemo(
    () => groups.flatMap((g) => (collapsed[g.page_id] ? [] : g.blocks)),
    [groups, collapsed],
  )
  const listRef = useRef<HTMLDivElement>(null)
  const { focusedIndex, setFocusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: visibleBlocks.length,
    listRef,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (index) => {
      const block = visibleBlocks[index]
      if (block) handleBlockClick(block)
    },
  })
  const focusedBlockId = visibleBlocks[focusedIndex]?.id ?? null
  useFocusedRowEffect({
    containerRef: listRef,
    focusedRowId: focusedBlockId,
    rowAttr: 'data-backlink-item',
    focusClasses: FOCUS_CLASSES,
    setFocusedIndex,
    resetDeps: [groups, collapsed, setFocusedIndex],
  })

  return (
    <Panel
      kind="content"
      heading={t('taggedItems.blocks')}
      query={query}
      empty={<EmptyState compact icon={Tag} headingLevel="p" message={t('taggedItems.noBlocks')} />}
    >
      {(headingId) => (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- focusable group implementing roving keyboard navigation over the rows, as Linked references does
        <div
          ref={listRef}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- grouped rows with interleaved group-header buttons; see LinkedReferences
          role="group"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard nav requires a focusable container
          tabIndex={0}
          aria-labelledby={headingId}
          aria-activedescendant={focusedBlockId ? blockRowDomId(focusedBlockId) : undefined}
          className="focus-ring-visible"
          onKeyDown={(e) => {
            if (handleKeyDown(e)) e.preventDefault()
          }}
        >
          <BacklinkGroupRenderer
            groups={groups}
            expandedGroups={expandedGroups}
            onToggleGroup={toggleGroup}
            onNavigateToPage={onNavigateToPage}
            handleBlockClick={handleBlockClick}
            handleBlockKeyDown={handleBlockKeyDown}
            resolveBlockTitle={resolveBlockTitle}
            resolveBlockStatus={resolveBlockStatus}
            resolveTagName={resolveTagName}
            focusedBlockId={focusedBlockId}
            rowDomId={blockRowDomId}
            anchorRefId={tagId}
            listAriaLabel={(title) => t('taggedItems.blocksIn', { title })}
            blockChildren={blockChildren}
          />
        </div>
      )}
    </Panel>
  )
}
