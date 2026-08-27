import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { PageHeading, PageSubtree, TagCacheRow } from '@/lib/bindings'
import { toSpaceScope, requireActiveScope } from '@/lib/tauri/_shared'

/** Get all aliases for a page. */
export async function getPageAliases(pageId: string): Promise<string[]> {
  return unwrap(await commands.getPageAliases(pageId))
}

/**
 * Resolve a page by one of its aliases. Returns page ID + title, or null.
 *
 * `spaceId` — when set, restricts the match to
 * aliases pointing at pages whose `space` property equals `spaceId`.
 * Pass `null` / `undefined` to leave the resolve unscoped (cross-space)
 * for callers (e.g. agent / MCP tools) that span every space.
 */
export async function resolvePageByAlias(params: {
  alias: string
  spaceId?: string | null | undefined
}): Promise<[string, string | null] | null> {
  return unwrap(await commands.resolvePageByAlias(params.alias, toSpaceScope(params.spaceId)))
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
