import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  BlockRow,
  FilterPrimitive,
  PageHeading,
  PageResponse,
  PageSort,
  PageSubtree,
  PageWithMetadataRow,
  TagCacheRow,
} from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'
import { toSpaceScope, requireActiveScope } from '@/lib/tauri/_shared'

/**
 * Look up a single journal page by its date string in the given space.
 *
 * Replaces the frontend pattern of paginating `listBlocks({ blockType:
 * 'page', limit: 100 })` and probing the resulting Map. Backed by the partial
 * index `idx_blocks_journal_date` (migration 0047) so the lookup is O(index)
 * regardless of total block count. Returns `null` when no journal page exists
 * for `date` in `spaceId`.
 */
export async function getJournalPageByDate(params: {
  date: string
  spaceId: string
}): Promise<BlockRow | null> {
  return unwrap(
    await commands.getJournalPageByDate(params.date, requireActiveScope(params.spaceId)),
  )
}

/**
 * List the date-formatted journal pages in the given space whose date falls
 * inclusively in `[startDate, endDate]`.
 *
 * Replaces the cursor-paginated `listBlocks({ blockType: 'page',
 * limit: 100 })` loop in `useCalendarPageDates` with a range-scoped
 * indexed lookup. Callers pass the visible date range (typically the
 * 6-week calendar grid for monthly views, or the visible week / day for
 * smaller views) so the response is bounded by what the UI actually
 * renders rather than every journal page ever created in the space.
 */
export async function listJournalPagesInRange(params: {
  startDate: string
  endDate: string
  spaceId: string
}): Promise<BlockRow[]> {
  return unwrap(
    await commands.listJournalPagesInRange(
      params.startDate,
      params.endDate,
      requireActiveScope(params.spaceId),
    ),
  )
}

/**
 * Paginated page list with per-page metadata columns:
 * `last_modified_at`, `inbound_link_count`, `child_block_count`, and a
 * `has_property_flags` bitmask (bit 0 tags / 1 todo / 2 scheduled / 3 due).
 *
 * Sibling of {@link listBlocks}. This wrapper backs the `PageBrowser`
 * page list.
 *
 * Sort modes that need server-derived sort keys (`recently-modified`,
 * `most-linked`, `biggest`) cursor-paginate via the new keysets. The
 * frontend-only `recent` (per-device visit history) and `created`
 * (ULID DESC) modes reuse the `ulid` SQL ordering and re-sort in JS.
 */
export async function listPagesWithMetadata(params: {
  sort?: PageSort | undefined
  spaceId: string
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  /**
   * Phase 3 — compound filter primitives applied server-side
   * (AND-composed). Omit / empty for today's unfiltered behaviour. The
   * backend gates each primitive against the Pages allowed-keys set and
   * rejects Search-only primitives with a validation error.
   */
  filters?: FilterPrimitive[] | undefined
}): Promise<PageResponse<PageWithMetadataRow>> {
  return unwrap(
    await commands.listPagesWithMetadata(
      // No frontend-side default — the Rust `#[default] Alphabetical`
      // attribute on `PageSort` is the single source of truth. Sending
      // an explicit value here would silently drift if the backend
      // default ever changes (Review Round 1 — UX MEDIUM #5).
      //
      // `filters` defaults to `[]` (the Rust `#[serde(default)]` would
      // accept its absence too, but sending an explicit empty array keeps
      // the wire shape unambiguous for the mock handler).
      {
        sort: params.sort ?? null,
        spaceId: params.spaceId,
        filters: params.filters ?? [],
      } as Parameters<typeof commands.listPagesWithMetadata>[0],
      params.cursor ?? null,
      params.limit ?? null,
    ),
  )
}

/** Set the complete list of aliases for a page (replaces existing). */
export async function setPageAliases(pageId: string, aliases: string[]): Promise<string[]> {
  return unwrap(await commands.setPageAliases(pageId, aliases))
}

/** Get all aliases for a page. */
export async function getPageAliases(pageId: string): Promise<string[]> {
  return unwrap(await commands.getPageAliases(pageId))
}

/**
 * Resolve a page by one of its aliases. Returns page ID + title, or null.
 *
 * `spaceId` — when set, restricts the match to
 * aliases pointing at pages whose `space` property equals `spaceId`.
 * Mirrors the param-object shape used by `listPageAliasesByPrefix`
 * directly below. Pass `null` / `undefined` to leave the resolve
 * unscoped (cross-space) for callers (e.g. agent / MCP tools) that
 * span every space.
 */
export async function resolvePageByAlias(params: {
  alias: string
  spaceId?: string | null | undefined
}): Promise<[string, string | null] | null> {
  return unwrap(await commands.resolvePageByAlias(params.alias, toSpaceScope(params.spaceId)))
}

/**
 * List page aliases whose alias starts with the given prefix, ordered
 * shortest-alias first, then alphabetical. Bounded server-side at 50.
 *
 * Used by the [[ picker for progressive alias filtering. The
 * exact-match `resolvePageByAlias` is still used by SearchPanel /
 * PageBrowser (out of scope here — follow-ups).
 *
 * `spaceId` — when set, restricts matches to aliases
 * pointing at pages whose `space` property equals `spaceId`. Pass
 * `null`/`undefined` to leave the result set unscoped (cross-space).
 */
export async function listPageAliasesByPrefix(params: {
  prefix: string
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<Array<[string, string, string | null]>> {
  return unwrap(
    await commands.listPageAliasesByPrefix(
      params.prefix,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

// ---------------------------------------------------------------------------
// Markdown export (#519)
// ---------------------------------------------------------------------------

/** Export a page as Markdown with human-readable tag/page references. */
export async function exportPageMarkdown(pageId: string): Promise<string> {
  return unwrap(await commands.exportPageMarkdown(pageId))
}

/**
 * List every page in `spaceId` as `{ id, content }`.  No pagination, no
 * clamp — bounded by the space's intrinsic page count.  Use when the
 * caller genuinely needs every page (markdown export, graph rendering);
 * use `listBlocks` for paginated list views.
 *
 * `tagIds`, when non-empty, restricts the result to pages carrying at
 * least one of those tags via the direct `block_tags` table.  Inherited
 * tags are intentionally excluded — mirrors the GraphView semantics.
 */
export async function listAllPagesInSpace(
  spaceId: string,
  tagIds: string[] | null = null,
): Promise<PageHeading[]> {
  return unwrap(await commands.listAllPagesInSpace(requireActiveScope(spaceId), tagIds))
}

/**
 * Return the IDs of every page in `spaceId` whose `template` property
 * is set to `'true'`.  No pagination, no clamp — templates are a
 * small bounded set by convention.  Used by the graph view to flag
 * template pages with a visual marker.
 */
export async function listTemplatePageIdsInSpace(spaceId: string): Promise<string[]> {
  return unwrap(await commands.listTemplatePageIdsInSpace(requireActiveScope(spaceId)))
}

/**
 * List every tag in `spaceId` as `TagCacheRow[]`.  No pagination, no
 * clamp — bounded by the space's intrinsic tag count.  Use when the
 * caller genuinely needs every tag (the tag-management list view);
 * use `listTagsByPrefix` for typeahead pickers.
 *
 * limit-clamp-followup — replaces `TagList.tsx`'s
 * `listTagsByPrefix({ prefix: '', limit: 500 })` call, which the
 * backend silently clamped to 200 via `MAX_TAGS_PREFIX`.  Tags are
 * space-scoped via `block_properties(key='space')` on the tag block
 * itself (see `commands/tags.rs` cross-space guard).
 */
export async function listAllTagsInSpace(spaceId: string): Promise<TagCacheRow[]> {
  return unwrap(await commands.listAllTagsInSpace(requireActiveScope(spaceId)))
}

/**
 * Load every active descendant under `rootBlockId` in `spaceId` — a
 * single SELECT against the materializer-maintained `page_id` index.
 * Replaces the FE-side recursive `listBlocks` walk that silently
 * clamped each parent to 100 children.
 *
 * Excludes the root block and soft-deleted descendants.  Result order
 * is not load-bearing — `buildFlatTree` regroups by `parent_id`.
 *
 * #1258 — returns the full {@link PageSubtree} (not a bare array) so the
 * caller can read `truncated` / `total`: when a page exceeds the backend
 * `PAGE_SUBTREE_MAX_BLOCKS` cap, `blocks` is capped but `total` carries
 * the true descendant count, letting the UI surface a non-blocking
 * "showing the first N of M" notice instead of silently dropping blocks.
 */
export async function loadPageSubtree(rootBlockId: string, spaceId: string): Promise<PageSubtree> {
  return unwrap(await commands.loadPageSubtree(rootBlockId, requireActiveScope(spaceId)))
}

// ---------------------------------------------------------------------------
// Attachment commands (F-7)
// ---------------------------------------------------------------------------
