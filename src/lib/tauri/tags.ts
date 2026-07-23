import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  BlockRow,
  PageResponse,
  TagCacheRow,
  TagExpr,
  TagResponse,
  WithOps,
} from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'
import { toSpaceScope } from '@/lib/tauri/_shared'

/** Associate a tag with a block.
 *
 * #2468: carries `op_refs`. The real backend REJECTS an already-present tag
 * (`InvalidOperation("tag already applied")`), so a real success never has
 * empty `op_refs`; the tauri-mock's lenient duplicate path (kept for the
 * `tag_add_remove` conformance fixture) returns `op_refs: []` instead —
 * callers must NOT push an undo entry when `op_refs` is empty.
 */
export async function addTag(blockId: string, tagId: string): Promise<WithOps<TagResponse>> {
  return unwrap(await commands.addTag(blockId, tagId))
}

/**
 * #81 / add ONE tag to N blocks in a single IPC.
 *
 * Bulk counterpart to {@link addTag}; the backend skips ids that are
 * missing or already carry the tag, and returns the number of blocks
 * newly tagged. Used by the Pages-view batch toolbar's "Add tag" action.
 */
export async function addTagsByIds(blockIds: string[], tagId: string): Promise<number> {
  return unwrap(await commands.addTagsByIds(blockIds, tagId))
}

/** Remove a tag association from a block.
 *
 * #2468: carries `op_refs`. The real backend REJECTS an unattached remove
 * (`NotFound("tag association")`); only the tauri-mock's lenient path
 * returns `op_refs: []` — callers must NOT push an undo entry then.
 */
export async function removeTag(blockId: string, tagId: string): Promise<WithOps<TagResponse>> {
  return unwrap(await commands.removeTag(blockId, tagId))
}

/** Query blocks by boolean tag expression (AND/OR mode), paginated.
 *
 * `spaceId` (Phase 4) — when set, restricts matches to blocks
 * whose owning page carries `space = <spaceId>`. `null` / `undefined`
 * leaves the result set unscoped (cross-space view).
 *
 * `blockType` — when set, restricts matches to
 * blocks whose `block_type` equals the supplied value (e.g. `'page'`).
 * Pushes GraphView's JS-side `pagesResp.items.filter(p => p.block_type
 * === 'page')` predicate into SQL.
 */
export async function queryByTags(params: {
  tagIds: string[]
  prefixes: string[]
  mode: string // 'and' | 'or'
  includeInherited?: boolean | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
  blockType?: string | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.queryByTags(
      params.tagIds,
      params.prefixes,
      params.mode,
      params.includeInherited ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
      params.blockType ?? null,
    ),
  )
}

/**
 * Query blocks by an arbitrary nested boolean tag expression (#1472).
 *
 * Unlike {@link queryByTags} — which assembles at most a single-level tree
 * from a flat `(tagIds, prefixes, mode)` triple — this accepts the full
 * recursive {@link TagExpr} (`(A AND B) OR (NOT C)`, per-leaf `Not`, arbitrary
 * `Prefix` leaves), so a deep TagFilterPanel composer can reach the resolver's
 * nested-tree capability over IPC.
 *
 * `expr` nesting depth is validated against `TagExpr::MAX_DEPTH` on the backend
 * before resolution; an over-deep tree rejects with a validation error.
 * `spaceId` / `blockType` / `includeInherited` / pagination behave exactly as
 * in {@link queryByTags}.
 */
export async function queryByTagExpr(params: {
  expr: TagExpr
  includeInherited?: boolean | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
  blockType?: string | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.queryByTagExpr(
      params.expr,
      params.includeInherited ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
      params.blockType ?? null,
    ),
  )
}

/** List tags whose name starts with the given prefix (autocomplete). */
export async function listTagsByPrefix(params: {
  prefix: string
  limit?: SafeLimit | undefined
}): Promise<TagCacheRow[]> {
  return unwrap(await commands.listTagsByPrefix(params.prefix, params.limit ?? null))
}

export async function listTagsForBlock(blockId: string): Promise<string[]> {
  return unwrap(await commands.listTagsForBlock(blockId))
}

/**
 * List the tag IDs a block holds via inheritance (`block_tag_inherited`),
 * i.e. tags a strict ancestor applies directly that propagate down. Paired
 * with {@link listTagsForBlock} so the UI can render inherited (derived) tag
 * chips distinctly from directly-applied ones (#1423).
 */
export async function listInheritedTagsForBlock(blockId: string): Promise<string[]> {
  return unwrap(await commands.listInheritedTagsForBlock(blockId))
}

// ---------------------------------------------------------------------------
// Property commands
// ---------------------------------------------------------------------------
