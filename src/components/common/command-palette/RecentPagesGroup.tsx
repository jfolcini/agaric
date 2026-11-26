/**
 * RecentPagesGroup — search-mode empty-state list of recent pages.
 * Extracted from `PaletteBody` in CommandPalette.tsx. #1149 — the list
 * is sourced from the reactive recent-pages store by the parent and
 * passed in; this component is purely presentational (rows + the inline
 * bookmark toggle, Phase 4).
 *
 * Bookmarked state is NOT part of a recent entry: it comes from the one
 * bookmark list (the `bookmark` page property), passed down as `bookmarkedIds`, so the
 * glyph here and the star in the page header always agree.
 */

import { Bookmark, Clock } from 'lucide-react'
import type React from 'react'
import type { useTranslation } from 'react-i18next'

import { CommandGroup, CommandItem } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import type { RecentPage } from '@/stores/recent-pages'

export function RecentPagesGroup({
  recents,
  onSelect,
  bookmarkedIds,
  onToggleBookmark,
  t,
}: {
  recents: RecentPage[]
  onSelect: (page: RecentPage) => void
  bookmarkedIds: ReadonlySet<string>
  onToggleBookmark: (pageId: string) => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <CommandGroup heading={t('palette.recentTitle')} data-testid="palette-recents-group">
      {recents.map((page) => {
        const isBookmarked = bookmarkedIds.has(page.id)
        return (
          <CommandItem
            key={page.id}
            value={`recent:${page.id}`}
            onSelect={() => onSelect(page)}
            data-testid={`palette-recent-${page.id}`}
            data-bookmarked={isBookmarked ? 'true' : undefined}
            className="group gap-2"
          >
            {/*  Phase 4 — bookmarked entries swap the
                history glyph for a filled `Bookmark`, signalling
                their sticky-at-top state without a separate
                group heading. */}
            {isBookmarked ? (
              <Bookmark
                className="h-3.5 w-3.5 shrink-0 text-foreground"
                fill="currentColor"
                aria-hidden="true"
              />
            ) : (
              <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="flex-1 truncate">{page.title}</span>
            {/*  Phase 4 — inline bookmark-toggle button. Stops
                propagation so the row's onSelect does not
                also fire and navigate the user away. On touch it sits
                far enough from the list's edge, which clips, for its
                whole 44 px hit area to take taps. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggleBookmark(page.id)
              }}
              onPointerDown={(e) => {
                // Prevent cmdk from interpreting the
                // pointerdown as a row "click".
                e.stopPropagation()
              }}
              className={cn(
                'touch-hit-area rounded p-0.5 text-muted-foreground hover:bg-muted/60 focus-ring-visible coarse:mr-1.5',
                !isBookmarked && 'hover-reveal',
              )}
              aria-label={
                isBookmarked
                  ? t('bookmarks.remove', { title: page.title })
                  : t('palette.bookmarkPage', { title: page.title })
              }
              data-testid={`palette-recent-bookmark-${page.id}`}
            >
              <Bookmark
                className="h-3 w-3"
                fill={isBookmarked ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
            </button>
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}
