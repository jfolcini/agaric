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

// #3824 — the two history queries page the SAME way every other keyset does
// (`LIMIT ?limit + 1` over a `pagination::Cursor`), so they reuse `list_blocks`'
// paginator rather than growing a second cursor codec free to drift from the
// backend's `Cursor` shape. Same move #4667 made for `get_backlinks`.
import { type SortKey, compareSortKeysDesc, paginateKeyset } from '@/lib/tauri-mock/handlers/blocks'
import {
  type TypedHandlers,
  applyUndoForTarget,
  notFoundRejection,
  pageRequestLimit,
  resolveUndoTarget,
  reverseOpTypeFor,
  reversePayloadFor,
  sortOpLogNewestFirst,
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

// Mirror `undo_page_group_inner`'s group sizing so browser-mode FE
// tests observe the same group the real backend reverts. Walks the in-memory `opLog` newest-first,
// filtering out `is_undo` ops (#4868), seeds at index `depth`,
// and counts consecutive same-device + within-window ops.
function findUndoGroupSize(depth: number, windowMs: number): number {
  // Newest-first ordering on (created_at DESC, seq DESC) — see
  // `sortOpLogNewestFirst` (shared.ts).
  const undoableOps = sortOpLogNewestFirst(opLog.filter((o) => !o.is_undo))

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
}

/** The sentinel `page_id` that asks `list_page_history` for the WHOLE op log
 *  rather than one page's subtree (`pagination::list_page_history`). */
const GLOBAL_HISTORY_PAGE_ID = '__all__'

/**
 * The `op_log.block_id` COLUMN the backend fills from `OpPayload::block_id()`
 * (migration 0030). The mock has no such column, so it reads the same value
 * back out of the JSON payload — which is where the backend put it.
 *
 * #4868 — the undo, redo and revert arms now stamp a `block_id` of their own,
 * so this returns one for them too. It used to return `null`: their payload
 * only wrapped the target op, and the two branches that require a block id —
 * the per-page scope and `get_block_history` — therefore dropped every undo
 * row the backend lists. The fix was in the write path, which is where it
 * landed; this reader was always right.
 */
function opBlockId(entry: MockOpLogEntry): string | null {
  try {
    const payload = JSON.parse(entry.payload) as Record<string, unknown>
    const id = payload['block_id']
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

/** `AND (?N IS NULL OR ol.op_type = ?N)` — both history queries push the FE's
 *  op-type filter into SQL, so a filtered page is a full page of matches. */
function matchesOpType(entry: MockOpLogEntry, opTypeFilter: string | null): boolean {
  return opTypeFilter === null || entry.op_type === opTypeFilter
}

/**
 * The `__all__` branch's space predicate: the op's block belongs to the
 * requested space, resolved through its owning page's `space` property.
 *
 * More permissive than the backend in one place — a row whose payload names no
 * block is KEPT, where `ol.block_id IN (…)` drops it. That allowance existed
 * for the mock's block-less undo rows; #4868 gave those a real `block_id`, so
 * what it now covers is only a seeded or synthetic row that genuinely names no
 * block.
 */
function inSpace(entry: MockOpLogEntry, spaceId: string | null): boolean {
  if (spaceId === null) return true
  const blockId = opBlockId(entry)
  if (blockId === null) return true
  const blk = blocks.get(blockId)
  const ownerId = (blk?.['page_id'] as string | null) ?? blockId
  return (properties.get(ownerId)?.get('space')?.['value_ref'] ?? null) === spaceId
}

/** Mirrors the `pb.depth < 100` guard on the `page_blocks` CTE. */
const DESCENDANT_DEPTH_CAP = 100

/**
 * The ids the backend's `page_blocks` recursive CTE yields: the page itself
 * plus every transitive child, tombstones included (the CTE has no `deleted_at`
 * filter — a page's history has to survive its own deletion), bounded at
 * `depth < 100` (AGENTS.md invariant 9).
 *
 * A page id no block carries seeds NOTHING, exactly as `SELECT id FROM blocks
 * WHERE id = ?1` does — so a purged page's ops stop being listed under it
 * rather than being matched by id alone.
 */
function pageSubtreeIds(pageId: string): Set<string> {
  const ids = new Set<string>()
  if (!blocks.has(pageId)) return ids
  ids.add(pageId)
  const all = [...blocks.values()]
  let frontier = new Set<string>([pageId])
  for (let depth = 0; depth < DESCENDANT_DEPTH_CAP && frontier.size > 0; depth++) {
    const next = new Set<string>()
    for (const b of all) {
      const id = b['id'] as string
      if (ids.has(id)) continue
      if (!frontier.has((b['parent_id'] as string | null) ?? '')) continue
      ids.add(id)
      next.add(id)
    }
    frontier = next
  }
  return ids
}

/** The `HistoryEntry` projection both queries `SELECT`, newest-first ordering
 *  left to {@link paginateKeyset}. */
function historyEntries(keep: (entry: MockOpLogEntry) => boolean): Record<string, unknown>[] {
  return opLog.filter(keep).map((o) => ({
    device_id: o.device_id,
    seq: o.seq,
    op_type: o.op_type,
    payload: o.payload,
    created_at: o.created_at,
    // #2481 phase 2: foreign audit ops carry is_replicated=1; the mock
    // op log is local-authored unless a row seeds it otherwise.
    is_replicated: (o as { is_replicated?: boolean }).is_replicated ?? false,
  }))
}

/** `(created_at, seq, device_id)` — the `ORDER BY` BOTH history listings
 *  share (#4964), read descending through {@link compareSortKeysDesc}.
 *  `list_block_history` used to lead on `seq` alone, which ranks a
 *  multi-device vault by each device's lifetime op count because the op_log
 *  PK is `(device_id, seq)`. */
function historyKey(row: Record<string, unknown>): SortKey {
  return [row['created_at'] as string, row['seq'] as number, row['device_id'] as string]
}

export const historyHandlers = {
  // `ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC LIMIT
  // ?limit + 1` over the `Cursor::for_history_full` `{deleted_at, seq, id}`
  // keyset — the sibling's, verbatim (#4964), where `deleted_at` carries
  // `created_at` and `id` carries `device_id`. Keying on `seq` first, as this
  // did, ranks a multi-device vault by each device's lifetime op count: the
  // op_log PK is `(device_id, seq)`, so `seq` is per-device and a peer paired
  // last week sorts below every op of a long-lived device
  // (`pagination::list_block_history`).
  //
  // #3824 — this used to be an UNCONDITIONAL empty page, waived on the grounds
  // that "browser-mode callers don't currently exercise per-block history", so
  // every argument it takes was ignored and no test could tell a working
  // handler from a broken one.
  //
  // NOT modelled, and unreachable rather than skipped: the backend's
  // `delete_attachment` / `rename_attachment` disjunct. The mock's attachment
  // handlers (`handlers/attachments.ts`) append NO op-log rows at all, so the
  // mock op log contains no attachment op of any kind for the disjunct to
  // admit — mirroring it here would be a branch nothing can enter.
  get_block_history: (args) => {
    const a = (args ?? {}) as Record<string, unknown>
    const blockId = (a['blockId'] as string | undefined) ?? null
    const opTypeFilter = (a['opTypeFilter'] as string | null | undefined) ?? null
    const rows = historyEntries((o) => opBlockId(o) === blockId && matchesOpType(o, opTypeFilter))
    return paginateKeyset(
      rows,
      historyKey,
      pageRequestLimit(a['limit']),
      a['cursor'],
      null,
      ['deleted_at', 'seq'],
      compareSortKeysDesc,
    )
  },

  // `ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC LIMIT
  // ?limit + 1` over the `Cursor::for_history_full` `{deleted_at, seq, id}`
  // keyset — the "composite overload" in which `deleted_at` carries
  // `created_at` and `id` carries `device_id` (`pagination::list_page_history`).
  //
  // #3824 — this used to read NEITHER `pageId` nor `cursor` nor `limit` nor
  // `opTypeFilter`: it answered every request with the whole space-filtered op
  // log under `{ next_cursor: null, has_more: false }`, so per-page history was
  // global history and every page was the first page. The same shape #3870
  // found in `list_blocks` and #4849 in `get_backlinks`.
  //
  // The attachment disjunct is unreachable here for the reason
  // `get_block_history` above gives.
  list_page_history: (args) => {
    const a = (args ?? {}) as Record<string, unknown>
    const pageId = (a['pageId'] as string | undefined) ?? GLOBAL_HISTORY_PAGE_ID
    const opTypeFilter = (a['opTypeFilter'] as string | null | undefined) ?? null
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    // The backend runs exactly one of two branches, and `space_id` belongs to
    // only one of them: a real `page_id` scopes through the recursive
    // `page_blocks` CTE and IGNORES the space (a page is itself space-bound),
    // while `__all__` scopes through `blocks.space_id`.
    const subtree = pageId === GLOBAL_HISTORY_PAGE_ID ? null : pageSubtreeIds(pageId)
    const inScope =
      subtree === null
        ? (o: MockOpLogEntry) => inSpace(o, spaceId)
        : (o: MockOpLogEntry) => {
            const id = opBlockId(o)
            return id !== null && subtree.has(id)
          }
    const rows = historyEntries((o) => inScope(o) && matchesOpType(o, opTypeFilter))
    return paginateKeyset(
      rows,
      historyKey,
      pageRequestLimit(a['limit']),
      a['cursor'],
      null,
      ['deleted_at', 'seq'],
      compareSortKeysDesc,
    )
  },

  // #2190 — batched group-undo. Mirrors `undo_page_group_inner`: size the
  // consecutive same-device, within-window group with `findUndoGroupSize`,
  // then apply the per-op reverse newest-first, returning
  // one UndoResult per reverted op. Reuses the sibling handlers so the reverse
  // effects stay identical to the single-op path. Reverse ops carry `is_undo`
  // (#4868) and are filtered out of the undoable set, so `depth + i` walks the
  // same ops the group spans across the loop.
  undo_page_group: (args) => {
    const a = (args ?? {}) as Record<string, unknown>
    const depth = (a['depth'] as number) ?? 0
    const windowMs = (a['windowMs'] as number) ?? 0
    const undoOp = historyHandlers['undo_page_op']
    if (!undoOp) {
      // mock-internal invariant (#2463) — `historyHandlers` is malformed if
      // this fires; it has no real-backend counterpart, so it stays a bare
      // Error. (The sibling lives in this same domain module post-#2931
      // split, so this is a same-object forward reference — resolved at
      // call time, after `historyHandlers` is fully constructed — not a
      // cross-module lookup through the barrel's `HANDLERS`.)
      throw new Error('undo_page_group mock: missing sibling handler')
    }
    const groupSize = findUndoGroupSize(depth, windowMs)
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

      // #4870 — a reverse row carries a genuine forward payload of its reverse
      // type, so reverting one re-applies the op it reversed, exactly as on the
      // backend. This used to skip such rows (`isBookkeepingRow`): their
      // payload was a stash with no `from_text`, and the `edit_block` arm would
      // have WIPED the block's content.
      const reversePayload = reversePayloadFor(target)
      applyRevertForOp(target, blocks, { properties, blockTags })

      // #4868 — the genuine reverse type flagged `is_undo`, matching
      // `revert_ops_in_tx`'s `append_local_undo_op_in_tx`.
      const newOp = pushOp(
        reverseOpTypeFor(target.op_type),
        { ...reversePayload, reverted: target },
        true,
      )
      results.push(newOp)
    }

    return results
  },

  undo_page_op: (args) => {
    const a = args as Record<string, unknown>
    const undoDepth = (a['undoDepth'] as number) ?? 0

    // Newest-first ordering on (created_at DESC, seq DESC), matching
    // `undo_page_op_inner`'s own `ORDER BY created_at DESC, seq DESC, …`
    // target-selection query (`src-tauri/src/commands/history.rs:1574`) — see
    // `sortOpLogNewestFirst` (shared.ts). `undo_depth` then indexes directly
    // into the sorted (newest-first) array: depth 0 is the newest op.
    // #4868 — `is_undo`, not an op_type prefix. `undo_page_op_inner`'s
    // `AND ol.is_undo = 0` admits a REDO op (`src-tauri/src/commands/history.rs:2401` keeps
    // it `is_undo = 0`, "its effect is forward-equivalent"), so undo-after-redo
    // targets the redo. The prefix filter excluded it and targeted the op
    // BEFORE it instead.
    const undoableOps = sortOpLogNewestFirst(opLog.filter((o) => !o.is_undo))
    // #2463 — mirrors `undo_page_op_inner`'s `NotFound` rejection
    // (`src-tauri/src/commands/history.rs`) when `undo_depth` overruns history.
    if (undoDepth < 0 || undoDepth >= undoableOps.length) {
      throw notFoundRejection(`no op found at undo_depth ${undoDepth}`)
    }
    const picked = undoableOps[undoDepth]
    if (!picked) throw notFoundRejection(`no op found at undo_depth ${undoDepth}`)

    // #4868 — a REDO op is undoable (it is `is_undo = 0`), and undoing it
    // means reversing the op it re-applied, so that the result names the
    // original — the same hop `resolveUndoTarget` makes for the ref-addressed
    // path.
    const reApplied = (JSON.parse(picked.payload) as { re_applied?: MockOpLogEntry }).re_applied
    const target = reApplied ?? picked

    // The shared table, not a local default. A `reverseOpType` local defaulted
    // to `edit_block`, so a positional undo of a `set_property` / `add_tag` /
    // `remove_tag` op stamped `edit_block` on the reverse row. Since #4868 that
    // row is one History displays and the #763 op-log digest compares, so the
    // wrong type is now observable rather than inert.
    const reverseOpType = reverseOpTypeFor(target.op_type)
    // #4870 — the shared reversal core, not a second per-type chain. This arm
    // owned an if/else covering the five block-row types only, so it stamped a
    // `remove_tag` reverse row while `blockTags` kept the tag, and reversed
    // `restore_block` on the target row alone where the backend cascades the
    // cohort. Two paths with different coverage is what produced that.
    const reversePayload = reversePayloadFor(target)
    applyRevertForOp(target, blocks, { properties, blockTags })

    // #4868 — the GENUINE reverse op type with `is_undo`, the way the backend
    // appends it, over a genuine reverse payload (#4870) whose `block_id` is
    // what `opBlockId` reads: without one the per-page scope and
    // `get_block_history` drop every undo the backend lists. `reversed` rides
    // along for `redo_page_op`'s lookup.
    const newOp = pushOp(reverseOpType, { ...reversePayload, reversed: target }, true)
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
    // #659 provenance check on `op_log.is_undo` — the same column since #4868,
    // rather than the op_type prefix that used to stand in for it.
    const undoOp: MockOpLogEntry | undefined = opLog.find((o) => o.seq === undoSeq)
    // #2463 — mirrors `redo_page_op_inner`'s two rejections
    // (`src-tauri/src/commands/history.rs`): a missing op_log row is
    // `NotFound`, a non-undo provenance ref is `Validation` (#659).
    if (!undoOp) throw notFoundRejection(`op_log (${a['undoDeviceId'] as string}, ${undoSeq})`)
    if (!undoOp.is_undo) {
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

    const redoOpType = reverseOpTypeFor(undoOp.op_type)
    // #4870 — a redo is the REVERSE OF THE UNDO, which is exactly what the
    // backend computes: `redo_page_op` builds `compute_reverse(undo_op)` and
    // runs it through `apply_reverse_in_tx`
    // (`src-tauri/src/commands/history.rs`). Now that the undo row carries a
    // genuine payload rather than a stash, reversing it here says the same
    // thing the per-type chain this replaces spelled out for five op types and
    // stayed silent on for the property and tag ones.
    const redoPayload = reversePayloadFor(undoOp)
    applyRevertForOp(undoOp, blocks, { properties, blockTags })

    // #4868 — `is_undo = 0`: a redo's effect is forward-equivalent
    // (`src-tauri/src/commands/history.rs:2401`), so it is itself undoable.
    // `re_applied` rides along for `resolveUndoTarget`'s hop back to the
    // original.
    const newOp = pushOp(redoOpType, { ...redoPayload, re_applied: originalOp }, false)
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
    const historicalCreatedAt = a['historicalCreatedAt'] as string | null | undefined
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
    const createdBound = historicalCreatedAt ?? null
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

  compact_op_log_cmd: () => ({ ops_deleted: 0 }),

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
