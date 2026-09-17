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

import {
  notFoundRejection,
  type TypedHandlers,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { attachmentBytes, attachments, fakeId, pushOp } from '@/lib/tauri-mock/seed'

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

/**
 * `validate_attachment_filename` (#2989): a filename is a NAME, not a path.
 * Trimmed first, then refused when empty, over the byte cap, carrying a path
 * separator or a control character, or consisting solely of dots — each of
 * which would let a rename address something outside the attachment directory.
 */
const MAX_ATTACHMENT_FILENAME_BYTES = 255

function validateAttachmentFilename(filename: string): string {
  const trimmed = (filename ?? '').trim()
  if (trimmed === '') throw validationRejection('attachment filename may not be empty')
  if (new TextEncoder().encode(trimmed).length > MAX_ATTACHMENT_FILENAME_BYTES) {
    throw validationRejection('attachment filename is too long')
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw validationRejection('attachment filename may not contain a path separator')
  }
  // `char::is_control` on the Rust side, which is Unicode's definition: C0
  // (U+0000-U+001F), DEL, and C1 (U+0080-U+009F). Spelled as a codepoint test
  // rather than a regex so it needs no lint suppression to say the same thing.
  // Indexed rather than spread or a regex: every control character is below
  // the surrogate range, so UTF-16 units decide this correctly, and neither
  // `no-misused-spread` nor `no-control-regex` has to be suppressed to say it.
  let hasControl = false
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) hasControl = true
  }
  if (hasControl) {
    throw validationRejection('attachment filename may not contain control characters')
  }
  if (/^\.+$/.test(trimmed)) {
    throw validationRejection('attachment filename may not consist solely of dots')
  }
  return trimmed
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
    const row = attachments.get(id)
    if (!row) throw notFoundRejection(`attachment '${id}'`)
    attachments.delete(id)
    attachmentBytes.delete(id)
    // The op records what was removed so a peer can reclaim the bytes; the
    // BYTES themselves are left to the GC pass (#1993), which is why the
    // backend no longer needs its app-data dir here.
    pushOp('delete_attachment', {
      attachment_id: id,
      fs_path: row['fs_path'],
      filename: row['filename'],
    })
    return null
  },

  rename_attachment: (args) => {
    const a = args as Record<string, unknown>
    const id = a['attachmentId'] as string
    const row = attachments.get(id)
    // NotFound is checked BEFORE the filename, so an unknown id with a bad
    // name is this refusal rather than that one.
    if (!row) throw notFoundRejection(`attachment '${id}'`)
    const oldFilename = row['filename'] as string
    const newFilename = validateAttachmentFilename(a['newFilename'] as string)
    row['filename'] = newFilename
    pushOp('rename_attachment', {
      attachment_id: id,
      old_filename: oldFilename,
      new_filename: newFilename,
    })
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
