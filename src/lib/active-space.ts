/**
 * Shared `activeSpaceKey()` helper.
 *
 * Returns the current active space id, falling back to `LEGACY_SPACE_KEY`
 * when no space is selected (pre-bootstrap, or migrated v0 data that
 * predates spaces). Used by per-space partition stores
 * (`navigation.ts`, `journal.ts`, `tabs.ts`, `recent-pages.ts`) to key
 * into their `*BySpace` maps.
 *
 * Extracted in PEND-30 L-1 to remove the identical 3-line copy duplicated
 * across the four stores.
 */

import { LEGACY_SPACE_KEY, useSpaceStore } from '../stores/space'

export function activeSpaceKey(): string {
  return useSpaceStore.getState().currentSpaceId ?? LEGACY_SPACE_KEY
}
