/**
 * Tauri mock handlers -- Tag attach/detach and tag/tag-expr queries.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import {
  type TagExprNode,
  type TypedHandlers,
  refInclusiveTags,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blockTags, blocks, properties, pushOp } from '@/lib/tauri-mock/seed'

// ---------------------------------------------------------------------------
// #3871 — tag inheritance (`block_tag_inherited`)
// ---------------------------------------------------------------------------

/**
 * Backend `BLOCK_TAG_CAP` (`tag_query::query`) — the typeahead insurance cap
 * both tag readers truncate their row list at.
 */
const BLOCK_TAG_CAP = 1000

/**
 * How far above a block a tag-bearing ancestor may sit and still propagate to
 * it, mirroring `MAX_TAG_INHERITANCE_DEPTH` (= 100) as the backend's recursive
 * CTEs actually apply it. Derivation, from `tag_inh_descendant_tags_full!()`:
 * the seed emits `depth = 0` rows for the tagged block's CHILDREN (distance 1),
 * and the recursive member extends a `depth = k` row only `WHILE k < 100`, so
 * the deepest row it can emit is `depth = 100` — distance 101. A chain longer
 * than that stops propagating rather than recursing forever on a corrupted
 * `parent_id` cycle.
 */
const MAX_INHERITED_ANCESTOR_DISTANCE = 101

/** Backend `MAX_TAGS_PREFIX` (`tag_query::query`): the validated prefix-scan page. */
const MAX_TAGS_PREFIX = 200

interface TagCacheRow {
  tag_id: string
  name: string
  usage_count: number
  updated_at: string
}

/**
 * What `tags_cache` holds, in `ORDER BY name` — SQLite's BINARY collation, so
 * a plain code-unit compare (`Zed` before `apple`). One row per live tag block
 * with content (`DESIRED_TAGS_SQL`); `usage_count` is the number of LIVE
 * holders. The backend also de-duplicates the cache by normalized name and
 * folds `block_tag_refs` into the count; the mock never populates refs, and
 * no fixture seeds two tags that share a fold, so neither is modelled here.
 */
function tagCacheRows(): TagCacheRow[] {
  const usage = new Map<string, number>()
  for (const [holder, tagIds] of blockTags) {
    if (blocks.get(holder)?.['deleted_at']) continue
    for (const tagId of tagIds) usage.set(tagId, (usage.get(tagId) ?? 0) + 1)
  }
  const rows: TagCacheRow[] = []
  for (const b of blocks.values()) {
    if (b['block_type'] !== 'tag' || b['deleted_at'] || b['content'] == null) continue
    const tagId = b['id'] as string
    rows.push({
      tag_id: tagId,
      name: b['content'] as string,
      usage_count: usage.get(tagId) ?? 0,
      updated_at: new Date().toISOString(),
    })
  }
  rows.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  return rows
}

/**
 * The inherited tag ids of `blockId`, DERIVED from the current block tree and
 * `blockTags` rather than cached.
 *
 * ## Why derive instead of maintaining a table
 *
 * The backend keeps `block_tag_inherited` as a materialised CACHE, updated
 * incrementally by `apply_op_tag_inheritance` on five op types (AddTag,
 * RemoveTag, CreateBlock, DeleteBlock, MoveBlock/RestoreBlock) and periodically
 * recomputed from scratch by `tag_inheritance::rebuild_all`. Mirroring the five
 * incremental hooks in the mock would mean five more places to keep in sync,
 * each able to drift on its own; deriving at READ time makes the answer a pure
 * function of state the mock already models, so no mock mutation can leave it
 * stale and there is no cache to invalidate.
 *
 * The relation implemented here is `rebuild_all`'s — the backend's own
 * ground-truth definition of what the cache should contain. The backend used
 * to be INTERNALLY inconsistent about one case, so this mock had to pick a
 * side: for a block holding a tag both directly and by inheritance,
 * `rebuild_all` kept the inherited row while the incremental maintainers
 * excluded it. #3876 settled that on the KEEP semantics implemented here and
 * converged `recompute_subtree_inheritance` (move/restore) onto it; #3923 did
 * the same for `remove_inherited_tag` (RemoveTag). So a fixture exercising
 * "direct + inherited, then move/remove" now agrees on both stacks, and a
 * divergence there is a real bug rather than a known backend disagreement.
 *
 *   `(B, T)` is inherited iff some STRICT ancestor `A` of `B` holds `T`
 *   directly in `block_tags`, where `A`, `B` and every block between them is
 *   active (`deleted_at IS NULL`).
 *
 * Hence the walk below stops at the first deleted ancestor: the backend's
 * recursion joins active rows only, so a tombstoned block breaks the chain for
 * everything above it as well as for itself.
 */
function inheritedTagIds(blockId: string): string[] {
  const self = blocks.get(blockId)
  // A tombstoned (or absent) block holds no inherited rows: the backend's walk
  // only ever emits rows for an active descendant.
  if (!self || self['deleted_at']) return []

  const out = new Set<string>()
  const seen = new Set<string>([blockId])
  let cursor = (self['parent_id'] as string | null) ?? null
  for (
    let distance = 1;
    cursor != null && distance <= MAX_INHERITED_ANCESTOR_DISTANCE;
    distance++
  ) {
    // Cycle guard — NOT equivalent to the backend's depth bound, and the
    // difference is observable on corrupt data. The CTE has no `seen` set: it
    // walks a cycle round and round, emitting a row each pass, and only stops
    // at `depth = 100`. So on `A.parent = B, B.parent = A` with A holding T
    // directly, the seed emits `(B, T, depth 0)` and the recursion then emits
    // `(A, T, depth 1)` — A inherits its OWN tag — where this walk revisits A,
    // breaks, and answers nothing for it. (B agrees on both stacks.)
    //
    // Reachable only through a `parent_id` cycle, which the block tree forbids
    // and no mock mutation path can create, so it is documented rather than
    // mirrored: reproducing it would mean walking a cycle 101 times to stay
    // bug-compatible with a bound that exists purely to stop the recursion.
    //
    // Recorded because this guard has already eaten one falsification attempt
    // during the #3871 work: a cycle was introduced to try to make the derived
    // walk disagree with the cache, the guard swallowed it, the walk returned
    // `[]`, and the test PASSED — reading as protection when it was silence. A
    // conformance fixture cannot restore the check either: the fixture seed
    // inserts through the engine, which will not accept a cycle.
    if (seen.has(cursor)) break
    seen.add(cursor)
    const ancestor = blocks.get(cursor)
    // Chain broken — a missing or deleted ancestor stops propagation from
    // ITSELF and from everything above it (see the doc comment).
    if (!ancestor || ancestor['deleted_at']) break
    for (const tagId of blockTags.get(cursor) ?? []) out.add(tagId)
    cursor = (ancestor['parent_id'] as string | null) ?? null
  }

  // `ORDER BY tag_id` + the shared `BLOCK_TAG_CAP` truncation, exactly as
  // `list_tags_for_block` (#3873) — the backend applies the identical
  // `ORDER BY tag_id LIMIT 1001` + `truncate(1000)` to both readers, so both
  // mock readers apply it too.
  return [...out].toSorted().slice(0, BLOCK_TAG_CAP)
}

/**
 * Faithful twin of `tag_query::eval_tag_query` (#3827). A block holds a tag
 * through `block_tags`, through a content ref (`block_tag_refs`, which the
 * mock does not populate) and, with `includeInherited`, through
 * `block_tag_inherited`. `Prefix` resolves through `tags_cache`, i.e. only
 * `block_type = 'tag'` blocks with content, matched case-insensitively.
 * `Not` is the complement over EVERY live block — pages and tag blocks
 * included — because it compiles to `b.id NOT IN (<inner>)`. The projection
 * applies the space scope and `blockType`, then orders `b.id ASC`.
 */
function evalTagQuery(
  expr: TagExprNode,
  a: Record<string, unknown>,
): { items: Record<string, unknown>[]; next_cursor: null; has_more: false; total_count: null } {
  const includeInherited = Boolean(a['includeInherited'])
  const blockType = (a['blockType'] as string | null) ?? null
  const scope = a['scope'] as { kind: string; space_id?: string } | undefined
  const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

  const prefixTagIds = (prefix: string): Set<string> => {
    const lp = prefix.toLowerCase()
    const ids = new Set<string>()
    for (const [, b] of blocks) {
      if (
        b['block_type'] === 'tag' &&
        !b['deleted_at'] &&
        typeof b['content'] === 'string' &&
        (b['content'] as string).toLowerCase().startsWith(lp)
      ) {
        ids.add(b['id'] as string)
      }
    }
    return ids
  }
  const tagsOf = (blockId: string): Set<string> => {
    const held = refInclusiveTags(blockId)
    if (!includeInherited) return held
    const all = new Set(held)
    for (const t of inheritedTagIds(blockId)) all.add(t)
    return all
  }
  const matches = (blockId: string, node: TagExprNode): boolean => {
    switch (node.type) {
      case 'Tag': {
        return tagsOf(blockId).has(node.value)
      }
      case 'Prefix': {
        const wanted = prefixTagIds(node.value)
        for (const t of tagsOf(blockId)) if (wanted.has(t)) return true
        return false
      }
      case 'And': {
        // `And([])` resolves to the EMPTY set on the backend, not to every block.
        return node.value.length > 0 && node.value.every((child) => matches(blockId, child))
      }
      case 'Or': {
        return node.value.some((child) => matches(blockId, child))
      }
      case 'Not': {
        return !matches(blockId, node.value)
      }
    }
  }

  const items = [...blocks.values()].filter((b) => {
    if (b['deleted_at']) return false
    if (blockType !== null && b['block_type'] !== blockType) return false
    if (spaceId !== null) {
      const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
      const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
      if (ownerSpace !== spaceId) return false
    }
    return matches(b['id'] as string, expr)
  })
  items.sort((x, y) => String(x['id']).localeCompare(String(y['id'])))
  return { items, next_cursor: null, has_more: false, total_count: null }
}

export const tagsHandlers = {
  add_tag: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const tagId = a['tagId'] as string
    // #2468 — duplicate add: the REAL `add_tag` command REJECTS it
    // (`InvalidOperation("tag already applied")`, `add_tag_inner`). The mock
    // stays lenient because the `tag_add_remove` conformance fixture drives
    // the backend's op-APPLY pipeline (which logs the duplicate op for LWW
    // convergence, #622/#709) through this one command surface. On that
    // mock-only lenient path the `WithOps<TagResponse>` response carries
    // EMPTY `op_refs`: reversing the duplicate would remove an edge an
    // earlier op also added, so it is not an undoable ref and the FE must
    // not push an undo entry for it.
    const alreadyAttached = blockTags.get(blockId)?.has(tagId) ?? false
    if (!blockTags.has(blockId)) blockTags.set(blockId, new Set())
    blockTags.get(blockId)?.add(tagId)
    const op = pushOp('add_tag', { block_id: blockId, tag_id: tagId })
    return {
      block_id: blockId,
      tag_id: tagId,
      op_refs: alreadyAttached ? [] : [{ device_id: op.device_id, seq: op.seq }],
    }
  },

  remove_tag: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const tagId = a['tagId'] as string
    // #2468 — unattached remove: the REAL `remove_tag` command REJECTS it
    // (`NotFound("tag association")`, `remove_tag_inner`); the mock stays
    // lenient (see add_tag — conformance-fixture constraint) and surfaces no
    // undoable ref on that mock-only path.
    const wasAttached = blockTags.get(blockId)?.has(tagId) ?? false
    blockTags.get(blockId)?.delete(tagId)
    const op = pushOp('remove_tag', { block_id: blockId, tag_id: tagId })
    return {
      block_id: blockId,
      tag_id: tagId,
      op_refs: wasAttached ? [{ device_id: op.device_id, seq: op.seq }] : [],
    }
  },

  // #81 / bulk add one tag to N blocks. Lenient skip of
  // missing / deleted / self / already-tagged; returns the count newly tagged.
  add_tags_by_ids: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    const tagId = a['tagId'] as string
    if (inputIds.length === 0) {
      throw validationRejection('block_ids list cannot be empty')
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

  // `query_by_tags` is `query_by_tag_expr` with the expression built the way
  // `query_by_tags_inner` builds it: every tag id a `Tag` leaf, every prefix a
  // `Prefix` leaf, then `and` → `And`, `not` → `Not(Or(...))`, anything else
  // → `Or`; no leaves at all short-circuits to an empty page.
  query_by_tags: (args) => {
    const a = args as Record<string, unknown>
    const leaves: TagExprNode[] = [
      ...((a['tagIds'] as string[] | null) ?? []).map((value): TagExprNode => ({
        type: 'Tag',
        value,
      })),
      ...((a['prefixes'] as string[] | null) ?? []).map((value): TagExprNode => ({
        type: 'Prefix',
        value,
      })),
    ]
    if (leaves.length === 0) {
      return { items: [], next_cursor: null, has_more: false, total_count: null }
    }
    const mode = (a['mode'] as string) ?? 'or'
    const expr: TagExprNode =
      mode === 'and'
        ? { type: 'And', value: leaves }
        : mode === 'not'
          ? { type: 'Not', value: { type: 'Or', value: leaves } }
          : { type: 'Or', value: leaves }
    return evalTagQuery(expr, a)
  },

  // #1472 — nested boolean tag expression `(A AND B) OR (NOT C)` over IPC.
  query_by_tag_expr: (args) => {
    const a = args as Record<string, unknown>
    return evalTagQuery(a['expr'] as TagExprNode, a)
  },

  // `tags_cache` prefix scan: `name LIKE ?1 ESCAPE '\\' ORDER BY name LIMIT ?2`
  // (`tag_query::list_tags_by_prefix`). LIKE folds ASCII case, the prefix is
  // a literal (`escape_like`), the limit is validated to `[1, MAX_TAGS_PREFIX]`
  // and defaults to the cap, and #768 splices the exact (case-insensitive)
  // match into name order when the LIMIT page left it out.
  list_tags_by_prefix: (args) => {
    const a = args as Record<string, unknown>
    const prefix = (a['prefix'] as string | undefined) ?? ''
    const limit = (a['limit'] as number | null | undefined) ?? null
    if (limit !== null && (limit < 1 || limit > MAX_TAGS_PREFIX)) {
      throw validationRejection(
        `list_tags_by_prefix limit must be in [1, ${MAX_TAGS_PREFIX}]; got ${limit}`,
      )
    }
    const effectiveLimit = limit ?? MAX_TAGS_PREFIX
    const folded = prefix.toLowerCase()
    const cache = tagCacheRows()
    const rows = cache
      .filter((r) => r.name.toLowerCase().startsWith(folded))
      .slice(0, effectiveLimit)
    if (prefix !== '') {
      // `cache` is in BINARY name order, so the first fold-equal row is the
      // one `exact_match_nocase`'s `ORDER BY name LIMIT 1` picks.
      const exact = cache.find((r) => r.name.toLowerCase() === folded)
      if (exact && !rows.some((r) => r.tag_id === exact.tag_id)) {
        if (rows.length >= effectiveLimit) rows.pop()
        const at = rows.findIndex((r) => r.name >= exact.name)
        rows.splice(at === -1 ? rows.length : at, 0, exact)
      }
    }
    return rows
  },

  // Every tag in the given space, `ORDER BY tc.name`. No pagination, no
  // clamp; bounded by the space's intrinsic tag count. #3081 — the space
  // filter is the tag block's own `blocks.space_id` column (the SOLE source
  // of truth since #533), NOT a retired `block_properties(key='space')` row;
  // the atomic create-tag path stamps it directly, so a freshly created tag
  // is returned here immediately and durably. A `Global` scope is refused as
  // `require_active` refuses it.
  list_all_tags_in_space: (args) => {
    const a = args as Record<string, unknown>
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    if (scope?.kind !== 'active' || !scope.space_id) {
      throw validationRejection('list_all_tags_in_space requires an active space scope')
    }
    const spaceId = scope.space_id
    return tagCacheRows().filter((r) => blocks.get(r.tag_id)?.['space_id'] === spaceId)
  },

  // #3873 — `ORDER BY tag_id`, not insertion order. `blockTags` is a `Set`, so
  // spreading it yields the order the `add_tag` ops ran, where the backend
  // (`tag_query::list_tags_for_block`) sorts. Tag ids are ULIDs (uppercase
  // base32), so a plain lexical sort matches SQLite's BINARY collation.
  //
  // The `BLOCK_TAG_CAP` truncation is the same statement's `LIMIT 1001` +
  // `rows.truncate(1000)`. The backend applies it to BOTH tag readers, so this
  // one caps as well as `list_inherited_tags_for_block` does — the mock used to
  // cap only the inherited reader while claiming the readers shared the rule.
  list_tags_for_block: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const tagSet = blockTags.get(blockId)
    if (!tagSet || tagSet.size === 0) return []
    return [...tagSet].toSorted().slice(0, BLOCK_TAG_CAP)
  },

  // #1423 / #3871 — inherited (DERIVED) tag ids, computed from the parent
  // chain by {@link inheritedTagIds}. Returns ONLY inherited tags: a direct tag
  // the block itself holds is `list_tags_for_block`'s answer, not this one
  // (the #1423 disjointness contract) — but a tag held BOTH directly and by an
  // ancestor appears in BOTH lists, and nothing here suppresses that: the walk
  // starts at the block's PARENT and only ever reads ancestors' direct tags, so
  // the block's own `block_tags` row is never consulted either to add or to
  // subtract. (An earlier version of this comment described a "filter below" on
  // the ancestor's direct tags; there is no filter — the starting point is the
  // whole mechanism.)
  list_inherited_tags_for_block: (args) => {
    const a = args as Record<string, unknown>
    return inheritedTagIds(a['blockId'] as string)
  },
} satisfies Pick<
  TypedHandlers,
  | 'add_tag'
  | 'remove_tag'
  | 'add_tags_by_ids'
  | 'query_by_tags'
  | 'query_by_tag_expr'
  | 'list_tags_by_prefix'
  | 'list_all_tags_in_space'
  | 'list_tags_for_block'
  | 'list_inherited_tags_for_block'
>
