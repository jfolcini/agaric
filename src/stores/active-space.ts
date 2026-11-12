/** The active space id, or `LEGACY_SPACE_KEY` with none, for keying `*BySpace` maps. */

import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

export function activeSpaceKey(): string {
  return useSpaceStore.getState().currentSpaceId ?? LEGACY_SPACE_KEY
}
