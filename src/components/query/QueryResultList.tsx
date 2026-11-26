import { Calendar, FileText, Pilcrow, Tag } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { TaskCheckbox } from '@/components/editor/TaskMarkerButton'
import {
  QueryResultRowContent,
  useRefTitleResolver,
} from '@/components/query/QueryResultRowContent'
import { listRowVariants } from '@/components/ui/list-item'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import type { BlockRow } from '@/lib/bindings'
import { displayPageTitle, isDateFormattedPage } from '@/lib/date-utils'
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
  /** The list's card (`listCardVariants`), where the list is not already inside one. */
  className?: string | undefined
  /** Row density: `compact` for a query block, whose rows sit among a page's blocks. */
  density?: 'default' | 'compact' | undefined
}

/** The sidebar's icons for a journal page, a page and a tag; the editor's Turn into icon for a block. */
const RESULT_TYPE_ICONS = { journal: Calendar, page: FileText, tag: Tag, block: Pilcrow } as const

/** What a result is, as its row's icon shows it. A task shows its checkbox instead. */
function ResultTypeIcon({ block }: { block: BlockRow }): React.ReactElement {
  const type =
    block.block_type === 'tag'
      ? 'tag'
      : block.block_type === 'page'
        ? isDateFormattedPage(block.content ?? '')
          ? 'journal'
          : 'page'
        : 'block'
  const Icon = RESULT_TYPE_ICONS[type]
  return (
    <Icon
      // The task checkbox's size, so the text starts at one edge on every row.
      className="size-[1em] shrink-0 text-muted-foreground [@media(pointer:coarse)]:size-[1.125em]"
      aria-hidden="true"
      data-testid="query-result-type"
      data-type={type}
    />
  )
}

export function QueryResultList({
  results,
  pageTitles,
  onNavigate,
  resolveBlockTitle,
  onItemSelect,
  className,
  density = 'default',
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
      className={className}
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
            className={cn(
              listRowVariants({ density, className: 'query-result-item cursor-pointer text-sm' }),
              index === focusedIndex && 'list-cursor',
            )}
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
            {/* The block's checkbox, drawn but not a control: a button may
                not sit inside a listbox option (#6544). The row's name
                carries the state. */}
            {block.todo_state ? (
              <TaskCheckbox state={block.todo_state} />
            ) : (
              <ResultTypeIcon block={block} />
            )}
            <span className="min-w-0 flex-1 truncate text-block-sm">
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
              <span className="max-w-[120px] shrink-0 truncate text-xs text-muted-foreground">
                {pageTitle}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
