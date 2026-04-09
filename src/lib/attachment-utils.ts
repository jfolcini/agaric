import { convertFileSrc } from '@tauri-apps/api/core'

/**
 * Convert a local filesystem path to a Tauri asset protocol URL.
 * Returns null when not running inside the Tauri runtime (browser dev mode, tests).
 */
export function getAssetUrl(fsPath: string): string | null {
  try {
    if (
      typeof window !== 'undefined' &&
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    ) {
      return convertFileSrc(fsPath)
    }
  } catch {
    // Not in Tauri environment
  }
  return null
}

/** Format bytes into a human-readable size string. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
