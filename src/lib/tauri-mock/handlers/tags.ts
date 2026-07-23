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

  query_by_tags: (args) => {
    const a = args as Record<string, unknown>
    const tagIds = (a['tagIds'] as string[]) ?? []
    const prefixes = (a['prefixes'] as string[] | null) ?? []
    const mode = ((a['mode'] as string) ?? 'and').toLowerCase()
    // `blockType` push-down: restrict to a single
    // block_type. `null` / `undefined` keeps the unfiltered behaviour.
    const blockType = (a['blockType'] as string | null) ?? null
    // Honour `scope: SpaceScope` (mirrors `query_by_tags_inner`).
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
      // Ref-inclusive (`block_tags` ∪ `block_tag_refs`), mirroring
      // `query_by_tags_inner`.
      const tags = refInclusiveTags(b['id'] as string)
      if (tags.size === 0) return false
      if (allTagIds.length === 0) return false
      if (mode === 'or') {
        return allTagIds.some((tid) => tags.has(tid))
      }
      // Default: AND — block must have ALL specified tags
      return allTagIds.every((tid) => tags.has(tid))
    })
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  // #1472 — nested boolean tag expression `(A AND B) OR (NOT C)` over IPC.
  // Faithful minimal twin of `query_by_tag_expr_inner` -> `eval_tag_query`:
  // recursively evaluates the adjacently-tagged `TagExpr` tree (the same wire
  // shape specta emits: `{ type, value }`) per non-deleted block. `Not`
  // complements over the visible block universe (matches the backend's
  // set-complement semantics), `Prefix` resolves to tag ids by tag-content
  // prefix. Scope / block_type filtering mirror `query_by_tags` above.
  query_by_tag_expr: (args) => {
    const a = args as Record<string, unknown>
    const expr = a['expr'] as TagExprNode
    const blockType = (a['blockType'] as string | null) ?? null
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    // Resolve a `Prefix` leaf to the set of tag ids whose tag-block content
    // starts with the prefix (case-insensitive), mirroring the SQL LIKE leaf.
    const prefixTagIds = (prefix: string): Set<string> => {
      const lp = prefix.toLowerCase()
      const ids = new Set<string>()
      for (const [, b] of blocks) {
        if (
          b['block_type'] === 'tag' &&
          !b['deleted_at'] &&
          ((b['content'] as string) ?? '').toLowerCase().startsWith(lp)
        ) {
          ids.add(b['id'] as string)
        }
      }
      return ids
    }

    // Does block `blockId` satisfy `node`? Recurses over And/Or/Not.
    const matches = (blockId: string, node: TagExprNode): boolean => {
      const tags = blockTags.get(blockId)
      switch (node.type) {
        case 'Tag': {
          return tags?.has(node.value) ?? false
        }
        case 'Prefix': {
          if (!tags || tags.size === 0) return false
          const wanted = prefixTagIds(node.value)
          for (const t of tags) if (wanted.has(t)) return true
          return false
        }
        case 'And': {
          return node.value.every((child) => matches(blockId, child))
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
    return { items, next_cursor: null, has_more: false, total_count: null }
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
  // the space's intrinsic tag count.  #3081 — mirrors the backend's
  // space-scope filter on the tag block's own `blocks.space_id` column (the
  // SOLE source of truth since #533), NOT a retired `block_properties(key=
  // 'space')` row. The atomic create-tag path stamps `space_id` directly, so
  // a freshly created tag is returned here immediately and durably.
  list_all_tags_in_space: (args) => {
    const a = args as Record<string, unknown>
    // b1 — `scope: SpaceScope`. `global` → null → no-match filter.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const tagRows: Array<{
      tag_id: string
      name: string
      usage_count: number
      updated_at: string
    }> = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'tag') continue
      if (b['deleted_at']) continue
      if ((b['space_id'] as string | null) !== spaceId) continue
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
