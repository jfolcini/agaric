/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { FileText, Plus, Search, Star, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { HighlightMatch } from '@/components/HighlightMatch'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { PageTreeItem } from '@/components/PageTreeItem'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { buildPageTree } from '@/lib/page-tree'
import { getRecentPages } from '@/lib/recent-pages'
import { getStarredPages, isStarred, toggleStarred } from '@/lib/starred-pages'
import { cn } from '@/lib/utils'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { usePageDelete } from '../hooks/usePageDelete'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import type { BlockRow } from '../lib/tauri'
import { createPageInSpace, listBlocks, resolvePageByAlias } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'
import { ViewHeader } from './ViewHeader'

type SortOption = 'alphabetical' | 'recent' | 'created'

const SORT_STORAGE_KEY = 'page-browser-sort'

function readSortPreference(): SortOption {
  try {
    const stored = localStorage.getItem(SORT_STORAGE_KEY)
    if (stored === 'alphabetical' || stored === 'recent' || stored === 'created') return stored
  } catch {
    // localStorage unavailable
  }
  return 'alphabetical'
}

function writeSortPreference(value: SortOption): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, value)
  } catch {
    // localStorage unavailable
  }
}

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string, title?: string) => void
}

export function PageBrowser({ onPageSelect }: PageBrowserProps): React.ReactElement {
  const { t } = useTranslation()

  // FEAT-3 Phase 2 — honour the current space. When the `SpaceStore`
  // has not yet hydrated (`isReady === false`) we render a
  // `LoadingSkeleton` instead of firing `listBlocks` so the first render
  // never leaks cross-space pages. Once ready, `currentSpaceId` is
  // threaded to `listBlocks` so the backend filters results.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)

  const queryFn = useCallback(
    (cursor?: string) =>
      listBlocks({
        blockType: 'page',
        ...(cursor != null && { cursor }),
        limit: 50,
        spaceId: currentSpaceId ?? undefined,
      }),
    [currentSpaceId],
  )
  const {
    items: pages,
    loading,
    hasMore,
    loadMore,
    setItems: setPages,
  } = usePaginatedQuery(queryFn, {
    onError: t('pageBrowser.loadFailed'),
    enabled: spaceIsReady,
  })

  const { deleteTarget, deletingId, setDeleteTarget, handleConfirmDelete } = usePageDelete(setPages)

  const [isCreating, setIsCreating] = useState(false)
  const [newPageName, setNewPageName] = useState('')
  const [filterText, setFilterText] = useState('')
  const [sortOption, setSortOption] = useState<SortOption>(readSortPreference)
  const [showStarredOnly, setShowStarredOnly] = useState(false)
  const [starredRevision, setStarredRevision] = useState(0)
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  const [aliasMatchId, setAliasMatchId] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const newPageInputRef = useRef<HTMLInputElement>(null)
  // Register the "new page" input as the primary-focus target for this view
  // so switching to Pages via sidebar lands the cursor in the create form
  // instead of the generic #main-content container (UX-220).
  useRegisterPrimaryFocus(newPageInputRef)
  // Tracks the handleCreateUnder focus setTimeout so we can cancel it on
  // unmount and avoid focusing a stale DOM node (#MAINT-14).
  const pendingFocusRef = useRef<number | null>(null)

  // Clear any pending focus timer on unmount.
  useEffect(
    () => () => {
      if (pendingFocusRef.current !== null) {
        window.clearTimeout(pendingFocusRef.current)
        pendingFocusRef.current = null
      }
    },
    [],
  )

  // Track load-more announcements for screen readers
  const prevLengthRef = useRef(0)
  useEffect(() => {
    if (pages.length > prevLengthRef.current && prevLengthRef.current > 0) {
      setLoadMoreAnnouncement(
        t('pageBrowser.loadedMorePages', { count: pages.length - prevLengthRef.current }),
      )
    } else if (pages.length < prevLengthRef.current) {
      setLoadMoreAnnouncement('')
    }
    prevLengthRef.current = pages.length
  }, [pages.length, t])

  // Alias resolution for filter
  useEffect(() => {
    if (!filterText.trim()) {
      setAliasMatchId(null)
      return
    }
    resolvePageByAlias(filterText.trim())
      .then((result) => {
        setAliasMatchId(result ? result[0] : null)
      })
      .catch((err) => {
        logger.warn('PageBrowser', 'alias resolution failed', { query: filterText.trim() }, err)
        setAliasMatchId(null)
      })
  }, [filterText])

  const handleCreatePage = useCallback(async () => {
    const name = newPageName.trim() || t('pageBrowser.untitled')
    // FEAT-3 Phase 2 — a page must belong to a space. On the rare
    // first-boot path where `SpaceStore` has not yet hydrated we
    // refuse to create and surface a toast rather than silently
    // creating an unscoped page. The `isReady` gate above normally
    // prevents this branch from firing.
    const activeSpaceId = useSpaceStore.getState().currentSpaceId
    if (activeSpaceId == null) {
      toast.error(t('pageBrowser.spaceNotReady'))
      return
    }
    setIsCreating(true)
    try {
      const newId = await createPageInSpace({ content: name, spaceId: activeSpaceId })
      const newPage: BlockRow = {
        id: newId,
        block_type: 'page',
        content: name,
        parent_id: null,
        position: null,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: newId,
      }
      setPages((prev) => [newPage, ...prev])
      setNewPageName('')
      onPageSelect?.(newId, name)
    } catch (error) {
      toast.error(t('pageBrowser.createFailed', { error: String(error) }), {
        action: { label: t('pageBrowser.retry'), onClick: () => handleCreatePage() },
      })
    }
    setIsCreating(false)
  }, [newPageName, setPages, t, onPageSelect])

  const handleCreateUnder = useCallback((namespacePath: string) => {
    setNewPageName(`${namespacePath}/`)
    if (pendingFocusRef.current !== null) {
      window.clearTimeout(pendingFocusRef.current)
    }
    pendingFocusRef.current = window.setTimeout(() => {
      pendingFocusRef.current = null
      formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    }, 0)
  }, [])

  const handleSortChange = useCallback((value: SortOption) => {
    setSortOption(value)
    writeSortPreference(value)
  }, [])

  const handleToggleStar = useCallback((pageId: string) => {
    toggleStarred(pageId)
    setStarredRevision((r) => r + 1)
  }, [])

  const starredCount = useMemo(() => {
    starredRevision // subscribe to revision changes
    return getStarredPages().length
  }, [starredRevision])

  const filteredPages = useMemo(() => {
    let result = pages
    const trimmed = filterText.trim()
    if (trimmed) {
      // UX-247 — Unicode-aware case- / diacritic-insensitive match so
      // Turkish (`İstanbul` ↔ `istanbul`), German (`Straße` ↔
      // `strasse`), and accented (`café` ↔ `cafe`) titles fold
      // together the way users expect from interactive filters.
      result = result.filter(
        (p) => matchesSearchFolded(p.content ?? '', trimmed) || p.id === aliasMatchId,
      )
    }
    if (showStarredOnly) {
      starredRevision // subscribe to revision changes
      const starred = getStarredPages()
      result = result.filter((p) => starred.includes(p.id))
    }

    const sorted = [...result]
    if (sortOption === 'alphabetical') {
      sorted.sort((a, b) => (a.content ?? '').localeCompare(b.content ?? ''))
    } else if (sortOption === 'created') {
      sorted.sort((a, b) => b.id.localeCompare(a.id))
    } else if (sortOption === 'recent') {
      const recentPages = getRecentPages()
      const recentMap = new Map(recentPages.map((rp) => [rp.id, rp.visitedAt]))
      sorted.sort((a, b) => {
        const aTime = recentMap.get(a.id)
        const bTime = recentMap.get(b.id)
        if (aTime && bTime) return bTime.localeCompare(aTime)
        if (aTime) return -1
        if (bTime) return 1
        return (a.content ?? '').localeCompare(b.content ?? '')
      })
    }
    return sorted
  }, [pages, filterText, sortOption, showStarredOnly, starredRevision, aliasMatchId])

  const isTreeMode = useMemo(
    () => filteredPages.some((p) => p.content?.includes('/')),
    [filteredPages],
  )
  const treeNodes = useMemo(
    () => (isTreeMode ? buildPageTree(filteredPages) : []),
    [isTreeMode, filteredPages],
  )
  const virtualItemCount = isTreeMode ? treeNodes.length : filteredPages.length

  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: filteredPages.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const page = filteredPages[idx]
      if (page) onPageSelect?.(page.id, page.content ?? undefined)
    },
  })

  // Reset focusedIndex when filter/sort changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: filterText and sortOption intentionally trigger reset
  useEffect(() => {
    setFocusedIndex(0)
  }, [filterText, sortOption, setFocusedIndex])

  const virtualizer = useVirtualizer({
    count: virtualItemCount,
    getScrollElement: () => listRef.current,
    estimateSize: () => 44,
    overscan: 5,
  })

  // Document-level keydown: skip if user is typing in input/select/textarea
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return
      if (navHandleKeyDown(e)) {
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navHandleKeyDown])

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0 || isTreeMode) return
    virtualizer.scrollToIndex(focusedIndex, { align: 'auto' })
  }, [focusedIndex, isTreeMode, virtualizer])

  const isFiltering = filterText.trim().length > 0 || showStarredOnly

  return (
    <div className="page-browser space-y-4">
      <ViewHeader>
        <div className="page-browser-header space-y-2">
          {/* Create page form */}
          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault()
              handleCreatePage()
            }}
            className="flex flex-col sm:flex-row sm:items-center gap-2"
          >
            <Label htmlFor="new-page-name" className="sr-only">
              {t('pageBrowser.createPageInputLabel')}
            </Label>
            <SearchInput
              ref={newPageInputRef}
              id="new-page-name"
              value={newPageName}
              onChange={(e) => setNewPageName(e.target.value)}
              placeholder={t('pageBrowser.newPagePlaceholder')}
              className="flex-1"
            />
            <Button type="submit" variant="outline" disabled={isCreating || !newPageName.trim()}>
              {isCreating ? <Spinner /> : <Plus className="h-4 w-4" />}
              {t('pageBrowser.newPage')}
            </Button>
          </form>

          {/* Search/filter input + sort dropdown */}
          {pages.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <SearchInput
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={t('pageBrowser.searchPlaceholder')}
                  className="pl-8"
                  aria-label={t('pageBrowser.searchPlaceholder')}
                />
              </div>
              <Select value={sortOption} onValueChange={(v) => handleSortChange(v as SortOption)}>
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-[7rem]"
                  aria-label={t('pageBrowser.sortLabel')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alphabetical">{t('pageBrowser.sortAlphabetical')}</SelectItem>
                  <SelectItem value="recent">{t('pageBrowser.sortRecent')}</SelectItem>
                  <SelectItem value="created">{t('pageBrowser.sortCreated')}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant={showStarredOnly ? 'default' : 'ghost'}
                size="icon"
                onClick={() => setShowStarredOnly((prev) => !prev)}
                aria-label={
                  showStarredOnly ? t('pageBrowser.showAll') : t('pageBrowser.showStarred')
                }
                aria-pressed={showStarredOnly}
                className="relative shrink-0"
              >
                <Star className="h-4 w-4" fill={showStarredOnly ? 'currentColor' : 'none'} />
                {starredCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="starred-count absolute -top-1.5 -right-1.5 h-4 min-w-[1rem] px-1 text-xs"
                  >
                    {starredCount}
                  </Badge>
                )}
              </Button>
            </div>
          )}
        </div>
      </ViewHeader>

      {(!spaceIsReady || (loading && pages.length === 0)) && (
        <div aria-busy="true">
          <LoadingSkeleton count={3} height="h-10" className="page-browser-loading" />
        </div>
      )}

      {spaceIsReady && !loading && pages.length === 0 && (
        <EmptyState
          icon={FileText}
          message={t('pageBrowser.noPages')}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 mx-auto flex items-center gap-1"
              onClick={handleCreatePage}
              disabled={isCreating}
            >
              {isCreating ? <Spinner /> : <Plus className="h-4 w-4" />}
              {t('pageBrowser.createFirst')}
            </Button>
          }
        />
      )}

      <ScrollArea
        viewportRef={listRef}
        className="page-browser-list max-h-[calc(100dvh-200px)]"
        viewportProps={{
          role: 'listbox',
          tabIndex: 0,
          'aria-label': t('pageBrowser.pageList'),
        }}
      >
        {isFiltering && filteredPages.length === 0 ? (
          <EmptyState
            icon={showStarredOnly ? Star : Search}
            message={
              showStarredOnly && !filterText.trim()
                ? t('pageBrowser.noStarredPages')
                : t('pageBrowser.noMatches')
            }
          />
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              if (isTreeMode) {
                const node = treeNodes[virtualRow.index]
                if (!node) return null
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <PageTreeItem
                      node={node}
                      depth={0}
                      onNavigate={(pageId, title) => onPageSelect?.(pageId, title)}
                      onCreateUnder={handleCreateUnder}
                      filterText={filterText.trim()}
                      forceExpand={isFiltering}
                      onDelete={(id, name) => setDeleteTarget({ id, name })}
                    />
                  </div>
                )
              }
              const page = filteredPages[virtualRow.index]
              if (!page) return null
              const index = virtualRow.index
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  role="option"
                  aria-selected={focusedIndex === index}
                  data-page-item
                  tabIndex={-1}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
                    focusedIndex === index && 'ring-2 ring-inset ring-ring/50 bg-accent/30',
                  )}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      isStarred(page.id) ? t('pageBrowser.unstarPage') : t('pageBrowser.starPage')
                    }
                    className="star-toggle shrink-0 h-6 w-6 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 focus-visible:opacity-100 focus-visible:ring-inset transition-opacity text-muted-foreground hover:text-star data-[starred=true]:opacity-100 data-[starred=true]:text-star"
                    data-starred={isStarred(page.id)}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleToggleStar(page.id)
                    }}
                  >
                    <Star
                      className="h-3.5 w-3.5"
                      fill={isStarred(page.id) ? 'currentColor' : 'none'}
                    />
                  </Button>
                  <button
                    type="button"
                    className="page-browser-item flex flex-1 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-hidden"
                    onClick={() =>
                      onPageSelect?.(page.id, page.content ?? t('pageBrowser.untitled'))
                    }
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span
                      className="page-browser-item-title truncate"
                      title={page.content ?? t('pageBrowser.untitled')}
                    >
                      <HighlightMatch
                        text={page.content ?? t('pageBrowser.untitled')}
                        filterText={filterText.trim()}
                      />
                      {aliasMatchId === page.id &&
                        filterText.trim() !== '' &&
                        !matchesSearchFolded(page.content ?? '', filterText.trim()) && (
                          <span className="alias-badge text-xs text-muted-foreground">(alias)</span>
                        )}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('pageBrowser.deleteButton')}
                    className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target focus-visible:opacity-100 focus-visible:ring-inset transition-opacity text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
                    disabled={deletingId === page.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteTarget({
                        id: page.id,
                        name: page.content ?? t('pageBrowser.untitled'),
                      })
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      <LoadMoreButton
        hasMore={hasMore}
        loading={loading}
        onLoadMore={loadMore}
        className="page-browser-load-more"
        label={t('pageBrowser.loadMore')}
        loadingLabel={t('pageBrowser.loading')}
      />

      <output className="sr-only" aria-live="polite">
        {loadMoreAnnouncement}
      </output>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('pageBrowser.deletePage')}
        description={t('pageBrowser.deleteDescription', { name: deleteTarget?.name })}
        cancelLabel={t('pageBrowser.cancel')}
        actionLabel={t('pageBrowser.delete')}
        actionVariant="destructive"
        onAction={handleConfirmDelete}
      />
    </div>
  )
}
