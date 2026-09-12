/**
 * Tauri mock handlers -- Attachment CRUD.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import { notFoundRejection, type TypedHandlers } from '@/lib/tauri-mock/handlers/shared'
import { attachmentBytes, attachments, fakeId } from '@/lib/tauri-mock/seed'

/**
 * The backend's `ORDER BY created_at, id` (`list_attachments_inner` and the
 * per-block lists of `list_attachments_batch_inner`). The mock answered in
 * `attachments` insertion order until `query_attachments.json` pinned the sort
 * (#3830).
 */
function byCreatedAtThenId(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const ca = a['created_at'] as number
  const cb = b['created_at'] as number
  if (ca !== cb) return ca < cb ? -1 : 1
  const ia = a['id'] as string
  const ib = b['id'] as string
  return ia < ib ? -1 : ia > ib ? 1 : 0
}

export const attachmentsHandlers = {
  list_attachments: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    return [...attachments.values()]
      .filter((att) => att['block_id'] === blockId)
      .toSorted(byCreatedAtThenId)
  },

  // Full-list batch — single source for both
  // SortableBlock badge counts (consumer reads `.length`) and StaticBlock
  // inline-image-render decisions. Mirrors the json_each-backed batch
  // pattern in `commands/blocks/queries.rs::batch_resolve_inner`.
  list_attachments_batch: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = (a['blockIds'] as string[]) ?? []
    const result: Record<string, Array<Record<string, unknown>>> = {}
    for (const att of [...attachments.values()].toSorted(byCreatedAtThenId)) {
      const bid = att['block_id'] as string
      if (blockIds.includes(bid)) {
        result[bid] = result[bid] ?? []
        result[bid].push(att)
      }
    }
    return result
  },

  // Bytes-over-IPC add. Stores the raw bytes so `read_attachment`
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
      created_at: Date.now(),
      // The backend stores the blake3 of the bytes; the mock never hashes, and
      // `null` is the wire-legal "no hash" the row carried before migration
      // 0093. The field is present so the row has the `AttachmentRow` shape.
      content_hash: null,
    }
    attachments.set(id, row)
    attachmentBytes.set(id, bytes)
    return row
  },

  // NOTE: `read_attachment` is NOT here — it returns a raw-byte
  // `tauri::ipc::Response` (#2654), so tauri-specta emits no binding for it and
  // it cannot live under the `satisfies TypedHandlers` contract (which is keyed
  // off `typeof commands`). Its handler lives in `RAW_RESPONSE_HANDLERS` below.

  // #1490 — metadata-only read used by the graph export to resolve an inline
  // `attachment:<id>` ref to a portable `assets/<filename>` path.
  read_attachment_meta: (args) => {
    const a = args as Record<string, unknown>
    const id = a['attachmentId'] as string
    const row = attachments.get(id)
    // `read_attachment_meta_inner` REFUSES a miss with `NotFound`; the mock
    // answered `null` until `query_attachments.json` pinned the refusal (#3830).
    if (!row) throw notFoundRejection(`attachment '${id}'`)
    return row
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
} satisfies Pick<
  TypedHandlers,
  | 'list_attachments'
  | 'list_attachments_batch'
  | 'add_attachment_with_bytes'
  | 'read_attachment_meta'
  | 'delete_attachment'
  | 'rename_attachment'
>
