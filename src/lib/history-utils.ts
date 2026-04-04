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
