/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: reverse ULID (creation time desc) via cursor pagination.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { BlockRow } from '../lib/tauri'
import { listBlocks } from '../lib/tauri'

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string) => void
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

  return (
    <div className="page-browser">
      <h2 className="page-browser-title">Pages</h2>

      {loading && pages.length === 0 && (
        <div className="page-browser-loading">Loading pages...</div>
      )}

      {!loading && pages.length === 0 && (
        <div className="page-browser-empty">No pages yet. Create one to get started.</div>
      )}

      <div className="page-browser-list">
        {pages.map((page) => (
          <button
            key={page.id}
            type="button"
            className="page-browser-item"
            onClick={() => onPageSelect?.(page.id)}
          >
            <span className="page-browser-item-title">{page.content ?? 'Untitled'}</span>
          </button>
        ))}
      </div>

      {hasMore && (
        <button
          type="button"
          className="page-browser-load-more"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  )
}
