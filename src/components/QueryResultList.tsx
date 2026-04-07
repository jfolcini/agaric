import type React from 'react'
import type { BlockRow } from '../lib/tauri'
import { truncateContent } from '../lib/text-utils'
import { PageLink } from './PageLink'
import { StatusBadge } from './ui/status-badge'

export interface QueryResultListProps {
  /** The block results to render as a list. */
  results: BlockRow[]
  /** Map of parent page IDs to their resolved titles. */
  pageTitles: Map<string, string>
  /** Navigate to a block's parent page. */
  onNavigate?: ((pageId: string) => void) | undefined
  /** Resolve block title by ID. */
  resolveBlockTitle?: ((id: string) => string) | undefined
}

export function QueryResultList({
  results,
  pageTitles,
  onNavigate,
  resolveBlockTitle,
}: QueryResultListProps): React.ReactElement {
  return (
    <ul className="divide-y divide-muted-foreground/10">
      {results.map((block) => {
        const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
        return (
          <li key={block.id} className="query-result-item" data-testid="query-result-item">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                if (block.parent_id && onNavigate) {
                  onNavigate(block.parent_id)
                }
              }}
            >
              {block.todo_state && (
                <StatusBadge
                  state={
                    block.todo_state === 'DONE'
                      ? 'DONE'
                      : block.todo_state === 'DOING'
                        ? 'DOING'
                        : 'default'
                  }
                >
                  {block.todo_state}
                </StatusBadge>
              )}
              <span className="flex-1 truncate">
                {resolveBlockTitle
                  ? resolveBlockTitle(block.id) || truncateContent(block.content, 80)
                  : truncateContent(block.content, 80)}
              </span>
              {pageTitle && block.parent_id && (
                <span className="shrink-0 text-[10px] text-muted-foreground/60 truncate max-w-[120px]">
                  <PageLink pageId={block.parent_id} title={pageTitle} />
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
