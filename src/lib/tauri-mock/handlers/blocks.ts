/**
 * Tauri mock handlers -- Block CRUD, listing, move/restore/purge.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import {
  type TypedHandlers,
  insertAtSlotAndRenumber,
  nextCohortMarker,
  notFoundRejection,
  refreshDescendantPageIds,
  renumberSiblings,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import {
  attachments,
  blockTags,
  blocks,
  fakeId,
  pageAliases,
  properties,
  pushOp,
} from '@/lib/tauri-mock/seed'

export const blocksHandlers = {
  list_blocks: (args) => {
    const a = args as Record<string, unknown>
    // #2277 item 7 — every list_blocks query param now nests under the
    // single `request` DTO (the agenda knobs flatten in as `date` /
    // `dateRange` / `source`); `scope` stays a separate top-level arg.
    const req = (a['request'] as Record<string, unknown>) ?? a
    let items: Record<string, unknown>[] = [...blocks.values()].filter(
      (b) => !(b['deleted_at'] as string | null),
    )
    if (req['blockType']) items = items.filter((b) => b['block_type'] === req['blockType'])
    if (req['parentId']) items = items.filter((b) => b['parent_id'] === req['parentId'])
    // Tag filtering
    if (req['tagId']) {
      const tagId = req['tagId'] as string
      items = items.filter((b) => {
        const tags = blockTags.get(b['id'] as string)
        return tags?.has(tagId) ?? false
      })
    }
    // Agenda date filtering — matches blocks by due_date or scheduled_date
    if (req['date']) {
      const dateStr = req['date'] as string
      const source = (req['source'] as string | null) ?? null
      if (source === 'column:due_date') {
        items = items.filter((b) => b['due_date'] === dateStr)
      } else if (source === 'column:scheduled_date') {
        items = items.filter((b) => b['scheduled_date'] === dateStr)
      } else {
        items = items.filter((b) => b['due_date'] === dateStr || b['scheduled_date'] === dateStr)
      }
    }
    // Agenda date range filtering — for weekly/monthly views
    if (req['dateRange']) {
      const range = req['dateRange'] as { start: string; end: string }
      const source = (req['source'] as string | null) ?? null
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
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  // Paginate soft-deleted blocks, space-scoped. Mirrors backend
  // `pagination::list_trash` (deleted_at DESC, id ASC).
  list_trash: () => {
    const items = [...blocks.values()].filter((b) => b['deleted_at'])
    items.sort((x, y) => String(y['deleted_at'] ?? '').localeCompare(String(x['deleted_at'] ?? '')))
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  create_block: (args) => {
    const a = args as Record<string, unknown>
    // #2849 PR2 — honor a client-supplied ULID verbatim (the backend uses it as
    // the block id iff well-formed + non-colliding); fall back to a minted id.
    const id = (a['blockId'] as string | null | undefined) ?? fakeId()
    const parentId = (a['parentId'] as string) ?? null
    // `scope: SpaceScope` mirrors the backend
    // `create_block_inner_with_space` semantics: when `kind === 'active'`
    // and the new block is a page, the page is stamped with
    // `space = ?space_id` so subsequent space-filtered queries (backlink
    // counts, alias resolution, etc.) recognise it as belonging to that
    // space. Global scope skips the stamp (legacy unscoped behaviour).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const blockType = a['blockType'] as string
    // #763 — the block's `page_id` is the ROOT page of the parent chain, not the
    // immediate parent. The backend resolves the parent's own `page_id` (which,
    // for a content parent, already holds the root page; for a page parent, is
    // its own id). Stamping the raw `parentId` mis-set `page_id` to a content
    // parent — the same class as the #1775 seed-loader / move-handler fix.
    const createParent = parentId != null ? blocks.get(parentId) : null
    const createPageId =
      blockType === 'page'
        ? id
        : createParent == null
          ? null
          : createParent['block_type'] === 'page'
            ? parentId
            : ((createParent['page_id'] as string | null) ?? null)
    const row = {
      id,
      block_type: blockType,
      content: (a['content'] as string) ?? null,
      parent_id: parentId,
      page_id: createPageId,
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
    const op = pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: parentId,
      block_type: row.block_type,
      position,
    })
    // #2468 — `WithOps<BlockRow>`: echo the appended op's ref so FE tests
    // exercise undo-ref capture. Spread copy: the stored block row must not
    // grow an `op_refs` field (list_blocks & co. return the stored rows).
    return { ...row, op_refs: [{ device_id: op.device_id, seq: op.seq }] }
  },

  // Atomic batch-create. Mirrors the existing
  // `create_block` mock once per input spec, plus a `set_property` op
  // per (key, value) pair in the spec's `properties` map. The real
  // backend wraps the whole batch in one IMMEDIATE transaction; the
  // mock here is sequential (good enough for the FE shape — atomicity
  // is exercised by the Rust tests). Returns the created BlockRows in
  // INPUT ORDER so callers can map template-line index → block id.
  create_blocks_batch: (args) => {
    const a = args as Record<string, unknown>
    const specs = (a['specs'] as Array<Record<string, unknown>>) ?? []
    if (specs.length === 0) {
      throw validationRejection('specs list cannot be empty')
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
      // #763 — root-page `page_id` resolution (see `create_block` above): use
      // the parent's own `page_id`, not the immediate parent id.
      const batchParent = parentId != null ? blocks.get(parentId) : null
      const batchPageId =
        blockType === 'page'
          ? id
          : batchParent == null
            ? null
            : batchParent['block_type'] === 'page'
              ? parentId
              : ((batchParent['page_id'] as string | null) ?? null)
      const row: Record<string, unknown> = {
        id,
        block_type: blockType,
        content: (spec['content'] as string) ?? null,
        parent_id: parentId,
        page_id: batchPageId,
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
  // Spaces — Phase 1 / Phase 2
  // ---------------------------------------------------------------------------

  edit_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw notFoundRejection(`block '${a['blockId'] as string}' not found`)
    const oldContent = b['content'] as string | null
    b['content'] = a['toText'] as string
    const op = pushOp('edit_block', {
      block_id: a['blockId'],
      to_text: a['toText'],
      from_text: oldContent,
    })
    // #2468 — `WithOps<BlockRow>` (spread copy — see create_block).
    return { ...b, op_refs: [{ device_id: op.device_id, seq: op.seq }] }
  },

  // #1775 — single-op soft-delete cascade, mirroring the backend's
  // `project_delete_block_to_sql` / `descendants_cte_active`. Tombstone the
  // target AND its whole ACTIVE descendant subtree, stamping the SAME
  // `deleted_at` cohort marker on every block actually tombstoned. The
  // recursive walk only descends into children whose `deleted_at` is NULL
  // (active), so an already-deleted descendant — and the subtree beneath it —
  // is left untouched, exactly like the SQL CTE's `b.deleted_at IS NULL` arm.
  // `descendants_affected` counts the descendants tombstoned (the target
  // itself is excluded, matching the backend's command return).
  delete_block: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const target = blocks.get(blockId)
    const now = nextCohortMarker()
    let descendantsAffected = 0
    // Only cascade for a live target; a missing / already-deleted target is a
    // no-op cascade (mirrors the CTE seed `WHERE deleted_at IS NULL` filter on
    // the UPDATE). The seed row itself is still re-stamped to `now` if live.
    if (target && !target['deleted_at']) {
      // BFS over the ACTIVE descendant subtree. Descend only into children
      // whose `deleted_at` is NULL — an already-deleted descendant boundary
      // (and everything below it) is skipped.
      const stack: string[] = [blockId]
      const seen = new Set<string>()
      while (stack.length > 0) {
        const id = stack.pop()
        if (id == null) break
        if (seen.has(id)) continue
        seen.add(id)
        const node = blocks.get(id)
        if (!node || node['deleted_at']) continue
        node['deleted_at'] = now
        // `descendants_affected` mirrors the backend's `rows_affected()` from
        // the `descendants_cte_active` UPDATE, whose `descendants` CTE includes
        // the SEED (target) at depth 0. So the count is the TOTAL number of
        // rows tombstoned — target INCLUDED — not just the strict descendants.
        // (The field name is the backend's; its value is target-inclusive, as
        // the `snapshot_delete_block_response` fixture proves: a lone block
        // delete returns `descendants_affected: 1`.)
        descendantsAffected++
        for (const child of blocks.values()) {
          if (
            child['parent_id'] === id &&
            !child['deleted_at'] &&
            !seen.has(child['id'] as string)
          ) {
            stack.push(child['id'] as string)
          }
        }
      }
    }
    const op = pushOp('delete_block', { block_id: blockId })
    // #2468 — `WithOps<DeleteResponse>`.
    return {
      block_id: blockId,
      deleted_at: now,
      descendants_affected: descendantsAffected,
      op_refs: [{ device_id: op.device_id, seq: op.seq }],
    }
  },

  // Batch soft-delete (mirror of `delete_block`'s
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
      throw validationRejection('block_ids list cannot be empty')
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

  // #1775 — single-op cohort restore, mirroring the backend's
  // `project_restore_block_to_sql` / `descendants_cte_cohort`. Restore the
  // target AND only the descendants that share the target's `deleted_at`
  // cohort marker (`deleted_at_ref`), reached via a CONTIGUOUS same-cohort
  // walk from the seed. The recursive arm only descends into a child whose
  // `deleted_at` equals the seed's `deleted_at`, so the walk stops at the
  // first boundary block of a DIFFERENT cohort (e.g. an independently-deleted
  // nested subtree) — leaving that descendant deleted, exactly like the SQL
  // cohort CTE. `restored_count` is the number of blocks actually restored.
  restore_block: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const target = blocks.get(blockId)
    const cohort = target?.['deleted_at'] as string | null | undefined
    let restoredCount = 0
    // A live (non-deleted) or missing target yields no cohort to restore.
    if (target && cohort) {
      const stack: string[] = [blockId]
      const seen = new Set<string>()
      while (stack.length > 0) {
        const id = stack.pop()
        if (id == null) break
        if (seen.has(id)) continue
        seen.add(id)
        const node = blocks.get(id)
        // Only same-cohort blocks are restored; a block whose `deleted_at`
        // differs from the seed's marker is a boundary — skip it and the
        // subtree below it (we never enqueue its children).
        if (!node || node['deleted_at'] !== cohort) continue
        node['deleted_at'] = null
        restoredCount++
        for (const child of blocks.values()) {
          if (child['deleted_at'] === cohort && !seen.has(child['id'] as string)) {
            if (child['parent_id'] === id) stack.push(child['id'] as string)
          }
        }
      }
    }
    pushOp('restore_block', { block_id: blockId })
    return { block_id: blockId, restored_count: restoredCount }
  },

  // #3079 — physically erase the ENTIRE subtree, mirroring the backend's
  // `purge_block_inner` → `descendants_cte_purge!()` + `purge_subtree_tables`.
  // The purge CTE has NO `deleted_at` filter, so it sweeps every descendant —
  // active OR tombstoned — and physically deletes each block PLUS its
  // satellite rows (`block_properties`, `block_tags`, …). The old handler only
  // removed the single target from `blocks`, leaking the descendant subtree
  // and every satellite (the same cleanup `purge_blocks_by_ids` already does
  // per id, but WITHOUT the descendant cascade).
  purge_block: (args) => {
    const a = args as Record<string, unknown>
    const rootId = a['blockId'] as string
    // BFS the full descendant subtree via `parent_id` (no `deleted_at`
    // filter — purge erases the whole subtree regardless of tombstone state).
    const cohort: string[] = []
    const stack: string[] = [rootId]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const id = stack.pop()
      if (id == null) break
      if (seen.has(id)) continue
      seen.add(id)
      if (!blocks.has(id)) continue
      cohort.push(id)
      for (const child of blocks.values()) {
        if (child['parent_id'] === id && !seen.has(child['id'] as string)) {
          stack.push(child['id'] as string)
        }
      }
    }
    // Physically delete every block in the cohort plus its satellite state
    // (mirrors `purge_blocks_by_ids`' per-id cleanup, now applied to the whole
    // cascaded subtree).
    for (const id of cohort) {
      blocks.delete(id)
      properties.delete(id)
      blockTags.delete(id)
      attachments.delete(id)
      pageAliases.delete(id)
    }
    pushOp('purge_block', { block_id: rootId })
    return { block_id: rootId, purged_count: cohort.length }
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

  // Single-IPC batch restore. Iterates the input ids,
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

  // Single-IPC batch purge. Iterates the input ids,
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
    if (!b) throw notFoundRejection(`block '${a['blockId'] as string}' not found`)
    return b
  },

  batch_resolve: (args) => {
    const a = args as Record<string, unknown>
    const ids = a['ids'] as string[]
    // Honour `scope: SpaceScope`. Active scope drops blocks
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
    if (!b) throw notFoundRejection(`block '${blockId}' not found`)
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
      .toSorted((x, y) => {
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
    const op = pushOp('move_block', {
      block_id: blockId,
      new_parent_id: newParentId,
      new_position: newPosition,
      old_parent_id: oldParentId,
      old_position: oldPosition,
    })
    // #2468 — `WithOps<MoveResponse>`.
    return {
      block_id: blockId,
      new_parent_id: newParentId,
      new_position: newPosition,
      op_refs: [{ device_id: op.device_id, seq: op.seq }],
    }
  },

  // #2274 — batched multi-select drag reparent/reorder. Contiguous-run semantics
  // (Refs #914 / Closes #2305): the ordered `blockIds` land as ONE contiguous run
  // among `newParentId`'s NON-selected children, at base position `newIndex`
  // (0-based, counted over the non-selected siblings) — a remove-then-splice,
  // matching the Rust backend's engine ground truth. Emits one `move_block` op
  // per block (wire format unchanged) and returns one MoveResponse per moved root
  // in input order. Throws (rolling the whole batch back, mock-side) on an empty
  // list or a missing block. Semantic parity with `move_blocks_batch_inner`
  // (#2463) — keep this splice in lockstep with the backend loop.
  move_blocks_batch: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = (a['blockIds'] as string[]) ?? []
    const newParentId = (a['newParentId'] as string | null) ?? null
    const newIndex = (a['newIndex'] as number) ?? 0
    if (blockIds.length === 0) {
      throw validationRejection('block_ids list cannot be empty')
    }
    const movedSet = new Set(blockIds)
    const cmp = (x: Record<string, unknown>, y: Record<string, unknown>) => {
      const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
      const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
      if (px !== py) return px - py
      return (x['id'] as string).localeCompare(y['id'] as string)
    }
    /** Live children of `parent` in (position, id) order, excluding the moved run. */
    const remainingChildren = (parent: string | null) =>
      [...blocks.values()]
        .filter(
          (s) =>
            ((s['parent_id'] as string | null) ?? null) === parent &&
            !s['deleted_at'] &&
            !movedSet.has(s['id'] as string),
        )
        .toSorted(cmp)
        .map((s) => s['id'] as string)
    // Pre-mutation capture of each moved block's old parent + 1-based slot (for
    // the op breadcrumb); also validates existence up-front (all-or-nothing).
    const oldParentOf = new Map<string, string | null>()
    const oldPositionOf = new Map<string, number>()
    for (const blockId of blockIds) {
      const b = blocks.get(blockId)
      if (!b) throw notFoundRejection(`block '${blockId}' not found`)
      const oldParentId = (b['parent_id'] as string | null) ?? null
      oldParentOf.set(blockId, oldParentId)
      const oldSiblings = [...blocks.values()]
        .filter(
          (s) => ((s['parent_id'] as string | null) ?? null) === oldParentId && !s['deleted_at'],
        )
        .toSorted(cmp)
      oldPositionOf.set(blockId, oldSiblings.findIndex((s) => s['id'] === blockId) + 1)
    }

    // Remove-then-splice: build the destination group and dense-renumber it.
    const base = remainingChildren(newParentId)
    const p = Math.max(0, Math.min(newIndex, base.length))
    const destOrder = [...base.slice(0, p), ...blockIds, ...base.slice(p)]
    for (const blockId of blockIds) {
      const b = blocks.get(blockId) as Record<string, unknown>
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
      refreshDescendantPageIds(blockId)
    }
    destOrder.forEach((id, i) => {
      ;(blocks.get(id) as Record<string, unknown>)['position'] = i + 1
    })
    // Dense-renumber every vacated source group (a parent a moved id left, other
    // than the destination — already renumbered above).
    const sourceParents = new Set<string | null>()
    for (const blockId of blockIds) {
      const from = oldParentOf.get(blockId) ?? null
      if (from !== newParentId) sourceParents.add(from)
    }
    for (const sp of sourceParents) renumberSiblings(sp)

    const out: Array<{ block_id: string; new_parent_id: string | null; new_position: number }> = []
    for (const blockId of blockIds) {
      const newPosition = (blocks.get(blockId) as Record<string, unknown>)['position'] as number
      pushOp('move_block', {
        block_id: blockId,
        new_parent_id: newParentId,
        new_position: newPosition,
        old_parent_id: oldParentOf.get(blockId) ?? null,
        old_position: oldPositionOf.get(blockId) ?? 0,
      })
      out.push({ block_id: blockId, new_parent_id: newParentId, new_position: newPosition })
    }
    return out
  },

  // ---------------------------------------------------------------------------
  // Tag associations
  // ---------------------------------------------------------------------------

  // #81 / bulk move N blocks to a space via the canonical
  // set_property(space) op. Lenient skip of missing / deleted; returns count moved.
  move_blocks_to_space: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    const spaceId = a['spaceId'] as string
    if (inputIds.length === 0) {
      throw validationRejection('block_ids list cannot be empty')
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

  count_trash: (args) => {
    // limit-clamp-followup — dedicated count IPC backing the
    // `useTrashCount` badge.  Mirrors the backend's
    // `count_trash_inner`: count soft-deleted blocks whose owning
    // page carries `space = <space_id>`.  The page-owner resolution
    // is the same `COALESCE(page_id, id)` lookup as
    // `count_backlinks_batch` above.
    // #2248 — the IPC now carries `scope: SpaceScope`. Trash is inherently
    // per-space, so only an `active` scope produces a count; `global` (never
    // sent by the FE for trash) resolves to no space and counts nothing.
    const a = args as Record<string, unknown>
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    if (spaceId == null) return 0
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
  // Get_blocks batch endpoint
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
      throw validationRejection('ids list cannot be empty')
    }
    const out: Record<string, unknown>[] = []
    for (const id of ids) {
      const row = blocks.get(id)
      if (row) out.push(row)
    }
    return out
  },

  // ---------------------------------------------------------------------------
  // First-child-per-parent batch
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
  // Quick capture
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
} satisfies Pick<
  TypedHandlers,
  | 'list_blocks'
  | 'list_trash'
  | 'create_block'
  | 'create_blocks_batch'
  | 'edit_block'
  | 'delete_block'
  | 'delete_blocks_by_ids'
  | 'restore_block'
  | 'purge_block'
  | 'restore_all_deleted'
  | 'purge_all_deleted'
  | 'restore_blocks_by_ids'
  | 'purge_blocks_by_ids'
  | 'get_block'
  | 'batch_resolve'
  | 'move_block'
  | 'move_blocks_batch'
  | 'move_blocks_to_space'
  | 'count_trash'
  | 'trash_descendant_counts'
  | 'get_blocks'
  | 'first_child_for_blocks'
  | 'quick_capture_block'
>
