/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 */

import { FileText, Plus } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { BlockRow } from '../lib/tauri'
import { createBlock, listBlocks } from '../lib/tauri'

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string, title?: string) => void
}

export function PageBrowser({ onPageSelect }: PageBrowserProps): React.ReactElement {
  const [pages, setPages] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)

  const loadPages = useCallback(async (cursor?: string) => {
    setLoading(true)
    try {
      const resp = await listBlocks({ blockType: 'page', cursor, limit: 50 })
      if (cursor) {
        setPages((prev) => [...prev, ...resp.items])
      } else {
        setPages(resp.items)
      }
      setNextCursor(resp.next_cursor)
      setHasMore(resp.has_more)
    } catch {
      // Silently fail
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
    try {
      const resp = await createBlock({ blockType: 'page', content: 'Untitled' })
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
    } catch {
      // Silently fail
    }
  }, [])

  return (
    <div className="page-browser space-y-4">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={handleCreatePage}>
          <Plus className="h-4 w-4" /> New Page
        </Button>
      </div>

      {loading && pages.length === 0 && (
        <div className="page-browser-loading text-sm text-muted-foreground">Loading pages...</div>
      )}

      {!loading && pages.length === 0 && (
        <div className="page-browser-empty rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No pages yet. Create one to get started.
        </div>
      )}

      <div className="page-browser-list space-y-1">
        {pages.map((page) => (
          <button
            key={page.id}
            type="button"
            className="page-browser-item flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
            onClick={() => onPageSelect?.(page.id, page.content ?? 'Untitled')}
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="page-browser-item-title truncate">{page.content ?? 'Untitled'}</span>
          </button>
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
    </div>
  )
}
