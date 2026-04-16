/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 */

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
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { buildPageTree } from '@/lib/page-tree'
import { getRecentPages } from '@/lib/recent-pages'
import { getStarredPages, isStarred, toggleStarred } from '@/lib/starred-pages'
import { cn } from '@/lib/utils'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { usePageDelete } from '../hooks/usePageDelete'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import type { BlockRow } from '../lib/tauri'
import { createBlock, listBlocks, resolvePageByAlias } from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'

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

  const queryFn = useCallback(
    (cursor?: string) =>
      listBlocks({ blockType: 'page', ...(cursor != null && { cursor }), limit: 50 }),
    [],
  )
  const {
    items: pages,
    loading,
    hasMore,
    loadMore,
    setItems: setPages,
  } = usePaginatedQuery(queryFn, { onError: t('pageBrowser.loadFailed') })

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
      .catch(() => setAliasMatchId(null))
  }, [filterText])

  const handleCreatePage = useCallback(async () => {
    const name = newPageName.trim() || t('pageBrowser.untitled')
    setIsCreating(true)
    try {
      const resp = await createBlock({ blockType: 'page', content: name })
      const newPage: BlockRow = {
        id: resp.id,
        block_type: resp.block_type,
        content: resp.content,
        parent_id: resp.parent_id,
        position: resp.position,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: resp.id,
      }
      setPages((prev) => [newPage, ...prev])
      setNewPageName('')
      onPageSelect?.(resp.id, resp.content ?? name)
    } catch (error) {
      toast.error(t('pageBrowser.createFailed', { error: String(error) }), {
        action: { label: t('pageBrowser.retry'), onClick: () => handleCreatePage() },
      })
    }
    setIsCreating(false)
  }, [newPageName, setPages, t, onPageSelect])

  const handleCreateUnder = useCallback((namespacePath: string) => {
    setNewPageName(`${namespacePath}/`)
    setTimeout(() => {
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
    if (filterText.trim()) {
      const lower = filterText.toLowerCase()
      result = result.filter(
        (p) => (p.content ?? '').toLowerCase().includes(lower) || p.id === aliasMatchId,
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
    if (focusedIndex < 0 || !listRef.current) return
    const items = listRef.current.querySelectorAll('[data-page-item]')
    const el = items[focusedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  const isFiltering = filterText.trim().length > 0 || showStarredOnly

  return (
    <div className="page-browser space-y-4">
      <div
        className="sticky top-0 z-10 bg-background isolate -mx-4 px-4 md:-mx-6 md:px-6 pb-4 border-b border-border/40 space-y-2"
        style={{ backgroundColor: 'var(--background, #fff)' }}
      >
        {/* Create page form */}
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault()
            handleCreatePage()
          }}
          className="flex flex-col sm:flex-row sm:items-center gap-2"
        >
          <Input
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
              <Input
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
              aria-label={showStarredOnly ? t('pageBrowser.showAll') : t('pageBrowser.showStarred')}
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

      {loading && pages.length === 0 && (
        <div aria-busy="true">
          <LoadingSkeleton count={3} height="h-10" className="page-browser-loading" />
        </div>
      )}

      {!loading && pages.length === 0 && (
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

      <div
        ref={listRef}
        className="page-browser-list space-y-1"
        role="listbox"
        tabIndex={0}
        aria-label={t('pageBrowser.pageList')}
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
        ) : filteredPages.some((p) => p.content?.includes('/')) ? (
          buildPageTree(filteredPages).map((node) => (
            <PageTreeItem
              key={node.fullPath}
              node={node}
              depth={0}
              onNavigate={(pageId, title) => onPageSelect?.(pageId, title)}
              onCreateUnder={handleCreateUnder}
              filterText={filterText.trim()}
              forceExpand={isFiltering}
              onDelete={(id, name) => setDeleteTarget({ id, name })}
            />
          ))
        ) : (
          filteredPages.map((page, index) => (
            <div
              key={page.id}
              role="option"
              aria-selected={focusedIndex === index}
              data-page-item
              tabIndex={-1}
              className={cn(
                'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
                focusedIndex === index && 'ring-2 ring-ring/50 bg-accent/30',
              )}
            >
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  isStarred(page.id) ? t('pageBrowser.unstarPage') : t('pageBrowser.starPage')
                }
                className="star-toggle shrink-0 h-6 w-6 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-star data-[starred=true]:opacity-100 data-[starred=true]:text-star"
                data-starred={isStarred(page.id)}
                onClick={(e) => {
                  e.stopPropagation()
                  handleToggleStar(page.id)
                }}
              >
                <Star className="h-3.5 w-3.5" fill={isStarred(page.id) ? 'currentColor' : 'none'} />
              </Button>
              <button
                type="button"
                className="page-browser-item flex flex-1 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onClick={() => onPageSelect?.(page.id, page.content ?? t('pageBrowser.untitled'))}
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
                    !(page.content ?? '').toLowerCase().includes(filterText.toLowerCase()) && (
                      <span className="alias-badge text-xs text-muted-foreground">(alias)</span>
                    )}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('pageBrowser.deleteButton')}
                className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
                disabled={deletingId === page.id}
                onClick={(e) => {
                  e.stopPropagation()
                  setDeleteTarget({ id: page.id, name: page.content ?? t('pageBrowser.untitled') })
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>

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
        onAction={handleConfirmDelete}
      />
    </div>
  )
}
