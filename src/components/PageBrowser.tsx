/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 */

import { Download, FileText, Plus, Search, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { HighlightMatch } from '@/components/HighlightMatch'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { PageTreeItem } from '@/components/PageTreeItem'
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
import { usePageDelete } from '../hooks/usePageDelete'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { downloadBlob, exportGraphAsZip } from '../lib/export-graph'
import type { BlockRow } from '../lib/tauri'
import { createBlock, listBlocks } from '../lib/tauri'
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
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  const [exporting, setExporting] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

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

  const handleExportAll = useCallback(async () => {
    setExporting(true)
    try {
      const blob = await exportGraphAsZip()
      const date = new Date().toISOString().slice(0, 10)
      downloadBlob(blob, `agaric-export-${date}.zip`)
      toast.success(t('pageBrowser.exportSuccess'))
    } catch {
      toast.error(t('pageBrowser.exportFailed'))
    }
    setExporting(false)
  }, [t])

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

  const filteredPages = useMemo(() => {
    let result = pages
    if (filterText.trim()) {
      const lower = filterText.toLowerCase()
      result = result.filter((p) => (p.content ?? '').toLowerCase().includes(lower))
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
  }, [pages, filterText, sortOption])

  const isFiltering = filterText.trim().length > 0

  return (
    <div className="page-browser space-y-4">
      <div className="sticky top-0 z-10 bg-background -mx-4 px-4 md:-mx-6 md:px-6 pb-4 border-b border-border/40 space-y-2">
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

      {/* biome-ignore lint/a11y/useSemanticElements: div+role used for styling flexibility with shadcn */}
      <div className="page-browser-list space-y-1" role="list">
        {isFiltering && filteredPages.length === 0 ? (
          <EmptyState icon={Search} message={t('pageBrowser.noMatches')} />
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
          filteredPages.map((page) => (
            // biome-ignore lint/a11y/useSemanticElements: div+role used for styling flexibility with shadcn
            <div
              key={page.id}
              role="listitem"
              className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
            >
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
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('pageBrowser.deleteButton')}
                className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target [@media(pointer:coarse)]:min-w-[44px] focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
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

      <Button
        variant="outline"
        size="sm"
        disabled={exporting}
        onClick={handleExportAll}
        className="w-full"
      >
        <Download className="h-4 w-4 mr-1" />
        {exporting ? t('pageBrowser.exporting') : t('pageBrowser.exportAll')}
      </Button>

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
