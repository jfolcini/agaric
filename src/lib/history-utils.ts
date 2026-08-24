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
 * Also handles the two attachment payloads (#4335 review): neither
 * `DeleteAttachmentPayload` nor `RenameAttachmentPayload`
 * (`src-tauri/agaric-store/src/op.rs`) carries `to_text`/`content`, so
 * without this a `delete_attachment`/`rename_attachment` row rendered with
 * a badge, a time, and a `dev:xxxxxxxx` — nothing that answers "what
 * happened to this page". `delete_attachment` renders its `filename`;
 * `rename_attachment` renders the `old_filename → new_filename` transition.
 * Both fields are individually optional in practice — `filename` is
 * `#[serde(default)]` so pre-#4262 op-log rows deserialize to `""`, and an
 * `old_filename`/`new_filename` could in principle be missing from a
 * malformed payload — so each half is checked independently and a missing
 * one is simply omitted rather than rendered as `undefined`.
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
      const oldFilename = typeof parsed['old_filename'] === 'string' ? parsed['old_filename'] : null
      const newFilename = typeof parsed['new_filename'] === 'string' ? parsed['new_filename'] : null
      if (oldFilename && newFilename) return `${oldFilename} → ${newFilename}`
      return oldFilename ?? newFilename
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
