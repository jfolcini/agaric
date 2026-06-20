/**
 * Shared palette value types. Extracted from CommandPalette.tsx (#751).
 */

import type { SearchBlockRow } from '@/lib/tauri'

/**
 * Merged palette group: a page header + ≤ N block hits + a surplus
 * Count. Migrated verbatim so the visual contract stays
 * stable across the rewrite.
 */
export interface PaletteGroup {
  pageId: string
  pageTitle: string
  /** True when the page itself (`block_type = 'page'`) matched. */
  hasPageNameMatch: boolean
  /** Block hits already capped to `MAX_MATCHES_PER_GROUP`. */
  matches: SearchBlockRow[]
  /** Number of matches dropped by the per-group cap. */
  surplus: number
  /** Blended FTS+fuzzy score used for the 4-band ordering. */
  score: number
}
