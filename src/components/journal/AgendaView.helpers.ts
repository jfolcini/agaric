/**
 * AgendaView.helpers — pure helpers for AgendaView data-fetch flow.
 *
 * Extracted to keep the component's useEffect body below Biome's cognitive
 * complexity threshold (25). No React, no hooks, no IO — all functions are
 * deterministic and side-effect free.
 */

import type { ExecuteFiltersResult } from '../../lib/agenda-filters'
import type { BlockRow, ResolvedBlock } from '../../lib/tauri'

/**
 * Hard cap on the number of agenda rows rendered per fetch. Matches the
 * original inline `.slice(0, 200)` in AgendaView.
 */
export const AGENDA_MAX_BLOCKS = 200

/** Fallback title used when batch-resolve returns a null title. */
export const FALLBACK_PAGE_TITLE = 'Untitled'

/** Processed outcome of a filter execution, ready for state updates. */
export interface AgendaFetchOutcome {
  /** Blocks to display — capped at {@link AGENDA_MAX_BLOCKS}. */
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
 * cap the blocks at {@link AGENDA_MAX_BLOCKS} and collect the page IDs that
 * need title resolution in a single pass-friendly package.
 */
export function processFilterResult(result: ExecuteFiltersResult): AgendaFetchOutcome {
  const blocks = result.blocks.slice(0, AGENDA_MAX_BLOCKS)
  return {
    blocks,
    hasMore: result.hasMore,
    cursor: result.cursor,
    pageIds: collectUniquePageIds(blocks),
  }
}
