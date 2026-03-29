/**
 * SearchPanel — full-text search across all blocks (p3-t5, p3-t6).
 *
 * Features:
 *  - Debounced search (300ms) on input change
 *  - Immediate search on form submit (Enter / button click)
 *  - Cursor-based pagination ("Load more")
 *  - CJK limitation notice (p3-t6)
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { BlockRow } from '../lib/tauri'
import { getBlock, searchBlocks } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'

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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    } catch {
      // Silently fail
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
      return
    }

    debounceRef.current = setTimeout(() => {
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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    if (query.trim()) {
      executeSearch(query)
    }
  }

  const handleResultClick = useCallback(
    async (block: BlockRow) => {
      if (block.block_type === 'page') {
        navigateToPage(block.id, block.content ?? 'Untitled')
        return
      }
      if (block.parent_id) {
        try {
          const parent = await getBlock(block.parent_id)
          navigateToPage(block.parent_id, parent.content ?? 'Untitled', block.id)
        } catch {
          // Silently fail — parent lookup failed
        }
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
        />
        <Button type="submit" variant="outline" disabled={!query.trim()}>
          Search
        </Button>
      </form>

      {hasCJK(query) && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          <span className="font-medium">Note:</span> CJK search is limited in v1. Some results may
          be incomplete.
        </div>
      )}

      {loading && !searched && (
        <div className="search-loading space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      {searched && !loading && results.length === 0 && (
        <div className="search-empty rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No results found.
        </div>
      )}

      {results.length > 0 && (
        <div className="search-results space-y-2">
          {results.map((block) => (
            <button
              key={block.id}
              type="button"
              className="w-full cursor-pointer rounded-lg border bg-card p-3 text-left hover:bg-accent/50"
              onClick={() => handleResultClick(block)}
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm whitespace-pre-wrap">
                  {block.content || '(empty)'}
                </span>
                {(block.block_type === 'tag' || block.block_type === 'page') && (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {block.block_type}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

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
