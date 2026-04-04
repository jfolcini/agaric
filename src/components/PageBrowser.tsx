/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 */

import { ChevronRight, Download, FileText, Loader2, Plus, Search, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { downloadBlob, exportGraphAsZip } from '../lib/export-graph'
import type { BlockRow } from '../lib/tauri'
import { createBlock, deleteBlock, listBlocks } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string, title?: string) => void
}

interface PageTreeNode {
  name: string // segment name (e.g., "work" or "project-alpha")
  fullPath: string // full page name (e.g., "work/project-alpha")
  pageId?: string // only set for leaf pages that exist
  children: PageTreeNode[]
}

function buildPageTree(pages: Array<{ id: string; content: string | null }>): PageTreeNode[] {
  const root: PageTreeNode[] = []

  for (const page of pages) {
    const path = page.content ?? 'Untitled'
    const segments = path.split('/')
    let current = root

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string
      const fullPath = segments.slice(0, i + 1).join('/')
      let node = current.find((n) => n.name === segment)

      if (!node) {
        node = { name: segment, fullPath, children: [] }
        current.push(node)
      }

      if (i === segments.length - 1) {
        node.pageId = page.id
      }

      current = node.children
    }
  }

  return root
}

/** Highlight matching segments of text when a filter is active. */
function HighlightMatch({
  text,
  filterText,
}: {
  text: string
  filterText: string
}): React.ReactElement {
  if (!filterText) return <>{text}</>
  const idx = text.toLowerCase().indexOf(filterText.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 dark:bg-yellow-800 rounded-sm">
        {text.slice(idx, idx + filterText.length)}
      </mark>
      {text.slice(idx + filterText.length)}
    </>
  )
}

function PageTreeItem({
  node,
  depth,
  onNavigate,
  onCreateUnder,
  filterText,
  forceExpand,
}: {
  node: PageTreeNode
  depth: number
  onNavigate: (pageId: string, title: string) => void
  onCreateUnder: (namespacePath: string) => void
  filterText: string
  forceExpand: boolean
}) {
  const [expanded, setExpanded] = useState(true) // namespaces start expanded

  if (node.pageId) {
    // Leaf page — clickable
    return (
      <button
        type="button"
        style={{ paddingLeft: `${depth * 16}px` }}
        onClick={() => {
          if (node.pageId) onNavigate(node.pageId, node.fullPath)
        }}
        className="w-full text-left px-2 py-1 text-sm hover:bg-accent rounded truncate"
        title={node.fullPath}
      >
        <HighlightMatch text={node.name} filterText={filterText} />
      </button>
    )
  }

  const isExpanded = forceExpand || expanded

  // Namespace folder — collapsible
  return (
    <div>
      <div className="group flex items-center" style={{ paddingLeft: `${depth * 16}px` }}>
        <button
          type="button"
          onClick={() => !forceExpand && setExpanded(!expanded)}
          className="flex-1 text-left px-2 py-1 text-sm text-muted-foreground hover:bg-accent/50 rounded flex items-center gap-1"
        >
          <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
          <HighlightMatch text={node.name} filterText={filterText} />
        </button>
        <button
          type="button"
          className="opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded hover:bg-accent transition-opacity"
          aria-label={`Create page under ${node.fullPath}`}
          onClick={(e) => {
            e.stopPropagation()
            onCreateUnder(node.fullPath)
          }}
        >
          <Plus size={12} />
        </button>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <PageTreeItem
            key={child.fullPath}
            node={child}
            depth={depth + 1}
            onNavigate={onNavigate}
            onCreateUnder={onCreateUnder}
            filterText={filterText}
            forceExpand={forceExpand}
          />
        ))}
    </div>
  )
}

export function PageBrowser({ onPageSelect }: PageBrowserProps): React.ReactElement {
  const { t } = useTranslation()

  const queryFn = useCallback(
    (cursor?: string) => listBlocks({ blockType: 'page', cursor, limit: 50 }),
    [],
  )
  const {
    items: pages,
    loading,
    hasMore,
    loadMore,
    setItems: setPages,
  } = usePaginatedQuery(queryFn, { onError: t('pageBrowser.loadFailed') })

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [newPageName, setNewPageName] = useState('')
  const [filterText, setFilterText] = useState('')
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  const [exporting, setExporting] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // Track load-more announcements for screen readers
  const prevLengthRef = useRef(0)
  useEffect(() => {
    if (pages.length > prevLengthRef.current && prevLengthRef.current > 0) {
      setLoadMoreAnnouncement(`Loaded ${pages.length - prevLengthRef.current} more pages`)
    } else if (pages.length < prevLengthRef.current) {
      setLoadMoreAnnouncement('')
    }
    prevLengthRef.current = pages.length
  }, [pages.length])

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
        archived_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      }
      setPages((prev) => [newPage, ...prev])
      setNewPageName('')
    } catch (error) {
      toast.error(t('pageBrowser.createFailed', { error: String(error) }), {
        action: { label: t('pageBrowser.retry'), onClick: () => handleCreatePage() },
      })
    }
    setIsCreating(false)
  }, [newPageName, setPages, t])

  const handleDeletePage = useCallback(
    async (pageId: string) => {
      setDeletingId(pageId)
      try {
        await deleteBlock(pageId)
        setPages((prev) => prev.filter((p) => p.id !== pageId))
        useResolveStore.getState().set(pageId, '(deleted)', true)
        toast.success(t('pageBrowser.deleteSuccess'))
      } catch (error) {
        toast.error(t('pageBrowser.deleteFailed', { error: String(error) }), {
          action: { label: t('pageBrowser.retry'), onClick: () => handleDeletePage(pageId) },
        })
      } finally {
        setDeletingId(null)
      }
    },
    [setPages, t],
  )

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      handleDeletePage(deleteTarget.id)
      setDeleteTarget(null)
    }
  }, [deleteTarget, handleDeletePage])

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

  const filteredPages = useMemo(() => {
    if (!filterText.trim()) return pages
    const lower = filterText.toLowerCase()
    return pages.filter((p) => (p.content ?? '').toLowerCase().includes(lower))
  }, [pages, filterText])

  const isFiltering = filterText.trim().length > 0

  return (
    <div className="page-browser space-y-4">
      {/* Create page form */}
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault()
          handleCreatePage()
        }}
        className="flex items-center gap-2"
      >
        <Input
          value={newPageName}
          onChange={(e) => setNewPageName(e.target.value)}
          placeholder={t('pageBrowser.newPagePlaceholder')}
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={isCreating || !newPageName.trim()}>
          {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t('pageBrowser.newPage')}
        </Button>
      </form>

      {/* Search/filter input */}
      {pages.length > 0 && (
        <div className="relative">
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
      )}

      {loading && pages.length === 0 && (
        <div className="page-browser-loading space-y-1">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      )}

      {!loading && pages.length === 0 && (
        <div className="page-browser-empty rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          <FileText className="mx-auto mb-2 h-5 w-5" />
          {t('pageBrowser.noPages')}
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 mx-auto flex items-center gap-1"
            onClick={handleCreatePage}
            disabled={isCreating}
          >
            {isCreating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {t('pageBrowser.createFirst')}
          </Button>
        </div>
      )}

      {/* biome-ignore lint/a11y/useSemanticElements: div+role used for styling flexibility with shadcn */}
      <div className="page-browser-list space-y-1" role="list">
        {isFiltering && filteredPages.length === 0 ? (
          <div className="page-browser-no-matches rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <Search className="mx-auto mb-2 h-5 w-5" />
            {t('pageBrowser.noMatches')}
          </div>
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
                className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
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

      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="page-browser-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? t('pageBrowser.loading') : t('pageBrowser.loadMore')}
        </Button>
      )}

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
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pageBrowser.deletePage')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('pageBrowser.deleteDescription', { name: deleteTarget?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('pageBrowser.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>
              {t('pageBrowser.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
