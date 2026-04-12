import { ArrowDown, ArrowUp } from 'lucide-react'
import type React from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { handleBlockNavigation, resolveBlockDisplay } from '../lib/query-result-utils'
import type { BlockRow } from '../lib/tauri'
import { PageLink } from './PageLink'

/** Column definition for table mode. */
export interface TableColumn {
  key: string
  label: string
}

export type SortDirection = 'asc' | 'desc'

export interface QueryResultTableProps {
  /** The block results to render in the table (already sorted). */
  results: BlockRow[]
  /** Column definitions to display. */
  columns: TableColumn[]
  /** Map of parent page IDs to their resolved titles. */
  pageTitles: Map<string, string>
  /** Currently sorted column key (null if unsorted). */
  sortKey: string | null
  /** Current sort direction. */
  sortDir: SortDirection
  /** Callback when a column header is clicked for sorting. */
  onColumnSort: (key: string) => void
  /** Navigate to a block's parent page. */
  onNavigate?: ((pageId: string) => void) | undefined
  /** Resolve block title by ID. */
  resolveBlockTitle?: ((id: string) => string) | undefined
}

export function QueryResultTable({
  results,
  columns,
  pageTitles,
  sortKey,
  sortDir,
  onColumnSort,
  onNavigate,
  resolveBlockTitle,
}: QueryResultTableProps): React.ReactElement {
  return (
    <ScrollArea className="w-full">
      {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: table uses grid role for sortable column headers */}
      <table className="w-full text-xs" role="grid">
        <thead>
          <tr className="border-b border-muted-foreground/20">
            {columns.map((col) => (
              <th
                key={col.key}
                className="px-3 py-1.5 text-left font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/40 transition-colors"
                onClick={() => onColumnSort(col.key)}
                aria-sort={
                  sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
                }
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {sortKey === col.key &&
                    (sortDir === 'asc' ? (
                      <ArrowUp className="h-2.5 w-2.5" aria-hidden="true" />
                    ) : (
                      <ArrowDown className="h-2.5 w-2.5" aria-hidden="true" />
                    ))}
                </span>
              </th>
            ))}
            <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Page</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-muted-foreground/10">
          {results.map((block) => {
            const { title, pageTitle } = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)
            return (
              <tr key={block.id} className="hover:bg-muted/40 transition-colors">
                {columns.map((col) => (
                  <td key={col.key} className="px-3 py-1.5">
                    {col.key === 'content' ? (
                      <button
                        type="button"
                        className="text-left hover:underline truncate max-w-[300px] block"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleBlockNavigation(block, onNavigate)
                        }}
                      >
                        {title}
                      </button>
                    ) : (
                      <span>{(block[col.key as keyof BlockRow] as string) ?? ''}</span>
                    )}
                  </td>
                ))}
                <td className="px-3 py-1.5 [@media(pointer:coarse)]:py-3 text-muted-foreground/60 truncate max-w-[120px]">
                  {pageTitle && block.parent_id ? (
                    <PageLink pageId={block.parent_id} title={pageTitle} />
                  ) : (
                    ''
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </ScrollArea>
  )
}
