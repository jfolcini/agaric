import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { AttachmentRow } from '@/lib/bindings'

/**
 * The generated wire shape (#4414). This module used to hand-declare a
 * duplicate that drifted from it — missing `content_hash` and typing
 * `id`/`block_id` as bare `string` instead of `BlockId`. Re-export instead of
 * redeclaring so `tsc` is the only thing that can let this drift again.
 */
export type { AttachmentRow } from '@/lib/bindings'

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

// `readAttachment` (sanctioned raw invoke) moved to `@/lib/ipc-helpers`
// (#4413, the migration floor). `readAttachmentMeta` retired its wrapper
// (#4411, PURE passthrough) — call `commands.readAttachmentMeta` directly.

// ---------------------------------------------------------------------------
// Markdown import (#660)
// ---------------------------------------------------------------------------
