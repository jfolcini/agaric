import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  BacklinkFilter,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  GroupedBacklinkResponse,
  PageLinksResponse,
  PageResponse,
} from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'
import { toSpaceScope } from '@/lib/tauri/_shared'

/** List blocks that link to the given block (backlinks), paginated.
 *
 * `spaceId` (Phase 4) — when set, restricts the backlinks to
 * source blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped (cross-space view).
 */
export async function getBacklinks(params: {
  blockId: string
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.getBacklinks(
      params.blockId,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

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

/** Query backlinks with composable filters, sort, and pagination.
 *
 * `spaceId` (Phase 4) — when set, restricts the source set to
 * blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped (cross-space view).
 */
export async function queryBacklinksFiltered(params: {
  blockId: string
  filters?: BacklinkFilter[] | undefined
  sort?: BacklinkSort | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<BacklinkQueryResponse> {
  return unwrap(
    await commands.queryBacklinksFiltered(
      params.blockId,
      params.filters ?? null,
      params.sort ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** Query backlinks grouped by source page, with filters and pagination.
 *
 * `spaceId` (Phase 4) — when set, restricts the source set to
 * blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped.
 */
export async function listBacklinksGrouped(params: {
  blockId: string
  filters?: BacklinkFilter[] | undefined
  sort?: BacklinkSort | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<GroupedBacklinkResponse> {
  return unwrap(
    await commands.listBacklinksGrouped(
      params.blockId,
      params.filters ?? null,
      params.sort ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** Query unlinked references grouped by source page, with filters, sort, and pagination.
 *
 * `spaceId` (Phase 4) — when set, restricts the candidate set
 * to blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped.
 */
export async function listUnlinkedReferences(params: {
  pageId: string
  filters?: BacklinkFilter[] | null | undefined
  sort?: BacklinkSort | null | undefined
  cursor?: string | null | undefined
  limit?: SafeLimit | null | undefined
  spaceId?: string | null | undefined
}): Promise<GroupedBacklinkResponse> {
  return unwrap(
    await commands.listUnlinkedReferences(
      params.pageId,
      params.filters ?? null,
      params.sort ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

export interface LinkMetadata {
  url: string
  title: string | null
  favicon_url: string | null
  description: string | null
  /** Milliseconds since the UNIX epoch (UTC). #109 Phase 2: was an RFC 3339 string. */
  fetched_at: number
  auth_required: boolean
  /**
   * (follow-up): `true` when the most recent
   * fetch saw a terminal "gone" status (HTTP 404 or 410). Distinct
   * from `auth_required` (401/403, sign-in card) and from transient
   * 5xx (both flags `false` plus `title === null`). Optional so a
   * legacy serialized blob without the field still deserializes.
   */
  not_found?: boolean
}

/** Fetch and cache link metadata (triggers HTTP fetch if not cached). */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  return unwrap(await commands.fetchLinkMetadata(url))
}

/** Get cached link metadata (no network fetch). */
export async function getLinkMetadata(url: string): Promise<LinkMetadata | null> {
  return unwrap(await commands.getLinkMetadata(url))
}

// The bug-report wrappers (`collectBugReportMetadata`, `readLogsForReport`)
// and their `BugReport` / `LogFileEntry` types were removed in #2927 — call
// `commands.collectBugReportMetadata()` / `commands.readLogsForReport(...)`
// directly and unwrap with the helper from `@/lib/app-error`. The types live
// in `@/lib/bindings`.

// ---------------------------------------------------------------------------
// Spaces (Phase 1)
// ---------------------------------------------------------------------------
