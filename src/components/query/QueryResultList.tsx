import type React from 'react'
import { useTranslation } from 'react-i18next'

import { PageLink } from '@/components/pages/PageLink'
import {
  QueryResultRowContent,
  useRefTitleResolver,
} from '@/components/query/QueryResultRowContent'
import { Badge } from '@/components/ui/badge'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import type { BlockRow } from '@/lib/bindings'
import { handleBlockNavigation, resolveBlockDisplay } from '@/lib/query-result-utils'
import { cn } from '@/lib/utils'

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
  // #4719 — the CHIP's resolver, not the optional `resolveBlockTitle` prop:
  // `AdvancedQueryView` / `GroupedResults` render this list without that prop
  // while their rows still resolve chips. See `resolveBlockDisplay`.
  const resolveRefTitle = useRefTitleResolver()
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
        const { title, displayMarkdown, pageTitle } = resolveBlockDisplay(
          block,
          pageTitles,
          resolveBlockTitle,
          resolveRefTitle,
        )
        // An `aria-label` REPLACES the row's contents as its accessible name,
        // so it has to carry everything the row shows, not just the body: the
        // todo badge and the parent-page name are rendered inside this same
        // `role="option"` and were part of the computed name before the label
        // existed ("TODO call the plumber My Page"). Naming the row after the
        // body alone would quietly drop the state and the page from what a
        // screen reader announces. The page arm mirrors the render condition
        // below exactly, so the name never claims a page the row does not show.
        const rowLabel = [block.todo_state, title, pageTitle && block.parent_id ? pageTitle : null]
          .filter(Boolean)
          .join(' ')
        return (
          <div
            key={block.id}
            id={`query-result-${block.id}`}
            className="query-result-item"
            data-testid="query-result-item"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="option" on the clickable result-row div of the custom listbox; native <option> can't host the rich row content + click navigation
            role="option"
            // Composed rather than left to the contents: the body is an
            // element tree now, and content the inline renderer drops
            // entirely (a lone `---`) would leave the row unnamed. Why the
            // string is safe to use as a name: see `resolveBlockDisplay`.
            aria-label={rowLabel}
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
              <span className="flex-1 truncate">
                {displayMarkdown !== null ? (
                  <QueryResultRowContent content={displayMarkdown} />
                ) : (
                  title
                )}
              </span>
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
