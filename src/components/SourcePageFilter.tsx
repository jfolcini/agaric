/**
 * SourcePageFilter -- filter popup for including/excluding source pages
 * in linked references.
 *
 * Renders a filter icon button that opens a popover with a searchable list
 * of source pages. Click to include (green), shift+click to exclude (red).
 */

import { Filter } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface SourcePageFilterProps {
  /** All source pages from the grouped response, used to populate the list. */
  sourcePages: Array<{ pageId: string; pageTitle: string | null; blockCount: number }>
  /** Currently included page IDs. */
  included: string[]
  /** Currently excluded page IDs. */
  excluded: string[]
  /** Called when include/exclude state changes. */
  onChange: (included: string[], excluded: string[]) => void
}

export function SourcePageFilter({
  sourcePages,
  included,
  excluded,
  onChange,
}: SourcePageFilterProps): React.ReactElement {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const hasIncludes = included.length > 0
  const hasExcludes = excluded.length > 0
  const hasFilters = hasIncludes || hasExcludes

  // Determine button color based on filter state
  const buttonColor = useMemo(() => {
    if (hasIncludes && hasExcludes) return 'text-status-pending-foreground'
    if (hasIncludes) return 'text-primary'
    if (hasExcludes) return 'text-destructive'
    return 'text-muted-foreground'
  }, [hasIncludes, hasExcludes])

  // Sort by blockCount descending, then filter by search
  const filteredPages = useMemo(() => {
    const sorted = [...sourcePages].sort((a, b) => b.blockCount - a.blockCount)
    if (!search.trim()) return sorted
    const q = search.toLowerCase()
    return sorted.filter((p) => (p.pageTitle ?? 'Untitled').toLowerCase().includes(q))
  }, [sourcePages, search])

  const handlePageClick = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent, pageId: string) => {
      const shiftKey = 'shiftKey' in e ? e.shiftKey : false
      if (shiftKey) {
        // Shift+click: toggle exclude
        if (excluded.includes(pageId)) {
          onChange(
            included,
            excluded.filter((id) => id !== pageId),
          )
        } else {
          // Remove from included if present, add to excluded
          onChange(
            included.filter((id) => id !== pageId),
            [...excluded, pageId],
          )
        }
      } else {
        // Normal click: toggle include
        if (included.includes(pageId)) {
          onChange(
            included.filter((id) => id !== pageId),
            excluded,
          )
        } else {
          // Remove from excluded if present, add to included
          onChange(
            [...included, pageId],
            excluded.filter((id) => id !== pageId),
          )
        }
      }
    },
    [included, excluded, onChange],
  )

  const handleClearAll = useCallback(() => {
    onChange([], [])
  }, [onChange])

  const handlePageKeyDown = useCallback(
    (e: React.KeyboardEvent, pageId: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handlePageClick(e, pageId)
      }
    },
    [handlePageClick],
  )

  const getDotColor = (pageId: string): string => {
    if (included.includes(pageId)) return 'bg-primary'
    if (excluded.includes(pageId)) return 'bg-destructive'
    return 'bg-muted-foreground'
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`source-page-filter-trigger h-7 w-7 p-0 ${buttonColor}`}
          aria-label={t('sourceFilter.filterLabel')}
        >
          <Filter className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2 max-w-[calc(100vw-2rem)]" align="start">
        <div className="source-page-filter-content space-y-2">
          <Input
            placeholder={t('sourceFilter.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs"
            aria-label={t('sourceFilter.searchLabel')}
          />
          <ScrollArea className="max-h-48">
            <div className="source-page-filter-list space-y-0.5">
              {filteredPages.map((page) => (
                <button
                  key={page.pageId}
                  type="button"
                  className="source-page-filter-item flex w-full items-center gap-2 rounded px-2 py-1 text-xs cursor-pointer hover:bg-accent/50 active:bg-accent/70"
                  onClick={(e) => handlePageClick(e, page.pageId)}
                  onKeyDown={(e) => handlePageKeyDown(e, page.pageId)}
                >
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${getDotColor(page.pageId)}`}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate">{page.pageTitle ?? 'Untitled'}</span>
                  <span className="text-muted-foreground">({page.blockCount})</span>
                </button>
              ))}
              {filteredPages.length === 0 && (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  {t('sourceFilter.noPagesFound')}
                </div>
              )}
            </div>
          </ScrollArea>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="source-page-filter-clear w-full text-xs"
              onClick={handleClearAll}
            >
              {t('sourceFilter.clearAllButton')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
