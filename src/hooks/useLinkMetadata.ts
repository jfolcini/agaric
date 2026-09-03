/**
 * useLinkMetadata — typed wrapper around `commands.fetchLinkMetadata`.
 *
 * Centralizes the link-metadata IPC call so LinkEditPopover doesn't
 * dispatch it itself. Wraps with structured
 * logger.warn on failure and re-throws so callers retain their
 * existing fire-and-forget / await error handling.
 *
 * Closes the last hook-wrap row.
 */

import { useCallback } from 'react'

import { unwrap } from '@/lib/app-error'
import { commands, type LinkMetadata } from '@/lib/bindings'
import { logger } from '@/lib/logger'

export interface UseLinkMetadataReturn {
  /** Fetch (and cache) link metadata for a URL. Throws on failure. */
  fetch: (url: string) => Promise<LinkMetadata>
}

export function useLinkMetadata(): UseLinkMetadataReturn {
  const fetch = useCallback(async (url: string): Promise<LinkMetadata> => {
    try {
      return unwrap(await commands.fetchLinkMetadata(url))
    } catch (err) {
      logger.warn('useLinkMetadata', 'fetchLinkMetadata failed', { url }, err)
      throw err
    }
  }, [])

  return { fetch }
}
