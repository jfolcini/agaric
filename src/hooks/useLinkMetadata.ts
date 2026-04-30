/**
 * useLinkMetadata — typed wrapper around fetchLinkMetadata.
 *
 * Centralizes the link-metadata IPC call so LinkEditPopover doesn't
 * import directly from `src/lib/tauri`. Wraps with structured
 * logger.warn on failure and re-throws so callers retain their
 * existing fire-and-forget / await error handling.
 *
 * MAINT-131 — closes the last hook-wrap row.
 */

import { useCallback } from 'react'
import { logger } from '../lib/logger'
import { fetchLinkMetadata, type LinkMetadata } from '../lib/tauri'

export interface UseLinkMetadataReturn {
  /** Fetch (and cache) link metadata for a URL. Throws on failure. */
  fetch: (url: string) => Promise<LinkMetadata>
}

export function useLinkMetadata(): UseLinkMetadataReturn {
  const fetch = useCallback(async (url: string): Promise<LinkMetadata> => {
    try {
      return await fetchLinkMetadata(url)
    } catch (err) {
      logger.warn('useLinkMetadata', 'fetchLinkMetadata failed', { url }, err)
      throw err
    }
  }, [])

  return { fetch }
}
