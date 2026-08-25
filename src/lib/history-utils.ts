import type { HistoryEntry } from '@/lib/bindings'

/**
 * Extract a text preview from an op-log entry payload.
 * Handles edit_block (to_text) and create_block (content) payloads.
 */
export function getPayloadPreview(entry: HistoryEntry, maxLen = 100): string | null {
  try {
    const parsed = JSON.parse(entry.payload) as Record<string, unknown>
    if (typeof parsed['to_text'] === 'string') {
      const text = parsed['to_text']
      return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text
    }
    if (typeof parsed['content'] === 'string') {
      const text = parsed['content']
      return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text
    }
  } catch {
    // Invalid JSON
  }
  return null
}

/**
 * Extract the raw `to_text` or `content` string from an op-log payload
 * WITHOUT truncation. Truncation is handled by CSS `line-clamp` in the UI.
 *
 * Also handles all three attachment payloads (#4335 review): none of
 * `AddAttachmentPayload`, `DeleteAttachmentPayload`, or
 * `RenameAttachmentPayload` (`src-tauri/agaric-store/src/op.rs`) carries
 * `to_text`/`content`, so without this an attachment row rendered with just
 * a badge, a time, and a `dev:xxxxxxxx` — nothing that answers "what
 * happened to this page". `add_attachment` and `delete_attachment` render
 * their `filename`; `rename_attachment` renders the `old_filename →
 * new_filename` transition. Every filename field is checked with
 * `.length > 0`, not just presence: `DeleteAttachmentPayload.filename` is
 * `#[serde(default)]` so pre-#4262 op-log rows deserialize it to `""`, and
 * a bare `??` on `RenameAttachmentPayload`'s two fields would let an empty
 * `old_filename` win over a populated `new_filename` (`""` is a string, not
 * `null`/`undefined` — `??` doesn't treat it as absent). Each half is
 * checked independently and a missing/empty one is simply omitted rather
 * than rendered as `undefined`/`""`.
 *
 * Returns null when the payload is invalid JSON or has no text/filename
 * field to show.
 */
export function getPayloadRawContent(entry: HistoryEntry): string | null {
  try {
    const parsed = JSON.parse(entry.payload) as Record<string, unknown>
    if (typeof parsed['to_text'] === 'string') return parsed['to_text']
    if (typeof parsed['content'] === 'string') return parsed['content']
    if (entry.op_type === 'delete_attachment') {
      const filename = parsed['filename']
      return typeof filename === 'string' && filename.length > 0 ? filename : null
    }
    if (entry.op_type === 'rename_attachment') {
      const oldRaw = parsed['old_filename']
      const newRaw = parsed['new_filename']
      // `""` is a string, so `??` alone would let an empty `old_filename`
      // win over a populated `new_filename` (#4335 review) — guard both
      // with `.length > 0`, same as the `delete_attachment` arm above.
      const oldFilename = typeof oldRaw === 'string' && oldRaw.length > 0 ? oldRaw : null
      const newFilename = typeof newRaw === 'string' && newRaw.length > 0 ? newRaw : null
      if (oldFilename && newFilename) return `${oldFilename} → ${newFilename}`
      return oldFilename ?? newFilename
    }
    if (entry.op_type === 'add_attachment') {
      const filename = parsed['filename']
      return typeof filename === 'string' && filename.length > 0 ? filename : null
    }
  } catch {
    // Invalid JSON
  }
  return null
}

/**
 * Extract property key/value from set_property or delete_property payloads.
 * Returns null when the payload is invalid or not a property operation.
 */
export function getPropertyPayload(entry: HistoryEntry): { key: string; value?: string } | null {
  if (entry.op_type !== 'set_property' && entry.op_type !== 'delete_property') {
    return null
  }
  try {
    const parsed = JSON.parse(entry.payload) as Record<string, unknown>
    if (typeof parsed['key'] === 'string') {
      return {
        key: parsed['key'],
        ...(typeof parsed['value'] === 'string' ? { value: parsed['value'] } : {}),
      }
    }
  } catch {
    // Invalid JSON
  }
  return null
}
