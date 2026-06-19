/**
 * RecentSearchesGroup — #131 recent search TERMS surface (distinct from
 * recent pages). Extracted from `PaletteBody` in CommandPalette.tsx; the
 * mobile empty state renders it so a tap re-runs a prior query. Mobile
 * only — desktop search already has the find-in-files history surface.
 */

import { Search as SearchIcon } from 'lucide-react'
import type React from 'react'
import type { useTranslation } from 'react-i18next'

import { CommandGroup, CommandItem } from '@/components/ui/command'

export function RecentSearchesGroup({
  recentSearches,
  onRun,
  onClear,
  t,
}: {
  recentSearches: string[]
  onRun: (term: string) => void
  onClear: () => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <CommandGroup
      heading={
        <span className="flex items-center justify-between gap-2">
          <span>{t('searchSheet.recentSearchesTitle')}</span>
          <button
            type="button"
            // cmdk treats keydown on items specially; this lives
            // in the heading (not an item), so a plain onClick is
            // safe. stopPropagation keeps the list from also
            // reacting.
            onClick={(e) => {
              e.stopPropagation()
              onClear()
            }}
            data-testid="palette-recent-searches-clear"
            className="rounded px-1 text-xs font-normal text-muted-foreground hover:text-foreground focus-ring-visible"
          >
            {t('searchSheet.recentSearchesClear')}
          </button>
        </span>
      }
      data-testid="palette-recent-searches-group"
    >
      {recentSearches.map((term) => (
        <CommandItem
          key={term}
          value={`recentsearch:${term}`}
          onSelect={() => onRun(term)}
          data-testid={`palette-recent-search-${term}`}
          aria-label={t('searchSheet.recentSearchRunLabel', { term })}
          className="gap-2"
        >
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1 truncate">{term}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  )
}
