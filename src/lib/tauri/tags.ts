import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { BlockRow, PageResponse, TagCacheRow } from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'
import { toSpaceScope } from '@/lib/tauri/_shared'

/**
 * #81 / add ONE tag to N blocks in a single IPC.
 *
 * Bulk counterpart to `addTag` (removed — dead wrapper, #4410); the backend
 * skips ids that are missing or already carry the tag, and returns the
 * number of blocks newly tagged. Used by the Pages-view batch toolbar's "Add
 * tag" action.
 */
export async function addTagsByIds(blockIds: string[], tagId: string): Promise<number> {
  return unwrap(await commands.addTagsByIds(blockIds, tagId))
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

/** List tags whose name starts with the given prefix (autocomplete). */
export async function listTagsByPrefix(params: {
  prefix: string
  limit?: SafeLimit | undefined
}): Promise<TagCacheRow[]> {
  return unwrap(await commands.listTagsByPrefix(params.prefix, params.limit ?? null))
}

// ---------------------------------------------------------------------------
// Property commands
// ---------------------------------------------------------------------------
