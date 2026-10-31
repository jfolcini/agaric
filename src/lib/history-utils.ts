import type { HistoryEntry } from '@/lib/bindings'

/** An op-log payload as a plain object, or `null` for invalid JSON or any non-object value. */
export function parsePayloadObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The label of a definition op, a rename, an option rename and a merge (#5841), by op type. */
const PROPERTY_KEY_OP_LABELS: Partial<
  Record<string, (payload: Record<string, unknown>) => string | null>
> = {
  set_property_def: (payload) => {
    const key = payload['key']
    return typeof key === 'string' && key.length > 0 ? key : null
  },
  rename_property_key: ({ old_key: oldKey, new_key: newKey }) =>
    typeof oldKey === 'string' && typeof newKey === 'string' ? `${oldKey} → ${newKey}` : null,
  rename_property_option: ({ key, old_option: from, new_option: to }) =>
    typeof key === 'string' && typeof from === 'string' && typeof to === 'string'
      ? `${key}: ${from} → ${to}`
      : null,
  // A merge writes `from`'s definition, then `into`'s; a type change (#5841 S3)
  // one; a removal of the values that don't fit (#6206) none, only values of its key.
  rewrite_properties: (payload) => {
    const defs = payload['defs']
    if (!Array.isArray(defs)) return null
    if (payload['reason'] === 'change_type') return typeChangeLabel(defs[0])
    if (payload['reason'] === 'remove_unfit') return removedKey(payload['values'])
    const keys = defs.map((d: unknown) => (d as Record<string, unknown> | null)?.['key'])
    return keys.every((k) => typeof k === 'string') ? keys.join(' → ') : null
  },
}

/** The key a removal's value writes are under. */
function removedKey(values: unknown): string | null {
  const key = Array.isArray(values)
    ? (values[0] as Record<string, unknown> | undefined)?.['key']
    : undefined
  return typeof key === 'string' ? key : null
}

/** `key: from → to` of a type change's definition write. */
function typeChangeLabel(write: unknown): string | null {
  const w = write as {
    key?: unknown
    def?: { value_type?: unknown }
    prior?: { value_type?: unknown }
  }
  const [key, from, to] = [w?.key, w?.prior?.value_type, w?.def?.value_type]
  return typeof key === 'string' && typeof from === 'string' && typeof to === 'string'
    ? `${key}: ${from} → ${to}`
    : null
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
 * The two alias ops (#5387) render their `alias`, a definition op (#5841)
 * its `key`.
 *
 * Returns null when the payload is invalid JSON or has no text/filename
 * field to show.
 */
export function getPayloadRawContent(entry: HistoryEntry): string | null {
  const parsed = parsePayloadObject(entry.payload)
  if (parsed === null) return null
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
  if (entry.op_type === 'add_page_alias' || entry.op_type === 'remove_page_alias') {
    const alias = parsed['alias']
    return typeof alias === 'string' && alias.length > 0 ? alias : null
  }
  const propertyKeyLabel = PROPERTY_KEY_OP_LABELS[entry.op_type]
  if (propertyKeyLabel) return propertyKeyLabel(parsed)
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
  const parsed = parsePayloadObject(entry.payload)
  if (parsed !== null && typeof parsed['key'] === 'string') {
    return {
      key: parsed['key'],
      ...(typeof parsed['value'] === 'string' ? { value: parsed['value'] } : {}),
    }
  }
  return null
}
