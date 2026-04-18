/**
 * Pure helpers for {@link DonePanel}.
 *
 * Extracted from the component to keep individual effects/callbacks below the
 * Biome cognitive-complexity threshold (MAINT-58). Each helper is pure and
 * independently unit-tested in `__tests__/DonePanel.helpers.test.ts`.
 */

import type { BlockRow, ResolvedBlock } from '../lib/tauri'

/** A single grouped-by-source-page bucket used by the DonePanel render. */
export interface DoneBlockGroup {
  pageId: string
  title: string
  items: BlockRow[]
}

/**
 * Drop blocks with empty/whitespace content (UX-129) and blocks whose
 * `parent_id` matches the page the panel is currently rendered on (B-74).
 */
export function filterDoneBlocks(
  items: readonly BlockRow[],
  excludePageId: string | undefined,
): BlockRow[] {
  const out: BlockRow[] = []
  for (const b of items) {
    if (!b.content?.trim()) continue
    if (excludePageId && b.parent_id === excludePageId) continue
    out.push(b)
  }
  return out
}

/**
 * Collect the unique, non-null `page_id`s from a list of blocks. Preserves
 * first-seen order so callers can pass the result straight to `batchResolve`.
 */
export function collectUniqueParentIds(blocks: readonly BlockRow[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const b of blocks) {
    const pid = b.page_id
    if (pid != null && !seen.has(pid)) {
      seen.add(pid)
      out.push(pid)
    }
  }
  return out
}

/**
 * Merge freshly-resolved titles into an existing id→title map. Null/undefined
 * titles fall back to `untitledLabel`. Returns a new Map — the input is not
 * mutated.
 */
export function mergeResolvedTitles(
  prev: ReadonlyMap<string, string>,
  resolved: readonly ResolvedBlock[],
  untitledLabel: string,
): Map<string, string> {
  const next = new Map(prev)
  for (const r of resolved) {
    next.set(r.id, r.title ?? untitledLabel)
  }
  return next
}

/**
 * Group blocks by source page and sort.
 *
 * - Groups alphabetically by resolved page title (locale-aware).
 * - Inside each group, sorts by block id descending (ULID ≈ most recently
 *   created first).
 * - Blocks with no `page_id` are bucketed under a synthetic `__none__` pageId
 *   and labelled with `untitledLabel`.
 */
export function groupBlocksByPage(
  blocks: readonly BlockRow[],
  pageTitles: ReadonlyMap<string, string>,
  untitledLabel: string,
): DoneBlockGroup[] {
  const groupMap = new Map<string, DoneBlockGroup>()
  for (const block of blocks) {
    const pageId = block.page_id ?? '__none__'
    const title = block.page_id ? (pageTitles.get(block.page_id) ?? untitledLabel) : untitledLabel
    let bucket = groupMap.get(pageId)
    if (!bucket) {
      bucket = { pageId, title, items: [] }
      groupMap.set(pageId, bucket)
    }
    bucket.items.push(block)
  }
  const groups = [...groupMap.values()].sort((a, b) => a.title.localeCompare(b.title))
  for (const group of groups) {
    group.items.sort((a, b) => b.id.localeCompare(a.id))
  }
  return groups
}
