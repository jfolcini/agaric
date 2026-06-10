/**
 * AgendaView.helpers — pure helpers for AgendaView data-fetch flow.
 *
 * Extracted to keep the component's useEffect body below Biome's cognitive
 * complexity threshold (25). No React, no hooks, no IO — all functions are
 * deterministic and side-effect free.
 */

import type { ExecuteFiltersResult } from '../../lib/agenda-filters'
import type { BlockRow, ResolvedBlock } from '../../lib/tauri'

/** Fallback title used when batch-resolve returns a null title. */
export const FALLBACK_PAGE_TITLE = 'Untitled'

/** Processed outcome of a filter execution, ready for state updates. */
export interface AgendaFetchOutcome {
  /**
   * Blocks to display. No client-side cap (#721): every fetch path is
   * backend-windowed (≤ 200 rows per source query), so a hard slice
   * here would silently drop rows that the pagination cursor has
   * already moved past — unrecoverable data loss for the user.
   */
  blocks: BlockRow[]
  /** Whether the backend indicates more pages remain. */
  hasMore: boolean
  /** Cursor for the next page (null when exhausted). */
  cursor: string | null
  /** Deduplicated page IDs needing title resolution (never contains null). */
  pageIds: string[]
}

/**
 * Collect the set of non-null `page_id` values from a list of blocks,
 * preserving first-seen order. Used to batch-resolve page titles for
 * breadcrumb display.
 */
export function collectUniquePageIds(blocks: readonly BlockRow[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const b of blocks) {
    if (b.page_id !== null && !seen.has(b.page_id)) {
      seen.add(b.page_id)
      ordered.push(b.page_id)
    }
  }
  return ordered
}

/**
 * Build an `id → title` map from a batch-resolve response. Null titles are
 * replaced with {@link FALLBACK_PAGE_TITLE} so callers can render without
 * additional null checks.
 */
export function buildPageTitleMap(resolved: readonly ResolvedBlock[]): Map<string, string> {
  const titleMap = new Map<string, string>()
  for (const r of resolved) {
    titleMap.set(r.id, r.title ?? FALLBACK_PAGE_TITLE)
  }
  return titleMap
}

/**
 * Transform an `executeAgendaFilters` result into an {@link AgendaFetchOutcome}:
 * pass the blocks through untruncated (#721 — see
 * {@link AgendaFetchOutcome.blocks}) and collect the page IDs that need
 * title resolution in a single pass-friendly package.
 */
export function processFilterResult(result: ExecuteFiltersResult): AgendaFetchOutcome {
  return {
    blocks: result.blocks,
    hasMore: result.hasMore,
    cursor: result.cursor,
    pageIds: collectUniquePageIds(result.blocks),
  }
}

/**
 * Append `next` onto `prev`, dropping any block whose id is already
 * present. Load-more for the unfiltered agenda merges three windowed
 * source queries (#721), so a block with both a due AND a scheduled
 * date can arrive from two sources in DIFFERENT windows — a plain
 * spread would render it twice.
 */
export function appendUniqueBlocks(
  prev: readonly BlockRow[],
  next: readonly BlockRow[],
): BlockRow[] {
  const seen = new Set(prev.map((b) => b.id))
  const merged = [...prev]
  for (const b of next) {
    if (!seen.has(b.id)) {
      seen.add(b.id)
      merged.push(b)
    }
  }
  return merged
}
