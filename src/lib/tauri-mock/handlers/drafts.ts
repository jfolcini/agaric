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
 * `src-tauri/agaric-engine/src/draft.rs` (SQL). Two guards decide whether a
 * flush commits or discards — the target must still be live, and the draft must
 * not have been superseded. The backend's third, a size refusal, is not
 * modelled; {@link flushOne} says why.
 */

import {
  type Handler,
  MOCK_LOCAL_DEVICE,
  type TypedHandlers,
} from '@/lib/tauri-mock/handlers/shared'
import { type MockDraftRow, blockDrafts, blocks, opLog, pushOp } from '@/lib/tauri-mock/seed'

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
 * H-12a — the live target row, or `undefined` when the draft is orphaned. A
 * draft whose block was HARD-deleted went with it (the row CASCADEs), so this
 * catches the SOFT-deleted case.
 */
function liveTarget(blockId: string): Record<string, unknown> | undefined {
  const block = blocks.get(blockId)
  return block && !block['deleted_at'] ? block : undefined
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
 * Resolve one draft: apply it, or discard it when a guard says the block has
 * moved on. Either way the row is CONSUMED, which is what `flush_all_drafts`
 * counts — a guard-dropped draft counts as well as an applied one, even though
 * it appends no op.
 *
 * The backend also REFUSES a draft over `MAX_CONTENT_LENGTH` from `flush_draft`
 * while `flush_all_drafts` skips it (#3262). That asymmetry is not modelled: no
 * frontend path stages a draft near 256 KiB, no fixture can express one without
 * a quarter-megabyte op arg, and the mock enforces no content bound anywhere
 * else — so it would be parity code nothing could redden.
 */
function flushOne(draft: MockDraftRow): void {
  blockDrafts.delete(draft.block_id)
  const block = liveTarget(draft.block_id)
  if (!block || isSuperseded(draft)) return
  const fromText = (block['content'] as string | null | undefined) ?? null
  block['content'] = draft.content
  pushOp('edit_block', {
    block_id: draft.block_id,
    to_text: draft.content,
    from_text: fromText,
  })
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
    if (draft) flushOne(draft)
    return null
  },

  flush_all_drafts: () => {
    const drafts = draftsOldestFirst()
    for (const draft of drafts) flushOne(draft)
    return { flushed: drafts.length }
  },

  list_drafts: () => draftsOldestFirst(),
} satisfies Pick<
  TypedHandlers,
  'save_draft' | 'delete_draft' | 'flush_draft' | 'flush_all_drafts' | 'list_drafts'
> satisfies Record<string, Handler>
