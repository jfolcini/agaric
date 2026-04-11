import type { HistoryEntry } from './tauri'

/**
 * Extract a text preview from an op-log entry payload.
 * Handles edit_block (to_text) and create_block (content) payloads.
 */
export function getPayloadPreview(entry: HistoryEntry, maxLen = 100): string | null {
  try {
    const parsed = JSON.parse(entry.payload) as Record<string, unknown>
    if (typeof parsed.to_text === 'string') {
      const text = parsed.to_text
      return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text
    }
    if (typeof parsed.content === 'string') {
      const text = parsed.content
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
 * Returns null when the payload is invalid JSON or has no text field.
 */
export function getPayloadRawContent(entry: HistoryEntry): string | null {
  try {
    const parsed = JSON.parse(entry.payload) as Record<string, unknown>
    if (typeof parsed.to_text === 'string') return parsed.to_text
    if (typeof parsed.content === 'string') return parsed.content
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
    if (typeof parsed.key === 'string') {
      return {
        key: parsed.key,
        ...(typeof parsed.value === 'string' ? { value: parsed.value } : {}),
      }
    }
  } catch {
    // Invalid JSON
  }
  return null
}
