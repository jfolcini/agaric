/**
 * RecentPagesGroup — search-mode empty-state list of recent pages.
 * Extracted from `PaletteBody` in CommandPalette.tsx. #1149 — the list
 * is sourced from the reactive recent-pages store by the parent and
 * passed in; this component is purely presentational (rows + the inline
 * bookmark toggle, Phase 4).
 *
 * A bookmark IS a pinned recent page — the sidebar's Bookmarks section is a
 * view over the same `recent-pages` state. The store still spells the flag
 * `pinned` (it is persisted under that name), so `onToggleBookmark` is wired
 * to `togglePinRecentPage` at the one seam, in `CommandPalette.tsx`.
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
  onToggleBookmark,
  t,
}: {
  recents: RecentPage[]
  onSelect: (page: RecentPage) => void
  onToggleBookmark: (pageId: string) => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <CommandGroup heading={t('palette.recentTitle')} data-testid="palette-recents-group">
      {recents.map((page) => {
        const isBookmarked = page.pinned === true
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
            {/*  Phase 4 — inline bookmark-toggle button.
                Mouse-only for v1 (the mobile affordance lives in
                the long-press action menu of Phase 5). Stops
                propagation so the row's onSelect does not
                also fire and navigate the user away. */}
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
                'rounded p-0.5 text-muted-foreground hover:bg-muted/60 focus-ring-visible',
                isBookmarked
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
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
