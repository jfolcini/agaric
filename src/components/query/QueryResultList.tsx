import { cva } from 'class-variance-authority'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { TaskCheckbox } from '@/components/editor/TaskMarkerButton'
import {
  QueryResultRowContent,
  useRefTitleResolver,
} from '@/components/query/QueryResultRowContent'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import type { BlockRow } from '@/lib/bindings'
import { displayPageTitle } from '@/lib/date-utils'
import { handleBlockNavigation, resolveBlockDisplay } from '@/lib/query-result-utils'
import { cn } from '@/lib/utils'

const rowVariants = cva(
  'flex w-full gap-2 text-left hover:bg-muted/40 transition-colors cursor-pointer',
  {
    variants: {
      layout: {
        rows: 'items-center px-3 py-1.5 text-xs [@media(pointer:coarse)]:py-3',
        cards:
          'flex-wrap items-start gap-y-1 overflow-hidden rounded-lg border bg-card p-3 text-sm',
      },
    },
  },
)

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
  /** `cards` gives each result a bordered card that wraps its text, for a board column. */
  layout?: 'rows' | 'cards' | undefined
  /** Names the listbox; defaults to the generic results label. */
  ariaLabel?: string | undefined
}

export function QueryResultList({
  results,
  pageTitles,
  onNavigate,
  resolveBlockTitle,
  onItemSelect,
  layout = 'rows',
  ariaLabel,
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
      // A card column always has a cursor card, which carries the focus ring.
      className={
        layout === 'cards' ? 'flex flex-col gap-2 outline-hidden' : 'divide-y divide-border'
      }
      tabIndex={0}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom listbox driven by aria-activedescendant + roving focus; <datalist>/<select> can't host the clickable result-row divs
      role="listbox"
      aria-label={ariaLabel ?? t('query.resultsListLabel')}
      aria-activedescendant={
        results[focusedIndex] ? `query-result-${results[focusedIndex].id}` : undefined
      }
      onKeyDown={(e) => {
        if (handleKeyDown(e)) e.preventDefault()
      }}
    >
      {results.map((block, index) => {
        const {
          title,
          displayMarkdown,
          pageTitle: storedPageTitle,
        } = resolveBlockDisplay(block, pageTitles, resolveBlockTitle, resolveRefTitle)
        const pageTitle = storedPageTitle && displayPageTitle(storedPageTitle)
        // An `aria-label` REPLACES the row's contents as its accessible name,
        // so it has to carry everything the row shows, not just the body: the
        // task checkbox and the parent-page name are rendered inside this same
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
            <div className={cn(rowVariants({ layout }), index === focusedIndex && 'list-cursor')}>
              {/* The block's checkbox, drawn but not a control: a button may
                  not sit inside a listbox option (#6544). The row's name
                  carries the state. */}
              {block.todo_state && <TaskCheckbox state={block.todo_state} />}
              <span
                className={layout === 'cards' ? 'min-w-0 flex-1 line-clamp-3' : 'flex-1 truncate'}
              >
                {displayMarkdown !== null ? (
                  <QueryResultRowContent content={displayMarkdown} />
                ) : (
                  title
                )}
              </span>
              {pageTitle && block.parent_id && (
                // #4737 — plain text, not `PageLink`: a `role="option"` may
                // not contain a focusable widget (axe `nested-interactive`),
                // and `PageLink`'s link role was never reachable from this
                // listbox's roving `tabIndex={-1}` rows anyway. The row's own
                // click/Enter handler already opens this same page via
                // `handleBlockNavigation`, so the target stays reachable.
                <span
                  className={cn(
                    'text-xs text-muted-foreground truncate',
                    layout === 'cards' ? 'basis-full' : 'shrink-0 max-w-[120px]',
                  )}
                >
                  {pageTitle}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
