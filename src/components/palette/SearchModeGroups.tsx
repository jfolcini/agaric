/**
 * Search-mode result groups renderer. Extracted from CommandPalette.tsx
 * (#751).
 */

import { FileText } from 'lucide-react'
import type React from 'react'
import type { useTranslation } from 'react-i18next'

import { SnippetHighlight } from '@/components/search/SnippetHighlight'
import { CommandGroup, CommandItem } from '@/components/ui/command'

import type { PaletteGroup } from './types'

/**
 * Search-mode body — renders the merged groups produced by
 * `mergeAndRankGroups`. cmdk owns the highlight state via its own
 * `value`-keyed selection; we forward the same `<CommandItem
 * value={...}>` ids and let cmdk wire up `aria-activedescendant`.
 */
export function SearchModeGroups({
  groups,
  linkMode,
  onNavigatePage,
  onNavigateBlock,
  onEscalateToMore,
  t,
}: {
  groups: PaletteGroup[]
  linkMode: boolean
  onNavigatePage: (pageId: string, pageTitle: string) => void
  onNavigateBlock: (blockId: string, pageId: string, pageTitle: string) => void
  onEscalateToMore: () => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <>
      {groups.map((group) => (
        // No `heading` prop. The page-header CommandItem
        // below IS the visible title; cmdk's muted group-heading would
        // double-render the page title in the same group.
        <CommandGroup key={group.pageId} data-testid={`palette-group-${group.pageId}`}>
          <CommandItem
            value={`page:${group.pageId}`}
            onSelect={() => onNavigatePage(group.pageId, group.pageTitle)}
            data-testid={`palette-page-header-${group.pageId}`}
            className="flex items-center gap-2"
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1 truncate">{group.pageTitle}</span>
            {group.hasPageNameMatch && (
              // Render the title-match signal as a small
              // uppercase pill so it reads as metadata rather than as
              // an accidental subtitle. Matches Linear's match-source
              // pill convention.
              <span
                className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                data-testid="palette-title-match-tag"
              >
                {t('palette.titleMatchTag')}
              </span>
            )}
          </CommandItem>
          {!linkMode &&
            group.matches.map((block) => (
              <CommandItem
                key={block.id}
                value={`block:${block.id}`}
                onSelect={() => onNavigateBlock(block.id, group.pageId, group.pageTitle)}
                data-testid={`palette-block-${block.id}`}
                className="ml-6"
              >
                {/* Render the FTS5 snippet with `<mark>` boundaries
                    inline. We avoid wrapping `SearchResultBlockRow`
                    (which is a `<li role="option">`) inside the
                    `<CommandItem>` (already an option) — nesting two
                    listbox options would violate ARIA. SnippetHighlight
                    is the pure renderer extracted in . */}
                {block.snippet != null && block.snippet.length > 0 ? (
                  <SnippetHighlight snippet={block.snippet} className="truncate" />
                ) : (
                  <span className="truncate">{block.content ?? ''}</span>
                )}
              </CommandItem>
            ))}
          {!linkMode && group.surplus > 0 && (
            <CommandItem
              value={`more:${group.pageId}`}
              onSelect={onEscalateToMore}
              data-testid={`palette-more-pill-${group.pageId}`}
              className="ml-6 text-xs text-muted-foreground"
            >
              {t('palette.moreInThisPage', { count: group.surplus })}
            </CommandItem>
          )}
        </CommandGroup>
      ))}
    </>
  )
}
