import type React from 'react'
import { useTranslation } from 'react-i18next'

import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { handleBlockNavigation, resolveBlockDisplay } from '../lib/query-result-utils'
import type { BlockRow } from '../lib/tauri'
import { cn } from '../lib/utils'
import { PageLink } from './PageLink'
import { Badge } from './ui/badge'

export interface QueryResultListProps {
  /** The block results to render as a list. */
  results: BlockRow[]
  /** Map of parent page IDs to their resolved titles. */
  pageTitles: Map<string, string>
  /** Navigate to a block's parent page. */
  onNavigate?: ((pageId: string) => void) | undefined
  /** Resolve block title by ID. */
  resolveBlockTitle?: ((id: string) => string) | undefined
  /** Called when an item is selected via keyboard. */
  onItemSelect?: ((index: number) => void) | undefined
}

export function QueryResultList({
  results,
  pageTitles,
  onNavigate,
  resolveBlockTitle,
  onItemSelect,
}: QueryResultListProps): React.ReactElement {
  const { t } = useTranslation()
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: results.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      onItemSelect?.(idx)
      const block = results[idx]
      if (block) handleBlockNavigation(block, onNavigate)
    },
  })

  return (
    <div
      className="divide-y divide-muted-foreground/10"
      tabIndex={0}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom listbox driven by aria-activedescendant + roving focus; <datalist>/<select> can't host the clickable result-row divs
      role="listbox"
      aria-label={t('query.resultsListLabel')}
      aria-activedescendant={
        results[focusedIndex] ? `query-result-${results[focusedIndex].id}` : undefined
      }
      onKeyDown={(e) => {
        if (handleKeyDown(e)) e.preventDefault()
      }}
    >
      {results.map((block, index) => {
        const { title, pageTitle } = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)
        return (
          <div
            key={block.id}
            id={`query-result-${block.id}`}
            className="query-result-item"
            data-testid="query-result-item"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="option" on the clickable result-row div of the custom listbox; native <option> can't host the rich row content + click navigation
            role="option"
            aria-selected={index === focusedIndex}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              handleBlockNavigation(block, onNavigate)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                handleBlockNavigation(block, onNavigate)
              }
            }}
          >
            <div
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors cursor-pointer [@media(pointer:coarse)]:py-3',
                index === focusedIndex && 'bg-accent',
              )}
            >
              {block.todo_state && (
                <Badge
                  tone="status"
                  shape="rounded"
                  size="compact"
                  statusState={
                    block.todo_state === 'DONE'
                      ? 'DONE'
                      : block.todo_state === 'DOING'
                        ? 'DOING'
                        : 'default'
                  }
                >
                  {block.todo_state}
                </Badge>
              )}
              <span className="flex-1 truncate">{title}</span>
              {pageTitle && block.parent_id && (
                <span className="shrink-0 text-xs text-muted-foreground/60 truncate max-w-[120px]">
                  <PageLink pageId={block.parent_id} title={pageTitle} />
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
