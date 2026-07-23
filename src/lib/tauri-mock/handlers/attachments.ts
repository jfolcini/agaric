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

import { type TypedHandlers } from '@/lib/tauri-mock/handlers/shared'
import { attachmentBytes, attachments, fakeId } from '@/lib/tauri-mock/seed'

export const attachmentsHandlers = {
  list_attachments: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    return [...attachments.values()].filter((att) => att['block_id'] === blockId)
  },

  // Full-list batch — single source for both
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
      created_at: new Date().toISOString(),
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
    return attachments.get(a['attachmentId'] as string) ?? null
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
  | 'add_attachment'
  | 'add_attachment_with_bytes'
  | 'read_attachment_meta'
  | 'delete_attachment'
  | 'rename_attachment'
>
