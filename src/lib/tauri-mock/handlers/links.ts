/**
 * Tauri mock handlers -- Backlinks, unlinked references, and the page-link graph.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

// #4022 — the `fts_blocks.stripped` stand-in, imported rather than re-spelled:
// `search.ts` is its single owner (#3938), and a second copy of the strip /
// fold pair here would be free to drift away from the index it models.
// #4667 — `get_backlinks` pages the SAME way `list_blocks`'s three
// `ORDER BY id ASC` branches do (`Cursor::for_id`, `LIMIT ?limit + 1`), so it
// reuses their paginator rather than growing a second cursor codec that would
// be free to drift from the backend's `Cursor` shape.
import { idKey, paginateKeyset } from '@/lib/tauri-mock/handlers/blocks'
import { matchesFtsIndex, stripForFts } from '@/lib/tauri-mock/handlers/search'
import {
  type TypedHandlers,
  contentLinksTo,
  inSpaceScope,
  pageRequestLimit,
  scanLinkTargets,
} from '@/lib/tauri-mock/handlers/shared'
import { blockTags, blocks, pageAliases, properties } from '@/lib/tauri-mock/seed'

/**
 * `BacklinkFilter::PropertyText`'s `CompareOp` over a stored `value_text`:
 * `<>` / `<` / `>` / `<=` / `>=` are SQLite text compares; `Contains` /
 * `StartsWith` are `LIKE`, ASCII-case-insensitive over a literal needle.
 */
function textCompare(op: string, lhs: string, rhs: string): boolean {
  switch (op) {
    case 'Neq': {
      return lhs !== rhs
    }
    case 'Lt': {
      return lhs < rhs
    }
    case 'Gt': {
      return lhs > rhs
    }
    case 'Lte': {
      return lhs <= rhs
    }
    case 'Gte': {
      return lhs >= rhs
    }
    case 'Contains': {
      return lhs.toLowerCase().includes(rhs.toLowerCase())
    }
    case 'StartsWith': {
      return lhs.toLowerCase().startsWith(rhs.toLowerCase())
    }
    default: {
      return lhs === rhs
    }
  }
}

/**
 * Narrow a backlink candidate set by `BacklinkFilter`s (mirrors the filter
 * evaluation `eval_backlink_query_grouped` runs on the backend).
 */
function applyBacklinkFilters(
  items: Record<string, unknown>[],
  filterList: Array<Record<string, unknown>>,
): Record<string, unknown>[] {
  let backlinkItems = items
  // Apply simple filter support
  for (const filter of filterList) {
    const type = filter['type'] as string
    if (type === 'BlockType') {
      const bt = filter['block_type'] as string
      backlinkItems = backlinkItems.filter((b) => b['block_type'] === bt)
    } else if (type === 'Contains') {
      const query = (filter['query'] as string) ?? ''
      // #4022 — `BacklinkFilter::Contains` is `sanitize_fts_query` + `WHERE
      // fts_blocks MATCH ?1` (`agaric-store/src/backlink/filters.rs:381-421`,
      // SQL at :398-407). It is NOT a `LIKE` scan over `blocks.content`: it
      // reads the SAME trigram index `search_blocks` does, so it matches
      // `stripForFts`'s text through the index's case-only fold. This was
      // `matchesSearchFolded` over raw content, which both over-matched
      // (folding diacritics the tokenizer does not fold) and under-matched
      // (blind to markup-hidden terms and to the names `#[ULID]` /
      // `[[ULID]]` resolve to).
      //
      // One query-SIDE divergence is left standing, and is named rather than
      // modelled: the backend early-returns an EMPTY result set when
      // `query.trim().is_empty()` or the query sanitizes to empty
      // (`src-tauri/agaric-store/src/backlink/filters.rs:382-388` / `:955-962`), where `matchesFtsIndex` admits
      // every candidate for an empty needle. Note the backend TRIMS, so this
      // covers two shapes — `''` (which `matchesFtsIndex` short-circuits to
      // "match all") and whitespace-only such as `'   '` (which it runs as a
      // three-space substring test). Both are the pre-#4022 behaviour here,
      // unchanged by this seam, and both are reachable from this call site
      // because it does not test blank-ness first.
      backlinkItems = backlinkItems.filter((b) =>
        matchesFtsIndex(stripForFts(b['content'] as string | null), query),
      )
    } else if (type === 'PropertyText') {
      const key = filter['key'] as string
      const value = filter['value'] as string
      const op = (filter['op'] as string | undefined) ?? 'Eq'
      backlinkItems = backlinkItems.filter((b) => {
        const text = properties.get(b['id'] as string)?.get(key)?.['value_text'] as
          | string
          | null
          | undefined
        // `EXISTS (… key = ? AND value_text <op> ?)` on the backend: a block
        // without the property matches under no operator, `Neq` included.
        if (text == null) return false
        return textCompare(op, text, value)
      })
    }
    // Unsupported filter types are ignored (graceful degradation)
  }

  return backlinkItems
}

/**
 * The `GroupedBacklinkResponse` both grouped readers answer with, built the
 * way `eval_backlink_query_grouped` and `eval_unlinked_references` build
 * theirs (`agaric-store/src/backlink/grouped.rs`).
 *
 * #4667 — found by `query_backlinks_grouped.json`. This used to be two copies
 * that grouped by `parent_id`, kept the target page's own blocks, listed
 * groups in insertion order and ignored `limit` and `cursor`. The backend:
 *
 *   * keys a group by the source's ROOT page (`blocks.page_id`) and drops a
 *     source on the TARGET's root page as a self-reference — from the groups
 *     and from both counts;
 *   * orders groups by `(page_title, page_id)` (`cmp_group`) whatever the
 *     user's sort, which orders MEMBERS only — the default `Created { Asc }`
 *     is ULID order, so the id compare below;
 *   * counts `limit` in GROUPS and mints `Cursor::for_group`: `page_id` in
 *     `id`, `page_title` in the `deleted_at` slot;
 *   * answers `total_count: 0` / `filtered_count: 0` on a cursor page (#2201
 *     item 1b — the two COUNTs run on the first page only, and the UI keeps
 *     that page's numbers).
 *
 * `sources` is the base set BEFORE the user's `filters` (the `total_count`
 * universe); `filters` narrow it to the `filtered_count` one. `truncated` is
 * the `MAX_BLOCKS_PER_GROUP` cap per group and the FTS row cap on the
 * envelope; neither is reachable from a mock fixture.
 */
function groupedBacklinkResponse(
  sources: Record<string, unknown>[],
  targetPageId: string,
  a: Record<string, unknown>,
): {
  groups: Record<string, unknown>[]
  next_cursor: string | null
  has_more: boolean
  total_count: number
  filtered_count: number
  truncated: boolean
} {
  const base = sources.filter((b) => {
    const pid = b['page_id'] as string | null
    return pid !== null && pid !== targetPageId && blocks.has(pid)
  })
  const filterList = (a['filters'] as Array<Record<string, unknown>> | null) ?? []
  const filtered = applyBacklinkFilters(base, filterList)
  const byPage = new Map<string, Record<string, unknown>[]>()
  for (const b of filtered.toSorted((x, y) =>
    (x['id'] as string) < (y['id'] as string) ? -1 : 1,
  )) {
    const pid = b['page_id'] as string
    const group = byPage.get(pid)
    if (group === undefined) byPage.set(pid, [b])
    else group.push(b)
  }
  const groups = [...byPage].map(([page_id, items]) => ({
    page_id,
    // `base` already requires the root page to exist, and `content` is
    // `NOT NULL` on the backend.
    page_title: blocks.get(page_id)?.['content'] as string,
    blocks: items,
    truncated: false,
  }))
  const page = paginateKeyset(
    groups,
    (g) => [g['page_title'] as string, g['page_id'] as string],
    pageRequestLimit(a['limit']),
    a['cursor'],
    null,
    ['deleted_at'],
  )
  const firstPage = a['cursor'] == null
  return {
    groups: page.items,
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    total_count: firstPage ? base.length : 0,
    filtered_count: firstPage ? filtered.length : 0,
    truncated: false,
  }
}

export const linksHandlers = {
  get_backlinks: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    // Honour `scope: SpaceScope` the same way the backend's
    // `get_backlinks_inner` does. Active scope drops source blocks whose
    // owning page (`page_id`, or own id if itself a page) lives in a
    // different space. Global is unfiltered (legacy cross-space view).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    // Scan all blocks for [[ULID]] tokens matching the target (#3332: the scan
    // itself is `contentLinksTo`, the single owner of the token grammar).
    const backlinkItems = [...blocks.values()].filter(
      (b) =>
        !b['deleted_at'] &&
        inSpaceScope(b, spaceId) &&
        contentLinksTo(b['content'] as string | null, targetId),
    )
    // #4667 — this used to return the WHOLE set with `has_more: false` and no
    // cursor, ignoring `limit` and `cursor` outright, so every page was the
    // first page. `pagination::list_backlinks` is `ORDER BY bl.source_id ASC
    // LIMIT ?limit + 1` over an `{id}` keyset; `bl.source_id` is the source
    // block's own id, which is what {@link idKey} reads. Found by the
    // `query_backlinks.json` query steps.
    return paginateKeyset(backlinkItems, idKey, pageRequestLimit(a['limit']), a['cursor'], null, [])
  },

  count_backlinks_batch: (args) => {
    const a = args as Record<string, unknown>
    const pageIds = a['pageIds'] as string[]
    // Honour `scope` so mock-mode FE tests can
    // observe space-scoped badge counts the same way the real backend
    // produces them. The shape mirrors `list_page_aliases_by_prefix`
    // above: pull the active spaceId out of `{ kind, space_id }`,
    // fall back to `null` (cross-space, legacy) for `Global`.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const result: Record<string, number> = {}
    for (const pid of pageIds) {
      // Active-space scoping (`inSpaceScope`) drops source blocks whose owning
      // page doesn't carry `space = <spaceId>` — the SQL
      // `COALESCE(b.page_id, b.id) IN (... space ...)` predicate
      // `count_backlinks_batch_inner` uses.
      const count = [...blocks.values()].filter(
        (b) =>
          !b['deleted_at'] &&
          inSpaceScope(b, spaceId) &&
          contentLinksTo(b['content'] as string | null, pid),
      ).length
      result[pid] = count
    }
    return result
  },

  list_backlinks_grouped: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    // Honour `scope: SpaceScope` (mirrors
    // `list_backlinks_grouped_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const sources = [...blocks.values()].filter(
      (b) =>
        !b['deleted_at'] &&
        inSpaceScope(b, spaceId) &&
        contentLinksTo(b['content'] as string | null, targetId),
    )
    // `COALESCE(tgt.page_id, tgt.id)` — the target's root page, whose own
    // blocks are self-references.
    const targetPageId = (blocks.get(targetId)?.['page_id'] as string | null) ?? targetId
    return groupedBacklinkResponse(sources, targetPageId, a)
  },

  list_unlinked_references: (args) => {
    const a = args as Record<string, unknown>
    const pageId = a['pageId'] as string
    // Honour `scope: SpaceScope` (mirrors
    // `list_unlinked_references_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    // #4159 item 3 — the TITLE lookup is guarded:
    // `SELECT content FROM blocks WHERE id = ?1 AND block_type = 'page' AND
    // deleted_at IS NULL` (`agaric-store/src/backlink/grouped.rs:588-591`),
    // and the guard is there so a conflict-copy page id never resolves to a
    // title that drives the search. `fetch_optional` answering `None` is not
    // an early return on the backend: `title` falls back to the empty string
    // (`:594-598`) and the ALIAS half still runs. So a `pageId` naming a
    // content block or a soft-deleted page contributes NO title term here,
    // exactly as it contributes none there — while a live alias row on that
    // same id still searches, because `SELECT alias FROM page_aliases WHERE
    // page_id = ?1` (`:601-605`) carries neither predicate on either side.
    //
    // This replaces a `blocks.get(pageId)` that applied neither predicate AND
    // early-returned on a miss, so it was wrong in both directions: a
    // content-block id searched on that block's text, and an id with only an
    // alias row answered empty.
    const page = blocks.get(pageId)
    const pageTitle =
      page && page['block_type'] === 'page' && !page['deleted_at']
        ? ((page['content'] as string | null) ?? '')
        : ''
    // #4036 item 1 — the needle set is the page TITLE **OR** every one of its
    // `page_aliases` rows, not the title alone. `eval_unlinked_references`
    // builds `terms` from the sanitized title and then from each sanitized,
    // trimmed alias, and ORs them into one FTS5 query — `(t1) OR (t2) …`
    // (`agaric-store/src/backlink/grouped.rs:598-645`). A block reading "see
    // getting-started for setup" is an unlinked reference to the
    // `getting-started`-aliased page on the backend; here it was a false
    // negative, and not hypothetically — `pageAliases` is a seeded store
    // (`src/lib/tauri-mock/seed.ts:653`).
    //
    // The `trim()` on each term is the backend's own (`alias.trim()`,
    // grouped.rs:614) plus, for the title, the `sanitize_fts_query` empty
    // check: a whitespace-only title contributes NO term, so it neither
    // early-returns on its own nor runs as a literal substring needle that
    // would match every block containing a space. The early return fires only
    // when the COMBINED term list is empty (grouped.rs:625-635) — a blank
    // title with a live alias still searches.
    const terms = [pageTitle, ...(pageAliases.get(pageId) ?? [])]
      .map((t) => t.trim())
      .filter((t) => t !== '')
    if (terms.length === 0)
      return {
        groups: [],
        next_cursor: null,
        has_more: false,
        total_count: 0,
        filtered_count: 0,
        truncated: false,
      }
    // Find blocks that mention the page title as text but don't have a [[link]].
    //
    // #4022 — `eval_unlinked_references` runs `WHERE fts_blocks MATCH ?1`
    // (`agaric-store/src/backlink/grouped.rs:682-697`) over the sanitized
    // title, so the haystack is `fts_blocks.stripped` ({@link stripForFts})
    // and the fold is the trigram tokenizer's case-only one
    // ({@link matchesFtsIndex}) — the same index `search_blocks` reads, not a
    // `LIKE` scan over `blocks.content`. This was `matchesSearchFolded` over
    // raw content, which surfaced diacritic-folded mentions the backend never
    // returns and missed mentions hidden behind markup or supplied by a
    // resolved `[[ULID]]` title.
    const unlinked = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      // `AND b.block_type != 'page'` (grouped.rs:688) — title blocks are
      // dropped from the base set GLOBALLY, not just for descendants of this
      // page. The trigram tokenizer is substring-based, so a child page
      // `Notes/2026` would otherwise surface as an unlinked reference to
      // `Notes` via the trigrams `Not` / `ote` / `tes`; the refs panel
      // surfaces body matches, not title matches.
      if (b['block_type'] === 'page') return false
      if (!inSpaceScope(b, spaceId)) return false
      const content = (b['content'] as string) ?? ''
      // The FTS5 `OR` over `terms` — ANY term hitting keeps the row.
      const stripped = stripForFts(content)
      if (!terms.some((t) => matchesFtsIndex(stripped, t))) return false
      // Exclude if it already has a [[link]] to this page.
      return !contentLinksTo(content, pageId)
    })
    return groupedBacklinkResponse(unlinked, pageId, a)
  },

  // ---------------------------------------------------------------------------
  // Word-level diff for history display
  // ---------------------------------------------------------------------------

  // oxlint-disable-next-line eslint/complexity -- pre-existing
  list_page_links: (args) => {
    // Scan all non-deleted blocks for [[ULID]] page link tokens and
    // return page-to-page edges (source = parent page, target = linked page).
    const a = (args as Record<string, unknown> | null | undefined) ?? {}
    // When `tagIds` is non-empty, restrict edges to
    // those whose target page carries at least one of the listed tags.
    // Mirrors the backend semantics (`block_tags`-only resolution in the
    // mock world; the real backend additionally unions
    // `block_tag_inherited` / `block_tag_refs`, which the mock does not
    // model — see seed.ts).
    const rawTagIds = a['tagIds'] as string[] | null | undefined
    const tagFilter = rawTagIds && rawTagIds.length > 0 ? new Set(rawTagIds) : null
    // Honour `scope: SpaceScope` (mirrors `list_page_links_inner`).
    // Both endpoints of an edge must live in the active space; global is
    // unfiltered. Matches the backend's `b1.space = ?` AND `b2.space = ?`
    // join predicate.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const pageSpace = (pid: string): string | null =>
      (properties.get(pid)?.get('space')?.['value_ref'] as string | null) ?? null
    const linkSet = new Set<string>()
    const pageLinks: Array<{ source_id: string; target_id: string; ref_count: number }> = []
    for (const b of blocks.values()) {
      if (b['deleted_at']) continue
      const parentId = b['parent_id'] as string | null
      if (!parentId) continue
      // Only consider blocks whose parent is a page
      const parentBlock = blocks.get(parentId)
      if (!parentBlock || parentBlock['block_type'] !== 'page') continue
      // Active-scope filter on source page.
      if (spaceId !== null && pageSpace(parentId) !== spaceId) continue
      const content = (b['content'] as string) ?? ''
      for (const targetPageId of scanLinkTargets(content)) {
        // Ensure target is an existing non-deleted page
        const targetBlock = blocks.get(targetPageId)
        if (!targetBlock || targetBlock['block_type'] !== 'page' || targetBlock['deleted_at'])
          continue
        // Active-scope filter on target page (mirrors the
        // backend's `b2.space = ?` predicate).
        if (spaceId !== null && pageSpace(targetPageId) !== spaceId) continue
        // Apply target-side tag filter.
        if (tagFilter) {
          const targetTags = blockTags.get(targetPageId)
          let hit = false
          if (targetTags) {
            for (const tid of tagFilter) {
              if (targetTags.has(tid)) {
                hit = true
                break
              }
            }
          }
          if (!hit) continue
        }
        // Deduplicate edges
        const key = `${parentId}→${targetPageId}`
        if (!linkSet.has(key)) {
          linkSet.add(key)
          pageLinks.push({ source_id: parentId, target_id: targetPageId, ref_count: 1 })
        }
      }
    }
    // #2298 count-then-cap — the real backend ships a `PageLinksResponse`
    // envelope. The mock world never caps, so `total` is always the full
    // edge count and `truncated` is always false.
    return { edges: pageLinks, total: pageLinks.length, truncated: false }
  },

  // ---------------------------------------------------------------------------
  // Logging commands (fire-and-forget)
  // ---------------------------------------------------------------------------

  fetch_link_metadata: (args) => {
    const a = args as Record<string, unknown>
    return {
      url: a['url'],
      title: 'Mock Title',
      favicon_url: null,
      description: null,
      fetched_at: Date.now(),
      auth_required: false,
      not_found: false,
    }
  },

  get_link_metadata: (args) => {
    const a = args as Record<string, unknown>
    return {
      url: a['url'],
      title: 'Mock Title',
      favicon_url: null,
      description: null,
      fetched_at: Date.now(),
      auth_required: false,
      not_found: false,
    }
  },

  // ---------------------------------------------------------------------------
  // MCP read-only / read-write servers
  //
  // The real backend manages a Unix-domain-socket lifecycle that can't run
  // inside Playwright. The mock returns disabled status snapshots so
  // AgentAccessSettingsTab renders its toggles + socket-path readouts
  // without per-call stubbing. Toggle commands echo the requested value;
  // disconnect commands return `null` since they have no observable
  // effect on the mock state.
  // ---------------------------------------------------------------------------
} satisfies Pick<
  TypedHandlers,
  | 'get_backlinks'
  | 'count_backlinks_batch'
  | 'list_backlinks_grouped'
  | 'list_unlinked_references'
  | 'list_page_links'
  | 'fetch_link_metadata'
  | 'get_link_metadata'
>
