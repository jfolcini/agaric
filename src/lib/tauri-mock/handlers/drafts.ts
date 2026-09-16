/**
 * `block_drafts` — the autosave staging table (F-17, H-12).
 *
 * A draft is UNCOMMITTED text: `save_draft` writes one row and appends NO op,
 * so a draft is invisible to history until it is flushed. `flush_draft` is the
 * commit step, and it does NOT create a block — it converts the stored text
 * into an `edit_block` op against a block that already exists, then drops the
 * row.
 *
 * Twin of `src-tauri/src/commands/drafts.rs` (guards) and
 * `src-tauri/agaric-engine/src/draft.rs` (SQL). The three guards below decide
 * whether a flush commits or discards, and the two flush paths deliberately
 * disagree about oversized content — see {@link flushOne}.
 */

import {
  type Handler,
  MOCK_LOCAL_DEVICE,
  type TypedHandlers,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { type MockDraftRow, blockDrafts, blocks, opLog, pushOp } from '@/lib/tauri-mock/seed'

/** `MAX_CONTENT_LENGTH` (`agaric-engine/src/block_ops.rs`). */
const MAX_CONTENT_LENGTH = 256 * 1024

/** `FLUSH_ALL_DRAFTS_CAP` (`commands/drafts.rs`). */
const FLUSH_ALL_DRAFTS_CAP = 1000

/** Rust compares `content.len()`, which is BYTES; `String.length` is UTF-16
 *  code units, so a multi-byte draft near the cap would disagree. */
function byteLength(content: string): number {
  return new TextEncoder().encode(content).length
}

/** `COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?`. */
function localAnchorSeq(): number {
  let max = 0
  for (const entry of opLog) {
    if (entry.device_id === MOCK_LOCAL_DEVICE && entry.seq > max) max = entry.seq
  }
  return max
}

/** Oldest first, the order both `list_drafts` and the flush-all driver use. */
function draftsOldestFirst(): MockDraftRow[] {
  return [...blockDrafts.values()].toSorted((a, b) => a.updated_at - b.updated_at)
}

/**
 * H-12a — the target must be live. A draft whose block was hard-deleted is
 * already gone (the row CASCADEs), so this catches the SOFT-deleted case.
 */
function targetIsLive(blockId: string): boolean {
  const block = blocks.get(blockId)
  return block !== undefined && !block['deleted_at']
}

/**
 * The draft is stale when this device has edited or re-created the block since
 * the draft was anchored: the newer op wins and the draft is discarded rather
 * than regressing the block's content over it.
 */
function isSuperseded(draft: MockDraftRow): boolean {
  const device = draft.draft_anchor_device ?? MOCK_LOCAL_DEVICE
  return opLog.some(
    (entry) =>
      (entry.op_type === 'edit_block' || entry.op_type === 'create_block') &&
      entry.device_id === device &&
      entry.seq > draft.draft_anchor_seq &&
      (JSON.parse(entry.payload) as { block_id?: string }).block_id === draft.block_id,
  )
}

/**
 * Resolve one draft. Returns whether the row was CONSUMED — which the flush-all
 * counter reports as `flushed`, so a guard-dropped draft counts even though it
 * appended no op.
 *
 * `oversized` is the one place the two flush paths differ: `flush_draft`
 * REFUSES (its caller rolls back, keeping the row) while `flush_all_drafts`
 * skips the offender so the rest of the batch still commits (#3262). The guard
 * order matters — an orphaned or superseded draft is dropped before its size is
 * ever looked at, so an oversized draft on a dead block is reaped, not stuck.
 */
function flushOne(draft: MockDraftRow, oversized: 'refuse' | 'skip'): boolean {
  if (!targetIsLive(draft.block_id) || isSuperseded(draft)) {
    blockDrafts.delete(draft.block_id)
    return true
  }
  if (byteLength(draft.content) > MAX_CONTENT_LENGTH) {
    if (oversized === 'refuse') {
      throw validationRejection(
        `draft content ${byteLength(draft.content)} exceeds maximum ${MAX_CONTENT_LENGTH}`,
      )
    }
    return false
  }
  const block = blocks.get(draft.block_id)
  const fromText = (block?.['content'] as string | null | undefined) ?? null
  if (block) block['content'] = draft.content
  pushOp('edit_block', {
    block_id: draft.block_id,
    to_text: draft.content,
    from_text: fromText,
  })
  blockDrafts.delete(draft.block_id)
  return true
}

export const draftsHandlers = {
  save_draft: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    blockDrafts.set(blockId, {
      block_id: blockId,
      content: (a['content'] as string) ?? '',
      updated_at: Date.now(),
      draft_anchor_seq: localAnchorSeq(),
      draft_anchor_device: MOCK_LOCAL_DEVICE,
    })
    return null
  },

  delete_draft: (args) => {
    blockDrafts.delete((args as Record<string, unknown>)['blockId'] as string)
    return null
  },

  flush_draft: (args) => {
    const draft = blockDrafts.get((args as Record<string, unknown>)['blockId'] as string)
    // No draft is not an error: the editor flushes on blur whether or not one
    // was ever staged.
    if (draft) flushOne(draft, 'refuse')
    return null
  },

  flush_all_drafts: () => {
    let flushed = 0
    for (const draft of draftsOldestFirst().slice(0, FLUSH_ALL_DRAFTS_CAP)) {
      if (flushOne(draft, 'skip')) flushed += 1
    }
    return { flushed }
  },

  list_drafts: () => draftsOldestFirst(),
} satisfies Pick<
  TypedHandlers,
  'save_draft' | 'delete_draft' | 'flush_draft' | 'flush_all_drafts' | 'list_drafts'
> satisfies Record<string, Handler>
