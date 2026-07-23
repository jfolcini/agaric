import { invoke } from '@tauri-apps/api/core'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'

export interface AttachmentRow {
  id: string
  block_id: string
  filename: string
  mime_type: string
  size_bytes: number
  fs_path: string
  /** Epoch-ms (attachments.created_at is INTEGER since migration 0081). */
  created_at: number
}

/** List all attachments for a block. */
export async function listAttachments(blockId: string): Promise<AttachmentRow[]> {
  return unwrap(await commands.listAttachments(blockId))
}

/**
 * Batch-fetch full attachment lists for many blocks in one IPC.
 *
 * Returns a record mapping block_id → AttachmentRow[]. Block IDs absent
 * from the record have either 0 attachments or are not in the database;
 * callers should default missing keys to `[]`. Counts are derivable as
 * `result[id].length` — folded the separate count
 * batch (`get_batch_attachment_counts`) into this one.
 *
 * Replaces N per-block `listAttachments` IPCs for both the
 * SortableBlock paperclip badge and the StaticBlock inline-image render
 * path with a single batched query mounted at the BlockTree level.
 */
export async function getBatchAttachments(
  blockIds: string[],
): Promise<Record<string, AttachmentRow[]>> {
  return unwrap(await commands.listAttachmentsBatch(blockIds))
}

/** Add an attachment to a block. */
export async function addAttachment(params: {
  blockId: string
  filename: string
  mimeType: string
  sizeBytes: number
  fsPath: string
}): Promise<AttachmentRow> {
  return unwrap(
    await commands.addAttachment(
      params.blockId,
      params.filename,
      params.mimeType,
      params.sizeBytes,
      params.fsPath,
    ),
  )
}

/**
 * Add an attachment by passing the file's raw bytes over IPC.
 * The backend is the sole writer — it persists the bytes under
 * `$APPDATA/attachments/` and records the row. `bytes` is the file content
 * (e.g. from `new Uint8Array(await file.arrayBuffer())`).
 */
export async function addAttachmentWithBytes(params: {
  blockId: string
  filename: string
  mimeType: string
  bytes: Uint8Array
}): Promise<AttachmentRow> {
  return unwrap(
    await commands.addAttachmentWithBytes(
      params.blockId,
      params.filename,
      params.mimeType,
      Array.from(params.bytes),
    ),
  )
}

/**
 * Read an attachment's raw bytes by ID.
 *
 * #2654: the `read_attachment` Tauri command returns a raw-byte
 * `tauri::ipc::Response`, so `invoke` resolves an `ArrayBuffer` with zero JSON
 * encoding — no multi-MB `number[]` parse on the main thread. Because a
 * raw-response command cannot carry a `specta::Type`, it has no generated
 * `commands.*` binding; this is the sanctioned raw-`invoke` seam (tauri.ts is
 * exempt from the no-raw-invoke guard). A backend error rejects the promise
 * with the serialized `AppError`, matching every other wrapper's throw shape.
 */
export async function readAttachment(attachmentId: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>('read_attachment', { attachmentId })
  return new Uint8Array(buffer)
}

/**
 * Read an attachment's metadata row (filename, mime, …) by ID (#1490).
 * Used by the graph export to resolve an inline-image `attachment:<id>` ref to
 * a portable `assets/<filename>` path. Metadata-only: does not read the file.
 */
export async function readAttachmentMeta(attachmentId: string): Promise<AttachmentRow> {
  return unwrap(await commands.readAttachmentMeta(attachmentId))
}

/** Delete an attachment by ID. */
export async function deleteAttachment(attachmentId: string): Promise<void> {
  unwrap(await commands.deleteAttachment(attachmentId))
}

/** Rename an attachment by ID. */
export async function renameAttachment(params: {
  attachmentId: string
  newFilename: string
}): Promise<void> {
  unwrap(await commands.renameAttachment(params.attachmentId, params.newFilename))
}

// ---------------------------------------------------------------------------
// Markdown import (#660)
// ---------------------------------------------------------------------------
