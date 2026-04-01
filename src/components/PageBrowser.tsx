/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 */

import { FileText, Loader2, Plus, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
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
import type { BlockRow } from '../lib/tauri'
import { createBlock, deleteBlock, listBlocks } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string, title?: string) => void
}

export function PageBrowser({ onPageSelect }: PageBrowserProps): React.ReactElement {
  const [pages, setPages] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [newPageName, setNewPageName] = useState('')
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')

  const loadPages = useCallback(async (cursor?: string) => {
    setLoading(true)
    try {
      const resp = await listBlocks({ blockType: 'page', cursor, limit: 50 })
      if (cursor) {
        setPages((prev) => [...prev, ...resp.items])
        setLoadMoreAnnouncement(`Loaded ${resp.items.length} more pages`)
      } else {
        setPages(resp.items)
        setLoadMoreAnnouncement('')
      }
      setNextCursor(resp.next_cursor)
      setHasMore(resp.has_more)
    } catch (error) {
      toast.error(`Failed to load pages: ${String(error)}`)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadPages()
  }, [loadPages])

  const loadMore = useCallback(() => {
    if (nextCursor) loadPages(nextCursor)
  }, [nextCursor, loadPages])

  const handleCreatePage = useCallback(async () => {
    const name = newPageName.trim() || 'Untitled'
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
      }
      setPages((prev) => [newPage, ...prev])
      setNewPageName('')
    } catch (error) {
      toast.error(`Failed to create page: ${String(error)}`, {
        action: { label: 'Retry', onClick: () => handleCreatePage() },
      })
    }
    setIsCreating(false)
  }, [newPageName])

  const handleDeletePage = useCallback(async (pageId: string) => {
    try {
      await deleteBlock(pageId)
      setPages((prev) => prev.filter((p) => p.id !== pageId))
      useResolveStore.getState().set(pageId, '(deleted)', true)
    } catch (error) {
      toast.error(`Failed to delete page: ${String(error)}`, {
        action: { label: 'Retry', onClick: () => handleDeletePage(pageId) },
      })
    }
  }, [])

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
          placeholder="New page name..."
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={isCreating}>
          {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          New Page
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
          No pages yet.
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
            Create your first page
          </Button>
        </div>
      )}

      <div className="page-browser-list space-y-1">
        {pages.map((page) => (
          <div
            key={page.id}
            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
          >
            <button
              type="button"
              className="page-browser-item flex flex-1 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer"
              onClick={() => onPageSelect?.(page.id, page.content ?? 'Untitled')}
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="page-browser-item-title truncate">{page.content ?? 'Untitled'}</span>
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Delete page"
              className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation()
                setDeleteTarget({ id: page.id, name: page.content ?? 'Untitled' })
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
          {loading ? 'Loading...' : 'Load more'}
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
            <AlertDialogTitle>Delete page?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the page &ldquo;{deleteTarget?.name}&rdquo;. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
