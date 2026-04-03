/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 */

import { FileText, Loader2, Plus, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import type { BlockRow } from '../lib/tauri'
import { createBlock, deleteBlock, listBlocks } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string, title?: string) => void
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
  const [isCreating, setIsCreating] = useState(false)
  const [newPageName, setNewPageName] = useState('')
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')

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
      try {
        await deleteBlock(pageId)
        setPages((prev) => prev.filter((p) => p.id !== pageId))
        useResolveStore.getState().set(pageId, '(deleted)', true)
      } catch (error) {
        toast.error(t('pageBrowser.deleteFailed', { error: String(error) }), {
          action: { label: t('pageBrowser.retry'), onClick: () => handleDeletePage(pageId) },
        })
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

  return (
    <div className="page-browser space-y-4">
      {/* Create page form */}
      <form
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
        <Button type="submit" variant="outline" disabled={isCreating}>
          {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t('pageBrowser.newPage')}
        </Button>
      </form>

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
        {pages.map((page) => (
          // biome-ignore lint/a11y/useSemanticElements: div+role used for styling flexibility with shadcn
          <div
            key={page.id}
            role="listitem"
            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
          >
            <button
              type="button"
              className="page-browser-item flex flex-1 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer"
              onClick={() => onPageSelect?.(page.id, page.content ?? t('pageBrowser.untitled'))}
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="page-browser-item-title truncate">
                {page.content ?? t('pageBrowser.untitled')}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('pageBrowser.deleteButton')}
              className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation()
                setDeleteTarget({ id: page.id, name: page.content ?? t('pageBrowser.untitled') })
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
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
