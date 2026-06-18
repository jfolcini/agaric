/**
 * Tauri mock — command dispatch layer.
 *
 * Every mocked command has a handler in `HANDLERS`, keyed by command name. The
 * handler receives the raw IPC args object and returns the mock response (or
 * throws to surface an error to callers). `dispatch()` is the single entry
 * point used by `setupMock()`.
 *
 * Converting the previous switch/case chain to a map makes coverage auditable:
 * `Object.keys(HANDLERS)` is the canonical list of mocked commands and can be
 * diffed against the real backend's command surface in `src/lib/bindings.ts`.
 */

import { matchesSearchFolded } from '../fold-for-search'
import { logger } from '../logger'
import { applyRevertForOp } from './revert'
import {
  attachmentBytes,
  attachments,
  blocks,
  blockTags,
  fakeId,
  type MockOpLogEntry,
  makeBlock,
  opLog,
  pageAliases,
  pageLastModified,
  properties,
  propertyDefs,
  pushOp,
} from './seed'

type Handler = (args: unknown) => unknown

// Stub return shapes used by handlers that don't need behaviour beyond a
// type-correct empty payload. `list_projected_agenda` is cursor-paginated
// (M-25) and returns a `PageResponse<T>` shape, NOT a bare array — using
// `returnEmptyArray` for it crashes consumers that read `response.items`.
const returnNull: Handler = () => null
const returnUndefined: Handler = () => undefined

// In-memory system clipboard for the browser/e2e harness. The real
// `src/lib/clipboard.ts` prefers the Tauri clipboard plugin over
// `navigator.clipboard`, so block copy/cut/paste round-trips through these
// `plugin:clipboard-manager|write_text` / `read_text` IPCs — NOT navigator.
// Persisting the text here (instead of a `write_text` no-op + unhandled
// `read_text`) lets e2e drive the genuine copy→paste pipeline through the
// production clipboard lib. (#976 finding 1 testability.)
let mockClipboardText = ''
const clipboardWriteText: Handler = (args) => {
  mockClipboardText = ((args as Record<string, unknown>)['text'] as string | undefined) ?? ''
  return null
}
const clipboardReadText: Handler = () => mockClipboardText
const returnEmptyArray: Handler = () => []
const returnEmptyPage: Handler = () => ({
  items: [],
  next_cursor: null,
  has_more: false,
  total_count: null,
})

/**
 * A `[[ULID]]`-derived block-link edge — mock stand-in for `block_links`.
 * `sourcePageId` is the owning page of the source block (a page block owns
 * itself, a descendant carries its ancestor `page_id`, an orphan is `null`).
 * It is what the same-page/self/orphan-source exclusion (migration 0070)
 * reads to decide whether an edge counts toward a target page's inbound total.
 */
interface MockLinkEdge {
  sourceId: string
  targetId: string
  sourcePageId: string | null
}

/**
 * Scan every non-deleted block's content for `[[ULID]]` tokens and return the
 * implied block-link edges. The faithful mock stand-in for the backend's
 * `block_links` table — used to evaluate the link facets (`Orphan` /
 * `HasNoInboundLinks`) and the `MostLinked` sort. Mirrors the `get_backlinks`
 * scan. Each edge captures the source block's `page_id` so `pageLinkStats`
 * can apply the same-page/self/orphan-source inbound exclusion (migration
 * 0070 + `recompute_pages_cache_counts_for_pages`).
 */
function deriveLinkEdges(allBlocks: Map<string, Record<string, unknown>>): MockLinkEdge[] {
  const LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
  const edges: MockLinkEdge[] = []
  for (const blk of allBlocks.values()) {
    if (blk['deleted_at']) continue
    const content = (blk['content'] as string | null) ?? ''
    if (!content.includes('[[')) continue
    const sourcePageId = (blk['page_id'] as string | null) ?? null
    for (const m of content.matchAll(LINK_RE)) {
      edges.push({ sourceId: blk['id'] as string, targetId: m[1] as string, sourcePageId })
    }
  }
  return edges
}

/**
 * Inbound/outbound link facts for a page, scoped to "page block OR any
 * non-deleted descendant" (matching migration 0069 + the fixed `Orphan`
 * outbound term, PEND-58b P0-A). `inbound` = distinct sources linking in
 * (`COUNT(DISTINCT source_id)`); `hasOutbound` = the page or a descendant
 * authors an outbound link.
 *
 * `inbound` applies the same-page/self/orphan-source exclusion that the live
 * IPC reads off `pages_cache.inbound_link_count` (migration 0070 +
 * `recompute_pages_cache_counts_for_pages`): an edge counts only when its
 * source belongs to a DIFFERENT page (`src.page_id != target page` and
 * `src.page_id IS NOT NULL`). A block linking to another block on the same
 * page, a page-block self-link, or a link from an orphan/page-block source
 * (no resolvable `page_id`) is NOT inbound. `hasOutbound` is unaffected by
 * the exclusion — it answers "does this page author any outbound link".
 */
function pageLinkStats(
  pageId: string,
  pageScopeIds: Set<string>,
  edges: ReadonlyArray<MockLinkEdge>,
): { inbound: number; hasOutbound: boolean } {
  const inboundSources = new Set<string>()
  let hasOutbound = false
  for (const e of edges) {
    if (pageScopeIds.has(e.targetId) && e.sourcePageId !== null && e.sourcePageId !== pageId) {
      inboundSources.add(e.sourceId)
    }
    if (pageScopeIds.has(e.sourceId)) hasOutbound = true
  }
  return { inbound: inboundSources.size, hasOutbound }
}

/**
 * Metadata-rich page row mirroring the camelCase `PageWithMetadataRow` wire
 * shape, plus the mock-internal `hasOutboundLink` used to evaluate `Orphan`.
 */
interface PageMetaRow {
  id: string
  blockType: string
  content: string | null
  parentId: string | null
  position: number | null
  deletedAt: string | null
  todoState: string | null
  priority: string | null
  dueDate: string | null
  scheduledDate: string | null
  pageId: string | null
  lastModifiedAt: string | null
  inboundLinkCount: number
  childBlockCount: number
  hasOutboundLink: boolean
  flags: { hasTags: boolean; hasTodo: boolean; hasScheduled: boolean; hasDue: boolean }
}

/**
 * Match a page title against the documented Page-path glob mini-language,
 * case-insensitively. Mirrors `src-tauri/src/filters/primitive.rs::glob_to_like`
 * semantics:
 *   - `*` → any run of characters (`%`),
 *   - `?` → exactly one character (`_`),
 *   - a bare word (no `*`/`?`) → substring match (`%word%`),
 *   - any other char is a literal.
 * The match is anchored (the whole title must satisfy the pattern), which is
 * how SQLite `LIKE` evaluates — the substring wrap on bare words is what makes
 * `Alpha` match `My Alpha Page`.
 */
function globMatchesTitle(pattern: string, title: string): boolean {
  const hasWildcard = /[*?]/.test(pattern)
  // Build an anchored, case-insensitive RegExp mirroring glob_to_like's
  // translation. Bare words (no wildcard) become substring matches.
  let body = ''
  for (const ch of pattern) {
    if (ch === '*') body += '.*'
    else if (ch === '?') body += '.'
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  const source = hasWildcard ? `^${body}$` : `^.*${body}.*$`
  let re: RegExp
  try {
    re = new RegExp(source, 'i')
  } catch {
    return false
  }
  return re.test(title)
}

/**
 * Does a page row satisfy one compound-filter primitive? The mock evaluates
 * `Stub` / `HasNoInboundLinks` / `Orphan` / `Tag` / `Priority` / `PathGlob` /
 * `HasProperty` / `LastEdited` faithfully (mirroring the REAL backend
 * semantics in `src-tauri/src/filters/primitive.rs`); any other primitive is
 * a permissive no-op (the backend owns those, and FE tests that need them
 * mock at the IPC boundary directly).
 */
function metaRowMatchesFilter(r: PageMetaRow, f: Record<string, unknown>): boolean {
  switch (f['type'] as string) {
    case 'Stub':
      return r.childBlockCount === 0
    case 'HasNoInboundLinks':
      return r.inboundLinkCount === 0
    case 'Orphan':
      return r.inboundLinkCount === 0 && !r.hasOutboundLink
    case 'Tag':
      return blockTags.get(r.id)?.has(f['tag'] as string) ?? false
    case 'Priority':
      return r.priority === (f['priority'] as string)
    case 'PathGlob': {
      // Case-insensitive glob over the page title. `exclude:true` inverts.
      const hit = globMatchesTitle((f['pattern'] as string) ?? '', r.content ?? '')
      return (f['exclude'] as boolean) ? !hit : hit
    }
    case 'HasProperty':
      return hasPropertyMatches(r, f)
    case 'LastEdited':
      return lastEditedMatches(r, f['spec'] as Record<string, unknown> | undefined)
    default:
      return true
  }
}

/**
 * Evaluate a `HasProperty` primitive against a page's seeded `block_properties`
 * (`properties` map, keyed on the page block id), mirroring the backend's
 * `compile_has_property` predicate matrix. The wire shape is the nested
 * `predicate: PropertyPredicate` (D8 — invalid op/value combos are
 * unrepresentable):
 *   - `Exists`     — key present,
 *   - `NotExists`  — key absent,
 *   - `Eq`         — `value_text` (or `value_ref` for a Ref value) equals,
 *   - `Ne`         — no property row with that value (NOT EXISTS).
 */
function hasPropertyMatches(r: PageMetaRow, f: Record<string, unknown>): boolean {
  const key = f['key'] as string
  const predicate = f['predicate'] as Record<string, unknown> | undefined
  const ptype = predicate?.['type'] as string | undefined
  const prop = properties.get(r.id)?.get(key)
  switch (ptype) {
    case 'Exists':
      return prop != null
    case 'NotExists':
      return prop == null
    case 'Eq':
    case 'Ne': {
      const value = predicate?.['value'] as Record<string, unknown> | undefined
      // Ref values compare against `value_ref`; Text against `value_text`.
      const isRef = value?.['type'] === 'Ref'
      const wanted = (value?.['value'] as string | undefined) ?? null
      const stored = prop
        ? ((isRef ? prop['value_ref'] : prop['value_text']) as string | null)
        : null
      const hit = prop != null && wanted != null && stored === wanted
      // `Ne` = NOT EXISTS a row with key=? AND value=? — true when the key is
      // absent OR present-but-different.
      return ptype === 'Ne' ? !hit : hit
    }
    default:
      return true
  }
}

/**
 * Evaluate a `LastEdited` primitive against the page's `lastModifiedAt`,
 * mirroring the backend's `compile_last_edited` buckets (rolling window
 * ending "now"):
 *   - `Rolling{days}`   — modified within the last N days,
 *   - `OlderThan{days}` — modified before the last-N-days cutoff (NULL counts
 *     as older, matching the backend's `COALESCE(..., '0001-01-01')`),
 *   - `Range{start,end}` — modified within `[start, end]` (inclusive).
 */
function lastEditedMatches(r: PageMetaRow, spec: Record<string, unknown> | undefined): boolean {
  if (!spec) return true
  const lm = r.lastModifiedAt
  const cutoff = (days: number): string => {
    const d = new Date()
    d.setDate(d.getDate() - days)
    return d.toISOString()
  }
  switch (spec['type'] as string) {
    case 'Rolling': {
      if (lm == null) return false
      return lm >= cutoff(spec['days'] as number)
    }
    case 'OlderThan':
      // NULL last-modified sorts as the oldest possible → counts as older.
      return lm == null || lm < cutoff(spec['days'] as number)
    case 'Range': {
      if (lm == null) return false
      const start = spec['start'] as string
      const end = spec['end'] as string
      return lm >= start && lm <= end
    }
    default:
      return true
  }
}

/** Comparator mirroring the backend's per-sort keyset (id is the tiebreaker). */
function compareMetaRows(x: PageMetaRow, y: PageMetaRow, sort: string): number {
  let primary = 0
  switch (sort) {
    case 'alphabetical':
      primary = (x.content ?? '').toLowerCase().localeCompare((y.content ?? '').toLowerCase())
      break
    case 'recently-modified':
      primary = (y.lastModifiedAt ?? '').localeCompare(x.lastModifiedAt ?? '')
      break
    case 'most-linked':
      primary = y.inboundLinkCount - x.inboundLinkCount
      break
    case 'most-content':
      primary = y.childBlockCount - x.childBlockCount
      break
    default:
      primary = x.id.localeCompare(y.id)
      break
  }
  return primary !== 0 ? primary : x.id.localeCompare(y.id)
}

/**
 * Map a sort mode to the cursor `position` discriminator the backend stamps
 * into the keyset cursor (mirrors `sort_discriminator` in
 * `src-tauri/src/commands/pages.rs`). The frontend ships the wire sort enum
 * (`default` / `recently-modified` / `most-linked` / `most-content`); the
 * frontend-only `alphabetical` value resolves to the same discriminator as
 * `default` because both ride the `default` wire keyset. The discriminator is
 * what `validate_pages_metadata_cursor` compares to reject a cursor reused
 * across a sort change (the `RequiresRefresh:` recovery path).
 */
function sortDiscriminator(sort: string): number {
  switch (sort) {
    case 'recently-modified':
      return 2
    case 'most-linked':
      return 3
    case 'most-content':
      return 4
    // `alphabetical` and `default` both ride the default-wire keyset.
    default:
      return 5
  }
}

/**
 * Encode a next-page cursor matching the backend's per-sort shape so cursor
 * round-trips hit the same validation path. The `position` slot carries the
 * sort discriminator (see `sortDiscriminator`).
 */
function encodeNextCursor(last: PageMetaRow, sort: string): string {
  const disc = sortDiscriminator(sort)
  const cursorObj: Record<string, unknown> = { id: last.id, version: 1, position: disc }
  switch (sort) {
    case 'alphabetical':
      cursorObj['deleted_at'] = last.content
      break
    case 'recently-modified':
      cursorObj['deleted_at'] = last.lastModifiedAt
      break
    case 'most-linked':
      cursorObj['seq'] = last.inboundLinkCount
      break
    case 'most-content':
      cursorObj['seq'] = last.childBlockCount
      break
  }
  return btoa(JSON.stringify(cursorObj))
}

/**
 * Resolve a page's `last_modified_at`, mirroring the backend's
 * `MAX(op_log.created_at) WHERE block_id = b.id`: scan `opLog` for the latest
 * entry whose payload `block_id` is this page, then fall back to the
 * deterministic seeded `last_modified_at` stamp (set in `seed.ts`), and
 * finally `null` for a page with neither.
 */
function pageLastModifiedAt(b: Record<string, unknown>): string | null {
  const pageId = b['id'] as string
  let maxOp: string | null = null
  for (const o of opLog) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(o.payload) as Record<string, unknown>
    } catch {
      continue
    }
    if (payload['block_id'] !== pageId) continue
    if (maxOp === null || o.created_at > maxOp) maxOp = o.created_at
  }
  const seeded = pageLastModified.get(pageId) ?? null
  if (maxOp !== null && seeded !== null) return maxOp > seeded ? maxOp : seeded
  return maxOp ?? seeded
}

/** Assemble one `PageMetaRow` from a page block + its (already-filtered) descendants. */
function buildPageMetaRow(
  b: Record<string, unknown>,
  descendants: Array<Record<string, unknown>>,
  edges: ReadonlyArray<MockLinkEdge>,
): PageMetaRow {
  const pageId = b['id'] as string
  const pageScopeIds = new Set<string>([pageId, ...descendants.map((d) => d['id'] as string)])
  const { inbound, hasOutbound } = pageLinkStats(pageId, pageScopeIds, edges)
  return {
    id: b['id'] as string,
    blockType: 'page',
    content: (b['content'] as string | null) ?? null,
    parentId: (b['parent_id'] as string | null) ?? null,
    position: (b['position'] as number | null) ?? null,
    deletedAt: null,
    todoState: (b['todo_state'] as string | null) ?? null,
    priority: (b['priority'] as string | null) ?? null,
    dueDate: (b['due_date'] as string | null) ?? null,
    scheduledDate: (b['scheduled_date'] as string | null) ?? null,
    pageId: (b['page_id'] as string | null) ?? null,
    // last_modified_at mirrors the backend's `MAX(op_log.created_at)` over
    // the page block: take the latest op_log entry targeting this page,
    // falling back to the deterministic seeded `last_modified_at` stamp (and
    // finally null). This gives the `last-edited:` compound filter and the
    // recently-modified sort real, comparable ISO timestamps.
    lastModifiedAt: pageLastModifiedAt(b),
    inboundLinkCount: inbound,
    childBlockCount: descendants.length,
    hasOutboundLink: hasOutbound,
    flags: {
      hasTags: (blockTags.get(b['id'] as string)?.size ?? 0) > 0,
      hasTodo: descendants.some((d) => d['todo_state'] != null),
      hasScheduled: descendants.some((d) => d['scheduled_date'] != null),
      hasDue: descendants.some((d) => d['due_date'] != null),
    },
  }
}

/**
 * #400 — assign dense 1-based `position` to every live child of `parentId`,
 * in their current sort order, so the mock mirrors the backend's dense-rank
 * semantics (`position ASC, id ASC`, no gaps, no collisions).
 */
function renumberSiblings(parentId: string | null): void {
  const siblings = [...blocks.values()].filter(
    (b) => (b['parent_id'] ?? null) === parentId && !b['deleted_at'],
  )
  siblings.sort((x, y) => {
    const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    if (px !== py) return px - py
    return (x['id'] as string).localeCompare(y['id'] as string)
  })
  siblings.forEach((b, i) => {
    b['position'] = i + 1
  })
}

/**
 * #400 — place `blockId` at the 0-based `slot` among `parentId`'s OTHER live
 * children, then renumber the whole group to dense 1-based positions. `slot`
 * is clamped to `[0, otherCount]`; a value >= otherCount (e.g.
 * `Number.MAX_SAFE_INTEGER` for "append") lands the block last.
 */
function insertAtSlotAndRenumber(parentId: string | null, blockId: string, slot: number): void {
  const moved = blocks.get(blockId)
  if (!moved) return
  const others = [...blocks.values()].filter(
    (b) => (b['parent_id'] ?? null) === parentId && !b['deleted_at'] && b['id'] !== blockId,
  )
  others.sort((x, y) => {
    const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
    if (px !== py) return px - py
    return (x['id'] as string).localeCompare(y['id'] as string)
  })
  const clamped = Math.max(0, Math.min(slot, others.length))
  // Pre-rank the OTHER siblings 1..N, then give the moved block a fractional
  // key that sits just after the (clamped)-th other sibling. `renumberSiblings`
  // then collapses everything back to dense integers in that order.
  others.forEach((b, i) => {
    b['position'] = i + 1
  })
  moved['position'] = clamped + 0.5
  renumberSiblings(parentId)
}

/**
 * #957 — after a cross-parent move, the moved block's `page_id` is recomputed
 * from its new parent (the page root, or `null` when orphaned). The Rust
 * backend (#664) ALSO refreshes every transitive descendant's `page_id` so the
 * whole subtree carries the new page root. Mirror that here: walk descendants
 * via `parent_id` chains over the `blocks` map and set each one's `page_id` to
 * the moved block's (already-updated) `page_id`. Without this, a moved subtree's
 * descendants keep a stale `page_id`, diverging from the backend (and breaking
 * `load_page_subtree`, which keys on `page_id`).
 */
function refreshDescendantPageIds(rootBlockId: string): void {
  const root = blocks.get(rootBlockId)
  if (!root) return
  const newPageId = (root['page_id'] as string | null) ?? null
  const all = Array.from(blocks.values())
  // BFS over parent_id edges from the moved block down through its subtree.
  const queue: string[] = [rootBlockId]
  while (queue.length > 0) {
    const parentId = queue.shift() as string
    const children = all.filter((b) => ((b['parent_id'] as string | null) ?? null) === parentId)
    for (const child of children) {
      child['page_id'] = newPageId
      queue.push(child['id'] as string)
    }
  }
}

export const HANDLERS: Record<string, Handler> = {
  // ---------------------------------------------------------------------------
  // Block listing & CRUD
  // ---------------------------------------------------------------------------

  list_blocks: (args) => {
    const a = args as Record<string, unknown>
    let items: Record<string, unknown>[] = [...blocks.values()].filter(
      (b) => !(b['deleted_at'] as string | null),
    )
    if (a['blockType']) items = items.filter((b) => b['block_type'] === a['blockType'])
    if (a['parentId']) items = items.filter((b) => b['parent_id'] === a['parentId'])
    // Tag filtering
    if (a['tagId']) {
      const tagId = a['tagId'] as string
      items = items.filter((b) => {
        const tags = blockTags.get(b['id'] as string)
        return tags?.has(tagId) ?? false
      })
    }
    // Agenda date filtering — matches blocks by due_date or scheduled_date
    if (a['agendaDate']) {
      const dateStr = a['agendaDate'] as string
      const source = (a['agendaSource'] as string | null) ?? null
      if (source === 'column:due_date') {
        items = items.filter((b) => b['due_date'] === dateStr)
      } else if (source === 'column:scheduled_date') {
        items = items.filter((b) => b['scheduled_date'] === dateStr)
      } else {
        items = items.filter((b) => b['due_date'] === dateStr || b['scheduled_date'] === dateStr)
      }
    }
    // Agenda date range filtering — for weekly/monthly views
    if (a['agendaDateRange']) {
      const range = a['agendaDateRange'] as { start: string; end: string }
      const source = (a['agendaSource'] as string | null) ?? null
      items = items.filter((b) => {
        const due = b['due_date'] as string | null
        const sched = b['scheduled_date'] as string | null
        const inRange = (d: string | null) => d != null && d >= range.start && d <= range.end
        if (source === 'column:due_date') return inRange(due)
        if (source === 'column:scheduled_date') return inRange(sched)
        return inRange(due) || inRange(sched)
      })
    }
    // Sort by position for consistent ordering (matches real backend)
    items.sort((x, y) => ((x['position'] as number) ?? 0) - ((y['position'] as number) ?? 0))
    return { items, next_cursor: null, has_more: false }
  },

  // Paginate soft-deleted blocks, space-scoped. Mirrors backend
  // `pagination::list_trash` (deleted_at DESC, id ASC).
  list_trash: () => {
    const items = [...blocks.values()].filter((b) => b['deleted_at'])
    items.sort((x, y) => String(y['deleted_at'] ?? '').localeCompare(String(x['deleted_at'] ?? '')))
    return { items, next_cursor: null, has_more: false }
  },

  // BUG-48: indexed lookup for a single date-formatted journal page in
  // the active space. Real backend implementation: a SELECT on
  // `idx_blocks_journal_date` with a `space` ref-property subquery.
  get_journal_page_by_date: (args) => {
    const a = args as Record<string, unknown>
    const date = a['date'] as string
    const spaceId = a['spaceId'] as string
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      if (b['content'] !== date) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      return b
    }
    return null
  },

  // BUG-48 follow-up: list date-formatted journal pages in the active
  // space whose date falls in `[startDate, endDate]`. The real backend
  // uses the `idx_blocks_journal_date` partial index plus a content
  // range predicate so this is O(visible-days).
  list_journal_pages_in_range: (args) => {
    const a = args as Record<string, unknown>
    const startDate = a['startDate'] as string
    const endDate = a['endDate'] as string
    const spaceId = a['spaceId'] as string
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    const items: Record<string, unknown>[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const content = b['content'] as string | null
      if (!content || !datePattern.test(content)) continue
      if (content < startDate || content > endDate) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      items.push(b)
    }
    items.sort((x, y) =>
      ((x['content'] as string) ?? '').localeCompare((y['content'] as string) ?? ''),
    )
    return items
  },

  // Every page in the active space as `{ id, content }`.  No pagination,
  // no clamp — bounded by the space's intrinsic page count.  Backs
  // `exportGraphAsZip` and graph rendering.
  //
  // `tagIds`, when non-empty, restricts the result to pages carrying at
  // least one of those tags via the direct `block_tags` table (mock
  // models direct tags only — same surface as the real backend's
  // direct-tag filter; inherited tags intentionally not modelled here).
  list_all_pages_in_space: (args) => {
    const a = args as Record<string, unknown>
    const spaceId = a['spaceId'] as string
    const rawTagIds = a['tagIds'] as string[] | null | undefined
    const tagFilter = rawTagIds && rawTagIds.length > 0 ? new Set(rawTagIds) : null
    const items: Array<{ id: string; content: string | null }> = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      if (tagFilter) {
        const tagsForBlock = blockTags.get(b['id'] as string)
        if (!tagsForBlock) continue
        let hit = false
        for (const t of tagsForBlock) {
          if (tagFilter.has(t)) {
            hit = true
            break
          }
        }
        if (!hit) continue
      }
      items.push({ id: b['id'] as string, content: (b['content'] as string | null) ?? null })
    }
    items.sort((x, y) => {
      const c = (x.content ?? '').toLowerCase().localeCompare((y.content ?? '').toLowerCase())
      return c !== 0 ? c : x.id.localeCompare(y.id)
    })
    return items
  },

  // Every active descendant under `rootBlockId` (one SELECT via the
  // materializer-maintained `page_id` index in production). Replaces
  // the FE-side recursive `listBlocks` walk.
  load_page_subtree: (args) => {
    const a = args as Record<string, unknown>
    const rootBlockId = a['rootBlockId'] as string
    const spaceId = a['spaceId'] as string
    // Space-membership check — mirrors the backend.
    const rootProps = properties.get(rootBlockId)
    const rootSpace = rootProps?.get('space')
    if (rootSpace?.['value_ref'] !== spaceId) {
      throw new Error(`block '${rootBlockId}' not in current space '${spaceId}'`)
    }
    const items: Record<string, unknown>[] = []
    for (const b of blocks.values()) {
      if (b['id'] === rootBlockId) continue
      if (b['deleted_at']) continue
      if (b['page_id'] !== rootBlockId) continue
      items.push(b)
    }
    items.sort((x, y) => {
      const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
      const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
      if (px !== py) return px - py
      return (x['id'] as string).localeCompare(y['id'] as string)
    })
    // #1258 — backend returns `{ blocks, truncated, total }` (see
    // `PageSubtree`). The mock never exceeds the 10k cap, so `truncated`
    // is always false and `total === items.length`.
    return { blocks: items, truncated: false, total: items.length }
  },

  // #1280 — advanced-query engine. The mock cannot compile a `FilterExpr`
  // tree to SQL, so it returns an empty page in the backend's wire shape
  // ({ rows, nextCursor, hasMore, totalCount }) by default. D2 added the
  // advanced-query UI controls (fulltext/sort/group-by/aggregates); to let the
  // component/hook tests exercise the GROUPED + AGGREGATE response paths, the
  // handler now SYNTHESISES `groups`/`aggregates` from the request shape rather
  // than compiling SQL:
  //   - `aggregates` requested → echo one `AggregateResult` per spec, with a
  //     deterministic stub value (`count` ⇒ `count`, fold ops ⇒ `value`).
  //   - `groupBy` requested → return a single synthetic group bucket keyed by a
  //     rendered label, carrying the per-group aggregates (same shape) and an
  //     empty `rows` page (the GROUPED contract).
  // The default (no groupBy / no aggregates) stays the empty flat page so
  // existing command-parity callers are unaffected.
  run_advanced_query: (args) => {
    const request = ((args as Record<string, unknown>)['request'] ?? {}) as Record<string, unknown>
    const aggSpecs = (request['aggregates'] as Array<Record<string, unknown>> | undefined) ?? []
    const groupBy = request['groupBy'] as Record<string, unknown> | null | undefined
    const cursor = request['cursor'] as string | null | undefined

    // Echo one AggregateResult per requested spec. `count` lands in `count`;
    // every fold operator (sum/avg/min/max) lands a stub `value`.
    const aggregateResults = aggSpecs.map((spec, i) => {
      const op = spec['op'] as string
      if (op === 'count') return { op, value: null, count: i + 1 }
      return { op, value: (i + 1) * 10, count: null }
    })

    if (groupBy != null) {
      // First page only: synthesise one bucket. Cursor pages return an empty
      // tail so load-more terminates deterministically.
      if (cursor != null) {
        return { rows: [], groups: [], nextCursor: null, hasMore: false, totalCount: null }
      }
      const key = (groupBy['key'] as Record<string, unknown> | undefined) ?? {}
      const renderedKey = (key['type'] as string | undefined) ?? 'group'
      return {
        rows: [],
        groups: [
          {
            key: renderedKey,
            count: 1,
            members: [],
            ...(aggregateResults.length > 0 ? { aggregates: aggregateResults } : {}),
          },
        ],
        nextCursor: null,
        hasMore: false,
        totalCount: 1,
        ...(aggregateResults.length > 0 ? { aggregates: aggregateResults } : {}),
      }
    }

    return {
      rows: [],
      nextCursor: null,
      hasMore: false,
      totalCount: 0,
      ...(aggregateResults.length > 0 ? { aggregates: aggregateResults } : {}),
    }
  },

  // PEND-56 — paginated page list with per-page metadata columns.
  // Mock parity with `list_pages_with_metadata_inner`: returns the same
  // shape as the backend (BlockRow columns + last_modified_at +
  // inbound_link_count + child_block_count + has_property_flags), sorts
  // by the requested mode, and cursor-paginates using the same keyset
  // shape (cursor.deleted_at = last sort-key string, cursor.seq = last
  // sort-key i64, cursor.id = tiebreaker).
  list_pages_with_metadata: (args) => {
    const a = args as Record<string, unknown>
    const filter = (a['filter'] as Record<string, unknown> | undefined) ?? {}
    const spaceId = filter['spaceId'] as string
    const sort = (filter['sort'] as string | undefined) ?? 'alphabetical'
    const cursor = a['cursor'] as string | null
    const limit = Math.min(Number((a['limit'] as number | null) ?? 50), 100)

    // Block-link edges derived from `[[ULID]]` tokens (mock stand-in for the
    // backend's `block_links` table) so the link facets and `MostLinked` sort
    // reflect the seed's real topology.
    const edges = deriveLinkEdges(blocks)

    // Build the metadata-rich row for every page in the space.
    const rows: PageMetaRow[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page' || b['deleted_at']) continue
      if (properties.get(b['id'] as string)?.get('space')?.['value_ref'] !== spaceId) continue
      const descendants = Array.from(blocks.values()).filter(
        (d) => d['page_id'] === b['id'] && !d['deleted_at'] && d['id'] !== b['id'],
      )
      rows.push(buildPageMetaRow(b, descendants, edges))
    }

    // PEND-58 Phase 3 — AND-compose the requested filter primitives, then sort.
    const filters = (filter['filters'] as Array<Record<string, unknown>> | undefined) ?? []
    const matched = rows.filter((r) => filters.every((f) => metaRowMatchesFilter(r, f)))
    matched.sort((x, y) => compareMetaRows(x, y, sort))

    // Cursor: skip rows up to AND INCLUDING the cursor's anchor.
    let startIdx = 0
    if (cursor) {
      let decoded: Record<string, unknown> | null = null
      try {
        decoded = JSON.parse(atob(cursor)) as Record<string, unknown>
      } catch {
        // Malformed cursor: start from the top (mirrors a cursorless fetch).
        decoded = null
      }
      if (decoded) {
        // Cross-sort cursor rejection — mirror the backend's
        // `validate_pages_metadata_cursor`: a cursor minted under one sort
        // carries that sort's `position` discriminator; reusing it after a
        // sort change is rejected with a `Validation` error whose message
        // carries the `RequiresRefresh:` prefix the frontend's
        // `withCursorRecovery` recognises (drop cursor → refetch page 1).
        // The thrown value carries the `{ kind, message }` AppError wire
        // shape (an `Error` instance augmented with `kind`, so it satisfies
        // both `isAppError` — `'kind' in err && 'message' in err` — and the
        // `useThrowOnlyError` lint) so `err.kind === 'validation'` narrows.
        const cursorDisc = decoded['position'] as number | undefined
        if (cursorDisc !== sortDiscriminator(sort)) {
          throw Object.assign(
            new Error(`RequiresRefresh: cursor sort mismatch (expected ${sort})`),
            { kind: 'validation' },
          )
        }
        const idx = matched.findIndex((r) => r.id === (decoded['id'] as string))
        if (idx >= 0) startIdx = idx + 1
      }
    }
    const slice = matched.slice(startIdx, startIdx + limit + 1)
    const hasMore = slice.length > limit
    const items = hasMore ? slice.slice(0, limit) : slice
    const last = items.at(-1)
    const nextCursor = hasMore && last ? encodeNextCursor(last, sort) : null
    // PEND-58d D6 (null-retention) — mirror the backend: the `total_count`
    // COUNT runs ONLY on the first page (`cursor == null`). The filtered-set
    // total does not change as the user pages with the same filters, so
    // recomputing it on every cursor page is wasted work. Subsequent (cursor)
    // pages return `total_count: null`; the frontend (`PageBrowser`'s
    // `displayTotalCount`) retains the first page's value. Returning the full
    // filtered-set size (not the page slice) on page 1 keeps the count chip
    // and e2e count assertions reflecting the active filters.
    const totalCount = cursor ? null : matched.length
    return { items, next_cursor: nextCursor, has_more: hasMore, total_count: totalCount }
  },

  // Every page in the space whose `template` property is set to 'true'.
  // No pagination, no clamp; the graph view uses this to flag templates.
  list_template_page_ids_in_space: (args) => {
    const a = args as Record<string, unknown>
    const spaceId = a['spaceId'] as string
    const ids: string[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const blockProps = properties.get(b['id'] as string)
      if (!blockProps) continue
      const spaceProp = blockProps.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      const tplProp = blockProps.get('template')
      if (tplProp?.['value_text'] !== 'true') continue
      ids.push(b['id'] as string)
    }
    return ids
  },

  list_undated_tasks: (args) => {
    // MAINT-226 — honour `scope: SpaceScope` (mirrors
    // `list_undated_tasks_inner`).
    const a = (args ?? {}) as Record<string, unknown>
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (b['todo_state'] === null) return false
      if (b['due_date'] !== null) return false
      if (b['scheduled_date'] !== null) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      return true
    })
    return { items, next_cursor: null, has_more: false }
  },

  create_block: (args) => {
    const a = args as Record<string, unknown>
    const id = fakeId()
    const parentId = (a['parentId'] as string) ?? null
    // PEND-35 / MAINT-226 — `scope: SpaceScope` mirrors the backend
    // `create_block_inner_with_space` semantics: when `kind === 'active'`
    // and the new block is a page, the page is stamped with
    // `space = ?space_id` so subsequent space-filtered queries (backlink
    // counts, alias resolution, etc.) recognise it as belonging to that
    // space. Global scope skips the stamp (legacy unscoped behaviour).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const blockType = a['blockType'] as string
    const row = {
      id,
      block_type: blockType,
      content: (a['content'] as string) ?? null,
      parent_id: parentId,
      page_id: blockType === 'page' ? id : parentId,
      // #400: position is the dense 1-based rank assigned by the renumber pass.
      position: 0,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    // #400: `index` is a 0-based sibling slot; null appends at the end. Insert
    // at the slot and renumber the sibling group to dense 1-based positions.
    const rawIndex = a['index'] as number | null | undefined
    insertAtSlotAndRenumber(parentId, id, rawIndex == null ? Number.MAX_SAFE_INTEGER : rawIndex)
    const position = row['position'] as number
    // Stamp the `space` ref property on new pages so the rest of the
    // scope-aware mock handlers (`count_backlinks_batch`,
    // `resolve_page_by_alias`, etc.) treat the page as living in the
    // active space — same invariant as `create_page_in_space`.
    if (blockType === 'page' && spaceId !== null) {
      if (!properties.has(id)) properties.set(id, new Map())
      properties.get(id)?.set('space', {
        block_id: id,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }
    pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: parentId,
      block_type: row.block_type,
      position,
    })
    return row
  },

  // PEND-35 Tier 4.3 — atomic batch-create. Mirrors the existing
  // `create_block` mock once per input spec, plus a `set_property` op
  // per (key, value) pair in the spec's `properties` map. The real
  // backend wraps the whole batch in one IMMEDIATE transaction; the
  // mock here is sequential (good enough for the FE shape — atomicity
  // is exercised by the Rust tests). Returns the created BlockRows in
  // INPUT ORDER so callers can map template-line index → block id.
  // oxlint-disable-next-line eslint/complexity -- pre-existing
  create_blocks_batch: (args) => {
    const a = args as Record<string, unknown>
    const specs = (a['specs'] as Array<Record<string, unknown>>) ?? []
    if (specs.length === 0) {
      throw new Error('specs list cannot be empty')
    }
    const out: Record<string, unknown>[] = []
    for (const spec of specs) {
      const id = fakeId()
      const parentId = (spec['parentId'] as string | null) ?? null
      let position = spec['position'] as number | undefined
      if (position == null) {
        const siblings = [...blocks.values()].filter(
          (b) => b['parent_id'] === parentId && !b['deleted_at'],
        )
        position = siblings.length
      }
      const blockType = spec['blockType'] as string
      const row: Record<string, unknown> = {
        id,
        block_type: blockType,
        content: (spec['content'] as string) ?? null,
        parent_id: parentId,
        page_id: blockType === 'page' ? id : parentId,
        position,
        deleted_at: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      }
      blocks.set(id, row)
      pushOp('create_block', {
        block_id: id,
        content: row['content'],
        parent_id: parentId,
        block_type: blockType,
        position,
      })
      // Apply any per-spec properties (mirrors `set_property_in_tx`
      // dispatch — reserved keys land on the block row, others go to
      // the properties map).
      const props = (spec['properties'] as Record<string, string> | undefined) ?? {}
      for (const [key, value] of Object.entries(props)) {
        if (key === 'todo_state') row['todo_state'] = value
        else if (key === 'priority') row['priority'] = value
        else if (key === 'due_date') row['due_date'] = value
        else if (key === 'scheduled_date') row['scheduled_date'] = value
        else {
          if (!properties.has(id)) properties.set(id, new Map())
          properties.get(id)?.set(key, {
            block_id: id,
            key,
            value_text: value,
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          })
        }
        pushOp('set_property', {
          block_id: id,
          key,
          value_text: value,
          value_number: null,
          value_date: null,
          value_ref: null,
        })
      }
      out.push(row)
    }
    return out
  },

  // ---------------------------------------------------------------------------
  // Spaces — FEAT-3 Phase 1 / Phase 2
  // ---------------------------------------------------------------------------

  // A mock vault always exposes a single canonical "Personal" space — the
  // matching id used across the unit tests in `App.test.tsx`,
  // `PageHeader.test.tsx`, etc. This keeps the space store hydrated and
  // `currentSpaceId` non-null so page-creation flows (Ctrl+N, the
  // PageBrowser input, the `[[` picker) don't bail out at the
  // `if (!isReady || currentSpaceId == null) return` guard in `App.tsx`.
  list_spaces: () => [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }],

  // FEAT-3 Phase 2 atomic page-creation IPC. Accepts `parentId` (null for a
  // top-level page), `content`, and `spaceId`. Returns the new page's ULID
  // as a plain string — `bindings.ts` documents this departure from the
  // BlockRow shape used by `create_block`.
  //
  // BUG-48 — the real backend wraps both the CreateBlock and
  // SetProperty(space) ops in a single transaction; the mock mirrors
  // that here so journal-page lookups (`get_journal_page_by_date`,
  // `list_journal_pages_in_range`) find newly-created pages by their
  // active space.
  create_page_in_space: (args) => {
    const a = args as Record<string, unknown>
    const id = fakeId()
    const parentId = (a['parentId'] as string | null) ?? null
    const spaceId = (a['spaceId'] as string | null) ?? null
    const siblings = [...blocks.values()].filter(
      (b) => b['parent_id'] === parentId && !b['deleted_at'],
    )
    const position = siblings.length
    const row = {
      id,
      block_type: 'page',
      content: (a['content'] as string) ?? null,
      parent_id: parentId,
      page_id: id,
      position,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    if (spaceId) {
      if (!properties.has(id)) properties.set(id, new Map())
      properties.get(id)?.set('space', {
        block_id: id,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }
    pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: parentId,
      block_type: 'page',
      position,
    })
    return id
  },

  // FEAT-3p6 atomic space-creation IPC. Accepts `name` and optional
  // `accentColor`. Returns the new space's ULID as a plain string.
  // Mirrors `create_page_in_space` but produces a top-level page block
  // marked with `is_space="true"` so `list_spaces` picks it up.
  create_space: (args) => {
    const a = args as Record<string, unknown>
    const id = fakeId()
    const row = {
      id,
      block_type: 'page',
      content: (a['name'] as string) ?? null,
      parent_id: null,
      page_id: id,
      position: 0,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: null,
      block_type: 'page',
      position: 0,
    })
    pushOp('set_property', {
      block_id: id,
      key: 'is_space',
      value_text: 'true',
      value_number: null,
      value_date: null,
      value_ref: null,
    })
    const accentColor = a['accentColor'] as string | null | undefined
    if (accentColor != null) {
      pushOp('set_property', {
        block_id: id,
        key: 'accent_color',
        value_text: accentColor,
        value_number: null,
        value_date: null,
        value_ref: null,
      })
    }
    return id
  },

  edit_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const oldContent = b['content'] as string | null
    b['content'] = a['toText'] as string
    pushOp('edit_block', {
      block_id: a['blockId'],
      to_text: a['toText'],
      from_text: oldContent,
    })
    return b
  },

  delete_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (b) b['deleted_at'] = new Date().toISOString()
    pushOp('delete_block', { block_id: a['blockId'] })
    return {
      block_id: a['blockId'],
      deleted_at: new Date().toISOString(),
      descendants_affected: 0,
    }
  },

  // PEND-35 Tier 2.1 — batch soft-delete (mirror of `delete_block`'s
  // cascade). The backend version walks descendants via a recursive
  // CTE seeded from every root; here we approximate that by walking
  // the live `blocks` map per root once (covers the same set without
  // SQL). Already-deleted / missing ids are silently skipped to
  // mirror the backend's lenient policy. One `delete_block` op_log
  // entry per RESOLVED root (matches the real backend's shape).
  delete_blocks_by_ids: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    if (inputIds.length === 0) {
      throw new Error('block_ids list cannot be empty')
    }
    const now = new Date().toISOString()
    // Resolve live roots (skip missing or already-deleted).
    const liveRoots = inputIds.filter((id) => {
      const b = blocks.get(id)
      return b && !b['deleted_at']
    })
    // BFS from every root, soft-delete every reachable descendant whose
    // `deleted_at` is currently NULL.
    let count = 0
    const stack: string[] = [...liveRoots]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const id = stack.pop()
      if (id == null) break
      if (seen.has(id)) continue
      seen.add(id)
      const b = blocks.get(id)
      if (!b || b['deleted_at']) continue
      b['deleted_at'] = now
      count++
      for (const child of blocks.values()) {
        if (child['parent_id'] === id && !child['deleted_at'] && !seen.has(child['id'] as string)) {
          stack.push(child['id'] as string)
        }
      }
    }
    // Append one delete_block op per resolved root (NOT per descendant)
    // — mirrors the backend's op_log shape.
    for (const root of liveRoots) {
      pushOp('delete_block', { block_id: root })
    }
    return count
  },

  restore_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (b) b['deleted_at'] = null
    pushOp('restore_block', { block_id: a['blockId'] })
    return { block_id: a['blockId'], restored_count: 1 }
  },

  purge_block: (args) => {
    const a = args as Record<string, unknown>
    blocks.delete(a['blockId'] as string)
    pushOp('purge_block', { block_id: a['blockId'] })
    return { block_id: a['blockId'], purged_count: 1 }
  },

  restore_all_deleted: () => {
    let count = 0
    for (const b of blocks.values()) {
      if (b['deleted_at']) {
        b['deleted_at'] = null
        count++
      }
    }
    return { affected_count: count }
  },

  purge_all_deleted: () => {
    let count = 0
    for (const [id, b] of blocks.entries()) {
      if (b['deleted_at']) {
        blocks.delete(id)
        count++
      }
    }
    return { affected_count: count }
  },

  // PEND-35 Tier 2.2 — single-IPC batch restore. Iterates the input ids,
  // clears `deleted_at` on each (matches existing `restore_block` mock's
  // per-row logic), pushes one `restore_block` op per actually-restored
  // root (mirrors backend's one op-per-root semantic). Non-deleted /
  // missing ids are silently skipped.
  restore_blocks_by_ids: (args) => {
    const a = args as Record<string, unknown>
    const ids = (a['blockIds'] as string[]) ?? []
    let count = 0
    for (const id of ids) {
      const b = blocks.get(id)
      if (b?.['deleted_at']) {
        b['deleted_at'] = null
        pushOp('restore_block', { block_id: id })
        count++
      }
    }
    return { affected_count: count }
  },

  // PEND-35 Tier 2.2 — single-IPC batch purge. Iterates the input ids,
  // physically removes each block plus all its related state from the
  // in-memory maps (matches the existing `purge_block` mock's cleanup
  // shape — that one only removed from `blocks`, but the real backend
  // cleans the ~13 dependent tables; we mirror that here for the maps
  // the seed actually tracks: properties, blockTags, attachments,
  // pageAliases). Non-deleted / missing ids are silently skipped.
  purge_blocks_by_ids: (args) => {
    const a = args as Record<string, unknown>
    const ids = (a['blockIds'] as string[]) ?? []
    let count = 0
    for (const id of ids) {
      const b = blocks.get(id)
      if (b?.['deleted_at']) {
        blocks.delete(id)
        properties.delete(id)
        blockTags.delete(id)
        attachments.delete(id)
        pageAliases.delete(id)
        count++
      }
    }
    return { affected_count: count }
  },

  get_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    return b
  },

  batch_resolve: (args) => {
    const a = args as Record<string, unknown>
    const ids = a['ids'] as string[]
    // MAINT-226 — honour `scope: SpaceScope`. Active scope drops blocks
    // whose owning page (`page_id`, or the block's own id if it IS a
    // page) is not stamped with `space = ?spaceId`, mirroring the
    // backend's `batch_resolve_inner` space-filter. Global passes
    // everything through (legacy cross-space behaviour).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    return ids
      .map((id) => blocks.get(id))
      .filter(Boolean)
      .filter((b) => {
        if (spaceId === null) return true
        const ownerId = (b?.['page_id'] as string | null) ?? (b?.['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        return ownerSpace === spaceId
      })
      .map((b) => ({
        id: b?.['id'] as string,
        title: (b?.['content'] as string | null) ?? null,
        block_type: b?.['block_type'] as string,
        deleted: b?.['deleted_at'] !== null,
      }))
  },

  move_block: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const b = blocks.get(blockId)
    if (!b) throw new Error('not found')
    const oldParentId = (b['parent_id'] as string | null) ?? null
    // #958 — record `old_position` as the block's 1-based DENSE RANK among its
    // current siblings, NOT its raw stored `position`. The seed stores some
    // positions 0-based (seed.ts `makeBlock(..., 0|1)`) while every renumber
    // (`insertAtSlotAndRenumber`/`renumberSiblings`) and `new_position` are
    // 1-based dense ranks. `undo_page_op` reverses a move by inserting at slot
    // `old_position - 1`, so a raw seed `position` is off by one and the undo
    // lands the block back where the move put it (a no-op). Concretely: moving
    // the 2nd of two root blocks up read the raw stored `position` of 1 (seeded
    // 0-based) which collided with the renumbered `new_position` of 1, so undo
    // re-inserted at slot 0 = unchanged. Ranking among live siblings makes
    // `old_position` the true 1-based slot the undo must restore to.
    const oldSiblings = [...blocks.values()]
      .filter(
        (s) => ((s['parent_id'] as string | null) ?? null) === oldParentId && !s['deleted_at'],
      )
      .sort((x, y) => {
        const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
        const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
        if (px !== py) return px - py
        return (x['id'] as string).localeCompare(y['id'] as string)
      })
    const oldPosition = oldSiblings.findIndex((s) => s['id'] === blockId) + 1
    const newParentId = (a['newParentId'] as string | null) ?? null
    // #400: `newIndex` is a 0-based insertion slot among the target parent's
    // OTHER children. Set the new parent, place the block at the slot, and
    // renumber BOTH the old and new sibling groups to dense 1-based positions
    // (matches the backend's `LoroTree::mov_to` + dense-rank materialization).
    const newIndex = a['newIndex'] as number
    b['parent_id'] = newParentId
    // Compute page_id from new parent (like the real backend)
    if (newParentId) {
      const newParent = blocks.get(newParentId)
      if (newParent) {
        b['page_id'] =
          newParent['block_type'] === 'page'
            ? (newParent['id'] as string)
            : (newParent['page_id'] as string | null)
      }
    } else {
      b['page_id'] = null
    }
    // #957 — refresh the moved subtree's descendants to the new page root
    // (mirrors the Rust backend's #664 descendant `page_id` refresh).
    refreshDescendantPageIds(blockId)
    insertAtSlotAndRenumber(newParentId, blockId, newIndex)
    // Renumber the old sibling group too (the vacated slot collapses). Skip
    // when the parent didn't change — the insert already renumbered it.
    if (oldParentId !== newParentId) renumberSiblings(oldParentId)
    const newPosition = b['position'] as number
    pushOp('move_block', {
      block_id: blockId,
      new_parent_id: newParentId,
      new_position: newPosition,
      old_parent_id: oldParentId,
      old_position: oldPosition,
    })
    return {
      block_id: blockId,
      new_parent_id: newParentId,
      new_position: newPosition,
    }
  },

  // ---------------------------------------------------------------------------
  // Tag associations
  // ---------------------------------------------------------------------------

  add_tag: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const tagId = a['tagId'] as string
    if (!blockTags.has(blockId)) blockTags.set(blockId, new Set())
    blockTags.get(blockId)?.add(tagId)
    pushOp('add_tag', { block_id: blockId, tag_id: tagId })
    return { block_id: blockId, tag_id: tagId }
  },

  remove_tag: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const tagId = a['tagId'] as string
    blockTags.get(blockId)?.delete(tagId)
    pushOp('remove_tag', { block_id: blockId, tag_id: tagId })
    return { block_id: blockId, tag_id: tagId }
  },

  // #81 / PEND-57 — bulk add one tag to N blocks. Lenient skip of
  // missing / deleted / self / already-tagged; returns the count newly tagged.
  add_tags_by_ids: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    const tagId = a['tagId'] as string
    if (inputIds.length === 0) {
      throw new Error('block_ids list cannot be empty')
    }
    let count = 0
    for (const blockId of inputIds) {
      const b = blocks.get(blockId)
      if (!b || b['deleted_at'] || blockId === tagId) continue
      if (!blockTags.has(blockId)) blockTags.set(blockId, new Set())
      const tags = blockTags.get(blockId)
      if (tags?.has(tagId)) continue
      tags?.add(tagId)
      pushOp('add_tag', { block_id: blockId, tag_id: tagId })
      count++
    }
    return count
  },

  // #81 / PEND-57 — bulk move N blocks to a space via the canonical
  // set_property(space) op. Lenient skip of missing / deleted; returns count moved.
  move_blocks_to_space: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    const spaceId = a['spaceId'] as string
    if (inputIds.length === 0) {
      throw new Error('block_ids list cannot be empty')
    }
    let count = 0
    for (const blockId of inputIds) {
      const b = blocks.get(blockId)
      if (!b || b['deleted_at']) continue
      if (!properties.has(blockId)) properties.set(blockId, new Map())
      properties.get(blockId)?.set('space', {
        block_id: blockId,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
      pushOp('set_property', {
        block_id: blockId,
        key: 'space',
        value_text: null,
        value_number: null,
        value_date: null,
        value_ref: spaceId,
      })
      count++
    }
    return count
  },

  // ---------------------------------------------------------------------------
  // Backlinks & history
  // ---------------------------------------------------------------------------

  get_backlinks: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    // MAINT-226 — honour `scope: SpaceScope` the same way the backend's
    // `get_backlinks_inner` does. Active scope drops source blocks whose
    // owning page (`page_id`, or own id if itself a page) lives in a
    // different space. Global is unfiltered (legacy cross-space view).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    // Scan all blocks for [[ULID]] tokens matching the target
    const LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
    const backlinkItems = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      const content = (b['content'] as string) ?? ''
      for (const m of content.matchAll(LINK_RE)) {
        if (m[1] === targetId) return true
      }
      return false
    })
    return { items: backlinkItems, next_cursor: null, has_more: false }
  },

  get_block_history: (_args) => {
    // PEND-35 Tier 1.3 — the backend now accepts `opTypeFilter`. The
    // mock signature mirrors that for parity with `bindings.ts` (the
    // handlers-drift test only checks that the command name is
    // present, but accepting the arg is the right shape). Browser-mode
    // callers don't currently exercise per-block history end-to-end, so
    // returning an empty page is still the cheapest correct behaviour.
    return { items: [], next_cursor: null, has_more: false, total_count: null }
  },

  list_page_history: (args) => {
    // Honour `scope: SpaceScope` by resolving the payload's `block_id`
    // through its owning page (`page_id`) and matching against the
    // active space's `space` property. This is more permissive than the
    // backend's literal SQL filter (which would only match page-level
    // ops because content blocks don't carry their own `space` property)
    // — the e2e tests + the user-facing UX both expect content-block
    // ops (e.g. `create_block` for a new child) to show in History view.
    // The backend SQL behaviour is filed as a separate concern; this
    // mock matches what the UI expects to see.
    const a = (args ?? {}) as Record<string, unknown>
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const items = [...opLog]
      .reverse()
      .filter((o) => {
        if (spaceId === null) return true
        let payloadObj: Record<string, unknown>
        try {
          payloadObj = JSON.parse(o.payload) as Record<string, unknown>
        } catch {
          return true
        }
        const blockId = payloadObj['block_id'] as string | undefined
        if (!blockId) return true
        const blk = blocks.get(blockId)
        const ownerId = (blk?.['page_id'] as string | null) ?? blockId
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        return ownerSpace === spaceId
      })
      .map((o) => ({
        device_id: o.device_id,
        seq: o.seq,
        op_type: o.op_type,
        payload: o.payload,
        created_at: o.created_at,
      }))
    return { items, next_cursor: null, has_more: false }
  },

  // PEND-35 Tier 4.4 — mirror `find_undo_group_inner` semantics so
  // browser-mode FE tests observe the same group sizing the real
  // backend produces. Walks the in-memory `opLog` newest-first,
  // filtering out `undo_*` / `redo_*` ops, seeds at index `depth`,
  // and counts consecutive same-device + within-window ops.
  find_undo_group: (args) => {
    const a = (args ?? {}) as Record<string, unknown>
    const depth = (a['depth'] as number) ?? 0
    const windowMs = (a['windowMs'] as number) ?? 0

    // Newest-first ordering on (created_at DESC, seq DESC).
    const undoableOps = [...opLog]
      .filter((o) => !o.op_type.startsWith('undo_') && !o.op_type.startsWith('redo_'))
      .sort((a2, b2) => {
        if (a2.created_at !== b2.created_at) return a2.created_at < b2.created_at ? 1 : -1
        return b2.seq - a2.seq
      })

    if (depth < 0 || depth >= undoableOps.length) return 0

    const seed = undoableOps[depth] as (typeof undoableOps)[number]
    let count = 1
    let prevTs = new Date(seed.created_at).getTime()
    let prevDevice = seed.device_id

    for (let i = depth + 1; i < undoableOps.length && count < 1000; i++) {
      const op = undoableOps[i] as (typeof undoableOps)[number]
      const ts = new Date(op.created_at).getTime()
      if (op.device_id !== prevDevice) break
      if (Math.abs(prevTs - ts) > windowMs) break
      count += 1
      prevTs = ts
      prevDevice = op.device_id
    }

    return count
  },

  revert_ops: (args) => {
    const a = args as Record<string, unknown>
    const ops = a['ops'] as Array<{ device_id: string; seq: number }>
    const results: Array<Record<string, unknown>> = []

    const sorted = [...ops].sort((x, y) => y.seq - x.seq)

    for (const opRef of sorted) {
      const target = opLog.find((o) => o.device_id === opRef.device_id && o.seq === opRef.seq)
      if (!target) continue

      applyRevertForOp(target, blocks, { properties, blockTags })

      const newOp = pushOp(`revert_${target.op_type}`, { reverted: target })
      results.push(newOp)
    }

    return results
  },

  search_blocks: (args) => {
    const a = args as Record<string, unknown>
    const query = (a['query'] as string) ?? ''
    if (!query) return { items: [], next_cursor: null, has_more: false }
    // UX-248 — Unicode-aware fold so the mock parity-matches the real
    // backend's FTS5 / `COLLATE NOCASE` behaviour for Turkish / German
    // / accented inputs.  Tests that assert Unicode matching against
    // the mock now see consistent behaviour.
    const items = [...blocks.values()].filter(
      (b) =>
        !(b['deleted_at'] as string | null) &&
        matchesSearchFolded((b['content'] as string) ?? '', query),
    )
    return { items, next_cursor: null, has_more: false }
  },

  search_blocks_partitioned: (args) => {
    // PEND-61 Phase 1 — partitions a single content-fold over `blocks`
    // into `pages` (block_type='page') and `blocks` (unrestricted). The
    // real backend caps each partition independently from one FTS scan;
    // the mock mirrors that wire shape on a folded-substring filter.
    const a = args as Record<string, unknown>
    const query = (a['query'] as string) ?? ''
    const pageLimit = (a['pageLimit'] as number) ?? 0
    const blockLimit = (a['blockLimit'] as number) ?? 0
    const empty = { items: [], next_cursor: null, has_more: false }
    if (!query) return { pages: empty, blocks: empty }

    const matching = [...blocks.values()].filter(
      (b) =>
        !(b['deleted_at'] as string | null) &&
        matchesSearchFolded((b['content'] as string) ?? '', query),
    )

    const pagesAll = matching.filter((b) => (b['block_type'] as string) === 'page')
    const pagesItems = pagesAll.slice(0, pageLimit)
    const blocksItems = matching.slice(0, blockLimit)

    return {
      pages: {
        items: pagesItems,
        next_cursor: null,
        has_more: pageLimit > 0 && pagesItems.length === pageLimit && pagesAll.length > pageLimit,
        total_count: null,
      },
      blocks: {
        items: blocksItems,
        next_cursor: null,
        has_more:
          blockLimit > 0 && blocksItems.length === blockLimit && matching.length > blockLimit,
        total_count: null,
      },
    }
  },

  get_status: () => {
    return {
      foreground_queue_depth: 0,
      background_queue_depth: 0,
      total_ops_dispatched: 0,
      total_background_dispatched: 0,
      fg_high_water: 0,
      bg_high_water: 0,
      fg_errors: 0,
      bg_errors: 0,
      fg_panics: 0,
      bg_panics: 0,
    }
  },

  // ---------------------------------------------------------------------------
  // Properties & tags queries
  // ---------------------------------------------------------------------------

  list_unfinished_tasks: (args) => {
    const a = args as Record<string, unknown>
    const beforeDate = a['beforeDate'] as string
    const todoStates = a['todoStates'] as string[]
    const limit = (a['limit'] as number | null) ?? 200
    // MAINT-226 — honour `scope: SpaceScope`. The previous mock read
    // `a['spaceId']`, which was the legacy IPC arg shape; the backend
    // now takes `scope: SpaceScope`, so callers in `tauri.ts` pass
    // `toSpaceScope(spaceId)` and the literal `spaceId` arg is no
    // longer present. Active scope: drop blocks whose owning page does
    // not carry `space = ?spaceId`. Global: unfiltered.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const items = Array.from(blocks.values()).filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      if (!todoStates.includes((b['todo_state'] as string) ?? '')) return false
      const date = b['due_date'] ?? b['scheduled_date']
      if (!date || date >= beforeDate) return false
      return true
    })

    items.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const dateA = a['due_date'] ?? a['scheduled_date'] ?? ''
      const dateB = b['due_date'] ?? b['scheduled_date'] ?? ''
      if (dateA !== dateB) return (dateB as string).localeCompare(dateA as string)
      return (b['id'] as string).localeCompare(a['id'] as string)
    })

    return Promise.resolve({
      items: items.slice(0, limit),
      next_cursor: null,
      has_more: items.length > limit,
    })
  },

  query_by_property: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const valueText = (a['valueText'] as string | null) ?? null
    const valueDate = (a['valueDate'] as string | null) ?? null
    // MAINT-226 — honour `scope: SpaceScope` (mirrors
    // `query_by_property_inner`). Active scope drops rows whose owning
    // page is not stamped with `space = ?spaceId`. Global passes through.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    // PEND-35 Tier 1.5 / Tier 3.4 — push-down filters bundled into
    // `extraFilters` on the IPC boundary. Mirror the backend
    // semantics so FE tests can observe the filter going through.
    //   - `excludeParentId` skips rows whose `parent_id` matches.
    //   - `contentNonEmpty` drops null/empty/whitespace-only content.
    //   - `blockType` (Tier 3.4) restricts to a single block_type.
    //   - `valueTextIn` (Tier 3.4) is set-membership over value_text;
    //     mutually exclusive with `valueText`.
    //   - `valueDateRange` (Tier 3.4) is half-open `[from, to)`.
    const extra = (a['extraFilters'] as Record<string, unknown> | null) ?? null
    const excludeParentId = ((extra?.['excludeParentId'] as string | null) ?? null) as string | null
    const contentNonEmpty = Boolean(extra?.['contentNonEmpty'])
    const blockType = ((extra?.['blockType'] as string | null) ?? null) as string | null
    const valueTextIn = ((extra?.['valueTextIn'] as string[] | null) ?? null) as string[] | null
    const valueDateRange = ((extra?.['valueDateRange'] as [string, string] | null) ?? null) as
      | [string, string]
      | null
    // Some well-known "properties" live on the block row itself in the seed
    // data (todo_state, priority, due_date, scheduled_date, completed_at,
    // created_at). The real backend exposes them through the properties
    // system, so the frontend calls query_by_property with those keys. We
    // fall back to reading the row-level field when the properties Map is
    // empty or doesn't carry that key (TEST-1f).
    const ROW_FIELD_KEYS: Record<string, 'text' | 'date'> = {
      todo_state: 'text',
      priority: 'text',
      due_date: 'date',
      scheduled_date: 'date',
    }
    const rowKind = ROW_FIELD_KEYS[key]
    // The predicate below mirrors the SQL evaluation order from
    // `pagination/properties.rs::query_by_property` so the mock's
    // observable behaviour matches the backend across reserved-key /
    // non-reserved / row-fallback branches plus the four pushed-down
    // filters (excludeParentId, contentNonEmpty, blockType, value_text/
    // valueTextIn, valueDate/valueDateRange). Splitting this into helpers
    // would make the SQL→TS correspondence harder to audit and would
    // duplicate the keep/drop signal across multiple closures.
    // oxlint-disable-next-line eslint/complexity -- pre-existing
    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      // MAINT-226 — active-space scoping: drop rows whose owning page
      // doesn't carry the active space ref.
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      // Push-down filters short-circuit before the property lookup so
      // the mock matches the SQL evaluation order.
      if (excludeParentId !== null && b['parent_id'] === excludeParentId) return false
      if (contentNonEmpty) {
        const content = b['content'] as string | null | undefined
        if (content == null || (content as string).trim() === '') return false
      }
      if (blockType !== null && b['block_type'] !== blockType) return false
      const blockProps = properties.get(b['id'] as string)
      const prop = blockProps?.get(key)
      const matchesValueTextIn = (v: string | null | undefined): boolean =>
        valueTextIn === null || valueTextIn.length === 0 || (v != null && valueTextIn.includes(v))
      const matchesValueDateRange = (v: string | null | undefined): boolean => {
        if (valueDateRange === null) return true
        if (v == null) return false
        const [from, to] = valueDateRange
        // Half-open `[from, to)`: include `from`, exclude `to`.
        return v >= from && v < to
      }
      if (prop) {
        if (!matchesValueTextIn(prop['value_text'] as string | null | undefined)) return false
        if (!matchesValueDateRange(prop['value_date'] as string | null | undefined)) return false
        if (valueText !== null) return prop['value_text'] === valueText
        if (valueDate !== null) return prop['value_date'] === valueDate
        return true
      }
      if (rowKind !== undefined) {
        const rowValue = b[key] as string | null | undefined
        if (rowValue == null) return false
        if (rowKind === 'text' && !matchesValueTextIn(rowValue)) return false
        if (rowKind === 'date' && !matchesValueDateRange(rowValue)) return false
        if (valueText !== null) return rowKind === 'text' && rowValue === valueText
        if (valueDate !== null) return rowKind === 'date' && rowValue === valueDate
        return true
      }
      return false
    })
    return { items, next_cursor: null, has_more: false }
  },

  query_by_tags: (args) => {
    const a = args as Record<string, unknown>
    const tagIds = (a['tagIds'] as string[]) ?? []
    const prefixes = (a['prefixes'] as string[] | null) ?? []
    const mode = ((a['mode'] as string) ?? 'and').toLowerCase()
    // PEND-35 Tier 3.4 — `blockType` push-down: restrict to a single
    // block_type. `null` / `undefined` keeps the unfiltered behaviour.
    const blockType = (a['blockType'] as string | null) ?? null
    // MAINT-226 — honour `scope: SpaceScope` (mirrors `query_by_tags_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    // Resolve prefixes to tag IDs by matching tag block content
    const resolvedFromPrefix: string[] = []
    for (const prefix of prefixes) {
      const lp = prefix.toLowerCase()
      for (const [, b] of blocks) {
        if (
          b['block_type'] === 'tag' &&
          !b['deleted_at'] &&
          ((b['content'] as string) ?? '').toLowerCase().startsWith(lp)
        ) {
          resolvedFromPrefix.push(b['id'] as string)
        }
      }
    }

    const allTagIds = [...tagIds, ...resolvedFromPrefix]

    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (blockType !== null && b['block_type'] !== blockType) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      const tags = blockTags.get(b['id'] as string)
      if (!tags || tags.size === 0) return false
      if (allTagIds.length === 0) return false
      if (mode === 'or') {
        return allTagIds.some((tid) => tags.has(tid))
      }
      // Default: AND — block must have ALL specified tags
      return allTagIds.every((tid) => tags.has(tid))
    })
    return { items, next_cursor: null, has_more: false }
  },

  // PEND-35 Tier 2.10b — AND-intersected property + tag query that the
  // backend resolves entirely in SQL via composed `EXISTS` subqueries.
  // The mock exists so FE tests can assert the IPC fires and observe
  // the post-intersection result; cursor pagination is intentionally
  // skipped (the backend semantic the audit cares about is "no silent
  // row cap" / "single round-trip", not "the mock paginates").
  filtered_blocks_query: (args) => {
    const a = args as Record<string, unknown>
    const propertyFilters = (a['propertyFilters'] as Record<string, unknown>[] | null) ?? []
    const tagFilters = (a['tagFilters'] as Record<string, unknown> | null) ?? null
    const blockType = (a['blockType'] as string | null) ?? null
    // MAINT-226 — honour `scope: SpaceScope` (mirrors `filtered_blocks_query_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const ROW_FIELD_KEYS: Record<string, 'text' | 'date'> = {
      todo_state: 'text',
      priority: 'text',
      due_date: 'date',
      scheduled_date: 'date',
    }

    /**
     * Evaluate one PropertyFilter against a block — mirrors the
     * EXISTS-subquery semantics the backend emits per filter (or, for
     * reserved keys, the direct column predicate routing).
     */
    const propertyFilterMatches = (
      b: Record<string, unknown>,
      pf: Record<string, unknown>,
      // oxlint-disable-next-line eslint/complexity -- pre-existing
    ): boolean => {
      const key = pf['key'] as string
      const valueText = (pf['valueText'] as string | null) ?? null
      const valueTextIn = (pf['valueTextIn'] as string[] | null) ?? null
      const valueDate = (pf['valueDate'] as string | null) ?? null
      const valueDateRange = (pf['valueDateRange'] as [string, string] | null) ?? null
      const operator = ((pf['operator'] as string | null) ?? 'eq').toLowerCase()

      const cmp = (lhs: string, rhs: string): boolean => {
        switch (operator) {
          case 'neq':
            return lhs !== rhs
          case 'lt':
            return lhs < rhs
          case 'gt':
            return lhs > rhs
          case 'lte':
            return lhs <= rhs
          case 'gte':
            return lhs >= rhs
          default:
            return lhs === rhs
        }
      }

      const blockProps = properties.get(b['id'] as string)
      const prop = blockProps?.get(key)
      const rowKind = ROW_FIELD_KEYS[key]
      // Resolve the candidate text/date for comparison from either
      // block_properties or the row-level reserved column.
      let pText: string | null = null
      let pDate: string | null = null
      if (prop) {
        pText = (prop['value_text'] as string | null) ?? null
        pDate = (prop['value_date'] as string | null) ?? null
      } else if (rowKind !== undefined) {
        const v = (b[key] as string | null | undefined) ?? null
        if (rowKind === 'text') pText = v
        else pDate = v
      } else {
        return false // key absent
      }

      if (valueTextIn && valueTextIn.length > 0) {
        if (pText == null || !valueTextIn.includes(pText)) return false
      }
      if (valueDateRange) {
        if (pDate == null) return false
        const [from, to] = valueDateRange
        if (!(pDate >= from && pDate < to)) return false
      }
      if (valueText !== null) {
        if (pText == null || !cmp(pText, valueText)) return false
      }
      if (valueDate !== null) {
        if (pDate == null || !cmp(pDate, valueDate)) return false
      }
      return true
    }

    const tagFilterMatches = (b: Record<string, unknown>): boolean => {
      if (!tagFilters) return true
      const tagIds = (tagFilters['tagIds'] as string[] | null) ?? []
      const prefixes = (tagFilters['prefixes'] as string[] | null) ?? []
      const mode = ((tagFilters['mode'] as string | null) ?? 'or').toLowerCase()
      if (tagIds.length === 0 && prefixes.length === 0) return true

      // Resolve prefixes to tag-block ids by content prefix-match
      // (mirrors the backend's `tags_cache.name LIKE ?` semantics —
      // the mock has no tags_cache table so we walk tag blocks).
      const resolvedFromPrefix: string[] = []
      for (const prefix of prefixes) {
        const lp = prefix.toLowerCase()
        for (const [, blk] of blocks) {
          if (
            blk['block_type'] === 'tag' &&
            !blk['deleted_at'] &&
            ((blk['content'] as string) ?? '').toLowerCase().startsWith(lp)
          ) {
            resolvedFromPrefix.push(blk['id'] as string)
          }
        }
      }
      const allIds = [...tagIds, ...resolvedFromPrefix]
      const tags = blockTags.get(b['id'] as string)
      if (!tags || tags.size === 0) return false
      if (mode === 'and') return allIds.every((tid) => tags.has(tid))
      return allIds.some((tid) => tags.has(tid))
    }

    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (blockType !== null && b['block_type'] !== blockType) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      for (const pf of propertyFilters) {
        if (!propertyFilterMatches(b, pf)) return false
      }
      if (!tagFilterMatches(b)) return false
      return true
    })
    items.sort((x, y) => (x['id'] as string).localeCompare(y['id'] as string))
    return { items, next_cursor: null, has_more: false }
  },

  list_tags_by_prefix: (args) => {
    const a = args as Record<string, unknown>
    const prefix = ((a['prefix'] as string) ?? '').toLowerCase()
    const tagBlocks = [...blocks.values()].filter(
      (b) =>
        b['block_type'] === 'tag' &&
        !(b['deleted_at'] as string | null) &&
        ((b['content'] as string) ?? '').toLowerCase().startsWith(prefix),
    )
    return tagBlocks.map((b) => ({
      tag_id: b['id'] as string,
      name: (b['content'] as string) ?? '',
      usage_count: 0,
      updated_at: new Date().toISOString(),
    }))
  },

  // Every tag in the given space.  No pagination, no clamp; bounded by
  // the space's intrinsic tag count.  Mirrors the backend's space-scope
  // filter via `block_properties(key='space').value_ref` on the tag
  // block itself.
  list_all_tags_in_space: (args) => {
    const a = args as Record<string, unknown>
    const spaceId = a['spaceId'] as string
    const tagRows: Array<{
      tag_id: string
      name: string
      usage_count: number
      updated_at: string
    }> = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'tag') continue
      if (b['deleted_at']) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      tagRows.push({
        tag_id: b['id'] as string,
        name: (b['content'] as string) ?? '',
        usage_count: 0,
        updated_at: new Date().toISOString(),
      })
    }
    tagRows.sort((x, y) => x.name.localeCompare(y.name))
    return tagRows
  },

  list_tags_for_block: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const tagSet = blockTags.get(blockId)
    if (!tagSet || tagSet.size === 0) return []
    return [...tagSet]
  },

  // #1423 — inherited (derived) tag IDs. The mock models only direct
  // associations (`blockTags`); tag inheritance via `block_tag_inherited`
  // is intentionally not modelled here, so this always returns an empty
  // list. Inherited-chip rendering is exercised by component unit tests
  // that pass the flag directly rather than through this mock.
  list_inherited_tags_for_block: () => [],

  set_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    // PEND-14: typed values are bundled under `value: SetPropertyArgs` (was 4 flat
    // args). Navigate the bundle to read each typed value column.
    const valueArgs = a['value'] as Record<string, unknown> | undefined
    const valueText = (valueArgs?.['value_text'] as string | null) ?? null
    const valueNum = (valueArgs?.['value_num'] as number | null) ?? null
    const valueDate = (valueArgs?.['value_date'] as string | null) ?? null
    const valueRef = (valueArgs?.['value_ref'] as string | null) ?? null
    const valueBool = (valueArgs?.['value_bool'] as boolean | null) ?? null
    // Capture the prior typed value (if any) so revert can restore it.
    // `from_value: null` signals "property did not exist" — revert removes it.
    const priorRow = properties.get(blockId)?.get(key)
    const fromValue = priorRow
      ? {
          value_text: (priorRow['value_text'] as string | null) ?? null,
          value_num: (priorRow['value_num'] as number | null) ?? null,
          value_date: (priorRow['value_date'] as string | null) ?? null,
          value_ref: (priorRow['value_ref'] as string | null) ?? null,
          value_bool: (priorRow['value_bool'] as number | null) ?? null,
        }
      : null
    if (!properties.has(blockId)) {
      properties.set(blockId, new Map())
    }
    properties.get(blockId)?.set(key, {
      key,
      value_text: valueText,
      value_num: valueNum,
      value_date: valueDate,
      value_ref: valueRef,
      value_bool: valueBool === null ? null : valueBool ? 1 : 0,
    })
    pushOp('set_property', { block_id: blockId, key, from_value: fromValue })
    const b = blocks.get(blockId)
    return b ? { ...b } : null
  },

  delete_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    // Capture the prior typed value so revert can re-add it.
    const priorRow = properties.get(blockId)?.get(key)
    const fromValue = priorRow
      ? {
          value_text: (priorRow['value_text'] as string | null) ?? null,
          value_num: (priorRow['value_num'] as number | null) ?? null,
          value_date: (priorRow['value_date'] as string | null) ?? null,
          value_ref: (priorRow['value_ref'] as string | null) ?? null,
          value_bool: (priorRow['value_bool'] as number | null) ?? null,
        }
      : null
    const blockProps = properties.get(blockId)
    if (blockProps) blockProps.delete(key)
    pushOp('delete_property', {
      block_id: blockId,
      key,
      from_value: fromValue,
    })
    return null
  },

  get_properties: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const blockProps = properties.get(blockId)
    if (!blockProps) return []
    return [...blockProps.values()]
  },

  // PEND-35 Tier 2.4c — single-key PK lookup. Returns the row or null.
  get_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    const propMap = properties.get(blockId)
    return propMap?.get(key) ?? null
  },

  get_batch_properties: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = a['blockIds'] as string[]
    const result: Record<string, Record<string, unknown>[]> = {}
    for (const id of blockIds) {
      const blockProps = properties.get(id)
      result[id] = blockProps ? [...blockProps.values()] : []
    }
    return result
  },

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------

  undo_page_op: (args) => {
    const a = args as Record<string, unknown>
    const undoDepth = (a['undoDepth'] as number) ?? 0

    const undoableOps = opLog.filter(
      (o) => !o.op_type.startsWith('undo_') && !o.op_type.startsWith('redo_'),
    )
    const targetIndex = undoableOps.length - 1 - undoDepth
    if (targetIndex < 0) throw new Error('no undoable op found')
    const target = undoableOps[targetIndex]
    if (!target) throw new Error('no undoable op found')

    const payload = JSON.parse(target.payload) as Record<string, unknown>
    let reverseOpType = 'edit_block'
    if (target.op_type === 'create_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = new Date().toISOString()
      reverseOpType = 'delete_block'
    } else if (target.op_type === 'delete_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = null
      reverseOpType = 'restore_block'
    } else if (target.op_type === 'edit_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['content'] = (payload['from_text'] as string | null) ?? null
      reverseOpType = 'edit_block'
    } else if (target.op_type === 'move_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) {
        // #958 — reverse a move by RE-INSERTING the block at its old SLOT in the
        // old parent group, exactly like the forward `move_block` handler. The
        // old code wrote the raw `old_position` back without re-slotting: the
        // moved block then collided (same `position`) with the sibling now in
        // its old slot, and `load_page_subtree` orders by `position ASC, id
        // ASC`, so the tie broke on id — NOT the intended pre-move order. The
        // "Undone" toast fired but the order/depth did not revert in place (it
        // only "healed" on a full reopen, where the backend re-materializes
        // dense ranks). `old_position` is a 1-based dense rank, so the 0-based
        // insertion slot among the OTHER siblings is `old_position - 1`.
        const curParentId = (b['parent_id'] as string | null) ?? null
        const oldParentId = (payload['old_parent_id'] as string | null) ?? null
        const oldSlot = ((payload['old_position'] as number) ?? 1) - 1
        b['parent_id'] = oldParentId
        // Recompute page_id from the restored parent (mirrors `move_block`).
        if (oldParentId) {
          const oldParent = blocks.get(oldParentId)
          if (oldParent) {
            b['page_id'] =
              oldParent['block_type'] === 'page'
                ? (oldParent['id'] as string)
                : (oldParent['page_id'] as string | null)
          }
        } else {
          b['page_id'] = null
        }
        // #957 — undoing a cross-parent move must also restore the subtree's
        // descendant `page_id`s to the (now-restored) page root.
        refreshDescendantPageIds(payload['block_id'] as string)
        insertAtSlotAndRenumber(oldParentId, payload['block_id'] as string, oldSlot)
        // Collapse the vacated source group too (skip when same parent — the
        // insert already renumbered it).
        if (curParentId !== oldParentId) renumberSiblings(curParentId)
      }
      reverseOpType = 'move_block'
    } else if (target.op_type === 'restore_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = new Date().toISOString()
      reverseOpType = 'delete_block'
    }

    const newOp = pushOp(`undo_${reverseOpType}`, { reversed: target })
    return {
      reversed_op: { device_id: target.device_id, seq: target.seq },
      new_op_ref: { device_id: newOp.device_id, seq: newOp.seq },
      new_op_type: reverseOpType,
      is_redo: false,
    }
  },

  redo_page_op: (args) => {
    const a = args as Record<string, unknown>
    const undoSeq = a['undoSeq'] as number

    // The frontend stores reversed_op (the original op's ref) in the redo
    // stack, so undoSeq is the original op's seq. Find and re-apply it.
    const originalOp: MockOpLogEntry | undefined = opLog.find((o) => o.seq === undoSeq)
    if (!originalOp) throw new Error('op not found for redo')

    const payload = JSON.parse(originalOp.payload) as Record<string, unknown>

    let redoOpType = 'edit_block'
    if (originalOp.op_type === 'create_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = null
      redoOpType = 'create_block'
    } else if (originalOp.op_type === 'delete_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = new Date().toISOString()
      redoOpType = 'delete_block'
    } else if (originalOp.op_type === 'edit_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['content'] = (payload['to_text'] as string | null) ?? null
      redoOpType = 'edit_block'
    } else if (originalOp.op_type === 'move_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) {
        // #958 — re-apply a move by RE-INSERTING at the new SLOT (see the undo
        // path above for why a raw `new_position` write collides and breaks
        // `position ASC, id ASC`). `new_position` is a 1-based dense rank → the
        // 0-based insertion slot among the OTHER siblings is `new_position - 1`.
        const curParentId = (b['parent_id'] as string | null) ?? null
        const newParentId = (payload['new_parent_id'] as string | null) ?? null
        const newSlot = ((payload['new_position'] as number) ?? 1) - 1
        b['parent_id'] = newParentId
        if (newParentId) {
          const newParent = blocks.get(newParentId)
          if (newParent) {
            b['page_id'] =
              newParent['block_type'] === 'page'
                ? (newParent['id'] as string)
                : (newParent['page_id'] as string | null)
          }
        } else {
          b['page_id'] = null
        }
        // #957 — re-applying a cross-parent move must also re-refresh the
        // subtree's descendant `page_id`s to the new page root.
        refreshDescendantPageIds(payload['block_id'] as string)
        insertAtSlotAndRenumber(newParentId, payload['block_id'] as string, newSlot)
        if (curParentId !== newParentId) renumberSiblings(curParentId)
      }
      redoOpType = 'move_block'
    } else if (originalOp.op_type === 'restore_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = null
      redoOpType = 'restore_block'
    }

    const newOp = pushOp(`redo_${redoOpType}`, { re_applied: originalOp })
    return {
      reversed_op: { device_id: originalOp.device_id, seq: originalOp.seq },
      new_op_ref: { device_id: newOp.device_id, seq: newOp.seq },
      new_op_type: redoOpType,
      is_redo: true,
    }
  },

  query_backlinks_filtered: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    const filterList = (a['filters'] as Array<Record<string, unknown>> | null) ?? []
    // MAINT-226 — honour `scope: SpaceScope` (mirrors
    // `query_backlinks_filtered_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    // Scan all blocks for [[ULID]] tokens matching the target
    const LINK_RE_F = /\[\[([0-9A-Z]{26})\]\]/g
    let backlinkItems = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      const content = (b['content'] as string) ?? ''
      for (const m of content.matchAll(LINK_RE_F)) {
        if (m[1] === targetId) return true
      }
      return false
    })

    // Apply simple filter support
    for (const filter of filterList) {
      const type = filter['type'] as string
      if (type === 'BlockType') {
        const bt = filter['block_type'] as string
        backlinkItems = backlinkItems.filter((b) => b['block_type'] === bt)
      } else if (type === 'Contains') {
        const query = (filter['query'] as string) ?? ''
        // UX-248 — Unicode-aware fold (mock / backend parity).
        backlinkItems = backlinkItems.filter((b) =>
          matchesSearchFolded((b['content'] as string) ?? '', query),
        )
      } else if (type === 'PropertyText') {
        const key = filter['key'] as string
        const value = filter['value'] as string
        backlinkItems = backlinkItems.filter((b) => {
          const blockProps = properties.get(b['id'] as string)
          if (!blockProps) return false
          const prop = blockProps.get(key)
          if (!prop) return false
          return (prop['value_text'] as string | null) === value
        })
      }
      // Unsupported filter types are ignored (graceful degradation)
    }

    const totalCount = backlinkItems.length
    return {
      items: backlinkItems,
      next_cursor: null,
      has_more: false,
      total_count: totalCount,
      filtered_count: totalCount,
      truncated: false,
    }
  },

  list_property_keys: () => {
    // Collect all distinct property keys from mock data
    const keys = new Set<string>()
    for (const blockProps of properties.values()) {
      for (const key of blockProps.keys()) {
        keys.add(key)
      }
    }
    // Always include common keys
    keys.add('todo')
    keys.add('priority')
    return [...keys].sort()
  },

  // #1425 — distinct text values for a key, usage-ranked (most-used
  // first), `value ASC` tiebreaker. Mirrors the backend
  // `list_property_values`, surfacing only the `value_text` channel.
  list_property_values: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const counts = new Map<string, number>()
    for (const blockProps of properties.values()) {
      const prop = blockProps.get(key)
      const value = prop?.['value_text']
      if (typeof value !== 'string') continue
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([value]) => value)
  },

  // ---------------------------------------------------------------------------
  // Sync / Peer-ref commands
  // ---------------------------------------------------------------------------

  list_peer_refs: () => [],
  get_peer_ref: returnNull,
  delete_peer_ref: returnUndefined,
  get_device_id: () => 'mock-device-id-0000',

  start_pairing: () => ({
    passphrase: 'alpha bravo charlie delta',
    qr_svg: '<svg></svg>',
  }),
  confirm_pairing: returnUndefined,
  cancel_pairing: returnUndefined,

  start_sync: (args) => {
    const a = args as Record<string, unknown>
    return {
      state: 'syncing',
      local_device_id: 'mock-device-id-0000',
      remote_device_id: a['peerId'],
      ops_received: 0,
      ops_sent: 0,
    }
  },

  cancel_sync: returnUndefined,

  // ---------------------------------------------------------------------------
  // Task properties (todo/priority/due/scheduled)
  // ---------------------------------------------------------------------------

  set_todo_state: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const fromState = (b['todo_state'] as string | null) ?? null
    b['todo_state'] = (a['state'] as string | null) ?? null
    pushOp('set_todo_state', {
      block_id: a['blockId'],
      state: b['todo_state'],
      from_state: fromState,
    })
    return { ...b }
  },

  // PEND-35 Tier 2.1 — batch set/clear todo state. Iterates the
  // input list, sets `b.todo_state` on each live block, and emits a
  // single `set_property` op per affected block (mirrors the
  // backend's per-block op_log entry under one tx). Missing /
  // soft-deleted ids are silently skipped (lenient batch semantic).
  set_todo_state_batch: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    if (inputIds.length === 0) {
      throw new Error('block_ids list cannot be empty')
    }
    const newState = (a['state'] as string | null) ?? null
    let updated = 0
    for (const id of inputIds) {
      const b = blocks.get(id)
      if (!b || b['deleted_at']) continue
      b['todo_state'] = newState
      pushOp('set_property', {
        block_id: id,
        key: 'todo_state',
        value_text: newState,
      })
      updated++
    }
    return updated
  },

  set_priority: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const fromLevel = (b['priority'] as string | null) ?? null
    b['priority'] = (a['level'] as string | null) ?? null
    pushOp('set_priority', {
      block_id: a['blockId'],
      level: b['priority'],
      from_level: fromLevel,
    })
    return { ...b }
  },

  set_due_date: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const fromDate = (b['due_date'] as string | null) ?? null
    b['due_date'] = (a['date'] as string | null) ?? null
    pushOp('set_due_date', {
      block_id: a['blockId'],
      date: b['due_date'],
      from_date: fromDate,
    })
    return { ...b }
  },

  set_scheduled_date: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const fromDate = (b['scheduled_date'] as string | null) ?? null
    b['scheduled_date'] = (a['date'] as string | null) ?? null
    pushOp('set_scheduled_date', {
      block_id: a['blockId'],
      date: b['scheduled_date'],
      from_date: fromDate,
    })
    return { ...b }
  },

  // ---------------------------------------------------------------------------
  // Batch count commands
  // ---------------------------------------------------------------------------

  count_agenda_batch: (args) => {
    const a = args as Record<string, unknown>
    const dates = a['dates'] as string[]
    // MAINT-226 — honour `scope: SpaceScope` (mirrors
    // `count_agenda_batch_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const result: Record<string, number> = {}
    for (const dateStr of dates) {
      const count = [...blocks.values()].filter((b) => {
        if (b['deleted_at'] as string | null) return false
        if (b['due_date'] !== dateStr && b['scheduled_date'] !== dateStr) return false
        if (spaceId !== null) {
          const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
          const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
          if (ownerSpace !== spaceId) return false
        }
        return true
      }).length
      result[dateStr] = count
    }
    return result
  },

  // oxlint-disable-next-line eslint/complexity -- MAINT-226 — scope filter added to a nested per-date / per-source / per-block loop. Splitting helpers would obscure the SQL→TS correspondence with `count_agenda_batch_by_source_inner`.
  count_agenda_batch_by_source: (args) => {
    const a = args as Record<string, unknown>
    const dates = a['dates'] as string[]
    // MAINT-226 — honour `scope: SpaceScope` (mirrors
    // `count_agenda_batch_by_source_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const result: Record<string, Record<string, number>> = {}
    for (const dateStr of dates) {
      const sources: Record<string, number> = {}
      for (const b of blocks.values()) {
        if (b['deleted_at'] as string | null) continue
        if (spaceId !== null) {
          const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
          const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
          if (ownerSpace !== spaceId) continue
        }
        if (b['due_date'] === dateStr) {
          sources['column:due_date'] = (sources['column:due_date'] ?? 0) + 1
        }
        if (b['scheduled_date'] === dateStr) {
          sources['column:scheduled_date'] = (sources['column:scheduled_date'] ?? 0) + 1
        }
      }
      if (Object.keys(sources).length > 0) {
        result[dateStr] = sources
      }
    }
    return result
  },

  count_backlinks_batch: (args) => {
    const a = args as Record<string, unknown>
    const pageIds = a['pageIds'] as string[]
    // PEND-35 Tier 1.6 — honour `scope` so mock-mode FE tests can
    // observe space-scoped badge counts the same way the real backend
    // produces them. The shape mirrors `list_page_aliases_by_prefix`
    // above: pull the active spaceId out of `{ kind, space_id }`,
    // fall back to `null` (cross-space, legacy) for `Global`.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const LINK_RE_BATCH = /\[\[([0-9A-Z]{26})\]\]/g
    const result: Record<string, number> = {}
    for (const pid of pageIds) {
      const count = [...blocks.values()].filter((b) => {
        if (b['deleted_at']) return false
        // Active-space scoping: drop source blocks whose owning page
        // (resolved via `page_id`, falling back to the block's own id
        // if it IS a page) doesn't carry `space = <spaceId>`. Matches
        // the SQL `COALESCE(b.page_id, b.id) IN (... space ...)` used
        // by `count_backlinks_batch_inner`.
        if (spaceId !== null) {
          const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
          const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
          if (ownerSpace !== spaceId) return false
        }
        const content = (b['content'] as string) ?? ''
        for (const m of content.matchAll(LINK_RE_BATCH)) {
          if (m[1] === pid) return true
        }
        return false
      }).length
      result[pid] = count
    }
    return result
  },

  count_trash: (args) => {
    // limit-clamp-followup — dedicated count IPC backing the
    // `useTrashCount` badge.  Mirrors the backend's
    // `count_trash_inner`: count soft-deleted blocks whose owning
    // page carries `space = <space_id>`.  The page-owner resolution
    // is the same `COALESCE(page_id, id)` lookup as
    // `count_backlinks_batch` above.
    const a = args as Record<string, unknown>
    const spaceId = a['spaceId'] as string
    if (!spaceId) return 0
    let count = 0
    for (const b of blocks.values()) {
      if (!b['deleted_at']) continue
      const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
      const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
      if (ownerSpace === spaceId) count++
    }
    return count
  },

  // ---------------------------------------------------------------------------
  // Grouped backlinks + unlinked references
  // ---------------------------------------------------------------------------

  list_backlinks_grouped: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    // MAINT-226 — honour `scope: SpaceScope` (mirrors
    // `list_backlinks_grouped_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const LINK_RE_G = /\[\[([0-9A-Z]{26})\]\]/g
    const backlinkItems = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      const content = (b['content'] as string) ?? ''
      for (const m of content.matchAll(LINK_RE_G)) {
        if (m[1] === targetId) return true
      }
      return false
    })
    // Group by parent_id (source page)
    const groupMap = new Map<string, Record<string, unknown>[]>()
    for (const item of backlinkItems) {
      const pid = (item['parent_id'] as string) ?? '__orphan__'
      if (!groupMap.has(pid)) groupMap.set(pid, [])
      groupMap.get(pid)?.push(item)
    }
    const groups = [...groupMap.entries()].map(([pageId, items]) => {
      const page = blocks.get(pageId)
      return {
        page_id: pageId,
        page_title: page ? ((page['content'] as string) ?? null) : null,
        blocks: items,
      }
    })
    return {
      groups,
      next_cursor: null,
      has_more: false,
      total_count: backlinkItems.length,
      filtered_count: backlinkItems.length,
      truncated: false,
    }
  },

  list_unlinked_references: (args) => {
    const a = args as Record<string, unknown>
    const pageId = a['pageId'] as string
    // MAINT-226 — honour `scope: SpaceScope` (mirrors
    // `list_unlinked_references_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const page = blocks.get(pageId)
    if (!page)
      return {
        groups: [],
        next_cursor: null,
        has_more: false,
        total_count: 0,
        filtered_count: 0,
        truncated: false,
      }
    const pageTitle = (page['content'] as string) ?? ''
    if (!pageTitle)
      return {
        groups: [],
        next_cursor: null,
        has_more: false,
        total_count: 0,
        filtered_count: 0,
        truncated: false,
      }
    // Find blocks that mention the page title as text but don't have a [[link]].
    // UX-248 — Unicode-aware fold (mock / backend parity).
    const LINK_RE_UL = /\[\[([0-9A-Z]{26})\]\]/g
    const unlinked = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (b['id'] === pageId) return false
      if (b['parent_id'] === pageId) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      const content = (b['content'] as string) ?? ''
      if (!matchesSearchFolded(content, pageTitle)) return false
      // Exclude if it already has a [[link]] to this page
      for (const m of content.matchAll(LINK_RE_UL)) {
        if (m[1] === pageId) return false
      }
      return true
    })
    const groupMap = new Map<string, Record<string, unknown>[]>()
    for (const item of unlinked) {
      const pid = (item['parent_id'] as string) ?? '__orphan__'
      if (!groupMap.has(pid)) groupMap.set(pid, [])
      groupMap.get(pid)?.push(item)
    }
    const groups = [...groupMap.entries()].map(([pid, items]) => {
      const p = blocks.get(pid)
      return {
        page_id: pid,
        page_title: p ? ((p['content'] as string) ?? null) : null,
        blocks: items,
      }
    })
    return {
      groups,
      next_cursor: null,
      has_more: false,
      total_count: unlinked.length,
      filtered_count: unlinked.length,
      truncated: false,
    }
  },

  // ---------------------------------------------------------------------------
  // Word-level diff for history display
  // ---------------------------------------------------------------------------

  compute_edit_diff: (args) => {
    const a = args as Record<string, unknown>
    const deviceId = a['deviceId'] as string
    const seq = a['seq'] as number
    const target = opLog.find((o) => o.device_id === deviceId && o.seq === seq)
    if (!target || target.op_type !== 'edit_block') return null
    const payload = JSON.parse(target.payload) as Record<string, unknown>
    const fromText = ((payload['from_text'] as string) ?? '').split(/\s+/)
    const toText = ((payload['to_text'] as string) ?? '').split(/\s+/)
    // Simple word-level diff: mark all old as removed, all new as added
    const spans: Array<Record<string, unknown>> = []
    if (fromText.length > 0 && fromText[0] !== '') {
      spans.push({ tag: 'Delete', value: fromText.join(' ') })
    }
    if (toText.length > 0 && toText[0] !== '') {
      spans.push({ tag: 'Insert', value: toText.join(' ') })
    }
    return spans
  },

  // PEND-17 Part B — diff between a block's historical content (as of
  // the selected point `(historicalCreatedAt, historicalSeq)`) and its
  // current live content. Mirrors the Rust command's contract:
  // empty/all-Equal spans for unmodified blocks, throws on a
  // soft-deleted block.
  //
  // #382: bound/sort on the canonical `(created_at, seq)` keyset rather
  // than bare per-device `seq`, mirroring the Rust fix. `created_at` in
  // the mock op-log is an ISO-8601 string (lexicographically ordered),
  // so string comparison preserves chronological order.
  compute_block_vs_current_diff: (args) => {
    const a = args as Record<string, unknown>
    const blockId = (a['blockId'] as string).toUpperCase()
    const historicalSeq = a['historicalSeq'] as number
    const historicalCreatedAt = a['historicalCreatedAt']
    const block = blocks.get(blockId)
    if (!block || block['deleted_at']) {
      throw new Error(`block '${blockId}' not found or soft-deleted (cannot diff against current)`)
    }
    const current = (block['content'] as string | null | undefined) ?? ''
    // Walk the op log for the most recent edit_block / create_block at
    // or before the selected point for this block, bounding on
    // `(created_at, seq)` so a cross-device op with a smaller seq but a
    // later created_at cannot leak past the selected point.
    const createdBound = historicalCreatedAt == null ? null : String(historicalCreatedAt)
    const candidates = opLog.filter((o) => {
      if (o.op_type !== 'edit_block' && o.op_type !== 'create_block') return false
      if (createdBound == null) {
        if (o.seq > historicalSeq) return false
      } else {
        const oc = String(o.created_at)
        if (oc > createdBound || (oc === createdBound && o.seq > historicalSeq)) return false
      }
      try {
        const p = JSON.parse(o.payload) as Record<string, unknown>
        const pid = (p['block_id'] as string | undefined)?.toUpperCase()
        return pid === blockId
      } catch {
        return false
      }
    })
    if (candidates.length === 0) {
      throw new Error(
        `no create_block or edit_block op for '${blockId}' at or before seq ${historicalSeq}`,
      )
    }
    // Canonical order: created_at DESC, then seq DESC.
    candidates.sort((x, y) => {
      const xc = String(x.created_at)
      const yc = String(y.created_at)
      if (xc !== yc) return xc < yc ? 1 : -1
      return y.seq - x.seq
    })
    const target = candidates[0] as MockOpLogEntry
    const targetPayload = JSON.parse(target.payload) as Record<string, unknown>
    const historical =
      target.op_type === 'edit_block'
        ? ((targetPayload['to_text'] as string) ?? '')
        : ((targetPayload['content'] as string) ?? '')
    if (historical === current) return []
    // Same simplified word-diff as compute_edit_diff above — Delete the
    // historical, Insert the current. Tests only assert the SHAPE
    // (presence of Insert / Delete / Equal tags) so this is fine.
    const spans: Array<Record<string, unknown>> = []
    if (historical) spans.push({ tag: 'Delete', value: historical })
    if (current) spans.push({ tag: 'Insert', value: current })
    return spans
  },

  // ---------------------------------------------------------------------------
  // Property definition commands
  // ---------------------------------------------------------------------------

  create_property_def: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const def = {
      key,
      value_type: a['valueType'] as string,
      options: (a['options'] as string | null) ?? null,
      created_at: new Date().toISOString(),
    }
    propertyDefs.set(key, def)
    return def
  },

  list_property_defs: () => ({
    // M-85: paginated; the mock returns every def in one page (the
    // mock fixtures stay small enough that pagination is irrelevant).
    items: [...propertyDefs.values()],
    next_cursor: null,
    has_more: false,
  }),

  // PEND-35 Tier 2.6 — single-key PK lookup. Returns the entry or null.
  get_property_def: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    return propertyDefs.get(key) ?? null
  },

  update_property_def_options: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const def = propertyDefs.get(key)
    if (!def) throw new Error('property definition not found')
    def['options'] = a['options'] as string
    return { ...def }
  },

  delete_property_def: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    propertyDefs.delete(key)
    return undefined
  },

  // ---------------------------------------------------------------------------
  // Peer name update
  // ---------------------------------------------------------------------------

  update_peer_name: returnUndefined,

  // ---------------------------------------------------------------------------
  // Page alias commands
  // ---------------------------------------------------------------------------

  set_page_aliases: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    const aliases = a['aliases'] as string[]
    pageAliases.set(pid, aliases)
    return aliases
  },

  get_page_aliases: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    return pageAliases.get(pid) ?? []
  },

  resolve_page_by_alias: (args) => {
    const a = args as Record<string, unknown>
    const alias = (a['alias'] as string).toLowerCase()
    // PEND-35 Tier 1.2 — backend now takes `scope: SpaceScope`. Mirror
    // the `list_page_aliases_by_prefix` mock (sibling below) so an
    // alias pointing at a foreign-space page does not surface when the
    // caller is scoped to the active space. Global keeps the
    // cross-space lookup so the MCP / agent surfaces don't regress.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    for (const [pid, aliases] of pageAliases.entries()) {
      if (aliases.some((al) => al.toLowerCase() === alias)) {
        const page = blocks.get(pid)
        if (!page) continue
        if (spaceId !== null) {
          const space = properties.get(pid)?.get('space')?.['value_ref'] ?? null
          if (space !== spaceId) continue
        }
        return [pid, (page['content'] as string) ?? null]
      }
    }
    return null
  },

  // Substring alias autocomplete used by the [[ picker. The IPC name
  // (`prefix`) is historical — matching is now case-insensitive
  // substring (`LIKE '%q%'`) so aliases behave like FTS-backed page
  // titles. Returns `[page_id, alias, title]` rows ordered
  // shortest-alias first (then alphabetical), capped at `limit`
  // (default 50). When the IPC arg's `scope` is `{ kind: 'active',
  // space_id }`, restricts matches to aliases pointing at pages whose
  // `space` property equals the wrapped ULID. Mirrors the backend's
  // `list_page_aliases_by_prefix_inner` shape.
  list_page_aliases_by_prefix: (args) => {
    const a = args as Record<string, unknown>
    const query = ((a['prefix'] as string) ?? '').toLowerCase()
    const limit = (a['limit'] as number | null) ?? 50
    // PEND-18 Phase 3 — IPC arg shape: `scope: SpaceScope`. Recover the
    // legacy `spaceId | null` shape for the active-space-scoping branch.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const rows: Array<[string, string, string | null]> = []
    for (const [pid, aliases] of pageAliases.entries()) {
      const page = blocks.get(pid)
      if (!page) continue
      if (page['deleted_at']) continue
      // Active-space scoping (PEND-34 Q3): when `scope.kind === 'active'`,
      // exclude pages that don't carry `space = ?spaceId` in their
      // property map.
      if (spaceId !== null) {
        const space = properties.get(pid)?.get('space')?.['value_ref'] ?? null
        if (space !== spaceId) continue
      }
      const title = (page['content'] as string | null) ?? null
      for (const alias of aliases) {
        if (alias.toLowerCase().includes(query)) {
          rows.push([pid, alias, title])
        }
      }
    }
    rows.sort((x, y) => x[1].length - y[1].length || x[1].localeCompare(y[1]))
    return rows.slice(0, limit)
  },

  // ---------------------------------------------------------------------------
  // Markdown export
  // ---------------------------------------------------------------------------

  export_page_markdown: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    const page = blocks.get(pid)
    if (!page) throw new Error('not found')
    const children = [...blocks.values()]
      .filter((b) => b['parent_id'] === pid && !(b['deleted_at'] as string | null))
      .sort((x, y) => ((x['position'] as number) ?? 0) - ((y['position'] as number) ?? 0))
    let md = `# ${(page['content'] as string) ?? 'Untitled'}\n\n`
    for (const child of children) {
      md += `- ${(child['content'] as string) ?? ''}\n`
    }
    return md
  },

  // ---------------------------------------------------------------------------
  // Markdown import (#660)
  // ---------------------------------------------------------------------------

  import_markdown: (args) => {
    const a = args as Record<string, unknown>
    const content = (a['content'] as string) ?? ''
    const filename = (a['filename'] as string | null) ?? null
    // PEND-35 Tier 1.1 — backend now requires `space_id`. Mirror the
    // backend behaviour: stamp `space = ?spaceId` on the created page
    // so `tauri-mock-parity` and downstream space-scoped read mocks
    // see the imported page in the active space. The backend rejects
    // empty / missing values with `AppError::Validation`; the mock is
    // permissive about the value (skips the stamp when empty) so older
    // mock fixtures that pre-date this fix don't break.
    const spaceId = (a['spaceId'] as string | undefined) ?? ''

    // Derive page title from filename (strip .md extension) or first heading
    let pageTitle = 'Untitled'
    if (filename) {
      pageTitle = filename.replace(/\.md$/i, '')
    }
    const lines = content.split('\n')
    // If first line is a heading, use it as the page title
    const headingMatch = lines[0]?.match(/^#+\s+(.+)/)
    if (headingMatch) {
      pageTitle = headingMatch[1]?.trim() as string
      lines.shift() // remove heading line from block content
    }

    // Create the page block + stamp `space` ref property (PEND-35).
    const pageId = fakeId()
    const pageBlock = makeBlock(pageId, 'page', pageTitle, null, blocks.size)
    blocks.set(pageId, pageBlock)
    if (spaceId) {
      if (!properties.has(pageId)) properties.set(pageId, new Map())
      properties.get(pageId)?.set('space', {
        block_id: pageId,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }

    // Create content blocks from non-empty lines
    let blocksCreated = 0
    let position = 0
    for (const line of lines) {
      // Strip leading list markers (-, *, +, numbered) and whitespace
      const trimmed = line
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+\.\s+/, '')
        .trim()
      if (!trimmed) continue

      const blockId = fakeId()
      const block = makeBlock(blockId, 'content', trimmed, pageId, position)
      blocks.set(blockId, block)
      blocksCreated++
      position++
    }

    return {
      page_title: pageTitle,
      blocks_created: blocksCreated,
      properties_set: 0,
      warnings: [] as string[],
    }
  },

  // ---------------------------------------------------------------------------
  // Attachment commands (F-7)
  // ---------------------------------------------------------------------------

  list_attachments: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    return [...attachments.values()].filter((att) => att['block_id'] === blockId)
  },

  // MAINT-131 / PEND-35 Tier 2.7a: full-list batch — single source for both
  // SortableBlock badge counts (consumer reads `.length`) and StaticBlock
  // inline-image-render decisions. Mirrors the json_each-backed batch
  // pattern in `commands/blocks/queries.rs::batch_resolve_inner`.
  list_attachments_batch: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = (a['blockIds'] as string[]) ?? []
    const result: Record<string, unknown[]> = {}
    for (const att of attachments.values()) {
      const bid = att['block_id'] as string
      if (blockIds.includes(bid)) {
        result[bid] = result[bid] ?? []
        result[bid].push(att)
      }
    }
    return result
  },

  add_attachment: (args) => {
    const a = args as Record<string, unknown>
    const row = {
      id: fakeId(),
      block_id: a['blockId'] as string,
      filename: a['filename'] as string,
      mime_type: a['mimeType'] as string,
      size_bytes: a['sizeBytes'] as number,
      fs_path: a['fsPath'] as string,
      created_at: new Date().toISOString(),
    }
    attachments.set(row.id, row)
    return row
  },

  // PEND-76 F2 — bytes-over-IPC add. Stores the raw bytes so `read_attachment`
  // can round-trip them; fs_path is backend-generated under attachments/.
  add_attachment_with_bytes: (args) => {
    const a = args as Record<string, unknown>
    const bytes = (a['bytes'] as number[]) ?? []
    const id = fakeId()
    const row = {
      id,
      block_id: a['blockId'] as string,
      filename: a['filename'] as string,
      mime_type: a['mimeType'] as string,
      size_bytes: bytes.length,
      fs_path: `attachments/${id}`,
      created_at: new Date().toISOString(),
    }
    attachments.set(id, row)
    attachmentBytes.set(id, bytes)
    return row
  },

  // PEND-76 F2 — bytes-over-IPC read. Returns the stored byte array.
  read_attachment: (args) => {
    const a = args as Record<string, unknown>
    return attachmentBytes.get(a['attachmentId'] as string) ?? []
  },

  delete_attachment: (args) => {
    const a = args as Record<string, unknown>
    const id = a['attachmentId'] as string
    attachments.delete(id)
    attachmentBytes.delete(id)
    return null
  },

  rename_attachment: (args) => {
    const a = args as Record<string, unknown>
    const id = a['attachmentId'] as string
    const row = attachments.get(id)
    if (row) row['filename'] = a['newFilename'] as string
    return null
  },

  // ---------------------------------------------------------------------------
  // Projected agenda (repeating tasks)
  // ---------------------------------------------------------------------------

  // MAINT-226 — stub returns empty so scope is a no-op today. If this
  // becomes a real handler, mirror `list_projected_agenda_inner`'s
  // `SpaceScope` filter (see `src-tauri/src/commands/agenda.rs` ~L175).
  list_projected_agenda: returnEmptyPage,

  // ---------------------------------------------------------------------------
  // OS notifications (FEAT-11)
  // ---------------------------------------------------------------------------

  // Mirrors `commands::notifier::notify_task` — rejects a blank title with a
  // validation error, otherwise resolves void (the mock has no OS to dispatch
  // to). See `src-tauri/src/commands/notifier.rs::prepare_notification`.
  notify_task: (args) => {
    const a = args as { notification?: { title?: unknown } }
    const title = typeof a.notification?.title === 'string' ? a.notification.title : ''
    if (title.trim() === '') {
      throw { kind: 'validation', message: 'notification title must not be empty' }
    }
    return undefined
  },

  // ---------------------------------------------------------------------------
  // Draft autosave (F-17)
  // ---------------------------------------------------------------------------

  save_draft: returnNull,
  flush_draft: returnNull,
  delete_draft: returnNull,

  list_drafts: returnEmptyArray,

  // PEND-35 Tier 2.12 — boot recovery uses a single IPC. The mock has
  // no in-memory drafts map (existing `list_drafts: returnEmptyArray`
  // is the canonical source-of-truth shape), so `flushed` is always 0.
  flush_all_drafts: () => ({ flushed: 0 }),

  // #1255 — boot-recovery status. The mock represents a clean dev boot, so
  // replay never fails: always report a healthy (non-degraded) status.
  get_recovery_status: () => ({ degraded: false, replay_errors: [] }),

  // ---------------------------------------------------------------------------
  // Peer address
  // ---------------------------------------------------------------------------

  set_peer_address: returnNull,

  // ---------------------------------------------------------------------------
  // Page links for graph view (F-33)
  // ---------------------------------------------------------------------------

  // oxlint-disable-next-line eslint/complexity -- pre-existing
  list_page_links: (args) => {
    // Scan all non-deleted blocks for [[ULID]] page link tokens and
    // return page-to-page edges (source = parent page, target = linked page).
    const a = (args as Record<string, unknown> | null | undefined) ?? {}
    // PEND-35 Tier 4.5 — when `tagIds` is non-empty, restrict edges to
    // those whose target page carries at least one of the listed tags.
    // Mirrors the backend semantics (`block_tags`-only resolution in the
    // mock world; the real backend additionally unions
    // `block_tag_inherited` / `block_tag_refs`, which the mock does not
    // model — see seed.ts).
    const rawTagIds = a['tagIds'] as string[] | null | undefined
    const tagFilter = rawTagIds && rawTagIds.length > 0 ? new Set(rawTagIds) : null
    // MAINT-226 — honour `scope: SpaceScope` (mirrors `list_page_links_inner`).
    // Both endpoints of an edge must live in the active space; global is
    // unfiltered. Matches the backend's `b1.space = ?` AND `b2.space = ?`
    // join predicate.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const pageSpace = (pid: string): string | null =>
      (properties.get(pid)?.get('space')?.['value_ref'] as string | null) ?? null
    const LINK_RE_PL = /\[\[([0-9A-Z]{26})\]\]/g
    const linkSet = new Set<string>()
    const pageLinks: Array<{ source_id: string; target_id: string }> = []
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
      for (const m of content.matchAll(LINK_RE_PL)) {
        const targetPageId = m[1] as string
        // Ensure target is an existing non-deleted page
        const targetBlock = blocks.get(targetPageId)
        if (!targetBlock || targetBlock['block_type'] !== 'page' || targetBlock['deleted_at'])
          continue
        // MAINT-226 — active-scope filter on target page (mirrors the
        // backend's `b2.space = ?` predicate).
        if (spaceId !== null && pageSpace(targetPageId) !== spaceId) continue
        // PEND-35 Tier 4.5 — apply target-side tag filter.
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
          pageLinks.push({ source_id: parentId, target_id: targetPageId })
        }
      }
    }
    return pageLinks
  },

  // ---------------------------------------------------------------------------
  // Logging commands (fire-and-forget)
  // ---------------------------------------------------------------------------

  log_frontend: returnNull,
  get_log_dir: () => '/mock/logs',

  // ---------------------------------------------------------------------------
  // Bug report (FEAT-5)
  // ---------------------------------------------------------------------------

  collect_bug_report_metadata: () => ({
    app_version: '0.1.0',
    os: 'mock',
    arch: 'mock',
    device_id: 'mock-device-id',
    recent_errors: [],
  }),

  read_logs_for_report: () => [],

  // ---------------------------------------------------------------------------
  // Op log compaction commands
  // ---------------------------------------------------------------------------

  get_compaction_status: () => ({
    total_ops: opLog.length,
    oldest_op_date: opLog.length > 0 ? (opLog[0]?.created_at ?? null) : null,
    eligible_ops: 0,
    retention_days: 90,
  }),

  compact_op_log_cmd: () => ({ snapshot_id: null, ops_deleted: 0 }),

  // ---------------------------------------------------------------------------
  // Point-in-time restore
  // ---------------------------------------------------------------------------

  restore_page_to_op: () => ({
    ops_reverted: 0,
    non_reversible_skipped: 0,
    results: [],
  }),

  // ---------------------------------------------------------------------------
  // Link metadata
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
  // MCP read-only / read-write servers (FEAT-4) — MAINT-160
  //
  // The real backend manages a Unix-domain-socket lifecycle that can't run
  // inside Playwright. The mock returns disabled status snapshots so
  // AgentAccessSettingsTab renders its toggles + socket-path readouts
  // without per-call stubbing. Toggle commands echo the requested value;
  // disconnect commands return `null` since they have no observable
  // effect on the mock state.
  // ---------------------------------------------------------------------------

  get_mcp_status: () => ({
    enabled: false,
    socket_path: '/mock/agaric-mcp-ro.sock',
    active_connections: 0,
  }),

  get_mcp_socket_path: () => '/mock/agaric-mcp-ro.sock',

  mcp_set_enabled: (args) => {
    const a = args as Record<string, unknown>
    return (a['enabled'] as boolean) ?? false
  },

  mcp_disconnect_all: returnNull,

  // #695 — activity-ring read surface. The mock server has no agent
  // traffic, so the recent-activity feed is always empty.
  get_mcp_recent_activity: () => [],

  get_mcp_rw_status: () => ({
    enabled: false,
    socket_path: '/mock/agaric-mcp-rw.sock',
    active_connections: 0,
  }),

  get_mcp_rw_socket_path: () => '/mock/agaric-mcp-rw.sock',

  mcp_rw_set_enabled: (args) => {
    const a = args as Record<string, unknown>
    return (a['enabled'] as boolean) ?? false
  },

  mcp_rw_disconnect_all: returnNull,

  // ---------------------------------------------------------------------------
  // Trash descendant counts (MAINT-160)
  //
  // Returns a map of root_id → number of cascade-deleted descendants.
  //
  // ── Semantic divergence from the Rust backend ─────────────────────────
  // The Rust impl in `src-tauri/src/commands/blocks/queries.rs`
  // (`trash_descendant_counts_inner` → `pagination::trash_descendant_counts`)
  // uses a SQL JOIN on the root's `deleted_at` timestamp, so it counts
  // only blocks deleted in the *same cascade-batch* as the root.
  //
  // The mock here counts ALL soft-deleted descendants of the root via a
  // BFS over `parent_id`, regardless of *when* they were deleted.
  //
  // For the current Playwright e2e seed-data flows the two converge,
  // because the seed deletes whole subtrees in a single batch. Revisit
  // this if a Playwright spec ever creates mixed-batch trash state
  // (e.g. partial restore-then-redelete) — at that point the mock will
  // need to track and join on `deleted_at` like the Rust impl.
  // ---------------------------------------------------------------------------

  trash_descendant_counts: (args) => {
    const a = args as Record<string, unknown>
    const rootIds = (a['rootIds'] as string[]) ?? []
    const result: Record<string, number> = {}
    for (const rootId of rootIds) {
      let count = 0
      const queue: string[] = [rootId]
      const seen = new Set<string>([rootId])
      while (queue.length > 0) {
        const parent = queue.shift() as string
        for (const b of blocks.values()) {
          const id = b['id'] as string
          if (seen.has(id)) continue
          if (b['parent_id'] !== parent) continue
          seen.add(id)
          if (b['deleted_at']) count++
          queue.push(id)
        }
      }
      result[rootId] = count
    }
    return result
  },

  // ---------------------------------------------------------------------------
  // PEND-35 Tier 2.3 — get_blocks batch endpoint
  // ---------------------------------------------------------------------------

  // get_blocks(ids: string[]) -> BlockRow[]
  //
  // Mirrors `commands/blocks/queries.rs::get_blocks_inner`: returns the
  // full BlockRow for every id present in the seed (NOT filtered by
  // soft-delete). Missing ids are silently omitted so callers map by id.
  get_blocks: (args) => {
    const a = args as Record<string, unknown>
    const ids = (a['ids'] as string[]) ?? []
    if (ids.length === 0) {
      throw new Error('ids list cannot be empty')
    }
    const out: Record<string, unknown>[] = []
    for (const id of ids) {
      const row = blocks.get(id)
      if (row) out.push(row)
    }
    return out
  },

  // ---------------------------------------------------------------------------
  // First-child-per-parent batch (PEND-35 Tier 2.8)
  //
  // Mirrors `commands/blocks/queries.rs::first_child_for_blocks_inner`:
  // returns a map of `parentId → first BlockRow` ordered by
  // `(position ASC, id ASC)`. Soft-deleted children are filtered out so
  // the value is always a live block. Parents with no active children
  // are omitted from the record.
  // ---------------------------------------------------------------------------

  first_child_for_blocks: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = (a['blockIds'] as string[]) ?? []
    const parentSet = new Set(blockIds)
    const result: Record<string, unknown> = {}
    // Group children by parent_id, then pick the first by (position, id).
    const grouped = new Map<string, Record<string, unknown>[]>()
    for (const b of blocks.values()) {
      const parent = b['parent_id'] as string | null | undefined
      if (parent == null) continue
      if (!parentSet.has(parent)) continue
      if (b['deleted_at']) continue
      const bucket = grouped.get(parent) ?? []
      bucket.push(b)
      grouped.set(parent, bucket)
    }
    for (const [parent, children] of grouped) {
      children.sort((x, y) => {
        const px = (x['position'] as number | null) ?? 0
        const py = (y['position'] as number | null) ?? 0
        if (px !== py) return px - py
        const idX = x['id'] as string
        const idY = y['id'] as string
        return idX.localeCompare(idY)
      })
      const first = children[0]
      if (first) result[parent] = first
    }
    return result
  },

  // ---------------------------------------------------------------------------
  // Quick capture (FEAT-12) — MAINT-160
  //
  // Creates a content block under today's daily page in the requested
  // space and returns the new BlockRow. The mock uses the seeded
  // `PAGE_DAILY` as the parent when available so the new block shows up
  // in the daily-page list_blocks query like the real backend would.
  // ---------------------------------------------------------------------------

  quick_capture_block: (args) => {
    const a = args as Record<string, unknown>
    const content = (a['content'] as string) ?? ''
    // Prefer today's daily page as the parent so the captured block
    // shows up where the UI expects it.  Fall back to the supplied
    // spaceId if the daily page is missing for any reason.
    const todayIso = new Date().toISOString().slice(0, 10)
    let parentId: string | null = null
    for (const b of blocks.values()) {
      if (b['block_type'] === 'page' && b['content'] === todayIso) {
        parentId = b['id'] as string
        break
      }
    }
    if (parentId == null) {
      parentId = (a['spaceId'] as string | null) ?? null
    }
    const id = fakeId()
    const siblings = [...blocks.values()].filter(
      (b) => b['parent_id'] === parentId && !b['deleted_at'],
    )
    const position = siblings.length
    const row = {
      id,
      block_type: 'content',
      content,
      parent_id: parentId,
      page_id: parentId,
      position,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    pushOp('create_block', {
      block_id: id,
      content,
      parent_id: parentId,
      block_type: 'content',
      position,
    })
    return row
  },
}

// ---------------------------------------------------------------------------
// Plugin commands (`plugin:<name>|<command>`) — #760
// ---------------------------------------------------------------------------
//
// `mockIPC` routes EVERY invoke through `dispatch`, including the
// `plugin:*`-prefixed commands emitted by the `@tauri-apps/plugin-*` JS
// APIs. The real runtime REJECTS an invoke against an unregistered
// plugin ("plugin <name> not found"), so the mock must not silently
// resolve `null` for them — that response is neither a desktop success
// nor a mobile rejection, and it left the designed degradation branches
// (AutostartRow's rejection→hide, `ensureNotificationPermission`'s
// catch→`false`) unexercised in browser dev / Playwright.
//
// The map below is the explicit allowlist of plugin commands the mock
// DOES model — plugins that are registered unconditionally in
// `src-tauri/src/lib.rs` (or are part of Tauri core) and whose success
// response the browser harness depends on. Everything else
// `plugin:`-prefixed throws from `dispatch`, mirroring the real
// runtime's rejection so callers exercise their catch paths.
//
// Deliberately NOT modeled (the rejection IS the designed behavior):
//   - `plugin:autostart|*` — AutostartRow hides the row on rejection
//     (mobile / browser-dev path; see `src/components/settings/AutostartRow.tsx`).
//   - `plugin:notification|*` — `ensureNotificationPermission` resolves
//     `false` when the plugin is unavailable.
//   - `plugin:updater|*` — `runUpdateCheckInner` logs and bails; a `null`
//     response would instead fake a successful "no update" round-trip.
//   - `plugin:process|*` — `relaunchApp` degrades to
//     `window.location.reload()`, the correct browser-mode analog.

/** Monotonic id for `plugin:event|listen` — the real handler returns an event id. */
let nextEventListenerId = 1

export const PLUGIN_HANDLERS: Record<string, Handler> = {
  // Core event system — `listen()` / `emit()` from `@tauri-apps/api/event`
  // back every frontend event hook; the real runtime always has them.
  'plugin:event|listen': () => nextEventListenerId++,
  'plugin:event|unlisten': returnNull,
  'plugin:event|emit': returnNull,
  'plugin:event|emit_to': returnNull,
  // Core app plugin — `addPluginListener('app', 'back-button', …)` in
  // `useAndroidBackButton` (allowed by `core:app:default` everywhere).
  'plugin:app|register_listener': returnNull,
  'plugin:app|remove_listener': returnNull,
  // Core window plugin — `setWindowTitle` re-stamps the OS title on every
  // space switch.
  'plugin:window|set_title': returnNull,
  // Deep-link is registered on desktop AND mobile; `null` is the real
  // "launched normally, no pending URL" response for `getCurrent()`.
  'plugin:deep-link|get_current': returnNull,
  // Clipboard / opener / shell are registered on desktop AND mobile;
  // copy-link and external-link e2e flows rely on the success path.
  'plugin:clipboard-manager|write_text': clipboardWriteText,
  'plugin:clipboard-manager|read_text': clipboardReadText,
  'plugin:shell|open': returnNull,
  'plugin:opener|open_url': returnNull,
  // Global-shortcut is desktop-only but the browser harness emulates a
  // desktop UA, where registration succeeds — modeling success keeps the
  // Settings quick-capture chord probe (`QuickCaptureRow`) usable in
  // browser dev.
  'plugin:global-shortcut|register': returnNull,
  'plugin:global-shortcut|unregister': returnNull,
  'plugin:global-shortcut|is_registered': () => false,
}

/**
 * Dispatch an IPC command to its handler.
 *
 * Resolution order:
 *  1. `HANDLERS` — the mocked app-command surface (parity-checked against
 *     `src/lib/bindings.ts` by `scripts/check-tauri-mock-parity.mjs`).
 *  2. `PLUGIN_HANDLERS` — explicitly modeled `plugin:*` commands.
 *  3. Any other `plugin:*` command THROWS, mirroring the real runtime's
 *     "plugin <name> not found" rejection for unregistered plugins (#760).
 *  4. Any other unknown command logs a warning via the structured logger
 *     and returns `null` (mock-drift signal, FE-H-13).
 */
export function dispatch(cmd: string, args: unknown): unknown {
  const handler = HANDLERS[cmd] ?? PLUGIN_HANDLERS[cmd]
  if (!handler) {
    if (cmd.startsWith('plugin:')) {
      const pluginName = cmd.slice('plugin:'.length).split('|')[0] ?? cmd
      logger.warn('TauriMock', 'unmodeled plugin command — rejecting like the real runtime', {
        command: cmd,
      })
      throw new Error(`plugin ${pluginName} not found`)
    }
    logger.warn('TauriMock', 'unhandled command', { command: cmd })
    return null
  }
  return handler(args)
}
