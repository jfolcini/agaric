/**
 * TagFilterPanel — boolean tag filter with AND/OR mode (p3-t9).
 *
 * Lets users select multiple tags via prefix search and see blocks
 * matching all (AND) or any (OR) of the selected tags.
 * Results are paginated with cursor-based "Load more".
 */

import { Plus, Search, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { BlockRow } from '../lib/tauri'
import { getBlock, listTagsByPrefix, queryByTags } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'

interface SelectedTag {
  id: string
  name: string
}

interface MatchingTag {
  tag_id: string
  name: string
  usage_count: number
}

function HighlightPrefix({ text, prefix }: { text: string; prefix: string }): React.ReactElement {
  const trimmed = prefix.trim().toLowerCase()
  if (!trimmed || !text.toLowerCase().startsWith(trimmed)) {
    return <>{text}</>
  }
  return (
    <>
      <strong>{text.slice(0, trimmed.length)}</strong>
      {text.slice(trimmed.length)}
    </>
  )
}

export function TagFilterPanel(): React.ReactElement {
  const [prefix, setPrefix] = useState('')
  const [matchingTags, setMatchingTags] = useState<MatchingTag[]>([])
  const [selectedTags, setSelectedTags] = useState<SelectedTag[]>([])
  const [mode, setMode] = useState<'and' | 'or'>('and')
  const [results, setResults] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)

  // Debounced prefix search
  const searchTags = useCallback(async (p: string) => {
    try {
      const tags = await listTagsByPrefix({ prefix: p })
      setMatchingTags(
        tags.map((t) => ({
          tag_id: t.tag_id,
          name: t.name,
          usage_count: t.usage_count,
        })),
      )
    } catch {
      // Silently fail
    }
  }, [])

  function handlePrefixChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setPrefix(value)

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    if (!value.trim()) {
      setMatchingTags([])
      return
    }

    debounceRef.current = setTimeout(() => {
      searchTags(value)
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

  // Execute block query when selectedTags or mode changes
  const executeQuery = useCallback(
    async (cursor?: string) => {
      if (selectedTags.length === 0) {
        setResults([])
        setNextCursor(null)
        setHasMore(false)
        return
      }

      setLoading(true)
      try {
        const resp = await queryByTags({
          tagIds: selectedTags.map((t) => t.id),
          prefixes: [],
          mode,
          cursor,
          limit: 50,
        })
        if (cursor) {
          setResults((prev) => [...prev, ...resp.items])
        } else {
          setResults(resp.items)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
      } catch {
        // Silently fail
      }
      setLoading(false)
    },
    [selectedTags, mode],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger query when selectedTags or mode changes
  useEffect(() => {
    executeQuery()
  }, [selectedTags, mode, executeQuery])

  const handleAddTag = useCallback(
    (tag: MatchingTag) => {
      if (selectedTags.some((t) => t.id === tag.tag_id)) return
      setSelectedTags((prev) => [...prev, { id: tag.tag_id, name: tag.name }])
    },
    [selectedTags],
  )

  const handleRemoveTag = useCallback((tagId: string) => {
    setSelectedTags((prev) => prev.filter((t) => t.id !== tagId))
  }, [])

  const loadMore = useCallback(() => {
    if (nextCursor) executeQuery(nextCursor)
  }, [nextCursor, executeQuery])

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

  // Filter out already-selected tags from matching results
  const filteredMatching = matchingTags.filter((t) => !selectedTags.some((s) => s.id === t.tag_id))

  return (
    <div className="tag-filter-panel space-y-4">
      <h3 className="text-sm font-semibold">Tag Filter</h3>

      {/* Prefix search */}
      <div className="flex items-center gap-2">
        <Input
          value={prefix}
          onChange={handlePrefixChange}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setPrefix('')
              setMatchingTags([])
            }
          }}
          placeholder="Search tags by prefix..."
          aria-label="Search tags by prefix"
          className="flex-1"
        />
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      {/* Selected tags */}
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Selected:</span>
          {selectedTags.map((tag) => (
            <Badge key={tag.id} variant="secondary" className="gap-1">
              {tag.name}
              <button
                type="button"
                className="ml-1 rounded-full hover:bg-muted"
                onClick={() => handleRemoveTag(tag.id)}
                aria-label={`Remove tag ${tag.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* AND/OR mode toggle */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Mode:</span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={mode === 'and' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMode('and')}
                aria-pressed={mode === 'and'}
              >
                AND
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Show blocks with ALL selected tags</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={mode === 'or' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMode('or')}
                aria-pressed={mode === 'or'}
              >
                OR
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Show blocks with ANY selected tag</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Filter feedback summary */}
      {selectedTags.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="tag-filter-feedback">
          Select tags above to filter blocks
        </p>
      )}
      {selectedTags.length > 0 && !loading && results.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="tag-filter-feedback">
          {results.length} {results.length === 1 ? 'block matches' : 'blocks match'}{' '}
          {selectedTags.length} {selectedTags.length === 1 ? 'tag' : 'tags'} ({mode.toUpperCase()})
        </p>
      )}

      {/* Matching tags from prefix search */}
      {filteredMatching.length > 0 && (
        <section className="rounded-lg border bg-card p-3">
          <h4 className="mb-2 text-sm font-medium text-muted-foreground">Matching tags</h4>
          <div className="space-y-1">
            {filteredMatching.map((tag) => (
              <div
                key={tag.tag_id}
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                <span>
                  <HighlightPrefix text={tag.name} prefix={prefix} /> ({tag.usage_count})
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2"
                  onClick={() => handleAddTag(tag)}
                >
                  <Plus className="h-3 w-3" />
                  Add
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Loading indicator */}
      {loading && results.length === 0 && (
        <div className="tag-filter-loading space-y-3">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      {/* Empty results */}
      {selectedTags.length > 0 && !loading && results.length === 0 && (
        <div className="tag-filter-empty rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No matching blocks found.
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <section className="tag-filter-results space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">Results ({results.length})</h4>
          {results.map((block) => (
            <button
              key={block.id}
              type="button"
              className="w-full cursor-pointer rounded-lg border bg-card p-4 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => handleResultClick(block)}
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm whitespace-pre-wrap">
                  {block.content || '(empty)'}
                </span>
                {(block.block_type === 'tag' || block.block_type === 'page') && (
                  <Badge variant="secondary">{block.block_type}</Badge>
                )}
              </div>
            </button>
          ))}
        </section>
      )}

      {/* Load more */}
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="tag-filter-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
