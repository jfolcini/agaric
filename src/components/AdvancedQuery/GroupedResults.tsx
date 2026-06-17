/**
 * GroupedResults — renders the GROUPED-mode advanced-query response (#1280 D2).
 *
 * Each `QueryGroup` becomes a section: a header (group key label + full bucket
 * count + per-group aggregate chips) over its previewed member rows. Members are
 * a bounded preview from the engine (`QueryGroup.members`), rendered with the
 * shared `QueryResultList` so a member row looks identical to a flat result row.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { QueryResultList } from '@/components/query/QueryResultList'
import type { BlockRow, QueryGroup } from '@/lib/tauri'

import { AggregateSummary } from './AggregateSummary'

export interface GroupedResultsProps {
  /** The group buckets to render. */
  groups: QueryGroup[]
  /** Map of parent page IDs to their resolved titles (shared across members). */
  pageTitles: Map<string, string>
  /** Navigate to a member block's parent page. */
  onNavigate?: ((pageId: string) => void) | undefined
}

export function GroupedResults({
  groups,
  pageTitles,
  onNavigate,
}: GroupedResultsProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      className="advanced-query-groups flex flex-col gap-4"
      data-testid="advanced-query-groups"
      aria-label={t('advancedQuery.group.summaryLabel')}
    >
      {groups.map((group, index) => {
        const members = group.members as unknown as BlockRow[]
        return (
          <section
            // biome-ignore lint/suspicious/noArrayIndexKey: group keys can repeat across pages; index is the stable position
            key={`${group.key}-${index}`}
            className="advanced-query-group flex flex-col gap-1.5"
            data-testid="advanced-query-group-section"
          >
            <header className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium" data-testid="advanced-query-group-key">
                {group.key}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('advancedQuery.group.countLabel', { count: group.count })}
              </span>
              {group.aggregates != null && group.aggregates.length > 0 && (
                <AggregateSummary
                  results={group.aggregates}
                  label={t('advancedQuery.aggregate.summaryLabel')}
                  testId="advanced-query-group-aggregates"
                />
              )}
            </header>
            {members.length > 0 && (
              <QueryResultList results={members} pageTitles={pageTitles} onNavigate={onNavigate} />
            )}
          </section>
        )
      })}
    </div>
  )
}
