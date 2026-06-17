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
import type { BlockRow, GroupSpec, QueryGroup } from '@/lib/tauri'

import { AggregateSummary } from './AggregateSummary'

export interface GroupedResultsProps {
  /** The group buckets to render. */
  groups: QueryGroup[]
  /**
   * The active grouping dimension (mirrors the request). Used to label the
   * bucket headers: Tag/Page keys are raw block ids resolved via `pageTitles`;
   * BlockType/Priority keys are raw enum codes mapped to display labels;
   * State/Property/DateBucket keys are rendered verbatim (#1447). `null` should
   * not occur in grouped mode but is tolerated (keys render verbatim).
   */
  groupBy?: GroupSpec | null
  /**
   * Map of block IDs to their resolved titles. Shared across members AND used to
   * resolve Tag/Page group-key headers (the hook folds those keys into the same
   * `batchResolve`).
   */
  pageTitles: Map<string, string>
  /** Navigate to a member block's parent page. */
  onNavigate?: ((pageId: string) => void) | undefined
}

export function GroupedResults({
  groups,
  groupBy,
  pageTitles,
  onNavigate,
}: GroupedResultsProps): React.ReactElement {
  const { t } = useTranslation()
  const keyType = groupBy?.key.type
  // Tag/Page bucket keys are raw block ids — resolve them to a human title.
  const isIdKeyed = keyType === 'Tag' || keyType === 'Page'

  /** Resolve one bucket's raw `QueryGroup.key` to its header label. */
  const headerLabel = (key: string): string => {
    // The engine maps the NULL/absent bucket (via COALESCE) to the literal `"none"`.
    if (key === 'none') return t('advancedQuery.group.noneKey')
    // Tag/Page: render the resolved title, falling back to the raw id when it
    // could not be resolved (e.g. a foreign-space or deleted target).
    if (isIdKeyed) return pageTitles.get(key) ?? key
    // BlockType keys are the raw `block_type` enum codes (`content`/`page`/`tag`)
    // — map to their human label, matching the rest of the app (#1447). Unknown
    // codes (e.g. future enum values) fall back to the raw key.
    if (keyType === 'BlockType') {
      const blockTypeLabels: Record<string, string> = {
        content: t('pageBrowser.filter.blockType.content'),
        page: t('pageBrowser.filter.blockType.page'),
        tag: t('pageBrowser.filter.blockType.tag'),
      }
      return blockTypeLabels[key] ?? key
    }
    // Priority keys are stored as bare levels (`1`/`2`/`3`); the app shows them
    // as `P1`–`P3` badges (see FormattingToolbar MetadataGroup) — match that.
    if (keyType === 'Priority') return `P${key}`
    // State keys (`TODO`/`DOING`/`DONE`/`CANCELLED`) are the canonical display
    // tokens used throughout the app; Property/DateBucket keys are likewise
    // already display strings emitted by the engine. Render verbatim.
    return key
  }
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
                {headerLabel(group.key)}
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
