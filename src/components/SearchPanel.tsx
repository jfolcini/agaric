/**
 * SearchPanel — full-text search across all blocks (p3-t5, p3-t6).
 *
 * Features:
 *  - Debounced search (300ms) on input change
 *  - Immediate search on form submit (Enter / button click)
 *  - Cursor-based pagination ("Load more")
 *  - CJK limitation notice (p3-t6)
 */

import { Loader2, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { BlockRow } from '../lib/tauri'
import { batchResolve, getBlock, searchBlocks } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { EmptyState } from './EmptyState'

/** Returns true if the text contains CJK codepoints. */
function hasCJK(text: string): boolean {
  return /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u30A0-\u30FF\u3040-\u309F\uAC00-\uD7AF]/.test(
    text,
  )
}

export function SearchPanel(): React.ReactElement {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [searched, setSearched] = useState(false)
  const [typing, setTyping] = useState(false)
  const [loadingResultId, setLoadingResultId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)

  const executeSearch = useCallback(async (q: string, cursor?: string) => {
    setLoading(true)
    try {
      const resp = await searchBlocks({ query: q, cursor, limit: 50 })
      if (cursor) {
        setResults((prev) => [...prev, ...resp.items])
      } else {
        setResults(resp.items)
      }
      setNextCursor(resp.next_cursor)
      setHasMore(resp.has_more)
      setSearched(true)
      const parentIds = resp.items
        .map((b) => b.parent_id)
        .filter((id): id is string => id != null)
      if (parentIds.length > 0) {
        try {
          const resolved = await batchResolve(parentIds)
          if (Array.isArray(resolved)) {
            setPageTitles((prev) => {
              const next = new Map(prev)
              for (const r of resolved) {
                next.set(r.id, r.title ?? 'Untitled')
              }
              return next
            })
          }
        } catch {
          // breadcrumbs are non-critical
        }
      }
    } catch {
      toast.error('Failed to search')
    }
    setLoading(false)
  }, [])

  const loadMore = useCallback(() => {
    if (nextCursor) executeSearch(query, nextCursor)
  }, [nextCursor, query, executeSearch])

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setQuery(value)

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    if (!value.trim()) {
      setResults([])
      setSearched(false)
      setNextCursor(null)
      setHasMore(false)
      setTyping(false)
      return
    }

    setTyping(true)
    debounceRef.current = setTimeout(() => {
      setTyping(false)
      executeSearch(value)
    }, 300)
  }

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  // Auto-focus search input on mount
  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search blocks"]')
    input?.focus()
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    setTyping(false)
    if (query.trim()) {
      executeSearch(query)
    }
  }

  const handleResultClick = useCallback(
    async (block: BlockRow) => {
      setLoadingResultId(block.id)
      try {
        if (block.block_type === 'page') {
          navigateToPage(block.id, block.content ?? 'Untitled')
          return
        }
        if (block.parent_id) {
          try {
            const parent = await getBlock(block.parent_id)
            navigateToPage(block.parent_id, parent.content ?? 'Untitled', block.id)
          } catch {
            toast.error('Failed to load search results')
          }
        } else {
          toast.error('This block has no parent page')
        }
      } finally {
        setLoadingResultId(null)
      }
    },
    [navigateToPage],
  )

  return (
    <div className="search-panel space-y-4">
      {/* biome-ignore lint/a11y/useSemanticElements: jsdom doesn't support <search> element */}
      <form onSubmit={handleSubmit} role="search" className="flex items-center gap-2">
        <Input
          value={query}
          onChange={handleInputChange}
          placeholder="Search blocks..."
          aria-label="Search blocks"
          className="flex-1"
          autoFocus
        />
        <Button type="submit" variant="outline" disabled={!query.trim()}>
          Search
        </Button>
        {(typing || loading) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </form>

      {hasCJK(query) && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          <span className="font-medium">Note:</span> CJK search is limited in v1. Some results may
          be incomplete.
        </div>
      )}

      {query.trim().length > 0 && query.trim().length < 3 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
          Search requires at least 3 characters
        </div>
      )}

      {loading && !searched && (
        <div className="search-loading space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      <div aria-live="polite">
        {searched && !loading && results.length === 0 && (
          <EmptyState
            icon={Search}
            message="No results found. Try different keywords or check your spelling."
          />
        )}

        {results.length > 0 && (
          <div className="search-results space-y-3" role="list">
            {results.map((block) => (
              <button
                key={block.id}
                type="button"
                role="listitem"
                className="w-full cursor-pointer rounded-lg border bg-card p-4 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => handleResultClick(block)}
                disabled={loadingResultId === block.id}
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm line-clamp-2">
                    {block.content || '(empty)'}
                  </span>
                  {loadingResultId === block.id && (
                    <Loader2 className="h-4 w-4 animate-spin shrink-0 text-muted-foreground" />
                  )}
                  {(block.block_type === 'tag' || block.block_type === 'page') && (
                    <Badge variant="secondary">{block.block_type}</Badge>
                  )}
                </div>
                {block.parent_id && pageTitles.get(block.parent_id) && (
                  <p className="text-xs text-muted-foreground mt-1">
                    in: {pageTitles.get(block.parent_id)}
                  </p>
                )}
              </button>
            ))}
          </div>
        )}
        {searched && !loading && <span className="sr-only">{results.length} results found</span>}
      </div>

      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="search-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
