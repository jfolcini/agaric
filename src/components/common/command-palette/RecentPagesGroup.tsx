/**
 * RecentPagesGroup — search-mode empty-state list of recent pages.
 * Extracted from `PaletteBody` in CommandPalette.tsx. #1149 — the list
 * is sourced from the reactive recent-pages store by the parent and
 * passed in; this component is purely presentational (rows + the inline
 * Pin-toggle button Phase 4).
 */

import { Clock, Pin } from 'lucide-react'
import type React from 'react'
import type { useTranslation } from 'react-i18next'

import { CommandGroup, CommandItem } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import type { RecentPage } from '@/stores/recent-pages'

export function RecentPagesGroup({
  recents,
  onSelect,
  onTogglePin,
  t,
}: {
  recents: RecentPage[]
  onSelect: (page: RecentPage) => void
  onTogglePin: (pageId: string) => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <CommandGroup heading={t('palette.recentTitle')} data-testid="palette-recents-group">
      {recents.map((page) => {
        const isPinned = page.pinned === true
        return (
          <CommandItem
            key={page.id}
            value={`recent:${page.id}`}
            onSelect={() => onSelect(page)}
            data-testid={`palette-recent-${page.id}`}
            data-pinned={isPinned ? 'true' : undefined}
            className="group gap-2"
          >
            {/*  Phase 4 — pinned entries swap the
                history glyph for a filled `Pin`, signalling
                their sticky-at-top state without a separate
                group heading. */}
            {isPinned ? (
              <Pin
                className="h-3.5 w-3.5 shrink-0 text-foreground"
                fill="currentColor"
                aria-hidden="true"
              />
            ) : (
              <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="flex-1 truncate">{page.title}</span>
            {/*  Phase 4 — inline pin-toggle button.
                Mouse-only for v1 (mobile pin lives in the
                long-press action menu of Phase 5). Stops
                propagation so the row's onSelect does not
                also fire and navigate the user away. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin(page.id)
              }}
              onPointerDown={(e) => {
                // Prevent cmdk from interpreting the
                // pointerdown as a row "click".
                e.stopPropagation()
              }}
              className={cn(
                'rounded p-0.5 text-muted-foreground hover:bg-muted/60 focus-ring-visible',
                isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
              )}
              aria-label={
                isPinned
                  ? t('palette.unpinRecent', { title: page.title })
                  : t('palette.pinRecent', { title: page.title })
              }
              data-testid={`palette-recent-pin-${page.id}`}
            >
              <Pin
                className="h-3 w-3"
                fill={isPinned ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
            </button>
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}
