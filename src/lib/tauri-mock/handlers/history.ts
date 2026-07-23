/**
 * Tauri mock handlers -- Block/page history, undo/redo, and op-log diff/compaction.
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
  applyUndoForTarget,
  insertAtSlotAndRenumber,
  notFoundRejection,
  refreshDescendantPageIds,
  renumberSiblings,
  resolveUndoTarget,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { applyRevertForOp } from '@/lib/tauri-mock/revert'
import {
  type MockOpLogEntry,
  blockTags,
  blocks,
  opLog,
  properties,
  pushOp,
} from '@/lib/tauri-mock/seed'

export const historyHandlers = {
  get_block_history: (_args) =>
    // The backend now accepts `opTypeFilter`. The
    // mock signature mirrors that for parity with `bindings.ts` (the
    // handlers-drift test only checks that the command name is
    // present, but accepting the arg is the right shape). Browser-mode
    // callers don't currently exercise per-block history end-to-end, so
    // returning an empty page is still the cheapest correct behaviour.
    ({ items: [], next_cursor: null, has_more: false, total_count: null }),

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
      .toReversed()
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
        // #2481 phase 2: foreign audit ops carry is_replicated=1; the mock
        // op log is local-authored unless a row seeds it otherwise.
        is_replicated: (o as { is_replicated?: boolean }).is_replicated ?? false,
      }))
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  // Mirror `find_undo_group_inner` semantics so
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
      .toSorted((a2, b2) => {
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

  // #2190 — batched group-undo. Mirrors `undo_page_group_inner`: size the
  // consecutive same-device, within-window group with the same walk as
  // `find_undo_group`, then apply the per-op reverse newest-first, returning
  // one UndoResult per reverted op. Reuses the sibling handlers so the reverse
  // effects stay identical to the single-op path. Reverse ops carry an `undo_`
  // prefix and are filtered out of the undoable set, so `depth + i` walks the
  // same ops the group spans across the loop.
  undo_page_group: (args) => {
    const a = (args ?? {}) as Record<string, unknown>
    const depth = (a['depth'] as number) ?? 0
    const windowMs = (a['windowMs'] as number) ?? 0
    const findGroup = historyHandlers['find_undo_group']
    const undoOp = historyHandlers['undo_page_op']
    if (!findGroup || !undoOp) {
      // mock-internal invariant (#2463) — `historyHandlers` is malformed if
      // this fires; it has no real-backend counterpart, so it stays a bare
      // Error. (Both siblings live in this same domain module post-#2931
      // split, so this is a same-object forward reference — resolved at
      // call time, after `historyHandlers` is fully constructed — not a
      // cross-module lookup through the barrel's `HANDLERS`.)
      throw new Error('undo_page_group mock: missing sibling handler')
    }
    const groupSize = findGroup({ pageId: a['pageId'], depth, windowMs }) as number
    const results: unknown[] = []
    for (let i = 0; i < groupSize; i++) {
      results.push(undoOp({ pageId: a['pageId'], undoDepth: depth + i }))
    }
    return results
  },

  revert_ops: (args) => {
    const a = args as Record<string, unknown>
    const ops = a['ops'] as Array<{ device_id: string; seq: number }>
    const results: Array<Record<string, unknown>> = []

    const sorted = [...ops].toSorted((x, y) => y.seq - x.seq)

    for (const opRef of sorted) {
      const target = opLog.find((o) => o.device_id === opRef.device_id && o.seq === opRef.seq)
      if (!target) continue

      applyRevertForOp(target, blocks, { properties, blockTags })

      const newOp = pushOp(`revert_${target.op_type}`, { reverted: target })
      results.push(newOp)
    }

    return results
  },

  undo_page_op: (args) => {
    const a = args as Record<string, unknown>
    const undoDepth = (a['undoDepth'] as number) ?? 0

    const undoableOps = opLog.filter(
      (o) => !o.op_type.startsWith('undo_') && !o.op_type.startsWith('redo_'),
    )
    const targetIndex = undoableOps.length - 1 - undoDepth
    // #2463 — mirrors `undo_page_op_inner`'s `NotFound` rejection
    // (`src-tauri/src/commands/history.rs`) when `undo_depth` overruns history.
    if (targetIndex < 0) throw notFoundRejection(`no op found at undo_depth ${undoDepth}`)
    const target = undoableOps[targetIndex]
    if (!target) throw notFoundRejection(`no op found at undo_depth ${undoDepth}`)

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

    // Mirrors `redo_page_op_inner`: the ref identifies the UNDO op that a
    // previous undo appended (the FE stores each undo's `new_op_ref` on its
    // redo stack), and redo re-applies the ORIGINAL op that undo reversed.
    // A ref to a forward (non-undo) op is REJECTED, mirroring the backend's
    // #659 provenance check (`op_log.is_undo`; the mock's equivalent marker
    // is the `undo_` op_type prefix stamped by the undo handlers).
    const undoOp: MockOpLogEntry | undefined = opLog.find((o) => o.seq === undoSeq)
    // #2463 — mirrors `redo_page_op_inner`'s two rejections
    // (`src-tauri/src/commands/history.rs`): a missing op_log row is
    // `NotFound`, a non-undo provenance ref is `Validation` (#659).
    if (!undoOp) throw notFoundRejection(`op_log (${a['undoDeviceId'] as string}, ${undoSeq})`)
    if (!undoOp.op_type.startsWith('undo_')) {
      throw validationRejection(
        `redo target (${undoOp.device_id}, ${undoOp.seq}) is a '${undoOp.op_type}' op that was ` +
          'not produced by undo — refusing to reverse a forward op via redo (#659)',
      )
    }
    const originalOp = (JSON.parse(undoOp.payload) as { reversed: MockOpLogEntry }).reversed
    // mock-internal invariant (#2463) — the mock stashes the reversed op
    // inline on its own `undo_*` op_log entry; a missing `reversed` payload
    // means the mock corrupted its own bookkeeping, which has no real-backend
    // counterpart (the backend recomputes the reverse from `op_log` on every
    // call via `reverse::compute_reverse`, it never stores it).
    if (!originalOp) throw new Error('undo op carries no reversed payload')

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

  // #2468 — ref-addressed single undo (`undo_page_op` successor). The FE
  // submits the exact `OpRef` it captured from the mutation's `op_refs`
  // response; validation + reversal live in `resolveUndoTarget` /
  // `applyUndoForTarget` (shared with `undo_ops`), which delegate to the
  // mock op-log's reversal core (`applyRevertForOp`) and enforce the
  // foreign / undo-op / already-reversed reject rules.
  undo_op: (args) => {
    const a = args as Record<string, unknown>
    const opRef = a['opRef'] as { device_id: string; seq: number }
    return applyUndoForTarget(resolveUndoTarget(opRef))
  },

  // #2468 — ref-addressed group undo (`undo_page_group` successor) with
  // ATOMIC-ABORT semantics: every ref is validated (same reject rules as
  // `undo_op`, plus duplicate detection) BEFORE any reversal is applied, so a
  // bad ref anywhere in the set reverts nothing. Ops revert newest-first and
  // the results come back newest-first, matching the real command.
  undo_ops: (args) => {
    const a = args as Record<string, unknown>
    const ops = (a['ops'] as Array<{ device_id: string; seq: number }> | undefined) ?? []
    // Backend parity: `undo_ops_inner` returns `Ok(vec![])` for an empty
    // ref-set (mirrors `revert_ops_inner`) — it does NOT reject it.
    if (ops.length === 0) return []
    const seen = new Set<string>()
    for (const ref of ops) {
      const key = `${ref.device_id}:${ref.seq}`
      if (seen.has(key)) {
        throw validationRejection(`duplicate op ref (${ref.device_id}, ${ref.seq})`)
      }
      seen.add(key)
    }
    const newestFirst = [...ops].toSorted((x, y) => y.seq - x.seq)
    // Validate ALL before applying ANY (atomic-abort).
    const targets = newestFirst.map((ref) => resolveUndoTarget(ref))
    return targets.map((target) => applyUndoForTarget(target))
  },

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

  // Part B — diff between a block's historical content (as of
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
      throw notFoundRejection(
        `block '${blockId}' not found or soft-deleted (cannot diff against current)`,
      )
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
      throw notFoundRejection(
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
} satisfies Pick<
  TypedHandlers,
  | 'get_block_history'
  | 'list_page_history'
  | 'find_undo_group'
  | 'undo_page_group'
  | 'revert_ops'
  | 'undo_page_op'
  | 'redo_page_op'
  | 'undo_op'
  | 'undo_ops'
  | 'compute_edit_diff'
  | 'compute_block_vs_current_diff'
  | 'get_compaction_status'
  | 'compact_op_log_cmd'
  | 'restore_page_to_op'
>
