import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { PageLinksResponse } from '@/lib/bindings'
import { toSpaceScope } from '@/lib/tauri/_shared'

/** List all page-to-page links for graph visualization.
 *
 * `spaceId` (Phase 4) — when set, restricts the link set to
 * source pages whose `space = <spaceId>`. `null` / `undefined` leaves
 * the graph cross-space (legacy behaviour).
 *
 * `tagIds` — when non-empty, restricts edges to
 * those whose **target page** carries at least one of the listed
 * tags (via `block_tags`, `block_tag_inherited`, or
 * `block_tag_refs` — same union semantics as `queryByTags`).
 * Pushes the GraphView tag-filter predicate into SQL so the renderer
 * no longer fetches every space-wide edge then drops the off-tag
 * subgraph in JS. `null` / `undefined` / empty leaves the edge set
 * unfiltered.
 *
 * Backward-compat note: callers that still pass a bare `spaceId`
 * string keep working — the legacy positional shape is detected and
 * normalised to `{ spaceId, tagIds: null }` below.
 *
 * #2298 count-then-cap: the response is now a `PageLinksResponse`
 * envelope — `edges` is the (possibly capped) edge set, `total` the
 * TRUE matching-edge count computed independently of the cap, and
 * `truncated` signals that the cap fired so the graph view can show
 * a non-blocking "showing N of M" notice instead of silently
 * rendering a partial graph.
 */
export async function listPageLinks(
  arg?:
    | string
    | null
    | undefined
    | {
        spaceId?: string | null | undefined
        tagIds?: string[] | null | undefined
      },
): Promise<PageLinksResponse> {
  const params = typeof arg === 'object' && arg !== null ? arg : { spaceId: arg ?? null }
  const tagIds = params.tagIds && params.tagIds.length > 0 ? params.tagIds : null
  return unwrap(await commands.listPageLinks(toSpaceScope(params.spaceId), tagIds))
}
