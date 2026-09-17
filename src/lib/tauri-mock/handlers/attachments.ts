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
import { attachmentBytes, attachments, blocks, fakeId, pushOp } from '@/lib/tauri-mock/seed'

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

/**
 * `ALLOWED_MIME_PATTERNS` + `is_mime_allowed` (`commands/mod.rs`). A `*`
 * pattern takes any NON-EMPTY subtype with no further `/`, so `image/` and
 * `image/../x` are refused rather than waved through by the prefix.
 */
const ALLOWED_MIME_PATTERNS = [
  'image/*',
  'application/pdf',
  'text/*',
  'application/json',
  'application/zip',
  'application/x-tar',
]

function isMimeAllowed(mime: string): boolean {
  return ALLOWED_MIME_PATTERNS.some((pattern) => {
    if (!pattern.endsWith('/*')) return pattern === mime
    const subtype = mime.startsWith(pattern.slice(0, -1)) ? mime.slice(pattern.length - 1) : null
    return subtype !== null && subtype !== '' && !subtype.includes('/')
  })
}

function validateAttachmentFilename(filename: string): string {
  const trimmed = filename.trim()
  if (trimmed === '') throw validationRejection('attachment filename may not be empty')
  if (new TextEncoder().encode(trimmed).length > MAX_ATTACHMENT_FILENAME_BYTES) {
    throw validationRejection('attachment filename is too long')
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw validationRejection('attachment filename may not contain a path separator')
  }
  // `char::is_control` on the Rust side, which is Unicode's definition: C0
  // (U+0000-U+001F), DEL, and C1 (U+0080-U+009F). Indexed rather than spread or
  // a regex: every control character is below the surrogate range, so UTF-16
  // units decide this correctly, and neither `no-misused-spread` nor
  // `no-control-regex` has to be suppressed to say it.
  let hasControl = false
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      hasControl = true
      break
    }
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
  //
  // #5057 — the handler used to store the row and nothing else: no validation
  // of any kind, and no op. `validate_new_attachment` refuses a disallowed MIME
  // type and every bad filename `rename_attachment` already refuses here, and
  // `persist_attachment` refuses a block that is missing or tombstoned — in
  // that order, so a bad name on an unknown block is the validation refusal.
  // The op is what `reverse_add_attachment` rebuilds an undo from.
  add_attachment_with_bytes: (args) => {
    const a = args as Record<string, unknown>
    const bytes = (a['bytes'] as number[]) ?? []
    const mimeType = a['mimeType'] as string
    if (!isMimeAllowed(mimeType)) {
      throw validationRejection(`MIME type '${mimeType}' is not allowed`)
    }
    const filename = validateAttachmentFilename(a['filename'] as string)
    const blockId = a['blockId'] as string
    const block = blocks.get(blockId)
    if (!block || block['deleted_at']) {
      throw notFoundRejection(`block '${blockId}' (not found or deleted)`)
    }
    const id = fakeId()
    const fsPath = `attachments/${id}`
    const row = {
      id,
      block_id: blockId,
      filename,
      mime_type: mimeType,
      size_bytes: bytes.length,
      fs_path: fsPath,
      created_at: Date.now(),
      // The backend stores the blake3 of the bytes; the mock never hashes, and
      // `null` is the wire-legal "no hash" the row carried before migration
      // 0093. The field is present so the row has the `AttachmentRow` shape.
      content_hash: null,
    }
    attachments.set(id, row)
    attachmentBytes.set(id, bytes)
    pushOp('add_attachment', {
      attachment_id: id,
      block_id: blockId,
      mime_type: mimeType,
      filename,
      size_bytes: bytes.length,
      fs_path: fsPath,
    })
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
    // The op records what was removed so a peer can reclaim the bytes; the
    // BYTES themselves are left to the GC pass (#1993), which is why
    // `delete_attachment_inner` takes its app-data dir as `_app_data_dir`.
    // The mock used to drop them here, so an undone delete restored a row
    // whose `read_attachment` answered an empty buffer where the backend
    // still had the file. `purge_block` is the path that does reclaim them.
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
